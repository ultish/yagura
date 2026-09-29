import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveSetting, type Bootstrap } from "./config.js";
import { PASS_TIERS, REBASE_HARNESS, spendsAttempt } from "./domain.js";
import type { Attempt, Project, Repo, Sha, Unit, UnitId, VerdictId } from "./domain.js";
import { forgeFor, ForgeError, getMergeRequest, recordMergeStatus, saveMergeRequest, setMergeState, type ForgeAdapter, type PrStatus } from "./forge.js";
import { gateResolved } from "./gates.js";
import { addDetachedWorktree, ensureMirror, git, gitWithEnv, patchId, removeWorktree, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { markPackProven } from "./packs.js";
import { MAX_REBASES, queueRebase } from "./rebase.js";
import { freshThreads, listThreadRows, MAX_TRIAGE_WAVES, queueTriage } from "./triage.js";
import { addVerifyUnit } from "./runner.js";
import {
  addUnitNote,
  createAttempt,
  getProject,
  getRepo,
  getUnit,
  listAttempts,
  listGates,
  now,
  recordEvent,
  setLandedSha,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { landMessage } from "./audit.js";

export type LandOutcome = "landed" | "blocked" | "reverifying" | "proposed" | "waiting" | "rework" | "rebasing" | "triaging";

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

interface Landing {
  db: Db;
  boot: Bootstrap;
  unit: Unit;
  project: Project;
  repo: Repo;
  verdict: LiveVerdict;
  work: Attempt;
  mirror: string;
}

export function verifiedHead(db: Db, unit: Unit): { verdict: LiveVerdict; work: Attempt } {
  const verdict = liveVerdict(db, unit.id);
  if (!verdict) throw new Error(`U${unit.seq} has no live passing verdict`);
  const work = listAttempts(db, unit.id).find((a) => a.headSha === verdict.head_sha && a.baseSha);
  if (!work?.baseSha) throw new Error(`U${unit.seq}: no attempt produced the verified head ${verdict.head_sha}`);
  return { verdict, work };
}

function landing(ctx: { db: Db; boot: Bootstrap }, unit: Unit): Landing {
  const { db, boot } = ctx;
  if (!unit.repoId) throw new Error(`U${unit.seq} has no repo`);
  const repo = getRepo(db, unit.repoId);
  const { verdict, work } = verifiedHead(db, unit);
  return { db, boot, unit, project: getProject(db, unit.projectId), repo, verdict, work, mirror: layout(boot).mirror(repo.id) };
}

const authorOf = (l: Landing) => ({
  name: resolveSetting(l.db, "git.author_name", { projectId: l.project.id, repoId: l.repo.id }).value,
  email: resolveSetting(l.db, "git.author_email", { projectId: l.project.id, repoId: l.repo.id }).value,
});

type Squash = { kind: "squashed"; landed: Sha; trunk: Sha; message: string } | { kind: "conflict"; trunk: Sha } | { kind: "changed"; trunk: Sha; rebased: Sha };

// The verified head, rebased onto trunk and squashed into one commit with yagura's trailers.
async function squashOntoTrunk(l: Landing): Promise<Squash> {
  const author = authorOf(l);
  await ensureMirror(l.repo.url, l.mirror);
  const trunk = await resolveRef(l.mirror, `origin/${l.repo.defaultBranch}`);
  const wt = `${layout(l.boot).worktree(l.repo.id, l.project.id, l.unit.seq, 0)}.land`;
  mkdirSync(dirname(wt), { recursive: true });
  await removeWorktree(l.mirror, wt).catch(() => undefined);
  await addDetachedWorktree(l.mirror, wt, l.verdict.head_sha);
  try {
    if (trunk !== l.work.baseSha) {
      try {
        await git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "rebase", "--quiet", "--onto", trunk, l.work.baseSha!], { cwd: wt });
      } catch {
        await git(["rebase", "--abort"], { cwd: wt }).catch(() => undefined);
        return { kind: "conflict", trunk };
      }
    }
    const tree = await git(["rev-parse", "HEAD^{tree}"], { cwd: wt });
    const message = landMessage(l.db, l.boot, {
      unit: l.unit,
      work: l.work,
      verdict: { id: l.verdict.id, tier: l.verdict.tier, attemptId: l.verdict.attempt_id },
      url: resolveSetting(l.db, "yagura.url", { projectId: l.project.id, repoId: l.repo.id }).value,
    });
    const identity = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    const landed = (await gitWithEnv(["commit-tree", tree, "-p", trunk, "-F", "-"], wt, identity, message)) as Sha;
    if (!l.verdict.patch_id || (await patchId(wt, trunk, landed)) !== l.verdict.patch_id)
      return { kind: "changed", trunk, rebased: (await git(["rev-parse", "HEAD"], { cwd: wt })) as Sha };
    return { kind: "squashed", landed, trunk, message };
  } finally {
    await removeWorktree(l.mirror, wt).catch(() => undefined);
  }
}

function triageOrBlock(l: Landing, number: number, fresh: Parameters<typeof queueTriage>[3]): LandResult {
  const triage = queueTriage(l.db, l.unit, number, fresh);
  if (!triage) return block(l, `pull request #${number} has new review threads after ${MAX_TRIAGE_WAVES} triage waves; it needs you`);
  const reason = `${fresh.length} review thread(s) on pull request #${number}; triaging in U${triage.seq}`;
  if (l.unit.state === "landing") transitionUnit(l.db, l.unit.id, "blocked", { reason, reviewUnit: triage.seq });
  return { unit: getUnit(l.db, l.unit.id), outcome: "triaging", landedSha: null, reason };
}

function rebaseOrBlock(l: Landing, trunk: Sha, conflict: string): LandResult {
  const rebase = queueRebase(l.db, l.unit, trunk, conflict);
  if (!rebase) return block(l, `${conflict}; ${MAX_REBASES} rebases did not land it`);
  const reason = `${conflict}; rebasing in U${rebase.seq}`;
  transitionUnit(l.db, l.unit.id, "blocked", { reason, rebaseUnit: rebase.seq });
  return { unit: getUnit(l.db, l.unit.id), outcome: "rebasing", landedSha: null, reason };
}

// git and gh put the command first and the reason last.
const lastLine = (message: string) => message.trim().split("\n").filter(Boolean).at(-1) ?? message;

function block(l: Landing, reason: string): LandResult {
  transitionUnit(l.db, l.unit.id, "blocked", { reason });
  return { unit: getUnit(l.db, l.unit.id), outcome: "blocked", landedSha: null, reason };
}

async function reverify(l: Landing, onto: Sha, rebased: Sha): Promise<LandResult> {
  const { db } = l;
  const attempt = createAttempt(db, l.unit.id, REBASE_HARNESS, null);
  const branch = `${l.work.branch ?? `yg/${l.project.id}/u${l.unit.seq}`}-rebased-${attempt.n}`;
  await git(["update-ref", `refs/heads/${branch}`, rebased], { gitDir: l.mirror });
  const reason = `rebased onto ${l.repo.defaultBranch} at ${onto.slice(0, 10)} and the patch changed; the rebased head needs re-verification`;
  db.transaction(() => {
    updateAttempt(db, attempt.id, { state: "handed_off", baseSha: onto, headSha: rebased, branch, startedAt: now(), endedAt: now() });
    db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE id = ?").run(now(), reason, l.verdict.id);
    transitionUnit(db, l.unit.id, "verifying", { reason, rebasedHead: rebased });
    addVerifyUnit(db, getUnit(db, l.unit.id));
  })();
  return { unit: getUnit(db, l.unit.id), outcome: "reverifying", landedSha: null, reason };
}

// The verdict follows the code to the commit on trunk, as long as that commit's patch is the one verified.
function carryVerdict(l: Landing, sha: Sha, reason: string): void {
  const { db } = l;
  db.transaction(() => {
    db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE id = ?").run(now(), reason, l.verdict.id);
    db.prepare(
      `INSERT INTO verdicts (unit_id, attempt_id, tier, repo_id, head_sha, patch_id, dep_shas_json, artifact_versions_json, trunk_outcome, head_outcome, created_at)
       SELECT unit_id, attempt_id, tier, repo_id, ?, patch_id, dep_shas_json, artifact_versions_json, trunk_outcome, head_outcome, ? FROM verdicts WHERE id = ?`,
    ).run(sha, now(), l.verdict.id);
    db.prepare(
      "INSERT INTO verdict_artifacts (verdict_id, artifact_id) SELECT last_insert_rowid(), artifact_id FROM verdict_artifacts WHERE verdict_id = ?",
    ).run(l.verdict.id);
  })();
}

function markLanded(l: Landing, sha: Sha, data: Record<string, unknown>): void {
  setLandedSha(l.db, l.unit.id, sha);
  markPackProven(l.db, l.unit, sha);
  transitionUnit(l.db, l.unit.id, "landed", { sha, ...data });
  recordEvent(
    l.db,
    "unit.landed",
    { projectId: l.project.id, unitId: l.unit.id },
    { sha, branch: l.repo.defaultBranch, squashedFrom: l.verdict.head_sha, ...data },
  );
}

export async function landUnit(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId): Promise<LandResult> {
  const { db } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.state !== "verified") throw new Error(`U${unit.seq} is ${unit.state}, not verified`);
  const l = landing(ctx, unit);
  const busy = db.prepare("SELECT seq FROM units WHERE repo_id = ? AND state = 'landing' AND id <> ?").get(l.repo.id, unit.id) as { seq: number } | undefined;
  if (busy) throw new Error(`U${busy.seq} is already landing in ${l.repo.id}; one lander per repo`);

  transitionUnit(db, unit.id, "landing", { verdict: l.verdict.id });
  let forge: ForgeAdapter | null;
  try {
    forge = forgeFor(db, l.repo);
  } catch (e) {
    return block(l, (e as Error).message);
  }
  const squash = await squashOntoTrunk(l);
  if (squash.kind === "conflict") return rebaseOrBlock(l, squash.trunk, `conflicts with ${l.repo.defaultBranch} at ${squash.trunk.slice(0, 10)}`);
  if (squash.kind === "changed") return reverify(l, squash.trunk, squash.rebased);
  if (forge) return propose(l, forge, squash);

  carryVerdict(l, squash.landed, `landed as ${squash.landed}; patch-id unchanged, carried forward`);
  try {
    await git(["push", "--quiet", "origin", `${squash.landed}:refs/heads/${l.repo.defaultBranch}`], { gitDir: l.mirror });
  } catch (e) {
    return block(l, `push to ${l.repo.defaultBranch} was rejected: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  await ensureMirror(l.repo.url, l.mirror);
  const rebased = squash.trunk !== l.work.baseSha;
  markLanded(l, squash.landed, { onto: squash.trunk, rebased });
  return {
    unit: getUnit(db, unit.id),
    outcome: "landed",
    landedSha: squash.landed,
    reason: rebased ? "rebased onto the moved trunk and squashed; patch unchanged" : "squashed onto trunk",
  };
}

// One pull request per unit, on a branch yagura owns; pushing again updates it.
async function propose(l: Landing, forge: ForgeAdapter, squash: Extract<Squash, { kind: "squashed" }>): Promise<LandResult> {
  const { db } = l;
  const branch = `${resolveSetting(db, "git.branch_prefix", { projectId: l.project.id, repoId: l.repo.id }).value}/${l.project.id}/u${l.unit.seq}`;
  try {
    const push = () => git(["push", "--quiet", "--force", "origin", `${squash.landed}:refs/heads/${branch}`], { gitDir: l.mirror });
    // GitHub sometimes refuses a push for a moment; one retry separates that from a real rejection.
    await push().catch(async () => {
      await new Promise((r) => setTimeout(r, 2000));
      await push();
    });
    const existing = getMergeRequest(db, l.unit.id);
    const pr =
      (existing?.state === "open" ? { number: existing.number, url: existing.url } : null) ??
      (await forge.find(branch)) ??
      (await forge.open({ branch, base: l.repo.defaultBranch, title: l.unit.goal, body: squash.message }));
    saveMergeRequest(db, {
      unitId: l.unit.id,
      forge: forge.kind,
      forgeRepo: forge.repo,
      number: pr.number,
      url: pr.url,
      branch,
      headSha: squash.landed,
      baseSha: squash.trunk,
    });
    recordEvent(db, "pr.pushed", { projectId: l.project.id, unitId: l.unit.id }, { number: pr.number, url: pr.url, head: squash.landed, onto: squash.trunk });
    return { unit: getUnit(db, l.unit.id), outcome: "proposed", landedSha: null, reason: `pull request #${pr.number}: ${pr.url}` };
  } catch (e) {
    if (e instanceof ForgeError || (e as { code?: unknown }).code !== undefined)
      return block(l, `could not open the pull request: ${lastLine((e as Error).message)}`);
    throw e;
  }
}

export function mergeApproved(db: Db, project: Project, unit: Unit): boolean {
  if (project.mergePolicy === "auto") return true;
  const gate = listGates(db, project.id)
    .filter((g) => g.kind === "land" && g.unitId === unit.id)
    .at(-1);
  return !!gate && gateResolved(gate, "land");
}

async function finishMerged(l: Landing, status: PrStatus, number: number): Promise<LandResult> {
  const merged = status.mergedSha!;
  await ensureMirror(l.repo.url, l.mirror);
  const patch = await patchId(l.mirror, `${merged}^1` as Sha, merged);
  setMergeState(l.db, l.unit.id, "merged", l.project.id, { number, sha: merged });
  if (patch === l.verdict.patch_id) carryVerdict(l, merged, `merged as ${merged} (pull request #${number}); patch-id unchanged, carried forward`);
  else {
    const reason = `pull request #${number} merged as ${merged} with a patch other than the one verified; verdict not carried`;
    l.db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE id = ?").run(now(), reason, l.verdict.id);
    recordEvent(l.db, "pr.merged_unverified", { projectId: l.project.id, unitId: l.unit.id }, { number, sha: merged });
  }
  markLanded(l, merged, { pr: number });
  return { unit: getUnit(l.db, l.unit.id), outcome: "landed", landedSha: merged, reason: `pull request #${number} merged` };
}

// A first failure on a head may be flaky and gets one re-run; failing again on the same head is the code's fault,
// so the unit goes back to work with the failing logs, its next attempt resumes the worker, and the same pull request is updated.
async function ciFailed(l: Landing, forge: ForgeAdapter, number: number, head: Sha, failing: string[]): Promise<LandResult> {
  const { db } = l;
  const refs = { projectId: l.project.id, unitId: l.unit.id };
  const seen = (
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'pr.checks_failed' AND unit_id = ? AND json_extract(data_json, '$.head') = ?")
      .get(l.unit.id, head) as { n: number }
  ).n;
  const runs = await forge.failedRuns(head);
  if (!seen && runs.length) {
    for (const r of runs) await forge.rerunFailed(r.id);
    recordEvent(db, "pr.checks_failed", refs, { number, head, checks: failing, rerun: runs.map((r) => r.id) });
    return {
      unit: l.unit,
      outcome: "waiting",
      landedSha: null,
      reason: `checks failed on pull request #${number} (${failing.join(", ")}); re-running the failed jobs once in case they were flaky`,
    };
  }
  recordEvent(db, "pr.checks_failed", refs, { number, head, checks: failing, rerun: [] });
  const logs = runs.map((r) => `${r.name}:\n${r.log}`).join("\n\n");
  addUnitNote(
    db,
    l.unit.id,
    `CI failed on pull request #${number} (${failing.join(", ")})${seen ? " again after a re-run, so it is not flaky" : ""}.${logs ? `\n${logs}` : ""}`,
  );
  updateAttempt(db, l.work.id, { rejection: "code-fault" });
  const reason = `checks failed on pull request #${number}: ${failing.join(", ")}`;
  transitionUnit(db, l.unit.id, "blocked", { reason });
  const used = listAttempts(db, l.unit.id).filter(spendsAttempt).length;
  if (used >= l.unit.maxAttempts) return { unit: getUnit(db, l.unit.id), outcome: "blocked", landedSha: null, reason };
  transitionUnit(db, l.unit.id, "ready", { reason: "reworking after CI failed", attemptsUsed: used });
  return { unit: getUnit(db, l.unit.id), outcome: "rework", landedSha: null, reason };
}

// Deterministic babysitting: read the pull request, act on what changed, spend no tokens.
export async function watchMergeRequest(ctx: { db: Db; boot: Bootstrap }, unitId: UnitId): Promise<LandResult | null> {
  const { db } = ctx;
  const mr = getMergeRequest(db, unitId);
  if (!mr || mr.state !== "open") return null;
  const unit = getUnit(db, unitId);
  const repo = getRepo(db, unit.repoId!);
  const forge = forgeFor(db, repo);
  if (!forge) return null;
  const project = getProject(db, unit.projectId);
  if (unit.state === "abandoned") {
    await forge.close(mr.number, `yagura abandoned ${project.id}/U${unit.seq}, so this pull request will not be merged.`);
    setMergeState(db, unit.id, "closed", project.id, { number: mr.number, reason: "unit abandoned" });
    return null;
  }
  const status = await forge.status(mr.number);
  recordMergeStatus(db, unit.id, status);
  if (!["landing", "blocked"].includes(unit.state)) return null;
  const l = landing(ctx, unit);
  if (status.state === "merged") return finishMerged(l, status, mr.number);
  if (unit.state === "blocked" && listThreadRows(db, unit.id).some((r) => r.decision === "asked")) {
    const answered = freshThreads(db, unit.id, await forge.threads(mr.number)).filter((f) => f.directive);
    const open = listThreadRows(db, unit.id).filter((r) => r.decision === "asked").length;
    if (answered.length && answered.length >= open) return triageOrBlock(l, mr.number, answered);
    return null;
  }
  if (unit.state !== "landing") return null;
  if (status.state === "closed") {
    setMergeState(db, unit.id, "closed", project.id, { number: mr.number, reason: "closed on the forge" });
    return block(l, `pull request #${mr.number} was closed without merging`);
  }
  if (status.headSha !== mr.headSha) {
    // Right after a push the forge can still report a head yagura pushed earlier; only a head yagura never pushed is someone else's.
    const ours = db
      .prepare("SELECT 1 FROM events WHERE type = 'pr.pushed' AND unit_id = ? AND json_extract(data_json, '$.head') = ?")
      .get(unit.id, status.headSha);
    if (ours) return { unit, outcome: "waiting", landedSha: null, reason: `the forge still shows the earlier push ${status.headSha.slice(0, 10)}` };
    return block(l, `pull request #${mr.number}'s branch moved to ${status.headSha.slice(0, 10)} outside yagura`);
  }
  if (status.merge === "behind" || status.merge === "conflict") {
    const squash = await squashOntoTrunk(l);
    if (squash.kind === "conflict")
      return rebaseOrBlock(l, squash.trunk, `pull request #${mr.number} conflicts with ${repo.defaultBranch} at ${squash.trunk.slice(0, 10)}`);
    if (squash.kind === "changed") return reverify(l, squash.trunk, squash.rebased);
    return propose(l, forge, squash);
  }
  const fresh = freshThreads(db, unit.id, await forge.threads(mr.number));
  if (fresh.length) return triageOrBlock(l, mr.number, fresh);
  const waiting = (reason: string): LandResult => ({ unit, outcome: "waiting", landedSha: null, reason });
  const asking = listThreadRows(db, unit.id).filter((r) => r.decision === "asked");
  if (asking.length) return waiting(`waiting for your answer on ${asking.length} review thread(s)`);
  if (status.failing.length) return ciFailed(l, forge, mr.number, mr.headSha, status.failing);
  if (status.pending.length) return waiting(`checks running: ${status.pending.join(", ")}`);
  if (status.merge !== "clean") return waiting(`the forge says ${status.merge}`);
  if (!mergeApproved(db, project, unit)) return waiting("waiting for the land gate");
  await forge.merge(mr.number, mr.headSha, resolveSetting(db, "forge.merge_method", { repoId: repo.id }).value);
  const after = await forge.status(mr.number);
  recordMergeStatus(db, unit.id, after);
  return after.state === "merged" ? finishMerged(l, after, mr.number) : waiting("merge requested");
}
