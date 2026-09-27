import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveSetting, type Bootstrap } from "./config.js";
import { PASS_TIERS, REBASE_HARNESS } from "./domain.js";
import type { Sha, Unit, UnitId, VerdictId } from "./domain.js";
import { addDetachedWorktree, ensureMirror, git, gitWithEnv, patchId, removeWorktree, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { markPackProven } from "./packs.js";
import { addVerifyUnit } from "./runner.js";
import { createAttempt, getProject, getRepo, getUnit, listAttempts, now, recordEvent, setLandedSha, transitionUnit, updateAttempt, type Db } from "./store.js";
import { landMessage } from "./audit.js";

export type LandOutcome = "landed" | "blocked" | "reverifying";

export interface LandResult {
  unit: Unit;
  outcome: LandOutcome;
  landedSha: Sha | null;
  reason: string;
}

export interface LiveVerdict {
  id: VerdictId;
  attempt_id: number;
  tier: string;
  head_sha: Sha;
  patch_id: string | null;
}

export function liveVerdict(db: Db, unitId: UnitId): LiveVerdict | null {
  const tiers = PASS_TIERS.map(() => "?").join(", ");
  return (
    (db
      .prepare(
        `SELECT id, attempt_id, tier, head_sha, patch_id FROM verdicts WHERE unit_id = ? AND voided_at IS NULL AND tier IN (${tiers}) ORDER BY id DESC LIMIT 1`,
      )
      .get(unitId, ...PASS_TIERS) as LiveVerdict | undefined) ?? null
  );
}

export async function landUnit(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId): Promise<LandResult> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.state !== "verified") throw new Error(`U${unit.seq} is ${unit.state}, not verified`);
  if (!unit.repoId) throw new Error(`U${unit.seq} has no repo`);
  const repo = getRepo(db, unit.repoId);
  const busy = db.prepare("SELECT seq FROM units WHERE repo_id = ? AND state = 'landing' AND id <> ?").get(repo.id, unit.id) as { seq: number } | undefined;
  if (busy) throw new Error(`U${busy.seq} is already landing in ${repo.id}; one lander per repo`);
  const verdict = liveVerdict(db, unit.id);
  if (!verdict) throw new Error(`U${unit.seq} has no live passing verdict`);
  const work = listAttempts(db, unit.id).find((a) => a.headSha === verdict.head_sha && a.baseSha);
  if (!work?.baseSha) throw new Error(`U${unit.seq}: no attempt produced the verified head ${verdict.head_sha}`);
  const project = getProject(db, unit.projectId);
  const author = {
    name: resolveSetting(db, "git.author_name", { projectId: project.id, repoId: repo.id }).value,
    email: resolveSetting(db, "git.author_email", { projectId: project.id, repoId: repo.id }).value,
  };
  const refs = { projectId: project.id, unitId: unit.id };
  const paths = layout(boot);
  const mirror = paths.mirror(repo.id);

  transitionUnit(db, unit.id, "landing", { verdict: verdict.id });
  const reverify = async (onto: Sha, rebased: Sha): Promise<LandResult> => {
    const attempt = createAttempt(db, unit.id, REBASE_HARNESS, null);
    const branch = `${work.branch ?? `yg/${project.id}/u${unit.seq}`}-rebased-${attempt.n}`;
    await git(["update-ref", `refs/heads/${branch}`, rebased], { gitDir: mirror });
    const reason = `rebased onto ${repo.defaultBranch} at ${onto.slice(0, 10)} and the patch changed; the rebased head needs re-verification`;
    db.transaction(() => {
      updateAttempt(db, attempt.id, { state: "handed_off", baseSha: onto, headSha: rebased, branch, startedAt: now(), endedAt: now() });
      db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE id = ?").run(now(), reason, verdict.id);
      transitionUnit(db, unit.id, "verifying", { reason, rebasedHead: rebased });
      addVerifyUnit(db, getUnit(db, unit.id));
    })();
    return { unit: getUnit(db, unit.id), outcome: "reverifying", landedSha: null, reason };
  };
  const block = (reason: string): LandResult => {
    transitionUnit(db, unit.id, "blocked", { reason });
    return { unit: getUnit(db, unit.id), outcome: "blocked", landedSha: null, reason };
  };

  await ensureMirror(repo.url, mirror);
  const trunk = await resolveRef(mirror, `origin/${repo.defaultBranch}`);
  const wt = `${paths.worktree(repo.id, project.id, unit.seq, 0)}.land`;
  mkdirSync(dirname(wt), { recursive: true });
  await addDetachedWorktree(mirror, wt, verdict.head_sha);
  let landed: Sha;
  try {
    if (trunk !== work.baseSha) {
      try {
        await git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "rebase", "--quiet", "--onto", trunk, work.baseSha], { cwd: wt });
      } catch {
        await git(["rebase", "--abort"], { cwd: wt }).catch(() => undefined);
        return block(`conflicts with ${repo.defaultBranch} at ${trunk.slice(0, 10)}; needs a rebase unit`);
      }
    }
    const tree = await git(["rev-parse", "HEAD^{tree}"], { cwd: wt });
    const message = landMessage(db, boot, {
      unit,
      work,
      verdict: { id: verdict.id, tier: verdict.tier, attemptId: verdict.attempt_id },
      url: resolveSetting(db, "yagura.url", { projectId: project.id, repoId: repo.id }).value,
    });
    const identity = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    landed = (await gitWithEnv(["commit-tree", tree, "-p", trunk, "-F", "-"], wt, identity, message)) as Sha;
    const squashedPatch = await patchId(wt, trunk, landed);
    if (!verdict.patch_id || squashedPatch !== verdict.patch_id) return await reverify(trunk, (await git(["rev-parse", "HEAD"], { cwd: wt })) as Sha);
    db.transaction(() => {
      db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE id = ?").run(
        now(),
        `landed as ${landed}; patch-id unchanged, carried forward`,
        verdict.id,
      );
      db.prepare(
        `INSERT INTO verdicts (unit_id, attempt_id, tier, repo_id, head_sha, patch_id, dep_shas_json, artifact_versions_json, trunk_outcome, head_outcome, created_at)
         SELECT unit_id, attempt_id, tier, repo_id, ?, patch_id, dep_shas_json, artifact_versions_json, trunk_outcome, head_outcome, ? FROM verdicts WHERE id = ?`,
      ).run(landed, now(), verdict.id);
      db.prepare(
        "INSERT INTO verdict_artifacts (verdict_id, artifact_id) SELECT last_insert_rowid(), artifact_id FROM verdict_artifacts WHERE verdict_id = ?",
      ).run(verdict.id);
    })();
  } finally {
    await removeWorktree(mirror, wt).catch(() => undefined);
  }

  try {
    await git(["push", "--quiet", "origin", `${landed}:refs/heads/${repo.defaultBranch}`], { gitDir: mirror });
  } catch (e) {
    return block(`push to ${repo.defaultBranch} was rejected: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  await ensureMirror(repo.url, mirror);
  setLandedSha(db, unit.id, landed);
  markPackProven(db, unit, landed);
  transitionUnit(db, unit.id, "landed", { sha: landed, onto: trunk });
  recordEvent(db, "unit.landed", refs, { sha: landed, branch: repo.defaultBranch, rebased: trunk !== work.baseSha, squashedFrom: verdict.head_sha });
  return {
    unit: getUnit(db, unit.id),
    outcome: "landed",
    landedSha: landed,
    reason: trunk === work.baseSha ? "squashed onto trunk" : "rebased onto the moved trunk and squashed; patch unchanged",
  };
}
