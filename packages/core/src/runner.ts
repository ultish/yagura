import { promptPlugin, standingFor } from "./prompts.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { attemptRecorder, runAgentSession, stopRequested, write, type RunContext } from "./agent.js";
import { WORKER_REPORT, renderBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import { isBuild, type Attempt, type EnvironmentId, type ProjectId, type RenderedBrief, type RepoId, type Sha, type Unit, type UnitId } from "./domain.js";
import { chooseResume, renderResumePrompt, sendBackReason } from "./resume.js";
import { requiredProjectSkills, skillMethod } from "./skills.js";
import { environmentNotes, listValues, valueMap } from "./envvalues.js";
import { addDetachedWorktree, addedLines, addWorktree, changedPaths, discardLeftovers, ensureMirror, headSha, resolveRef } from "./git.js";
import { classifyFailure, ensureRecorded, reportOf, savedHandoff, sessionReport, syntheticFailureHandoff } from "./finish.js";
import { layout, unitRef } from "./paths.js";
import { failurePolicy } from "./schedule.js";
import {
  getEnvironment,
  addUnit,
  addUnitNote,
  createAttempt,
  getAttempt,
  getProject,
  getRepo,
  getUnit,
  listAttempts,
  now,
  recordEvent,
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

export async function runWorkUnit(ctx: RunContext, unitId: UnitId): Promise<Attempt> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (!isBuild(unit)) throw new Error(`U${unit.seq} is a ${unit.type} unit; use the runner for its type`);
  if (unit.state !== "waiting") throw new Error(`U${unit.seq} is ${unit.state}, not waiting`);
  if (!unit.repoId) throw new Error(`U${unit.seq} has no repo`);

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
  const choice = chooseResume(listAttempts(db, unit.id), {
    enabled: setting("work.resume_on_rejection"),
    canResume: adapter.canResume,
    maxContext: setting("work.resume_max_context"),
  });
  const from = choice.resume && existsSync(choice.resume.worktreePath!) ? choice.resume : null;
  const fresh = choice.fresh ?? (choice.resume && !from ? `attempt ${choice.resume.n}'s worktree is gone` : null);

  const attempt = createAttempt(db, unit.id, harnessId, setting("role.worker.model"));
  const refs = { projectId: project.id, unitId: unit.id, attemptId: attempt.id };
  if (fresh) recordEvent(db, "attempt.fresh", refs, { reason: fresh });
  const base = from ? from.baseSha! : await resolveRef(mirror, `origin/${unit.base ?? repo.defaultBranch}`);
  const branch = from ? from.branch! : `${setting("git.branch_prefix")}/${project.id}/${unitRef(unit.seq)}-${attempt.n}`;
  const worktree = from ? from.worktreePath! : paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  if (!from) {
    mkdirSync(dirname(worktree), { recursive: true });
    await addWorktree(mirror, worktree, branch, base);
  }

  const projectSkills = requiredProjectSkills(db, unit);
  const references = await referenceCheckouts(ctx, project.id, unit.seq, from?.n ?? attempt.n, setting("project.reference_repos"));
  const envValues = valueMap(db, project.environmentId);
  const brief: RenderedBrief = {
    goal: unit.goal,
    repo: { id: repo.id, worktree, branch, baseSha: base },
    context: [
      ...unit.context,
      ...unit.notes.map((n) => `Note from an earlier attempt: ${n}`),
      ...(environmentNotes(db, project.environmentId) ? [`About this environment: ${environmentNotes(db, project.environmentId)}`] : []),
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
    forbidden: ["no git push, rebase, merge, or branch switching"],
    method:
      `Load the yagura-worker skill first and follow it. Then load pstack:poteto-mode with the Skill tool and follow its ${unit.playbook ?? "feature"} playbook. Then load pstack:principle-prove-it-works and pstack:principle-test-behavior-not-implementation, and write the test that proves the change before the change itself. All four are required: an attempt that does not load them is rejected.` +
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
        why: sendBackReason(unit),
        timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
        report: WORKER_REPORT,
      })
    : renderBrief(brief);
  write(paths.brief(project.id, unit.seq, attempt.n), briefText);

  const startedAt = now();
  transitionUnit(db, unit.id, "building", { attempt: attempt.n, ...(from ? { resumes: from.n } : {}) });
  setUnitBranch(db, unit.id, branch);
  updateAttempt(db, attempt.id, { state: "running", startedAt, worktreePath: worktree, branch, baseSha: base, resumesAttemptId: from?.id ?? null });

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
      },
      cwd: worktree,
      env: envValues,
      timeboxSeconds: unit.timeboxSeconds,
      logPath: reminder ? paths.log(project.id, unit.seq, attempt.n).replace(/\.jsonl$/, ".resume.jsonl") : paths.log(project.id, unit.seq, attempt.n),
    });
  const first = await work(briefText, from?.sessionId ?? undefined);
  let session = first;
  const endedAt = now();

  const stop = stopRequested(db, attempt.id);
  if (stop.stopped) {
    await discardLeftovers(worktree);
    updateAttempt(db, attempt.id, { state: "stopped", endedAt, exitCode: first.exitCode });
    if (stop.note) addUnitNote(db, unit.id, `Operator stopped attempt ${attempt.n}: ${stop.note}`);
    transitionUnit(db, unit.id, "waiting", { reason: "stopped by operator", attempt: attempt.n });
    recordEvent(db, "attempt.ended", { projectId: project.id, unitId: unit.id, attemptId: attempt.id }, { stopped: true });
    return getAttempt(db, attempt.id);
  }

  if (from && !getAttempt(db, attempt.id).sessionId) {
    const reason = `resuming attempt ${from.n}'s session failed to start: ${session.final?.text || session.stderrTail.trim() || `exit ${session.exitCode}`}`;
    updateAttempt(db, attempt.id, { state: "failed", endedAt, exitCode: session.exitCode, failureMode: "harness-error" });
    recordEvent(db, "attempt.resume_failed", refs, { reason });
    transitionUnit(db, unit.id, "waiting", { reason, attempt: attempt.n });
    return runWorkUnit(ctx, unitId);
  }

  // The handoff comes from what the agent recorded with yagura handoff; a clean session that recorded nothing is asked once.
  session = await ensureRecorded(db, attempt.id, role, first, (prompt, sessionId) => work(prompt, sessionId, true));
  const leftovers = await discardLeftovers(worktree);
  if (leftovers.paths.length) write(paths.leftovers(project.id, unit.seq, attempt.n), leftovers.patch);
  const head = await headSha(worktree);
  const touched = await changedPaths(worktree, base);
  const final = session.final;
  const report = sessionReport(first, session);
  const handoff = savedHandoff(db, attempt.id);

  if (handoff) {
    write(paths.handoff(project.id, unit.seq, attempt.n), report ?? "");
    db.prepare("INSERT INTO search (body, kind, ref_id, project_id) VALUES (?, 'handoff', ?, ?)").run(report ?? "", String(attempt.id), project.id);
    updateAttempt(db, attempt.id, { state: "handed_off", endedAt, exitCode: session.exitCode, headSha: head, handoffStatus: handoff.status });
    if (handoff.status === "stuck") {
      transitionUnit(db, unit.id, "stuck", { attempt: attempt.n, reason: handoff.reason ?? "the worker said it is stuck" });
    } else if (head === base) {
      transitionUnit(db, unit.id, "stuck", { attempt: attempt.n, reason: "handed off done with no commits" });
    } else if (session.missingSkills.length && setting("method.enforce_required_skills")) {
      addUnitNote(
        db,
        unit.id,
        `Attempt ${attempt.n} skipped required skills (${session.missingSkills.join(", ")}). Load each of them with the Skill tool before doing any work.`,
      );
      transitionUnit(db, unit.id, "stuck", { attempt: attempt.n, reason: "skipped required skills", missing: session.missingSkills });
    } else {
      transitionUnit(db, unit.id, "judging", { attempt: attempt.n, head, leftovers: leftovers.paths });
    }
  } else {
    const facts = {
      timedOut: session.timedOut,
      exitCode: session.exitCode,
      signal: session.signal,
      finalText: final?.text ?? null,
      finalIsError: final?.isError ?? true,
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
  }
  recordEvent(db, "attempt.ended", refs, { exit: session.exitCode, signal: session.signal, timedOut: session.timedOut, touched });
  return getAttempt(db, attempt.id);
}
