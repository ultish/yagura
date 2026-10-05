import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { attemptRecorder, runAgentSession, write, type RunContext } from "./agent.js";
import { resolveSetting } from "./config.js";
import type { Attempt, Sha, Unit, UnitId } from "./domain.js";
import { valueMap } from "./envvalues.js";
import { addDetachedWorktree, discardLeftovers, ensureMirror, headSha, removeWorktree, resolveRef } from "./git.js";
import { INVESTIGATION_REPORT } from "./brief.js";
import { ensureRecorded, readHandoff, reportOf, sessionReport } from "./finish.js";
import { layout } from "./paths.js";
import { promptPlugin, standingFor } from "./prompts.js";
import {
  addUnit,
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

// A worker that only finds out: it reads and runs things in a copy of the code, changes nothing, and reports findings, which go to the manager that asked (§26).
export function queueInvestigation(db: Db, target: Unit, question: string): Unit {
  const unit = addUnit(db, {
    projectId: target.projectId,
    type: "investigate",
    repoId: target.repoId,
    targetUnitId: target.id,
    goal: `Investigate for U${target.seq}: ${question}`,
    writeScope: [],
    acceptance: [],
    verify: null,
    context: [question],
    timeboxSeconds: resolveSetting(db, "timebox.work_seconds", { projectId: target.projectId, repoId: target.repoId }).value,
    maxAttempts: 1,
  });
  transitionUnit(db, unit.id, "ready", { target: target.seq });
  recordEvent(db, "investigation.queued", { projectId: target.projectId, unitId: target.id }, { question, investigateUnit: unit.seq });
  return getUnit(db, unit.id);
}

const FORBIDDEN = [
  "no edits, commits, or any other change to the worktree",
  "no git push, rebase, merge, or branch switching",
  "no changes outside the worktree except scratch files under /tmp",
];

export async function runInvestigateUnit(ctx: RunContext, unitId: UnitId): Promise<Attempt> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.type !== "investigate" || !unit.targetUnitId || !unit.repoId) throw new Error(`U${unit.seq} is not an investigation`);
  if (unit.state !== "ready") throw new Error(`U${unit.seq} is ${unit.state}, not ready`);
  const target = getUnit(db, unit.targetUnitId);
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

  // The code as the unit's last worker left it, or trunk when it never committed.
  const last = listAttempts(db, target.id)
    .filter((a) => a.headSha)
    .at(-1);
  const at: Sha = last?.headSha ?? (await resolveRef(mirror, `origin/${repo.defaultBranch}`));
  const attempt = createAttempt(db, unit.id, harnessId, setting("role.worker.model"));
  const worktree = paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  mkdirSync(dirname(worktree), { recursive: true });
  await addDetachedWorktree(mirror, worktree, at);

  const question = unit.context[0] ?? unit.goal;
  const standing = standingFor(db, project.id, "worker");
  const brief = `# yagura investigation brief

You are investigating for the manager of ${project.id}/U${target.seq} (${target.goal}). You change nothing: you read, run, and measure, then report what you found. Everything you need is below; you cannot ask questions.

## QUESTION
${question}

## REPO
- repo: ${repo.id}
- worktree: ${worktree} (your working directory), detached at ${at}${last ? `, the code as U${target.seq}'s last worker left it` : ", trunk"}

## THE UNIT
- U${target.seq}: ${target.goal}
${target.description ? `- Why it exists: ${target.description}\n` : ""}- Expected to write: ${target.writeScope.join(", ") || "(unspecified)"}
- Acceptance: ${target.acceptance.join("; ") || "(none)"}
${target.notes.length ? `- Notes so far: ${target.notes.join(" / ")}\n` : ""}
## TIMEBOX
${Math.round(unit.timeboxSeconds / 60)} minutes. If you run out, stop and report what you have with Status: partial.

## FORBIDDEN
${FORBIDDEN.map((f) => `- ${f}`).join("\n")}

## REPORT
${INVESTIGATION_REPORT}
${standing ? `\n## STANDING ORDERS\n${standing}\n` : ""}
## METHOD
Load the yagura-worker skill first and follow it. Then load pstack:poteto-mode with the Skill tool and follow its investigation playbook. Both are required. This is an investigation: nothing is committed, and the findings you record are the whole result.
`;
  write(paths.brief(project.id, unit.seq, attempt.n), brief);
  transitionUnit(db, unit.id, "running", { attempt: attempt.n, target: target.seq });
  updateAttempt(db, attempt.id, { state: "running", startedAt: now(), worktreePath: worktree, baseSha: at });

  const investigate = (prompt: string, resume?: string) =>
    runAgentSession(ctx, {
      recorder: attemptRecorder(db, {
        attempt,
        unit,
        projectId: project.id,
        role: "worker",
        inheritedSkills: resume ? getAttempt(db, attempt.id).skills : undefined,
      }),
      adapter,
      run: {
        prompt,
        resume,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.worker.model"),
        permissionMode: setting("harness.claude.permission_mode"),
        pluginDirs: [promptPlugin(db, boot, project.id, { attemptId: attempt.id, role: "worker" })],
        addDirs: [],
        extraArgs: setting("harness.claude.extra_args"),
      },
      cwd: worktree,
      env: valueMap(db, project.environmentId),
      timeboxSeconds: unit.timeboxSeconds,
      logPath: resume ? paths.log(project.id, unit.seq, attempt.n).replace(/\.jsonl$/, ".resume.jsonl") : paths.log(project.id, unit.seq, attempt.n),
    });
  const first = await investigate(brief);
  const session = await ensureRecorded(db, attempt.id, "worker", first, (prompt, sessionId) => investigate(prompt, sessionId));

  const leftovers = await discardLeftovers(worktree);
  const after = await headSha(worktree);
  const report = sessionReport(first, session);
  if (report) write(paths.handoff(project.id, unit.seq, attempt.n), report);
  const handoff = readHandoff(db, attempt.id, [reportOf(session), reportOf(first)]);
  const problem = !handoff
    ? session.timedOut
      ? "the investigator ran out of time"
      : "the investigator ended without recording its findings"
    : after !== at || leftovers.paths.length
      ? `the investigator changed the worktree (${after !== at ? "committed" : leftovers.paths.join(", ")}); an investigation changes nothing`
      : session.missingSkills.length
        ? `the investigator skipped required skills: ${session.missingSkills.join(", ")}`
        : !handoff.findings.trim()
          ? "the investigator reported no findings"
          : null;
  updateAttempt(db, attempt.id, {
    state: handoff ? "handed_off" : "failed",
    endedAt: now(),
    exitCode: session.exitCode,
    headSha: after,
    handoffStatus: handoff?.status ?? null,
    ...(handoff ? {} : { failureMode: "unknown" as const }),
  });
  await removeWorktree(mirror, worktree).catch(() => undefined);
  const refs = { projectId: project.id, unitId: target.id, attemptId: attempt.id };
  if (problem) {
    transitionUnit(db, unit.id, "failed", { reason: problem });
    recordEvent(db, "investigation.failed", refs, { investigateUnit: unit.seq, reason: problem });
  } else {
    transitionUnit(db, unit.id, "handed_off", {});
    transitionUnit(db, unit.id, "done", {});
    recordEvent(db, "investigation.done", refs, { investigateUnit: unit.seq });
  }
  return getAttempt(db, attempt.id);
}
