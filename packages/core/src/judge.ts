import { environmentSection } from "./actions.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { attemptRecorder, runAgentSession, write, type RunContext } from "./agent.js";
import { checkoutUnit } from "./branch.js";
import { resolveSetting } from "./config.js";
import type { Attempt, Sha, Unit, UnitId } from "./domain.js";
import { baseWorktree, listEvidenceRuns } from "./evidence.js";
import { classifyFailure, ensureRecorded, sessionReport } from "./finish.js";
import { forgeFor, getMergeRequest } from "./forge.js";
import { ensureMirror, git, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { promptPlugin, standingFor } from "./prompts.js";
import { describeRecords, getRecord } from "./records.js";
import { recordInstructions } from "./record-usage.js";
import type { WorkerRound } from "./resume.js";
import { pullRequestBody } from "./audit.js";
import { listDecisions, threadsForProject } from "./threads.js";
import {
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
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";

const DIFF_LIMIT = 200_000;

export const JUDGE_REPORT = recordInstructions(
  ["judge"],
  [
    "- `approve` only when every acceptance outcome holds on this head, citing the runs you made that show it (--runs).",
    "- `changes` with one --finding per problem, each `<file:line> what is wrong`; the worker gets them as written.",
    "- `ask` when only a person can settle it (the goal is ambiguous, two outcomes contradict); the unit lead decides what happens.",
  ],
);

export interface JudgeBrief {
  unit: string;
  goal: string;
  acceptance: string[];
  context: string[];
  decisions: string[];
  checkout: string;
  head: Sha;
  diffBase: Sha;
  diff: string;
  environment: string;
  worker: string[];
  runs: string[];
  lastRound: string[];
  standing: string;
}

const list = (items: string[], empty = "(none)") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);

// The judge forms its own view before it reads the worker's: the goal and the change first, its own runs next, and the worker's
// account last, as claims to check.
export function renderJudgeBrief(b: JudgeBrief): string {
  return `# yagura brief: judge ${b.unit}

You are the judge. You took no part in this work and carry nothing from any earlier round. Decide whether the change meets the goal, from the change itself and from runs you make yourself. You cannot ask questions, and you change nothing in the branch.

## GOAL
${b.goal}

## ACCEPTANCE
${list(b.acceptance)}

## CONTEXT
${list(b.context)}

## DECISIONS ALREADY MADE
${list(b.decisions)}

## THE CHANGE
Your checkout ${b.checkout} is at the head ${b.head}. The change is everything since ${b.diffBase}, where the branch left its base.

${b.diff}

## YOUR RUNS
${b.environment}
Run what proves or disproves each outcome with \`yagura evidence run -- <command>\`; yagura runs it on this head and gives you a run id. When running a test on the base would tell you something (does it fail without the change?), add \`--at base\`.

## WHAT TO LOOK FOR
- Every acceptance outcome holds.
- Tests check behaviour, rather than passing whatever the code does.
- No placeholders, empty functions, stubs, TODOs, or disabled or skipped tests standing in for required behaviour, unless the context says another unit fills them in.
- No changes that have nothing to do with the goal, and no secrets.

## THE WORKER'S ACCOUNT
Read this only after you have judged the change yourself. Check its claims: evidence that does not resolve, or runs that did not pass, count against the work.

What the worker recorded:
${list(b.worker)}

Its recorded runs:
${list(b.runs)}

What the last round asked for:
${list(b.lastRound)}

## REPORT
${JUDGE_REPORT}

## STANDING ORDERS
${b.standing.trim() || "(none)"}
`;
}

// The judge round already ran when yagura stopped before acting on its verdict.
function judgedThisRound(db: Db, unitId: UnitId): Attempt | null {
  const since = lastTransition(db, unitId)?.ts ?? "";
  const last = listAttempts(db, unitId)
    .filter((a) => a.role === "judge")
    .at(-1);
  return last && (last.startedAt ?? "") >= since && last.state !== "running" && last.state !== "queued" ? last : null;
}

// How many rounds running the judge has asked for changes, the latest included.
function changeRounds(db: Db, unitId: UnitId): number {
  let n = 0;
  for (const a of listAttempts(db, unitId)
    .filter((x) => x.role === "judge")
    .reverse()) {
    if (getRecord(db, a.id, "judge")?.verdict !== "changes") break;
    n++;
  }
  return n;
}

// One judge round of a judging unit: a fresh session on a fresh checkout of the head, then yagura acts on its verdict.
export async function runJudgeRound(ctx: RunContext, unitId: UnitId): Promise<void> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.state !== "judging") throw new Error(`U${unit.seq} is ${unit.state}, not judging`);
  const done = judgedThisRound(db, unitId);
  if (done) return applyVerdict(ctx, unit, done);

  const project = getProject(db, unit.projectId);
  const repo = getRepo(db, unit.repoId!);
  const sctx = { projectId: project.id, repoId: repo.id };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.judge.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);
  const mirror = paths.mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const head = await resolveRef(mirror, `refs/heads/${unit.branch!}`);
  const baseSha = await resolveRef(mirror, `refs/remotes/origin/${unit.base ?? repo.defaultBranch}`);
  const diffBase = (await git(["merge-base", head, baseSha], { gitDir: mirror })) as Sha;

  const checkout = `${paths.checkout(repo.id, project.id, unit.seq)}.judge`;
  for (const dir of [checkout, baseWorktree(checkout)]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(checkout), { recursive: true });
  await checkoutUnit(mirror, checkout, unit.branch!);
  await git(["checkout", "--quiet", "--detach", head], { cwd: checkout });
  await checkoutUnit(mirror, baseWorktree(checkout), unit.branch!);
  await git(["checkout", "--quiet", "--detach", diffBase], { cwd: baseWorktree(checkout) });

  const attempts = listAttempts(db, unit.id);
  const workers = attempts.filter((a) => a.role === "worker" && a.state === "handed_off");
  const lastJudge = attempts.filter((a) => a.role === "judge").at(-1);
  const lastVerdict = lastJudge ? getRecord(db, lastJudge.id, "judge") : null;
  const diff = await git(["diff", "--stat", "--patch", "--no-color", diffBase, head], { gitDir: mirror });
  const decisions = threadsForProject(db, project.id).flatMap((t) => listDecisions(db, t, { activeOnly: true }).map((d) => `D${d.id}: ${d.text}`));

  const attempt = createAttempt(db, unit.id, harnessId, setting("role.judge.model"));
  const brief = renderJudgeBrief({
    unit: `${project.id}/U${unit.seq}`,
    goal: unit.goal,
    acceptance: unit.acceptance,
    context: unit.context,
    decisions,
    checkout,
    head,
    diffBase,
    diff: diff.length > DIFF_LIMIT ? `(the diff is ${diff.length} bytes; read it in your checkout with \`git diff ${diffBase} HEAD\`)` : diff || "(empty)",
    environment: environmentSection(db, project.environmentId, unit.repoId),
    worker: workers.map((a) => `A${a.agentNo}: ${describeRecords(db, a.id) ?? "(nothing recorded)"}`),
    runs: workers.flatMap((a) =>
      listEvidenceRuns(db, a.id).map(
        (r) => `run:${r.id} by A${a.agentNo} on ${r.sha.slice(0, 10)}: \`${r.command}\` ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}`,
      ),
    ),
    lastRound: lastVerdict?.verdict === "changes" ? lastVerdict.findings : [],
    standing: standingFor(db, project.id, "judge"),
  });
  write(paths.brief(project.id, unit.seq, attempt.n), brief);
  updateAttempt(db, attempt.id, { state: "running", startedAt: now(), worktreePath: checkout, branch: unit.branch, baseSha: diffBase, headSha: head });

  const role = "judge";
  const judge = (prompt: string, resume: string | undefined, reminder = false) =>
    runAgentSession(ctx, {
      recorder: attemptRecorder(db, { attempt, unit, projectId: project.id, role }),
      adapter,
      run: {
        prompt,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.judge.model"),
        permissionMode: setting("harness.claude.permission_mode"),
        pluginDirs: [promptPlugin(db, boot, project.id, { attemptId: attempt.id, role })],
        addDirs: [baseWorktree(checkout)],
        extraArgs: setting("harness.claude.extra_args"),
        resume,
      },
      cwd: checkout,
      env: {},
      timeboxSeconds: setting("timebox.judge_seconds"),
      logPath: reminder ? paths.log(project.id, unit.seq, attempt.n).replace(/\.jsonl$/, ".resume.jsonl") : paths.log(project.id, unit.seq, attempt.n),
    });
  const first = await judge(brief, undefined);
  const session = await ensureRecorded(db, attempt.id, role, first, (prompt, sessionId) => judge(prompt, sessionId, true));
  write(paths.handoff(project.id, unit.seq, attempt.n), sessionReport(first, session) ?? "");
  const verdict = getRecord(db, attempt.id, "judge");
  const mode = verdict
    ? null
    : classifyFailure({
        timedOut: session.timedOut,
        exitCode: session.exitCode,
        signal: session.signal,
        finalText: session.final?.text ?? null,
        finalIsError: session.final?.isError ?? true,
        stderrTail: session.stderrTail,
      });
  updateAttempt(db, attempt.id, { state: verdict ? "handed_off" : "failed", endedAt: now(), exitCode: session.exitCode, failureMode: mode });
  for (const dir of [checkout, baseWorktree(checkout)]) rmSync(dir, { recursive: true, force: true });
  return applyVerdict(ctx, getUnit(db, unit.id), getAttempt(db, attempt.id));
}

async function applyVerdict(ctx: RunContext, unit: Unit, attempt: Attempt): Promise<void> {
  const { db } = ctx;
  const verdict = getRecord(db, attempt.id, "judge");
  const refs = { projectId: unit.projectId, unitId: unit.id, attemptId: attempt.id };
  if (!verdict) {
    const failedBefore = listAttempts(db, unit.id)
      .filter((a) => a.role === "judge")
      .slice(-2)
      .every((a) => a.state === "failed");
    recordEvent(db, "judge.no_verdict", refs, { mode: attempt.failureMode });
    if (failedBefore) return transitionUnit(db, unit.id, "stuck", { reason: `two judge sessions in a row ended without a verdict (${attempt.failureMode})` });
    return transitionUnit(db, unit.id, "judging", { reason: `the judge ended without a verdict (${attempt.failureMode}); a fresh judge looks again` });
  }
  if (verdict.verdict === "ask")
    return transitionUnit(db, unit.id, "stuck", { reason: `the judge asks: ${verdict.question}`, question: verdict.question, trigger: "judge-asks" });
  if (verdict.verdict === "changes") {
    const rounds = changeRounds(db, unit.id);
    const max = resolveSetting(db, "judge.max_rounds", { projectId: unit.projectId, repoId: unit.repoId ?? undefined }).value;
    if (rounds >= max)
      return transitionUnit(db, unit.id, "stuck", {
        reason: `the judge asked for changes ${rounds} rounds running`,
        findings: verdict.findings,
        trigger: "changes-rounds",
      });
    return transitionUnit(db, unit.id, "building", { round: { kind: "changes", findings: verdict.findings } satisfies WorkerRound });
  }
  const head = attempt.headSha!;
  setApprovedSha(db, unit.id, head);
  const forge = forgeFor(db, getRepo(db, unit.repoId!));
  const mr = getMergeRequest(db, unit.id);
  if (forge && mr) {
    await forge.updateBody(mr.number, pullRequestBody(getProject(db, unit.projectId), unit, resolveSetting(db, "yagura.url").value));
    await forge.markReady(mr.number);
    db.prepare("UPDATE merge_requests SET draft = 0 WHERE unit_id = ?").run(unit.id);
  }
  transitionUnit(db, unit.id, "ready", { head, runs: verdict.runs });
}
