import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Bootstrap } from "./config.js";
import { resolveSetting } from "./config.js";
import {
  REPIN_HARNESS,
  TERMINAL_STATES,
  type PackPublish,
  type ProjectId,
  type PublicationKind,
  type PublicationState,
  type Repo,
  type RepoId,
  type Sha,
  type Unit,
  type UnitId,
} from "./domain.js";
import { valueMap } from "./envvalues.js";
import { runShell } from "./evidence.js";
import { addDetachedWorktree, addWorktree, commitAll, ensureMirror, git, headSha, readFileAt, removeWorktree } from "./git.js";
import { verifiedHead } from "./land.js";
import { parsePack } from "./pack.js";
import { layout, unitRef } from "./paths.js";
import { addVerifyUnit } from "./runner.js";
import { reverifyAgainstSources, sourceDeps, sourceSha } from "./sources.js";
import { createAttempt, getProject, getRepo, getUnit, listDeps, listUnits, now, recordEvent, transitionUnit, updateAttempt, type Db } from "./store.js";

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

export function qualifiedVersion(base: string, projectId: ProjectId, seq: number, sha: Sha, suffix: string): string {
  const project = projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${releaseVersion(base)}-yg-${project}-u${seq}-${sha.slice(0, 7)}${suffix}`;
}

// Units in another repo that build on this one's artifact and are not finished.
function liveConsumers(db: Db, up: Unit, kinds: readonly string[]): Unit[] {
  return listDeps(db, up.projectId)
    .filter((d) => d.dependsOn === up.id && kinds.includes(d.kind))
    .map((d) => getUnit(db, d.unitId))
    .filter((c) => c.repoId !== up.repoId && !TERMINAL_STATES.has(c.state));
}

export type UpstreamArtifact = { version: string } | { wait: string } | { stuck: string } | null;

// The artifact a consumer in `consumerRepo` builds against, what it waits for, or why it cannot get one; null when the upstream's repo does not publish.
export function upstreamArtifact(db: Db, up: Unit, consumerRepo: RepoId | null): UpstreamArtifact {
  if (!up.repoId || up.repoId === consumerRepo) return null;
  const repo = getRepo(db, up.repoId);
  if (!repo.publish) return null;
  if (up.landedSha) {
    const rel = publicationAt(db, up.id, "release", up.landedSha);
    if (rel?.state === "published") return { version: rel.version! };
    if (!rel || rel.state === "waiting")
      return { wait: `waits for ${repo.id}${rel?.version ? ` ${rel.version}` : ""} from U${up.seq}'s landing to be released` };
    return { stuck: rel.reason ?? `${repo.id} from U${up.seq}'s landing was not released` };
  }
  if (up.state === "done") return null;
  const head = sourceSha(db, up);
  const test = head ? publicationAt(db, up.id, "test", head) : null;
  if (test?.state === "published") return { version: test.version! };
  if (test?.state === "failed") return { stuck: `the test build of U${up.seq} in ${repo.id} failed: ${test.reason}` };
  return { wait: `waits for the test build of U${up.seq} in ${repo.id}` };
}

async function trunkPublish(ctx: { db: Db; boot: Bootstrap }, repo: Repo): Promise<PackPublish | null> {
  const mirror = layout(ctx.boot).mirror(repo.id);
  const pack = parsePack(await readFileAt(mirror, `origin/${repo.defaultBranch}`, `${repo.verifyPackPath}/verify.json`), repo.verifyPackPath);
  const publish = pack.ok ? (pack.pack.publish ?? null) : null;
  ctx.db.prepare("UPDATE repos SET publish_json = ? WHERE id = ?").run(publish ? JSON.stringify(publish) : null, repo.id);
  return publish;
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
  const publish = await trunkPublish(ctx, repo);
  if (!publish || publicationAt(db, unit.id, "test", head)) return null;
  const log = startLog(ctx, unit, "test", head);
  const id = insertPublication(db, unit, "test", head, "publishing", log);
  const refs = { projectId: unit.projectId, unitId: unit.id };
  await inCheckout(ctx, unit, repo, head, async (dir) => {
    const base = await step(ctx, unit, log, "version", publish.version, dir, { YAGURA_SHA: head });
    if (!base.ok || !base.stdout.trim()) {
      setPublication(db, id, { state: "failed", reason: base.ok ? "the pack's version command printed nothing" : base.detail });
      return;
    }
    const baseVersion = releaseVersion(base.stdout);
    const version = qualifiedVersion(base.stdout, unit.projectId, unit.seq, head, publish.suffix);
    setPublication(db, id, { version, baseVersion });
    const before = await step(ctx, unit, log, "available (the head's own version, before publishing)", publish.available, dir, { YAGURA_VERSION: baseVersion });
    setPublication(db, id, { baseReleased: before.ok });
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

// CI releases a landed upstream; yagura reads the version it will carry and polls until it can be fetched.
export async function watchRelease(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId): Promise<Publication | null> {
  const { db } = ctx;
  const unit = getUnit(db, unitId);
  const landed = unit.landedSha;
  if (!landed) return null;
  const repo = getRepo(db, unit.repoId!);
  const refs = { projectId: unit.projectId, unitId: unit.id };
  let rel = publicationAt(db, unit.id, "release", landed);
  if (!rel) {
    const publish = await trunkPublish(ctx, repo);
    if (!publish) return null;
    const log = startLog(ctx, unit, "release", landed);
    const id = insertPublication(db, unit, "release", landed, "waiting", log);
    const v = await inCheckout(ctx, unit, repo, landed, (dir) => step(ctx, unit, log, "version", publish.version, dir, { YAGURA_SHA: landed }));
    const version = v.ok ? releaseVersion(v.stdout) : "";
    if (!version) setPublication(db, id, { state: "failed", reason: v.ok ? "the pack's version command printed nothing" : v.detail });
    else {
      setPublication(db, id, { version });
      const already = listPublications(db, unit.id).find((p) => p.kind === "test" && p.baseVersion === version && p.baseReleased);
      if (already)
        setPublication(db, id, {
          state: "unchanged",
          reason: `U${unit.seq} landed without changing ${repo.id}'s version: ${version} was already released before it, so no release carries its change. Bump the version the way ${repo.id} does`,
        });
    }
    rel = listPublications(db, unit.id).find((p) => p.id === id)!;
    if (rel.state !== "waiting") {
      recordEvent(db, "publish.release_failed", refs, { repo: repo.id, version: rel.version, reason: rel.reason });
      return rel;
    }
  }
  if (rel.state !== "waiting") return rel;
  const publish = repo.publish ?? (await trunkPublish(ctx, repo));
  if (!publish) return rel;
  const check = await step(ctx, unit, rel.logPath!, "available", publish.available, ctx.boot.home, { YAGURA_VERSION: rel.version! });
  if (check.ok) {
    setPublication(db, rel.id, { state: "published", reason: null, checkedAt: now() });
    recordEvent(db, "publish.released", refs, { repo: repo.id, version: rel.version });
  } else {
    const minutes = resolveSetting(db, "publish.release_wait_minutes", { projectId: unit.projectId, repoId: repo.id }).value;
    const waited = (Date.now() - Date.parse(rel.createdAt)) / 60_000;
    if (waited >= minutes) {
      setPublication(db, rel.id, {
        state: "failed",
        checkedAt: now(),
        reason: `${repo.id} ${rel.version} was not released within ${minutes} minutes of U${unit.seq} landing (${check.detail})`,
      });
      recordEvent(db, "publish.release_failed", refs, { repo: repo.id, version: rel.version, reason: "timed out" });
    } else setPublication(db, rel.id, { checkedAt: now() });
  }
  return listPublications(db, unit.id).find((p) => p.id === rel.id)!;
}

// Test builds go once the upstream and every consumer of it are finished; without an unpublish command Nexus's cleanup policy has them.
export async function cleanUpTestBuilds(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId): Promise<number> {
  const { db } = ctx;
  const unit = getUnit(db, unitId);
  const repo = getRepo(db, unit.repoId!);
  let n = 0;
  for (const p of listPublications(db, unit.id).filter((x) => x.kind === "test" && x.state === "published")) {
    const unpublish = repo.publish?.unpublish;
    if (!unpublish) {
      setPublication(db, p.id, { state: "left", reason: "no unpublish command; left to the repository's cleanup policy" });
      continue;
    }
    const r = await step(ctx, unit, p.logPath!, "unpublish", unpublish, ctx.boot.home, { YAGURA_VERSION: p.version! });
    setPublication(db, p.id, r.ok ? { state: "removed" } : { state: "left", reason: r.detail });
    if (r.ok) n++;
  }
  recordEvent(db, "publish.cleaned", { projectId: unit.projectId, unitId: unit.id }, { repo: repo.id, removed: n });
  return n;
}

export interface PublishJob {
  key: string;
  label: string;
  run: (ctx: { db: Db; boot: Bootstrap }) => Promise<unknown>;
}

// What the engine should do about artifacts in a project now: publish verified heads consumers need, watch for
// releases of landed upstreams, and clean up after finished ones.
export function publishJobs(db: Db, projectId: ProjectId): PublishJob[] {
  const jobs: PublishJob[] = [];
  const poll = resolveSetting(db, "forge.poll_seconds").value * 1000;
  for (const u of listUnits(db, projectId)) {
    if (!u.repoId || !getRepo(db, u.repoId).publish) continue;
    const pubs = listPublications(db, u.id);
    if (!u.landedSha && (u.state === "verified" || u.state === "landing") && liveConsumers(db, u, ["needs-source"]).length) {
      const head = sourceSha(db, u);
      if (head && !pubs.some((p) => p.kind === "test" && p.sha === head))
        jobs.push({ key: `publish:${u.id}`, label: `publish a test build of U${u.seq}`, run: (c) => publishTestBuild(c, u.id, head) });
    }
    if (u.landedSha && liveConsumers(db, u, ["needs-source", "needs-landed"]).length) {
      const rel = pubs.find((p) => p.kind === "release" && p.sha === u.landedSha);
      if (!rel || (rel.state === "waiting" && (!rel.checkedAt || Date.now() - Date.parse(rel.checkedAt) >= poll)))
        jobs.push({ key: `release:${u.id}`, label: `watch for the release of U${u.seq}`, run: (c) => watchRelease(c, u.id) });
    }
    if (TERMINAL_STATES.has(u.state) && pubs.some((p) => p.kind === "test" && p.state === "published") && !liveConsumers(db, u, ["needs-source"]).length)
      jobs.push({ key: `unpublish:${u.id}`, label: `clean up U${u.seq}'s test builds`, run: (c) => cleanUpTestBuilds(c, u.id) });
  }
  return jobs;
}

// Test versions of the consumer's sources that its verified head still names, with the version each should become.
async function stalePins(ctx: { db: Db; boot: Bootstrap }, unit: Unit, head: Sha): Promise<{ from: string; to: string; source: Unit }[]> {
  const { db } = ctx;
  const mirror = layout(ctx.boot).mirror(unit.repoId!);
  const out: { from: string; to: string; source: Unit }[] = [];
  for (const up of sourceDeps(db, unit)) {
    const current = upstreamArtifact(db, up, unit.repoId);
    if (!current || !("version" in current)) continue;
    for (const p of listPublications(db, up.id).filter((x) => x.kind === "test" && x.version && x.version !== current.version)) {
      const hit = await git(["grep", "-l", "-F", "-e", p.version!, head], { gitDir: mirror }).then(
        (o) => o.trim().length > 0,
        () => false,
      );
      if (hit) out.push({ from: p.version!, to: current.version, source: up });
    }
  }
  return out;
}

// A consumer lands only with its sources' current versions in its code, whatever its verdict says about SHAs.
export async function repinIfStale(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId): Promise<"clean" | "repinned"> {
  const unit = getUnit(ctx.db, unitId);
  const { verdict } = verifiedHead(ctx.db, unit);
  if (!(await stalePins(ctx, unit, verdict.head_sha)).length) return "clean";
  await moveConsumer(ctx, unitId, "its change still names a test version of a source that has a newer one");
  return "repinned";
}

// A consumer whose source moved: yagura moves its pinned test versions to the source's current version on a new
// branch and verifies that head; with nothing pinned (a composite build) it is simply verified again.
export async function moveConsumer(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId, reason: string): Promise<"repinned" | "reverify"> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  const { verdict, work } = verifiedHead(db, unit);
  const repo = getRepo(db, unit.repoId!);
  const mirror = layout(boot).mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const pins = await stalePins(ctx, unit, verdict.head_sha);
  if (!pins.length) {
    reverifyAgainstSources(db, unit, reason, (u) => addVerifyUnit(db, u));
    return "reverify";
  }
  const sctx = { projectId: unit.projectId, repoId: repo.id };
  const attempt = createAttempt(db, unit.id, REPIN_HARNESS, null);
  const branch = `${resolveSetting(db, "git.branch_prefix", sctx).value}/${unit.projectId}/${unitRef(unit.seq)}-repin-${attempt.n}`;
  const wt = layout(boot).worktree(repo.id, unit.projectId, unit.seq, attempt.n);
  mkdirSync(dirname(wt), { recursive: true });
  await addWorktree(mirror, wt, branch, verdict.head_sha);
  const files = new Set<string>();
  for (const pin of pins) {
    const listed = await git(["grep", "-l", "-F", "-e", pin.from], { cwd: wt }).catch(() => "");
    for (const f of listed.split("\n").filter(Boolean)) {
      const path = join(wt, f);
      writeFileSync(path, readFileSync(path, "utf8").split(pin.from).join(pin.to));
      files.add(f);
    }
  }
  const moved = pins.map((p) => `${p.source.repoId} ${p.from} → ${p.to}`).join(", ");
  await commitAll(wt, `chore: move to ${pins.map((p) => `${p.source.repoId} ${p.to}`).join(", ")}\n\n${reason}`, {
    name: resolveSetting(db, "git.author_name", sctx).value,
    email: resolveSetting(db, "git.author_email", sctx).value,
  });
  const head = await headSha(wt);
  const why = `${reason}; yagura moved ${moved} in ${[...files].join(", ")}`;
  db.transaction(() => {
    updateAttempt(db, attempt.id, { state: "handed_off", baseSha: work.baseSha, headSha: head, branch, startedAt: now(), endedAt: now() });
    db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE unit_id = ? AND voided_at IS NULL").run(now(), why, unit.id);
    transitionUnit(db, unit.id, "verifying", { reason: why });
    addVerifyUnit(db, getUnit(db, unit.id));
  })();
  recordEvent(
    db,
    "consumer.repinned",
    { projectId: unit.projectId, unitId: unit.id, attemptId: attempt.id },
    { moved: pins.map((p) => ({ repo: p.source.repoId, from: p.from, to: p.to })), files: [...files], head },
  );
  return "repinned";
}
