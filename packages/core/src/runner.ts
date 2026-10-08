import { promptPlugin, standingFor } from "./prompts.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { attemptRecorder, runAgentSession, stopRequested, write, type RunContext } from "./agent.js";
import { closesIssues, commitSubject, pullRequestBody } from "./audit.js";
import { WORKER_REPORT, renderBrief } from "./brief.js";
import { checkoutUnit, commitBaseMerge, createUnitBranch, mergeWithBase, publishBranch, pushCheckout, syncCheckout, unitBranch } from "./branch.js";
import { resolveSetting } from "./config.js";
import { isBuild, type Attempt, type EnvironmentId, type ProjectId, type RenderedBrief, type RepoId, type Sha, type Unit, type UnitId } from "./domain.js";
import { environmentNotes, listValues, valueMap } from "./envvalues.js";
import { classifyFailure, ensureRecorded, savedHandoff, sessionReport, syntheticFailureHandoff } from "./finish.js";
import { forgeFor, getMergeRequest, saveMergeRequest } from "./forge.js";
import { addDetachedWorktree, discardLeftovers, ensureMirror, git, headSha, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { describeRecords } from "./records.js";
import { installRelay, PUSH_BRANCH_VAR } from "./relay.js";
import { chooseResume, renderResumePrompt, roundText, type WorkerRound } from "./resume.js";
import { failurePolicy } from "./schedule.js";
import { requiredProjectSkills, skillMethod } from "./skills.js";
import {
  addUnitNote,
  createAttempt,
  getAttempt,
  getProject,
  getRepo,
  getUnit,
  lastTransition,
  listAttempts,
  now,
  recordEvent,
  setApprovedSha,
  setUnitBranch,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";

export type { RunContext } from "./agent.js";

// Read-only trunk checkouts of repos that already do it right; a resumed attempt keeps the paths its session saw.
async function referenceCheckouts(ctx: RunContext, projectId: ProjectId, seq: number, n: number, repoIds: string[]) {
  const out: { repoId: RepoId; path: string; sha: Sha }[] = [];
  for (const id of repoIds) {
    const ref = getRepo(ctx.db, id as RepoId);
    const mirror = layout(ctx.boot).mirror(ref.id);
    await ensureMirror(ref.url, mirror);
    const sha = await resolveRef(mirror, `origin/${ref.defaultBranch}`);
    const path = `${layout(ctx.boot).worktree(ref.id, projectId, seq, n)}.reference`;
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      await addDetachedWorktree(mirror, path, sha);
    }
    out.push({ repoId: ref.id, path, sha: (await headSha(path)) as Sha });
  }
  return out;
}

// The round the unit is building for, carried by the move that put it in building.
export function currentRound(db: Db, unitId: UnitId): WorkerRound {
  const round = lastTransition(db, unitId)?.data.round as WorkerRound | undefined;
  if (round) return round;
  return listAttempts(db, unitId).some((a) => a.role === "worker") ? { kind: "fresh", reason: "the earlier worker stopped" } : { kind: "first" };
}

// The worker attempt that already handed off in this round, when yagura stopped before acting on it.
function handedOffThisRound(db: Db, unitId: UnitId): Attempt | null {
  const since = lastTransition(db, unitId)?.ts ?? "";
  const last = listAttempts(db, unitId)
    .filter((a) => a.role === "worker")
    .at(-1);
  return last && last.state === "handed_off" && (last.startedAt ?? "") >= since ? last : null;
}

const baseOf = (db: Db, unit: Unit) => unit.base ?? getRepo(db, unit.repoId!).defaultBranch;

// One worker round of a building unit, then what yagura does with its hand-off. Run again after a crash, it picks up where it stopped.
export async function runWorkerRound(ctx: RunContext, unitId: UnitId): Promise<void> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (!isBuild(unit)) throw new Error(`U${unit.seq} is a ${unit.type} unit`);
  if (unit.state !== "building") throw new Error(`U${unit.seq} is ${unit.state}, not building`);
  const done = handedOffThisRound(db, unitId);
  if (done) return afterHandoff(ctx, unit, done);

  const project = getProject(db, unit.projectId);
  const repo = getRepo(db, unit.repoId!);
  const sctx = { projectId: project.id, repoId: repo.id };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.worker.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);

  const mirror = paths.mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  installRelay(mirror);
  const base = baseOf(db, unit);
  const branch = unitBranch(setting("git.branch_prefix"), project.id, unit.seq);
  const start = await createUnitBranch(mirror, branch, base);
  setUnitBranch(db, unit.id, branch);
  const checkout = paths.checkout(repo.id, project.id, unit.seq);
  if (existsSync(checkout)) await syncCheckout(checkout, branch);
  else {
    mkdirSync(dirname(checkout), { recursive: true });
    await checkoutUnit(mirror, checkout, branch);
  }

  const round = currentRound(db, unitId);
  const choice =
    round.kind === "changes" || round.kind === "conflict" || round.kind === "lead"
      ? chooseResume(listAttempts(db, unit.id), {
          enabled: setting("work.resume_on_rejection"),
          canResume: adapter.canResume,
          maxContext: setting("work.resume_max_context"),
        })
      : { resume: null, fresh: null };
  const from = choice.resume;
  const attempt = createAttempt(db, unit.id, harnessId, setting("role.worker.model"));
  const refs = { projectId: project.id, unitId: unit.id, attemptId: attempt.id };
  if (choice.fresh) recordEvent(db, "attempt.fresh", refs, { reason: choice.fresh });

  const earlier = listAttempts(db, unit.id).filter((a) => a.role === "worker" && a.state === "handed_off");
  const projectSkills = requiredProjectSkills(db, unit);
  const references = await referenceCheckouts(ctx, project.id, unit.seq, attempt.n, setting("project.reference_repos"));
  const envValues = valueMap(db, project.environmentId);
  const brief: RenderedBrief = {
    goal: unit.goal,
    repo: { id: repo.id, worktree: checkout, branch, baseSha: start },
    context: [
      ...unit.context,
      ...unit.notes.map((n) => `Note: ${n}`),
      ...(environmentNotes(db, project.environmentId) ? [`About this environment: ${environmentNotes(db, project.environmentId)}`] : []),
      ...(round.kind === "first" ? [] : [roundText(round)]),
      ...earlier.map((a) => `What worker A${a.agentNo} recorded:\n${describeRecords(db, a.id) ?? "(nothing)"}`),
    ],
    readonly: references.map((r) => ({ repoId: r.repoId, path: r.path, sha: r.sha })),
    acceptance: unit.acceptance,
    test: resolveSetting(db, "test.command", { ...sctx, environmentId: project.environmentId }).value,
    env: envValues,
    envNotes: Object.fromEntries(
      listValues(db, project.environmentId as EnvironmentId)
        .map((v) => [v.name, v.note])
        .filter(([, n]) => n),
    ),
    timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
    forbidden: [
      `pushing any branch but ${branch}, force-pushing, or rebasing: merge instead`,
      "opening, readying, merging, or closing a pull request: yagura does that",
    ],
    method:
      `Load the yagura-worker skill first and follow it. Then load pstack:poteto-mode with the Skill tool and follow its ${unit.playbook ?? "feature"} playbook. Then load pstack:principle-prove-it-works and pstack:principle-test-behavior-not-implementation, and write the test that proves the change before the change itself. All four are required: an attempt that does not load them is sent back.` +
      (unit.scaffold ? " This is a scaffold unit: build the new project's skeleton the way the project skills below say, and nothing more." : "") +
      skillMethod(projectSkills),
    report: WORKER_REPORT,
    standing: standingFor(db, project.id, "worker"),
  };
  const briefText = from
    ? renderResumePrompt({
        unit: `${project.id}/U${unit.seq}`,
        attempt: attempt.n,
        resumes: from.n,
        branch,
        round,
        timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
        report: WORKER_REPORT,
      })
    : renderBrief(brief);
  write(paths.brief(project.id, unit.seq, attempt.n), briefText);

  const startedAt = now();
  updateAttempt(db, attempt.id, {
    state: "running",
    startedAt,
    worktreePath: checkout,
    branch,
    baseSha: start,
    resumesAttemptId: from?.id ?? null,
  });

  const role = "worker";
  const work = (prompt: string, resume: string | undefined, reminder = false) =>
    runAgentSession(ctx, {
      recorder: attemptRecorder(db, {
        attempt,
        unit,
        projectId: project.id,
        role,
        inheritedSkills: reminder ? getAttempt(db, attempt.id).skills : from?.skills,
        projectSkills,
      }),
      adapter,
      run: {
        prompt,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.worker.model"),
        permissionMode: setting("harness.claude.permission_mode"),
        pluginDirs: [promptPlugin(db, boot, project.id, { attemptId: attempt.id, role })],
        addDirs: references.map((r) => r.path),
        extraArgs: setting("harness.claude.extra_args"),
        resume,
        pushes: true,
      },
      cwd: checkout,
      env: { ...envValues, [PUSH_BRANCH_VAR]: branch },
      timeboxSeconds: unit.timeboxSeconds,
      logPath: reminder ? paths.log(project.id, unit.seq, attempt.n).replace(/\.jsonl$/, ".resume.jsonl") : paths.log(project.id, unit.seq, attempt.n),
    });
  const first = await work(briefText, from?.sessionId ?? undefined);
  const endedAt = now();

  const stop = stopRequested(db, attempt.id);
  if (stop.stopped) {
    await discardLeftovers(checkout);
    updateAttempt(db, attempt.id, { state: "stopped", endedAt, exitCode: first.exitCode });
    if (stop.note) addUnitNote(db, unit.id, `The developer stopped attempt ${attempt.n}: ${stop.note}`);
    transitionUnit(db, unit.id, "waiting", { reason: "stopped by the developer", attempt: attempt.n });
    recordEvent(db, "attempt.ended", refs, { stopped: true });
    return;
  }

  // The handoff comes from what the agent recorded with yagura handoff; a clean session that recorded nothing is asked once.
  const session = await ensureRecorded(db, attempt.id, role, first, (prompt, sessionId) => work(prompt, sessionId, true));
  const leftovers = await discardLeftovers(checkout);
  if (leftovers.paths.length) write(paths.leftovers(project.id, unit.seq, attempt.n), leftovers.patch);
  const head = (await headSha(checkout)) as Sha;
  const report = sessionReport(first, session);
  const handoff = savedHandoff(db, attempt.id);
  recordEvent(db, "attempt.ended", refs, { exit: session.exitCode, signal: session.signal, timedOut: session.timedOut, leftovers: leftovers.paths });

  if (!handoff) {
    const facts = {
      timedOut: session.timedOut,
      exitCode: session.exitCode,
      signal: session.signal,
      finalText: session.final?.text ?? null,
      finalIsError: session.final?.isError ?? true,
      stderrTail: session.stderrTail,
    };
    const mode = classifyFailure(facts);
    write(
      paths.handoff(project.id, unit.seq, attempt.n),
      syntheticFailureHandoff({
        unit: `${project.id}/U${unit.seq}`,
        attempt: attempt.n,
        mode,
        branch,
        startedAt,
        endedAt,
        lastActivity: session.lastActivity,
        facts,
      }),
    );
    updateAttempt(db, attempt.id, { state: "failed", endedAt, exitCode: session.exitCode, headSha: head, failureMode: mode });
    const policy = failurePolicy(getUnit(db, unit.id), listAttempts(db, unit.id));
    transitionUnit(db, unit.id, policy.action === "retry" ? "waiting" : "stuck", { attempt: attempt.n, mode, reason: policy.reason });
    return;
  }

  write(paths.handoff(project.id, unit.seq, attempt.n), report ?? "");
  db.prepare("INSERT INTO search (body, kind, ref_id, project_id) VALUES (?, 'handoff', ?, ?)").run(report ?? "", String(attempt.id), project.id);
  updateAttempt(db, attempt.id, { state: "handed_off", endedAt, exitCode: session.exitCode, headSha: head, handoffStatus: handoff.status });
  if (handoff.status === "stuck")
    return transitionUnit(db, unit.id, "stuck", {
      attempt: attempt.n,
      reason: handoff.reason ?? "the worker said it is stuck",
      trigger: round.kind === "conflict" ? "conflict" : "worker-stuck",
    });
  if (session.missingSkills.length && setting("method.enforce_required_skills")) {
    addUnitNote(
      db,
      unit.id,
      `Attempt ${attempt.n} skipped required skills (${session.missingSkills.join(", ")}). Load each of them with the Skill tool first.`,
    );
    return transitionUnit(db, unit.id, "stuck", { attempt: attempt.n, reason: "skipped required skills", missing: session.missingSkills });
  }
  return afterHandoff(ctx, getUnit(db, unit.id), getAttempt(db, attempt.id));
}

// After a worker hands off done: yagura pushes the branch, keeps its draft pull request current, and makes sure it merges with
// its base before the judge looks; a conflict goes straight back to the worker.
async function afterHandoff(ctx: RunContext, unit: Unit, attempt: Attempt): Promise<void> {
  const { db, boot } = ctx;
  const project = getProject(db, unit.projectId);
  const repo = getRepo(db, unit.repoId!);
  const mirror = layout(boot).mirror(repo.id);
  const branch = unit.branch!;
  const base = baseOf(db, unit);
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, { projectId: project.id, repoId: repo.id }).value;
  const refused = await pushCheckout(attempt.worktreePath!, branch);
  if (refused) return transitionUnit(db, unit.id, "stuck", { attempt: attempt.n, reason: `yagura could not push the branch: ${refused}` });
  await publishBranch(mirror, branch);

  await ensureMirror(repo.url, mirror);
  let head = await resolveRef(mirror, `refs/heads/${branch}`);
  const baseSha = await resolveRef(mirror, `refs/remotes/origin/${base}`);
  const own = await git(["merge-base", "--is-ancestor", head, baseSha], { gitDir: mirror }).then(
    () => false,
    () => true,
  );
  if (!own) return transitionUnit(db, unit.id, "stuck", { attempt: attempt.n, reason: "the worker handed off done with no commits of its own" });

  await openOrUpdateDraft(ctx, unit, head, baseSha);
  const merge = await mergeWithBase(mirror, head, baseSha);
  if (merge.kind === "conflict")
    return transitionUnit(db, unit.id, "building", {
      attempt: attempt.n,
      round: { kind: "conflict", base, baseSha, files: merge.files } satisfies WorkerRound,
    });
  if (merge.kind === "clean") {
    head = await commitBaseMerge(mirror, branch, merge, `Merge ${base} into ${branch}`, {
      name: setting("git.author_name"),
      email: setting("git.author_email"),
    });
    recordEvent(db, "unit.base_merged", { projectId: project.id, unitId: unit.id }, { base: merge.base, head });
  }
  updateAttempt(db, attempt.id, { headSha: head });
  setApprovedSha(db, unit.id, null);
  transitionUnit(db, unit.id, "judging", { attempt: attempt.n, head });
}

// The unit's draft pull request, opened at its first hand-off and kept current after; a repo without a forge has none.
export async function openOrUpdateDraft(ctx: RunContext, unit: Unit, head: Sha, baseSha: Sha): Promise<void> {
  const { db } = ctx;
  const repo = getRepo(db, unit.repoId!);
  const forge = forgeFor(db, repo);
  if (!forge) return;
  const project = getProject(db, unit.projectId);
  const body = pullRequestBody(project, unit, resolveSetting(db, "yagura.url").value);
  const existing = getMergeRequest(db, unit.id);
  const pr = existing ?? (await forge.openDraft({ branch: unit.branch!, base: baseOf(db, unit), title: commitSubject(unit.goal), body }));
  if (existing) await forge.updateBody(existing.number, body);
  else recordEvent(db, "pr.opened", { projectId: project.id, unitId: unit.id }, { number: pr.number, url: pr.url, closes: closesIssues(unit) });
  saveMergeRequest(db, {
    unitId: unit.id,
    forge: repo.forge,
    forgeRepo: forge.repo,
    number: pr.number,
    url: pr.url,
    branch: unit.branch!,
    headSha: head,
    baseSha,
  });
}
