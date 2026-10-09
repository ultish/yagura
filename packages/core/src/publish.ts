import { findAction } from "./actions.js";
import { inCheckout, runIn } from "./actionrun.js";
import type { Bootstrap } from "./config.js";
import type { ProjectId, PublicationKind, PublicationState, RepoId, Sha, Unit, UnitId } from "./domain.js";
import { getProject, getUnit, listUnits, now, recordEvent, type Db } from "./store.js";

export interface Publication {
  id: number;
  unitId: UnitId;
  repoId: RepoId;
  kind: PublicationKind;
  sha: Sha;
  version: string | null;
  state: PublicationState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

const AVAILABLE_TRIES = 24;

const fromRow = (r: Record<string, unknown>): Publication => ({
  id: r.id as number,
  unitId: r.unit_id as UnitId,
  repoId: r.repo_id as RepoId,
  kind: r.kind as PublicationKind,
  sha: r.sha as Sha,
  version: (r.version as string | null) ?? null,
  state: r.state as PublicationState,
  reason: (r.reason as string | null) ?? null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export function listPublications(db: Db, unitId: UnitId): Publication[] {
  return (db.prepare("SELECT * FROM publications WHERE unit_id = ? ORDER BY id").all(unitId) as Record<string, unknown>[]).map(fromRow);
}

// The test build of a unit's merge commit, the newest try first.
export function testBuildOf(db: Db, unit: Unit): Publication | null {
  if (!unit.mergedSha) return null;
  const r = db.prepare("SELECT * FROM publications WHERE unit_id = ? AND kind = 'test' AND sha = ? ORDER BY id DESC LIMIT 1").get(unit.id, unit.mergedSha) as
    Record<string, unknown> | undefined;
  return r ? fromRow(r) : null;
}

// The release version is what CI publishes from main: the build's version without a snapshot marker.
export const releaseVersion = (raw: string) => raw.trim().replace(/-SNAPSHOT$/, "");

// A snapshot stays a snapshot (1.5.0-SNAPSHOT becomes 1.5.0-yg-p-u2-ab12cd3-SNAPSHOT), so a build range such as 1.5.+ never resolves it
// and nothing yagura publishes can pass for a release.
export function qualifiedVersion(raw: string, projectId: ProjectId, seq: number, sha: Sha): string {
  const project = projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${releaseVersion(raw)}-yg-${project}-u${seq}-${sha.slice(0, 7)}${/-SNAPSHOT$/.test(raw.trim()) ? "-SNAPSHOT" : ""}`;
}

const contract = (db: Db, unit: Unit) => {
  const environmentId = getProject(db, unit.projectId).environmentId;
  const find = (name: string) => (environmentId && unit.repoId ? findAction(db, environmentId, unit.repoId, name) : null);
  return { environmentId, version: find("version"), publish: find("publish-snapshot"), available: find("snapshot-available") };
};

// A merged unit needs a test build when its repo can publish and a later unit comes after it.
export function needsTestBuild(db: Db, unit: Unit): boolean {
  if (unit.type !== "work" || unit.state !== "merged" || !unit.mergedSha) return false;
  if (!contract(db, unit).publish) return false;
  return listUnits(db, unit.projectId).some((u) => u.after.includes(unit.id));
}

// Publish again only when the try at this commit failed and the publish actions changed since (the developer or the doctor fixed them).
export function publishDue(db: Db, projectId: ProjectId): Unit[] {
  return listUnits(db, projectId).filter((u) => {
    if (!needsTestBuild(db, u)) return false;
    const pub = testBuildOf(db, u);
    if (!pub) return true;
    if (pub.state !== "failed") return false;
    const c = contract(db, u);
    return [c.version, c.publish, c.available].some((a) => a && a.updatedAt > pub.updatedAt);
  });
}

function setPublication(db: Db, id: number, fields: Partial<Pick<Publication, "version" | "state" | "reason">>) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  db.prepare(`UPDATE publications SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...entries.map(([, v]) => v),
    now(),
    id,
  );
}

// yagura publishes a merged library itself, from its merge commit, with the repo's own actions, for the units after it to depend on.
export async function publishTestBuild(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId, opts: { pollMs?: number } = {}): Promise<Publication | null> {
  const { db } = ctx;
  const unit = getUnit(db, unitId);
  const c = contract(db, unit);
  if (!needsTestBuild(db, unit) || !c.environmentId) return null;
  const sha = unit.mergedSha!;
  const id = Number(
    db
      .prepare("INSERT INTO publications (unit_id, repo_id, kind, sha, state, created_at, updated_at) VALUES (?, ?, 'test', ?, 'publishing', ?, ?)")
      .run(unit.id, unit.repoId, sha, now(), now()).lastInsertRowid,
  );
  const refs = { projectId: unit.projectId, unitId: unit.id };
  const missing = (["version", "publish", "available"] as const)
    .filter((k) => !c[k])
    .map((k) => ({ version: "version", publish: "publish-snapshot", available: "snapshot-available" })[k]);
  if (missing.length) setPublication(db, id, { state: "failed", reason: `the environment has no ${missing.join(", ")} action for ${unit.repoId}` });
  else
    await inCheckout(ctx, unit.repoId!, sha, async (dir) => {
      const run = (action: NonNullable<typeof c.version>, vars?: Record<string, string>) =>
        runIn(ctx, { dir, sha, environmentId: c.environmentId!, repoId: unit.repoId!, actionId: action.id, command: action.command, vars, by: "yagura" });
      const fail = (name: string, r: { exitCode: number | null; timedOut: boolean; output: string }) =>
        setPublication(db, id, {
          state: "failed",
          reason: `${name} ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}: ${r.output.trim().split("\n").at(-1)?.slice(0, 200) ?? ""}`,
        });
      const v = await run(c.version!);
      const raw = v.output.trim().split("\n")[0] ?? "";
      if (v.exitCode !== 0 || !raw) return fail("version", v);
      const version = qualifiedVersion(raw, unit.projectId, unit.seq, sha);
      setPublication(db, id, { version });
      const p = await run(c.publish!, { YAGURA_VERSION: version });
      if (p.exitCode !== 0 || p.timedOut) return fail("publish-snapshot", p);
      for (let i = 0; i < AVAILABLE_TRIES; i++) {
        const a = await run(c.available!, { YAGURA_VERSION: version });
        if (a.exitCode === 0) return setPublication(db, id, { state: "published", reason: null });
        if (i === AVAILABLE_TRIES - 1) return fail("snapshot-available", a);
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
      }
    });
  const done = testBuildOf(db, getUnit(db, unit.id))!;
  recordEvent(db, done.state === "published" ? "publish.test" : "publish.failed", refs, { version: done.version, reason: done.reason, sha });
  return done;
}
