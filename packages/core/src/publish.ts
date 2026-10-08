import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Bootstrap } from "./config.js";
import { type ProjectId, type PublicationKind, type PublicationState, type Repo, type RepoId, type Sha, type Unit, type UnitId } from "./domain.js";
import { valueMap } from "./envvalues.js";
import { runShell } from "./evidence.js";
import { addDetachedWorktree, ensureMirror, removeWorktree } from "./git.js";
import { layout } from "./paths.js";
import { getProject, getRepo, getUnit, now, recordEvent, type Db } from "./store.js";

export interface Publication {
  id: number;
  unitId: UnitId;
  repoId: RepoId;
  kind: PublicationKind;
  sha: Sha;
  version: string | null;
  state: PublicationState;
  reason: string | null;
  baseVersion: string | null;
  baseReleased: boolean;
  logPath: string | null;
  checkedAt: string | null;
  createdAt: string;
}

const COMMAND_SECONDS = 900;

const fromRow = (r: Record<string, unknown>): Publication => ({
  id: r.id as number,
  unitId: r.unit_id as UnitId,
  repoId: r.repo_id as RepoId,
  kind: r.kind as PublicationKind,
  sha: r.sha as Sha,
  version: (r.version as string | null) ?? null,
  state: r.state as PublicationState,
  reason: (r.reason as string | null) ?? null,
  baseVersion: (r.base_version as string | null) ?? null,
  baseReleased: r.base_released === 1,
  logPath: (r.log_path as string | null) ?? null,
  checkedAt: (r.checked_at as string | null) ?? null,
  createdAt: r.created_at as string,
});

export function listPublications(db: Db, unitId: UnitId): Publication[] {
  return (db.prepare("SELECT * FROM publications WHERE unit_id = ? ORDER BY id").all(unitId) as Record<string, unknown>[]).map(fromRow);
}

function publicationAt(db: Db, unitId: UnitId, kind: PublicationKind, sha: Sha): Publication | null {
  const r = db.prepare("SELECT * FROM publications WHERE unit_id = ? AND kind = ? AND sha = ?").get(unitId, kind, sha) as Record<string, unknown> | undefined;
  return r ? fromRow(r) : null;
}

function setPublication(db: Db, id: number, fields: Partial<Pick<Publication, "version" | "state" | "reason" | "baseVersion" | "baseReleased" | "checkedAt">>) {
  const cols: Record<string, string> = {
    version: "version",
    state: "state",
    reason: "reason",
    baseVersion: "base_version",
    baseReleased: "base_released",
    checkedAt: "checked_at",
  };
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  db.prepare(`UPDATE publications SET ${entries.map(([k]) => `${cols[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...entries.map(([, v]) => (typeof v === "boolean" ? (v ? 1 : 0) : v)),
    now(),
    id,
  );
}

// The release version is what CI publishes from trunk: the build's version without a snapshot marker.
export const releaseVersion = (raw: string) => raw.trim().replace(/-SNAPSHOT$/, "");

// A snapshot stays a snapshot (1.5.0-SNAPSHOT becomes 1.5.0-yg-p-u2-ab12cd3-SNAPSHOT), so a build range such as 1.5.+ never resolves it
// and nothing yagura publishes can pass for a release. Other ecosystems use the repo's own suffix.
export function qualifiedVersion(base: string, projectId: ProjectId, seq: number, sha: Sha, suffix: string): string {
  const project = projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${releaseVersion(base)}-yg-${project}-u${seq}-${sha.slice(0, 7)}${/-SNAPSHOT$/.test(base.trim()) ? "-SNAPSHOT" : suffix}`;
}

const lastLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .at(-1)
    ?.slice(0, 300) ?? "";

async function step(
  ctx: { db: Db; boot: Bootstrap },
  unit: Unit,
  log: string,
  label: string,
  command: string,
  cwd: string,
  vars: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; detail: string }> {
  const env = { ...process.env, ...valueMap(ctx.db, getProject(ctx.db, unit.projectId).environmentId), ...vars };
  const r = await runShell(command, cwd, env, COMMAND_SECONDS);
  const stdout = r.stdout.toString("utf8");
  const stderr = r.stderr.toString("utf8");
  appendFileSync(log, `$ ${command}  # ${label}\n${stdout}${stderr}${r.timedOut ? "(timed out)\n" : `(exit ${r.exitCode})\n`}\n`);
  const ok = r.exitCode === 0 && !r.timedOut;
  return { ok, stdout, detail: r.timedOut ? `${label} timed out` : `${label} exited ${r.exitCode}: ${lastLine(stderr) || lastLine(stdout)}` };
}

async function inCheckout<T>(ctx: { db: Db; boot: Bootstrap }, unit: Unit, repo: Repo, sha: Sha, fn: (dir: string) => Promise<T>): Promise<T> {
  const mirror = layout(ctx.boot).mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const dir = `${layout(ctx.boot).worktree(repo.id, unit.projectId, unit.seq, 0)}.publish-${sha.slice(0, 10)}`;
  mkdirSync(dirname(dir), { recursive: true });
  await removeWorktree(mirror, dir).catch(() => undefined);
  await addDetachedWorktree(mirror, dir, sha);
  try {
    return await fn(dir);
  } finally {
    await removeWorktree(mirror, dir).catch(() => undefined);
  }
}

function startLog(ctx: { boot: Bootstrap }, unit: Unit, kind: PublicationKind, sha: Sha): string {
  const log = layout(ctx.boot).publishLog(unit.projectId, unit.seq, kind, sha);
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "");
  return log;
}

function insertPublication(db: Db, unit: Unit, kind: PublicationKind, sha: Sha, state: PublicationState, log: string): number {
  return Number(
    db
      .prepare("INSERT INTO publications (unit_id, repo_id, kind, sha, state, log_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(unit.id, unit.repoId, kind, sha, state, log, now(), now()).lastInsertRowid,
  );
}

// yagura publishes a verified head itself, under a version unique to the unit and head, for its consumers to pin.
export async function publishTestBuild(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId, head: Sha): Promise<Publication | null> {
  const { db } = ctx;
  const unit = getUnit(db, unitId);
  const repo = getRepo(db, unit.repoId!);
  const publish = repo.publish;
  if (!publish || publicationAt(db, unit.id, "test", head)) return null;
  const log = startLog(ctx, unit, "test", head);
  const id = insertPublication(db, unit, "test", head, "publishing", log);
  const refs = { projectId: unit.projectId, unitId: unit.id };
  await inCheckout(ctx, unit, repo, head, async (dir) => {
    const base = await step(ctx, unit, log, "version", publish.version, dir, { YAGURA_SHA: head });
    if (!base.ok || !base.stdout.trim()) {
      setPublication(db, id, { state: "failed", reason: base.ok ? "the repo's version command printed nothing" : base.detail });
      return;
    }
    const baseVersion = releaseVersion(base.stdout);
    const version = qualifiedVersion(base.stdout, unit.projectId, unit.seq, head, publish.suffix);
    setPublication(db, id, { version, baseVersion });
    const pub = await step(ctx, unit, log, "publish", publish.command, dir, { YAGURA_VERSION: version, YAGURA_SHA: head });
    if (!pub.ok) {
      setPublication(db, id, { state: "failed", reason: pub.detail });
      return;
    }
    const fetchable = await step(ctx, unit, log, "available", publish.available, dir, { YAGURA_VERSION: version });
    setPublication(
      db,
      id,
      fetchable.ok ? { state: "published", reason: null } : { state: "failed", reason: `published, but it cannot be fetched: ${fetchable.detail}` },
    );
  });
  const done = listPublications(db, unit.id).find((p) => p.id === id)!;
  recordEvent(db, done.state === "published" ? "publish.test" : "publish.failed", refs, {
    repo: repo.id,
    version: done.version,
    head,
    ...(done.reason ? { reason: done.reason } : {}),
  });
  return done;
}
