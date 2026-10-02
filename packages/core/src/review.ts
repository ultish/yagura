import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { attemptRecorder, runAgentSession, write, type RunContext } from "./agent.js";
import { renderBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import { TERMINAL_STATES, type Attempt, type Sha, type Unit, type UnitId } from "./domain.js";
import { valueMap } from "./envvalues.js";
import { forgeFor, getMergeRequest, prRef, type PrThread } from "./forge.js";
import { addWorktree, changedPaths, discardLeftovers, ensureMirror, git, headSha } from "./git.js";
import { parseHandoff } from "./handoff.js";
import { verifiedHead } from "./land.js";
import { layout, unitRef } from "./paths.js";
import { readSpec, renderSpec } from "./spec.js";
import {
  addUnit,
  addUnitNote,
  createAttempt,
  getAttempt,
  getGate,
  getProject,
  getRepo,
  getUnit,
  listAttempts,
  listUnits,
  now,
  recordEvent,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { listDecisions, threadsForProject } from "./threads.js";
import { freshThreads, isReviewThread, listThreadRows, queueTriage } from "./triage.js";

export const SEVERITIES = ["blocking", "should", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];
export interface Finding {
  n: number;
  severity: Severity;
  path: string;
  line: number | null;
  text: string;
}

// "- F1 [blocking] path:12 — what is wrong, why, and what would fix it", or "- none".
export function parseFindings(section: string): { findings: Finding[]; problem: string | null } {
  const lines = section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"));
  if (!lines.length) return { findings: [], problem: "the handoff has no ## Findings section (write `- none` when there is nothing)" };
  if (lines.length === 1 && /^-\s*none\b/i.test(lines[0]!)) return { findings: [], problem: null };
  const findings: Finding[] = [];
  for (const l of lines) {
    const m = /^-\s*F(\d+)\s*\[(\w+)\]\s*([^\s:]+)(?::(\d+))?\s*[—–-]+\s*(.+)$/.exec(l);
    if (!m) return { findings, problem: `a finding is not in the form "- F1 [blocking|should|nit] path:line — text": ${l.slice(0, 120)}` };
    const severity = m[2]!.toLowerCase();
    if (!(SEVERITIES as readonly string[]).includes(severity)) return { findings, problem: `F${m[1]} has severity "${m[2]}"; use blocking, should, or nit` };
    findings.push({ n: Number(m[1]), severity: severity as Severity, path: m[3]!, line: m[4] ? Number(m[4]) : null, text: m[5]!.trim() });
  }
  return { findings, problem: null };
}

export const reviewsOf = (db: Db, target: Unit) => listUnits(db, target.projectId).filter((u) => u.type === "review" && u.targetUnitId === target.id);

const reviewEnabled = (db: Db, target: Unit) => resolveSetting(db, "review.enabled", { projectId: target.projectId, repoId: target.repoId }).value;

// The head a review read: its attempt starts at the target's verified head.
const reviewedHead = (db: Db, review: Unit): Sha | null =>
  listAttempts(db, review.id)
    .filter((a) => a.state === "handed_off")
    .at(-1)?.baseSha ?? null;

export type ReviewStatus =
  | { state: "settled"; reason: string }
  | { state: "needed"; since: Sha | null; reason: string }
  | { state: "pending"; reason: string }
  | { state: "answered"; fresh: { thread: PrThread; directive: string | null }[] }
  | { state: "waiting"; reason: string };

// Whether a verified unit may land as far as code review goes, and what to do if not.
export function reviewStatus(db: Db, target: Unit): ReviewStatus {
  if (!isBuildTarget(target) || !reviewEnabled(db, target)) return { state: "settled", reason: "review is off" };
  const reviews = reviewsOf(db, target);
  const last = reviews.at(-1);
  if (!last) return { state: "needed", since: null, reason: "not reviewed yet" };
  if (last.state === "blocked") return { state: "waiting", reason: `the review U${last.seq} is blocked` };
  if (!TERMINAL_STATES.has(last.state)) return { state: "pending", reason: `U${last.seq} is reviewing it` };
  const rows = listThreadRows(db, target.id).filter((r) => isReviewThread(r.threadId));
  const triage = listUnits(db, target.projectId).filter((u) => u.type === "review-triage" && u.targetUnitId === target.id && !TERMINAL_STATES.has(u.state));
  if (triage.some((u) => u.state === "blocked")) return { state: "waiting", reason: `the triage of its review is blocked` };
  if (triage.length || rows.some((r) => r.decision === null)) return { state: "pending", reason: "its review findings are being triaged" };
  const asks = rows.filter((r) => r.decision === "asked" && r.gateId);
  const fresh = freshThreads(
    db,
    target.id,
    asks.map((r) => ({ id: r.threadId, kind: r.kind, author: r.author, path: r.path, line: r.line, comments: r.comments })),
  );
  if (fresh.length) return { state: "answered", fresh };
  const open = asks.filter((r) => getGate(db, r.gateId!).state === "open");
  if (open.length) return { state: "waiting", reason: `${open.length} review finding(s) wait for your answer` };
  const head = verifiedHead(db, target).verdict.head_sha;
  const seen = reviewedHead(db, last);
  const rounds = resolveSetting(db, "review.max_rounds", { projectId: target.projectId, repoId: target.repoId }).value;
  if (seen && seen !== head && reviews.length <= rounds) return { state: "needed", since: seen, reason: "the change was fixed after review" };
  return { state: "settled", reason: `reviewed by U${last.seq}` };
}

const isBuildTarget = (u: Unit) => u.type === "work" || u.type === "pack";

export function queueReview(db: Db, target: Unit, since: Sha | null): Unit {
  const round = reviewsOf(db, target).length + 1;
  const unit = addUnit(db, {
    projectId: target.projectId,
    type: "review",
    repoId: target.repoId,
    targetUnitId: target.id,
    goal: `Review U${target.seq}${round > 1 ? ` again (round ${round}, the fixes only)` : ""}: ${target.goal}`,
    writeScope: [],
    acceptance: target.acceptance,
    verify: target.verify,
    context: since ? [`since:${since}`] : [],
    timeboxSeconds: resolveSetting(db, "timebox.verify_seconds", { projectId: target.projectId, repoId: target.repoId! }).value,
    maxAttempts: 2,
  });
  transitionUnit(db, unit.id, "ready", { target: target.seq, round });
  return getUnit(db, unit.id);
}

const REVIEW_REPORT = `## Status
success | blocked
(success = you reviewed the change; blocked = you could not)

## Findings
- F1 [blocking] path/to/file.py:42 — what is wrong, why it matters, and what would fix it
- F2 [should] path/to/other.py:7 — …
- F3 [nit] path/to/file.py:3 — …
(one line per finding, each at a file and line the change touches; write \`- none\` when there is nothing worth raising)

## Notes, concerns, deviations
- <anything else the developer should know>`;

function projectDecisions(db: Db, projectId: Unit["projectId"]): string[] {
  return threadsForProject(db, projectId).flatMap((t) => listDecisions(db, t, { activeOnly: true }).map((d) => `D${d.id}: ${d.text}`));
}

export async function runReviewUnit(ctx: RunContext, unitId: UnitId): Promise<Attempt> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.type !== "review" || !unit.targetUnitId || !unit.repoId) throw new Error(`U${unit.seq} is not a review unit`);
  if (unit.state !== "ready") throw new Error(`U${unit.seq} is ${unit.state}, not ready`);
  const target = getUnit(db, unit.targetUnitId);
  const { verdict, work } = verifiedHead(db, target);
  const project = getProject(db, unit.projectId);
  const repo = getRepo(db, unit.repoId);
  const sctx = { projectId: project.id, repoId: repo.id };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.reviewer.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);
  const mirror = paths.mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const head = verdict.head_sha;
  const since = unit.context.find((c) => c.startsWith("since:"))?.slice(6) ?? null;
  const base = since ?? work.baseSha!;

  const attempt = createAttempt(db, unit.id, harnessId, setting("role.reviewer.model"));
  const branch = `${setting("git.branch_prefix")}/${project.id}/${unitRef(target.seq)}-review-${unitRef(unit.seq)}-${attempt.n}`;
  const worktree = paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  mkdirSync(dirname(worktree), { recursive: true });
  await addWorktree(mirror, worktree, branch, head);
  const files = await changedPaths(worktree, base as Sha);
  const stat = (await git(["diff", "--stat", `${base}..${head}`], { cwd: worktree })).trim();
  const spec = readSpec(paths.spec(project.id));
  const specText = spec ? renderSpec(spec) : "";
  const conventions = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"].filter((f) => existsSync(`${worktree}/${f}`));
  const standingPath = paths.standingOrders(project.id);
  const briefText = renderBrief({
    goal: `Review the code of U${target.seq} (${target.goal}) before it lands. Read the change, judge it as a careful senior reviewer of this repo would, and report findings. You change nothing.`,
    repo: { id: repo.id, worktree, branch, baseSha: head },
    scope: { write: ["nothing: this is a read-only review"], forbid: ["**"] },
    context: [
      `The change to review: \`git diff ${base}..${head}\` in your worktree${since ? " (only the fixes made after the last review)" : ""}.\n${stat}`,
      `The verifier proved its behaviour at ${verdict.tier}; you judge the code itself: correctness the checks miss, design, fit with the repo's existing code and conventions, duplication, error handling, security, and tests that would not catch a regression.`,
      ...(conventions.length ? [`The repo's own conventions: ${conventions.join(", ")}`] : []),
      ...projectDecisions(db, project.id).map((d) => `Agreed with the developer: ${d}`),
      ...(specText ? [`The project's spec:\n${specText.slice(0, 6000)}`] : []),
      "Severity: blocking = must not land as is (a bug, a security or data risk, or a broken agreement); should = worth fixing before it lands; nit = a matter of taste, never holds the merge.",
    ],
    readonly: [],
    acceptance: target.acceptance,
    verify: target.verify ?? "(the verifier has proved the behaviour)",
    env: valueMap(db, project.environmentId),
    timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
    forbidden: ["no edits, commits, or any other change to the worktree", "no git push, rebase, merge, or branch switching", "no findings outside the change"],
    method: "Load the yagura-reviewer skill first and follow it. Then load any review skills METHOD names below and use them.",
    report: REVIEW_REPORT,
    standing: existsSync(standingPath) ? readFileSync(standingPath, "utf8") : "",
  }).replace(
    "Load the yagura-reviewer skill first and follow it. Then load any review skills METHOD names below and use them.",
    `Load the yagura-reviewer skill first and follow it.${setting("skills.review").length ? ` Then load ${setting("skills.review").join(", ")} with the Skill tool (required) and use them.` : ""}`,
  );
  write(paths.brief(project.id, unit.seq, attempt.n), briefText);
  transitionUnit(db, unit.id, "running", { attempt: attempt.n, target: target.seq });
  updateAttempt(db, attempt.id, { state: "running", startedAt: now(), worktreePath: worktree, branch, baseSha: head });

  const session = await runAgentSession(ctx, {
    recorder: attemptRecorder(db, { attempt, unit, projectId: project.id, role: "reviewer", projectSkills: setting("skills.review") }),
    adapter,
    run: {
      prompt: briefText,
      bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
      model: setting("role.reviewer.model"),
      permissionMode: setting("harness.claude.permission_mode"),
      pluginDirs: [boot.skillsDir],
      addDirs: [],
      extraArgs: setting("harness.claude.extra_args"),
    },
    cwd: worktree,
    env: valueMap(db, project.environmentId),
    timeboxSeconds: unit.timeboxSeconds,
    logPath: paths.log(project.id, unit.seq, attempt.n),
  });

  const leftovers = await discardLeftovers(worktree);
  const after = await headSha(worktree);
  const final = session.final;
  const handoff = final && !final.isError && !session.timedOut ? parseHandoff(final.text) : null;
  if (handoff) write(paths.handoff(project.id, unit.seq, attempt.n), final!.text);
  const parsed = handoff ? parseFindings(handoff.findings) : null;
  const outside = parsed?.findings.filter((f) => !files.includes(f.path)) ?? [];
  const problem = !handoff
    ? "the reviewer ended without a handoff"
    : after !== head || leftovers.paths.length
      ? `the reviewer changed the worktree (${after !== head ? "committed" : leftovers.paths.join(", ")}); a review changes nothing`
      : session.missingSkills.length
        ? `the reviewer skipped required skills: ${session.missingSkills.join(", ")}`
        : parsed!.problem
          ? parsed!.problem
          : outside.length
            ? `finding(s) outside the change: ${outside.map((f) => `F${f.n} ${f.path}`).join(", ")}`
            : handoff.status === "blocked"
              ? `the reviewer could not review it: ${handoff.notes.trim().split("\n")[0] ?? ""}`
              : null;
  updateAttempt(db, attempt.id, {
    state: handoff ? "handed_off" : "failed",
    endedAt: now(),
    exitCode: session.exitCode,
    headSha: after,
    handoffStatus: handoff?.status ?? null,
    ...(handoff ? {} : { failureMode: "unknown" as const }),
  });
  const refs = { projectId: project.id, unitId: unit.id, attemptId: attempt.id };
  if (problem) {
    const tries = listAttempts(db, unit.id).length;
    if (handoff) transitionUnit(db, unit.id, "handed_off", { reason: problem });
    transitionUnit(db, unit.id, handoff ? "rejected" : "failed", { reason: problem });
    transitionUnit(db, unit.id, tries < unit.maxAttempts ? "ready" : "blocked", { reason: problem });
    recordEvent(db, "review.failed", refs, { target: target.seq, reason: problem });
    return getAttempt(db, attempt.id);
  }

  const findings = parsed!.findings;
  const raised = findings.filter((f) => f.severity !== "nit");
  for (const f of findings.filter((x) => x.severity === "nit"))
    addUnitNote(db, target.id, `Reviewer nit (U${unit.seq}) ${f.path}${f.line ? `:${f.line}` : ""}: ${f.text}`);
  db.transaction(() => {
    transitionUnit(db, unit.id, "handed_off", { findings: findings.length });
    transitionUnit(db, unit.id, "done", { blocking: raised.filter((f) => f.severity === "blocking").length, should: raised.length });
  })();
  recordEvent(db, "review.done", refs, {
    target: target.seq,
    head,
    findings: findings.map((f) => ({ n: f.n, severity: f.severity, path: f.path, line: f.line, text: f.text })),
  });
  if (raised.length) {
    const fresh = raised.map((f) => ({
      thread: {
        id: `review:U${unit.seq}:F${f.n}`,
        kind: "review-thread" as const,
        author: "yagura reviewer",
        path: f.path,
        line: f.line,
        comments: [`[${f.severity}] ${f.text}`],
      },
      directive: null,
    }));
    const triage = queueTriage(db, getUnit(db, target.id), `U${unit.seq}'s review`, fresh);
    if (!triage) transitionUnit(db, target.id, "blocked", { reason: `U${unit.seq}'s review raised findings after the last triage wave; it needs you` });
    const mr = getMergeRequest(db, target.id);
    const forge = mr ? forgeFor(db, repo) : null;
    if (mr && forge && mr.state === "open")
      await forge
        .reply(
          mr.number,
          { id: `review-U${unit.seq}`, kind: "comment" },
          `yagura's reviewer (U${unit.seq}) raised ${raised.length} finding(s); triage is handling them:\n\n${raised.map((f) => `- [${f.severity}] \`${f.path}${f.line ? `:${f.line}` : ""}\` ${f.text}`).join("\n")}`,
          `${project.id}/U${unit.seq}/review`,
        )
        .catch((e: unknown) =>
          recordEvent(db, "review.comment_failed", refs, { error: e instanceof Error ? e.message : String(e), pr: prRef(mr.forge, mr.number) }),
        );
  }
  return getAttempt(db, attempt.id);
}
