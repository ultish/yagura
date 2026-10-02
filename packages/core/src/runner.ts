import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { attemptRecorder, runAgentSession, stopRequested, write, type RunContext } from "./agent.js";
import { HANDOFF_TEMPLATE, packContract, renderBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import {
  isBuild,
  type Attempt,
  type EnvironmentId,
  type ProjectId,
  type Rejection,
  type RenderedBrief,
  type RepoId,
  type Sha,
  type Unit,
  type UnitId,
} from "./domain.js";
import { chooseResume, rejectionFindings, renderResumePrompt } from "./resume.js";
import { requiredProjectSkills, skillMethod } from "./skills.js";
import { mountSources, sourceEnv } from "./sources.js";
import { environmentNotes, listValues, valueMap } from "./envvalues.js";
import { LEASE_VARS } from "./leases.js";
import { addDetachedWorktree, addedLines, addWorktree, changedPaths, discardLeftovers, ensureMirror, headSha, mergesCleanly, resolveRef } from "./git.js";
import { classifyFailure, parseHandoff, syntheticFailureHandoff } from "./handoff.js";
import { layout, unitRef } from "./paths.js";
import { assessScope } from "./scope.js";
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
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";

export type { RunContext } from "./agent.js";

export function addVerifyUnit(db: Db, target: Unit): Unit {
  const verify = addUnit(db, {
    projectId: target.projectId,
    type: "verify",
    repoId: target.repoId,
    targetUnitId: target.id,
    goal: `Verify U${target.seq}: ${target.goal}`,
    writeScope: [],
    acceptance: target.acceptance,
    verify: target.verify,
    timeboxSeconds: resolveSetting(db, "timebox.verify_seconds", {
      projectId: target.projectId,
      repoId: target.repoId,
      environmentId: getProject(db, target.projectId).environmentId,
    }).value,
    maxAttempts: 1,
  });
  transitionUnit(db, verify.id, "ready");
  return getUnit(db, verify.id);
}

export function queueVerification(db: Db, target: Unit): Unit {
  const verify = addVerifyUnit(db, target);
  transitionUnit(db, target.id, "verifying", { verifyUnit: verify.seq });
  return verify;
}

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
  const isPack = unit.type === "pack";
  if (unit.state !== "ready") throw new Error(`U${unit.seq} is ${unit.state}, not ready`);
  if (!unit.repoId || !unit.verify) throw new Error(`U${unit.seq} has no repo or verify recipe`);

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
  const base = from ? from.baseSha! : await resolveRef(mirror, `origin/${repo.defaultBranch}`);
  const branch = from ? from.branch! : `${setting("git.branch_prefix")}/${project.id}/${unitRef(unit.seq)}-${attempt.n}`;
  const worktree = from ? from.worktreePath! : paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  if (!from) {
    mkdirSync(dirname(worktree), { recursive: true });
    await addWorktree(mirror, worktree, branch, base);
  }

  const projectSkills = requiredProjectSkills(db, unit);
  const sources = await mountSources(ctx, unit, worktree);
  const references = await referenceCheckouts(ctx, project.id, unit.seq, from?.n ?? attempt.n, setting("project.reference_repos"));
  const standingPath = paths.standingOrders(project.id);
  const packForbid = isPack ? [] : [`${repo.verifyPackPath}/**`];
  const env = project.environmentId ? getEnvironment(db, project.environmentId) : null;
  const envValues = valueMap(db, project.environmentId);
  const brief: RenderedBrief = {
    goal: unit.goal,
    repo: { id: repo.id, worktree, branch, baseSha: base },
    scope: { write: unit.writeScope, forbid: unit.forbidScope, hard: packForbid },
    context: [
      ...(isPack
        ? packContract({
            packPath: repo.verifyPackPath,
            provider: env?.provider ?? "local-process",
            leaseVars: LEASE_VARS[env?.provider ?? "local-process"] ?? [],
            minTier: project.minTier,
            reason: unit.context[0] ?? "This repo has no usable verify pack on trunk",
          })
        : []),
      ...(isPack ? unit.context.slice(1) : unit.context),
      ...unit.notes.map((n) => `Note from an earlier attempt: ${n}`),
      ...(environmentNotes(db, project.environmentId) ? [`About this environment: ${environmentNotes(db, project.environmentId)}`] : []),
    ],
    readonly: [
      ...sources.map((s) => ({ repoId: s.repoId, path: s.path, sha: s.sha })),
      ...references.map((r) => ({ repoId: r.repoId, path: r.path, sha: r.sha })),
    ],
    acceptance: unit.acceptance,
    verify: unit.verify,
    env: envValues,
    envNotes: Object.fromEntries(
      listValues(db, project.environmentId as EnvironmentId)
        .map((v) => [v.name, v.note])
        .filter(([, n]) => n),
    ),
    timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
    forbidden: [
      "no git push, rebase, merge, or branch switching",
      "nothing outside SCOPE",
      isPack
        ? "do not change the code the pack verifies"
        : `do not edit the verify pack at ${repo.verifyPackPath}; if your change stops it working, say what broke under Notes and the verifier will fix the pack`,
    ],
    method:
      (isPack
        ? "Load the yagura-pack skill first and follow it."
        : `Load the yagura-worker skill first and follow it. Then load pstack:poteto-mode with the Skill tool and follow its ${unit.playbook ?? "feature"} playbook. Both are required: an attempt that does not load them is rejected.`) +
      (unit.scaffold ? " This is a scaffold unit: build the new project's skeleton the way the project skills below say, and nothing more." : "") +
      skillMethod(projectSkills),
    report: HANDOFF_TEMPLATE,
    standing: existsSync(standingPath) ? readFileSync(standingPath, "utf8") : "",
  };
  const briefText = from
    ? renderResumePrompt({
        unit: `${project.id}/U${unit.seq}`,
        attempt: attempt.n,
        resumes: from.n,
        branch,
        ...rejectionFindings(db, boot, unit, from),
        timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
        report: HANDOFF_TEMPLATE,
      })
    : renderBrief(brief);
  write(paths.brief(project.id, unit.seq, attempt.n), briefText);

  const startedAt = now();
  transitionUnit(db, unit.id, "running", { attempt: attempt.n, ...(from ? { resumes: from.n } : {}) });
  updateAttempt(db, attempt.id, { state: "running", startedAt, worktreePath: worktree, branch, baseSha: base, resumesAttemptId: from?.id ?? null, sources });

  const session = await runAgentSession(ctx, {
    recorder: attemptRecorder(db, { attempt, unit, projectId: project.id, role: isPack ? "pack" : "worker", inheritedSkills: from?.skills, projectSkills }),
    adapter,
    run: {
      prompt: briefText,
      bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
      model: setting("role.worker.model"),
      permissionMode: setting("harness.claude.permission_mode"),
      pluginDirs: [boot.skillsDir],
      addDirs: [...sources.map((s) => s.path), ...references.map((r) => r.path)],
      extraArgs: setting("harness.claude.extra_args"),
      resume: from?.sessionId ?? undefined,
    },
    cwd: worktree,
    env: { ...envValues, ...sourceEnv(sources) },
    timeboxSeconds: unit.timeboxSeconds,
    logPath: paths.log(project.id, unit.seq, attempt.n),
  });
  const endedAt = now();

  const stop = stopRequested(db, attempt.id);
  if (stop.stopped) {
    await discardLeftovers(worktree);
    updateAttempt(db, attempt.id, { state: "stopped", endedAt, exitCode: session.exitCode });
    if (stop.note) addUnitNote(db, unit.id, `Operator stopped attempt ${attempt.n}: ${stop.note}`);
    transitionUnit(db, unit.id, "ready", { reason: "stopped by operator", attempt: attempt.n });
    recordEvent(db, "attempt.ended", { projectId: project.id, unitId: unit.id, attemptId: attempt.id }, { stopped: true });
    return getAttempt(db, attempt.id);
  }

  if (from && !getAttempt(db, attempt.id).sessionId) {
    const reason = `resuming attempt ${from.n}'s session failed to start: ${session.final?.text || session.stderrTail.trim() || `exit ${session.exitCode}`}`;
    updateAttempt(db, attempt.id, { state: "failed", endedAt, exitCode: session.exitCode, failureMode: "harness-error" });
    recordEvent(db, "attempt.resume_failed", refs, { reason });
    transitionUnit(db, unit.id, "ready", { reason, attempt: attempt.n });
    return runWorkUnit(ctx, unitId);
  }

  const leftovers = await discardLeftovers(worktree);
  if (leftovers.paths.length) write(paths.leftovers(project.id, unit.seq, attempt.n), leftovers.patch);
  const head = await headSha(worktree);
  const touched = await changedPaths(worktree, base);
  const reject = (rejection: Rejection, data: Record<string, unknown>) => {
    updateAttempt(db, attempt.id, { rejection, ...(rejection === "code-fault" ? {} : { failureMode: "scope" as const }) });
    transitionUnit(db, unit.id, "rejected", data);
  };
  const final = session.final;
  const handoff = final && !final.isError && !session.timedOut ? parseHandoff(final.text) : null;

  if (handoff) {
    write(paths.handoff(project.id, unit.seq, attempt.n), final!.text);
    db.prepare("INSERT INTO search (body, kind, ref_id, project_id) VALUES (?, 'handoff', ?, ?)").run(final!.text, String(attempt.id), project.id);
    updateAttempt(db, attempt.id, {
      state: "handed_off",
      endedAt,
      exitCode: session.exitCode,
      headSha: head,
      handoffStatus: handoff.status,
      selfTier: handoff.verification === "not-verified" ? null : handoff.verification,
    });
    transitionUnit(db, unit.id, "handed_off", { attempt: attempt.n, status: handoff.status, head, leftovers: leftovers.paths });
    const scope = assessScope(touched, unit.writeScope, unit.forbidScope, packForbid, handoff.outsideScope);
    const violations = [...scope.hard, ...scope.unjustified];
    if (!violations.length && scope.justified.length)
      recordEvent(
        db,
        "attempt.beyond_scope",
        { projectId: project.id, unitId: unit.id, attemptId: attempt.id },
        { paths: scope.justified.map((v) => v.path), reason: handoff.outsideScope },
      );
    if (violations.length) {
      addUnitNote(
        db,
        unit.id,
        scope.hard.length
          ? `Attempt ${attempt.n} wrote ${scope.hard.map((v) => v.path).join(", ")}, which yagura never allows (the verify pack). Leave it alone.`
          : `Attempt ${attempt.n} changed ${scope.unjustified.map((v) => v.path).join(", ")} outside SCOPE without saying why. Stay inside SCOPE, or list each such path under "## Outside scope" in the handoff with the reason the work needs it.`,
      );
      reject("scope", { reason: "scope", violations });
    } else if (handoff.status === "blocked") {
      transitionUnit(db, unit.id, "blocked", { reason: "agent reported blocked" });
    } else if (head === base) {
      transitionUnit(db, unit.id, "blocked", { reason: "handed off with no commits" });
    } else if (session.missingSkills.length && setting("method.enforce_required_skills")) {
      addUnitNote(
        db,
        unit.id,
        `Attempt ${attempt.n} skipped required skills (${session.missingSkills.join(", ")}). Load each of them with the Skill tool before doing any work.`,
      );
      updateAttempt(db, attempt.id, { rejection: "skills" });
      transitionUnit(db, unit.id, "rejected", { reason: "skipped required skills", missing: session.missingSkills });
    } else {
      await ensureMirror(repo.url, mirror);
      const trunk = await resolveRef(mirror, `origin/${repo.defaultBranch}`);
      if (trunk !== base && !(await mergesCleanly(mirror, trunk, head))) {
        addUnitNote(
          db,
          unit.id,
          `Attempt ${attempt.n} conflicted with ${repo.defaultBranch} at ${trunk.slice(0, 10)}, which moved while it worked; the next attempt starts from the new trunk.`,
        );
        updateAttempt(db, attempt.id, { rejection: "conflict" });
        transitionUnit(db, unit.id, "rejected", { reason: "conflicts with trunk", trunk });
      } else queueVerification(db, getUnit(db, unit.id));
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
    transitionUnit(db, unit.id, "failed", { attempt: attempt.n, mode });
  }
  recordEvent(db, "attempt.ended", refs, { exit: session.exitCode, signal: session.signal, timedOut: session.timedOut, touched });
  return getAttempt(db, attempt.id);
}
