import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runAgentSession, write, type RunContext } from "./agent.js";
import { HANDOFF_TEMPLATE, renderBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import type { Attempt, RenderedBrief, Unit, UnitId } from "./domain.js";
import { addWorktree, changedPaths, discardLeftovers, ensureMirror, headSha, resolveRef } from "./git.js";
import { classifyFailure, parseHandoff, syntheticFailureHandoff } from "./handoff.js";
import { layout, unitRef } from "./paths.js";
import { checkScope } from "./scope.js";
import { addUnit, createAttempt, getAttempt, getProject, getRepo, getUnit, now, recordEvent, transitionUnit, updateAttempt, type Db } from "./store.js";

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
    timeboxSeconds: resolveSetting(db, "timebox.verify_seconds", { projectId: target.projectId }).value,
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

export async function runWorkUnit(ctx: RunContext, unitId: UnitId): Promise<Attempt> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.type !== "work") throw new Error(`U${unit.seq} is a ${unit.type} unit; use the runner for its type`);
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
  const base = await resolveRef(mirror, `origin/${repo.defaultBranch}`);

  const attempt = createAttempt(db, unit.id, harnessId, setting("role.worker.model"));
  const branch = `${setting("git.branch_prefix")}/${project.id}/${unitRef(unit.seq)}-${attempt.n}`;
  const worktree = paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  mkdirSync(dirname(worktree), { recursive: true });
  await addWorktree(mirror, worktree, branch, base);

  const standingPath = paths.standingOrders(project.id);
  const packForbid = `${repo.verifyPackPath}/**`;
  const brief: RenderedBrief = {
    goal: unit.goal,
    repo: { id: repo.id, worktree, branch, baseSha: base },
    scope: { write: unit.writeScope, forbid: [...unit.forbidScope, packForbid] },
    context: [...unit.context, ...unit.notes.map((n) => `Note from an earlier attempt: ${n}`)],
    readonly: [],
    acceptance: unit.acceptance,
    verify: unit.verify,
    env: {},
    timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
    forbidden: ["no git push, rebase, merge, or branch switching", "nothing outside SCOPE", `do not edit the verify pack at ${repo.verifyPackPath}`],
    method: `Load the yagura-worker skill first and follow it. Then use pstack:poteto-mode${unit.playbook ? ` with the ${unit.playbook} playbook` : ""}.`,
    report: HANDOFF_TEMPLATE,
    standing: existsSync(standingPath) ? readFileSync(standingPath, "utf8") : "",
  };
  const briefText = renderBrief(brief);
  write(paths.brief(project.id, unit.seq, attempt.n), briefText);

  const startedAt = now();
  transitionUnit(db, unit.id, "running", { attempt: attempt.n });
  updateAttempt(db, attempt.id, { state: "running", startedAt, worktreePath: worktree, branch, baseSha: base });

  const session = await runAgentSession(ctx, {
    attempt,
    unit,
    projectId: project.id,
    role: "worker",
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
    env: {},
    timeboxSeconds: unit.timeboxSeconds,
    logPath: paths.log(project.id, unit.seq, attempt.n),
  });
  const endedAt = now();

  const leftovers = await discardLeftovers(worktree);
  if (leftovers.paths.length) write(paths.leftovers(project.id, unit.seq, attempt.n), leftovers.patch);
  const head = await headSha(worktree);
  const touched = await changedPaths(worktree, base);
  const refs = { projectId: project.id, unitId: unit.id, attemptId: attempt.id };
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
    const violations = checkScope(touched, unit.writeScope, [...unit.forbidScope, packForbid]);
    if (violations.length) {
      updateAttempt(db, attempt.id, { failureMode: "scope" });
      transitionUnit(db, unit.id, "rejected", { reason: "scope", violations });
    } else if (handoff.status === "blocked") {
      transitionUnit(db, unit.id, "blocked", { reason: "agent reported blocked" });
    } else if (head === base) {
      transitionUnit(db, unit.id, "blocked", { reason: "handed off with no commits" });
    } else {
      queueVerification(db, getUnit(db, unit.id));
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
      syntheticFailureHandoff({ unit: `${project.id}/U${unit.seq}`, attempt: attempt.n, mode, branch, startedAt, endedAt, lastActivity: session.lastActivity, facts }),
    );
    updateAttempt(db, attempt.id, { state: "failed", endedAt, exitCode: session.exitCode, headSha: head, failureMode: mode });
    transitionUnit(db, unit.id, "failed", { attempt: attempt.n, mode });
  }
  recordEvent(db, "attempt.ended", refs, { exit: session.exitCode, signal: session.signal, timedOut: session.timedOut, touched });
  return getAttempt(db, attempt.id);
}
