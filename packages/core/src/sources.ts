import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Bootstrap } from "./config.js";
import type { RepoId, Sha, Unit } from "./domain.js";
import { addDetachedWorktree, ensureMirror } from "./git.js";
import { layout } from "./paths.js";
import { upstreamArtifact } from "./publish.js";
import { getRepo, getUnit, listDeps, now, recordEvent, transitionUnit, type Db } from "./store.js";

export interface Source {
  unit: string;
  repoId: RepoId;
  sha: Sha;
  path: string;
  // The test build of the source, when its repo publishes one (§14).
  version?: string;
}

const PASSING = "('deployed-verified', 'live-local-verified', 'e2e-verified', 'unit-verified', 'build-only')";

// What a needs-source dependency is built against: the upstream's landed commit, or else its verified head.
export function sourceSha(db: Db, upstream: Unit): Sha | null {
  if (upstream.landedSha) return upstream.landedSha;
  const v = db
    .prepare(`SELECT head_sha FROM verdicts WHERE unit_id = ? AND voided_at IS NULL AND tier IN ${PASSING} ORDER BY id DESC LIMIT 1`)
    .get(upstream.id) as { head_sha: Sha } | undefined;
  return v?.head_sha ?? null;
}

export function sourceDeps(db: Db, unit: Unit): Unit[] {
  return listDeps(db, unit.projectId)
    .filter((d) => d.unitId === unit.id && d.kind === "needs-source")
    .map((d) => getUnit(db, d.dependsOn));
}

// Read-only checkouts, pinned to a SHA, next to the attempt's own worktree; an existing one (a resumed attempt) is kept.
export async function mountSources(ctx: { db: Db; boot: Bootstrap }, unit: Unit, beside: string): Promise<Source[]> {
  const out: Source[] = [];
  for (const up of sourceDeps(ctx.db, unit)) {
    const sha = sourceSha(ctx.db, up);
    if (!sha || !up.repoId) continue;
    const repo = getRepo(ctx.db, up.repoId);
    const mirror = layout(ctx.boot).mirror(repo.id);
    await ensureMirror(repo.url, mirror);
    const path = `${beside}.source-u${up.seq}`;
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      await addDetachedWorktree(mirror, path, sha);
    }
    const artifact = upstreamArtifact(ctx.db, up, unit.repoId);
    out.push({ unit: `U${up.seq}`, repoId: repo.id, sha, path, ...(artifact && "version" in artifact ? { version: artifact.version } : {}) });
  }
  return out;
}

const envName = (repoId: string) => repoId.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export const sourceEnv = (sources: Source[]): Record<string, string> =>
  Object.fromEntries(
    sources.flatMap((s) => [[`YAGURA_SOURCE_${envName(s.repoId)}`, s.path], ...(s.version ? [[`YAGURA_VERSION_${envName(s.repoId)}`, s.version]] : [])]),
  );

export const sourceVersions = (sources: Source[]): Record<string, string> =>
  Object.fromEntries(sources.filter((s) => s.version).map((s) => [s.unit, s.version!]));

export const depShas = (sources: Source[]): Record<string, Sha> => Object.fromEntries(sources.map((s) => [s.unit, s.sha]));

// The source a consumer's live verdict was proven against, when that is no longer what the source is (it landed, or was re-verified at a new head).
export function staleSource(db: Db, unit: Unit): string | null {
  const v = db
    .prepare(`SELECT dep_shas_json FROM verdicts WHERE unit_id = ? AND voided_at IS NULL AND tier IN ${PASSING} ORDER BY id DESC LIMIT 1`)
    .get(unit.id) as { dep_shas_json: string } | undefined;
  if (!v) return null;
  const proven = JSON.parse(v.dep_shas_json) as Record<string, Sha>;
  for (const up of sourceDeps(db, unit)) {
    const current = sourceSha(db, up);
    if (current && proven[`U${up.seq}`] !== current)
      return `U${up.seq} is now at ${current.slice(0, 10)}, not the ${proven[`U${up.seq}`]?.slice(0, 10) ?? "unrecorded"} it was verified against`;
  }
  return null;
}

export function reverifyAgainstSources(db: Db, unit: Unit, reason: string, queueVerify: (u: Unit) => void): void {
  db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE unit_id = ? AND voided_at IS NULL").run(now(), reason, unit.id);
  transitionUnit(db, unit.id, "verifying", { reason });
  queueVerify(getUnit(db, unit.id));
  recordEvent(db, "verdict.voided_by_source", { projectId: unit.projectId, unitId: unit.id }, { reason });
}
