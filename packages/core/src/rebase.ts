import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { attemptRecorder, runAgentSession, write, type RunContext } from "./agent.js";
import { HANDOFF_TEMPLATE, renderBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import { REBASE_HARNESS, type Attempt, type Sha, type Unit, type UnitId } from "./domain.js";
import { valueMap } from "./envvalues.js";
import { addWorktree, changedPaths, discardLeftovers, ensureMirror, git, headSha, resolveRef } from "./git.js";
import { parseHandoff } from "./handoff.js";
import { liveVerdict } from "./land.js";
import { layout, unitRef } from "./paths.js";
import { addVerifyUnit } from "./runner.js";
import { checkScope } from "./scope.js";
import { addUnit, createAttempt, getAttempt, getProject, getRepo, getUnit, now, recordEvent, transitionUnit, updateAttempt, type Db } from "./store.js";

export const MAX_REBASES = 2;

// A conflicting verified unit waits blocked while a rebase unit moves its change onto trunk; after MAX_REBASES it stays blocked for the planner.
export function queueRebase(db: Db, target: Unit, trunk: Sha, conflict: string): Unit | null {
  const earlier = db.prepare("SELECT COUNT(*) AS n FROM units WHERE type = 'rebase' AND target_unit_id = ?").get(target.id) as { n: number };
  if (earlier.n >= MAX_REBASES) return null;
  const repo = getRepo(db, target.repoId!);
  const unit = addUnit(db, {
    projectId: target.projectId,
    type: "rebase",
    repoId: target.repoId,
    targetUnitId: target.id,
    goal: `Rebase U${target.seq} onto ${repo.defaultBranch} at ${trunk}: ${target.goal}`,
    writeScope: target.writeScope,
    forbidScope: target.forbidScope,
    acceptance: target.acceptance,
    verify: target.verify,
    context: [conflict, ...target.context],
    timeboxSeconds: resolveSetting(db, "timebox.work_seconds", { projectId: target.projectId, repoId: target.repoId! }).value,
    maxAttempts: 1,
  });
  transitionUnit(db, unit.id, "ready", { target: target.seq });
  return getUnit(db, unit.id);
}

export async function runRebaseUnit(ctx: RunContext, unitId: UnitId): Promise<Attempt> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.type !== "rebase" || !unit.targetUnitId || !unit.repoId) throw new Error(`U${unit.seq} is not a rebase unit`);
  if (unit.state !== "ready") throw new Error(`U${unit.seq} is ${unit.state}, not ready`);
  const target = getUnit(db, unit.targetUnitId);
  const verdict = liveVerdict(db, target.id);
  if (!verdict) throw new Error(`U${target.seq} has no live verdict to rebase`);
  const project = getProject(db, unit.projectId);
  const repo = getRepo(db, unit.repoId);
  const sctx = { projectId: project.id, repoId: repo.id };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.worker.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);
  const mirror = paths.mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const trunk = (/ at ([0-9a-f]{40}):/.exec(unit.goal)?.[1] as Sha | undefined) ?? (await resolveRef(mirror, `origin/${repo.defaultBranch}`));

  const attempt = createAttempt(db, unit.id, harnessId, setting("role.worker.model"));
  const branch = `${setting("git.branch_prefix")}/${project.id}/${unitRef(target.seq)}-rebase-${unitRef(unit.seq)}`;
  const worktree = paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  mkdirSync(dirname(worktree), { recursive: true });
  await addWorktree(mirror, worktree, branch, verdict.head_sha);
  const envValues = valueMap(db, project.environmentId);
  const standingPath = paths.standingOrders(project.id);
  const briefText = renderBrief({
    goal: `Rebase this branch onto ${repo.defaultBranch} at ${trunk} (run \`git rebase ${trunk}\`) and resolve the conflicts so both trunk's changes and this branch's change (U${target.seq}: ${target.goal}) survive. Change nothing else.`,
    repo: { id: repo.id, worktree, branch, baseSha: verdict.head_sha },
    scope: { write: target.writeScope, forbid: [...target.forbidScope, `${repo.verifyPackPath}/**`] },
    context: unit.context,
    readonly: [],
    acceptance: target.acceptance,
    verify: target.verify ?? "(none)",
    env: envValues,
    timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
    forbidden: [
      "no git push, merge, or branch switching; the only rebase is onto the commit in GOAL",
      "nothing outside SCOPE",
      "no change beyond resolving the conflicts",
    ],
    method: "Load the yagura-rebase skill first and follow it. Then use cursor-team-kit:fix-merge-conflicts to resolve the conflicts.",
    report: HANDOFF_TEMPLATE,
    standing: existsSync(standingPath) ? readFileSync(standingPath, "utf8") : "",
  });
  write(paths.brief(project.id, unit.seq, attempt.n), briefText);
  transitionUnit(db, unit.id, "running", { attempt: attempt.n, target: target.seq });
  updateAttempt(db, attempt.id, { state: "running", startedAt: now(), worktreePath: worktree, branch, baseSha: verdict.head_sha });

  const session = await runAgentSession(ctx, {
    recorder: attemptRecorder(db, { attempt, unit, projectId: project.id, role: "rebase" }),
    adapter,
    run: {
      prompt: briefText,
      bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
      model: setting("role.worker.model"),
      permissionMode: setting("harness.claude.permission_mode"),
      pluginDirs: [boot.skillsDir],
      addDirs: [],
      extraArgs: setting("harness.claude.extra_args"),
    },
    cwd: worktree,
    env: envValues,
    timeboxSeconds: unit.timeboxSeconds,
    logPath: paths.log(project.id, unit.seq, attempt.n),
  });

  await git(["rebase", "--abort"], { cwd: worktree }).catch(() => undefined);
  await discardLeftovers(worktree);
  const head = await headSha(worktree);
  const final = session.final;
  const handoff = final && !final.isError && !session.timedOut ? parseHandoff(final.text) : null;
  if (handoff) write(paths.handoff(project.id, unit.seq, attempt.n), final!.text);
  const onTrunk = await git(["merge-base", "--is-ancestor", trunk, head], { cwd: worktree }).then(
    () => true,
    () => false,
  );
  const violations = checkScope(await changedPaths(worktree, trunk), target.writeScope, [...target.forbidScope, `${repo.verifyPackPath}/**`]);
  const problem = !handoff
    ? "the rebase agent ended without a handoff"
    : handoff.status !== "success"
      ? `the rebase agent reported ${handoff.status}`
      : !onTrunk
        ? `the branch is not on ${repo.defaultBranch} at ${trunk.slice(0, 10)}`
        : violations.length
          ? `the rebase touched paths outside U${target.seq}'s scope: ${violations.map((v) => v.path).join(", ")}`
          : null;
  updateAttempt(db, attempt.id, {
    state: handoff ? "handed_off" : "failed",
    endedAt: now(),
    exitCode: session.exitCode,
    headSha: head,
    handoffStatus: handoff?.status ?? null,
    ...(handoff ? {} : { failureMode: "unknown" as const }),
  });
  const refs = { projectId: project.id, unitId: unit.id, attemptId: attempt.id };
  if (problem) {
    transitionUnit(db, unit.id, handoff ? "handed_off" : "failed", { reason: problem });
    transitionUnit(db, unit.id, "blocked", { reason: problem });
    recordEvent(db, "rebase.failed", refs, { target: target.seq, reason: problem });
    return getAttempt(db, attempt.id);
  }

  // The rebased head is the target's to verify: an attempt yagura records for it, which costs the target no try.
  const reason = `rebased onto ${repo.defaultBranch} at ${trunk.slice(0, 10)} by U${unit.seq}; the rebased head needs verification`;
  db.transaction(() => {
    const onTarget = createAttempt(db, target.id, REBASE_HARNESS, null);
    updateAttempt(db, onTarget.id, { state: "handed_off", baseSha: trunk, headSha: head, branch, startedAt: now(), endedAt: now() });
    db.prepare("UPDATE verdicts SET voided_at = ?, void_reason = ? WHERE id = ?").run(now(), reason, verdict.id);
    transitionUnit(db, unit.id, "handed_off", { head });
    transitionUnit(db, unit.id, "done");
    transitionUnit(db, target.id, "verifying", { reason, rebasedHead: head, rebaseUnit: unit.seq });
    addVerifyUnit(db, getUnit(db, target.id));
  })();
  recordEvent(db, "rebase.done", refs, { target: target.seq, head, onto: trunk });
  return getAttempt(db, attempt.id);
}
