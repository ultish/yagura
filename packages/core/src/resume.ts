import { existsSync, readFileSync, statSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import type { Attempt, Rejection, Unit } from "./domain.js";
import { listEvidenceRuns, readArtifact, type EvidenceRun } from "./evidence.js";
import { layout } from "./paths.js";
import { getProject, listAttempts, type Db } from "./store.js";

export function contextWindow(model: string | null): number {
  return /1m|\[1m\]/.test(model ?? "") ? 1_000_000 : 200_000;
}

const REJECTION_TEXT: Record<Rejection, string> = {
  "code-fault": "a failing verification",
  literals: "hard-coded environment values",
  scope: "writing outside its scope",
  skills: "skipping required skills",
  conflict: "a conflict with the moved trunk",
};

export type ResumeChoice = { resume: Attempt; fresh: null } | { resume: null; fresh: string | null };

// Resume only when the rejected worker can fix its own work in place (a failing check, or a path outside scope it can explain or revert); one resumed round, then a clean slate.
export function chooseResume(attempts: Attempt[], opts: { enabled: boolean; canResume: boolean; maxContext: number }): ResumeChoice {
  const last = attempts.at(-1);
  if (!last?.rejection) return { resume: null, fresh: null };
  const fresh = (why: string): ResumeChoice => ({ resume: null, fresh: `attempt ${last.n} ${why}` });
  if (!opts.enabled) return fresh("is not resumed: resume on rejection is off");
  if (last.rejection !== "code-fault" && last.rejection !== "scope") return fresh(`was rejected for ${REJECTION_TEXT[last.rejection]}`);
  if (last.resumesAttemptId) return fresh("was already a resumed round");
  if (!opts.canResume) return fresh(`ran on ${last.harness}, which cannot resume`);
  if (!last.sessionId || !last.worktreePath || !last.branch || !last.baseSha) return fresh("left no session to resume");
  const share = last.contextPeak / contextWindow(last.model);
  if (share > opts.maxContext) return fresh(`peaked at ${Math.round(share * 100)}% of its context window`);
  return { resume: last, fresh: null };
}

export interface FailingRun {
  id: number;
  label: string;
  command: string;
  outcome: string;
  trunk: string | null;
  scripts: { path: string; text: string }[];
  tail: string;
}

export interface ResumePrompt {
  unit: string;
  attempt: number;
  resumes: number;
  branch: string;
  why: string;
  runs: FailingRun[];
  verifierReport: string | null;
  timeboxMinutes: number;
  report: string;
}

const fence = (text: string) => `  \`\`\`\n${text.replace(/^/gm, "  ")}\n  \`\`\``;

export function renderResumePrompt(p: ResumePrompt): string {
  const runs = p.runs.map(
    (r) =>
      `- run:${r.id} ${r.label} on your head: ${r.outcome}${r.trunk ? ` (trunk: ${r.trunk})` : ""}\n  command: ${r.command}${r.scripts
        .map((f) => `\n  ${f.path}:\n${fence(f.text)}`)
        .join("")}${r.tail ? `\n  last output:\n${fence(r.tail)}` : "\n  (no output)"}`,
  );
  return `# yagura: your handoff was rejected

This is attempt ${p.attempt} of ${p.unit}, resuming your own session from attempt ${p.resumes}. You are in the same worktree on the same branch \`${p.branch}\`; your earlier commits are still there. Fix what is below, commit, and hand off again. Everything in your brief still holds: SCOPE, FORBIDDEN, METHOD.

## WHY
${p.why}
${runs.length ? `\n## FAILING RUNS (captured by yagura)\n${runs.join("\n")}\n` : ""}${p.verifierReport ? `\n## VERIFIER'S REPORT\n${p.verifierReport}\n` : ""}
## TIMEBOX
${p.timeboxMinutes} ${p.timeboxMinutes === 1 ? "minute" : "minutes"} for this round.

## REPORT
End your final message with the handoff, in the same format as before:

${p.report}`;
}

const TAIL_LINES = 20;
const REPORT_CHARS = 4000;
const SCRIPT_CHARS = 3000;

// Agents cannot open artifacts, so the scripts a failing command runs are shown inline.
function scriptsOf(command: string): { path: string; text: string }[] {
  return command
    .split(/\s+/)
    .filter((t) => t.startsWith("/") && existsSync(t) && statSync(t).isFile())
    .map((path) => ({ path, text: readFileSync(path, "utf8").trimEnd().slice(0, SCRIPT_CHARS) }));
}

function tailOf(db: Db, boot: Bootstrap, run: EvidenceRun): string {
  const text = [run.stdoutArtifactId, run.stderrArtifactId]
    .flatMap((id) => {
      if (!id) return [];
      try {
        return [readArtifact(db, boot, id).toString("utf8")];
      } catch {
        return [];
      }
    })
    .join("\n");
  return text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

// What the verifier found, from yagura's own records: the verdict's reason, the failing head runs, and the verifier's report.
export function rejectionFindings(db: Db, boot: Bootstrap, unit: Unit, rejected: Attempt): { why: string; runs: FailingRun[]; verifierReport: string | null } {
  const note = unit.notes.at(-1) ?? REJECTION_TEXT[rejected.rejection ?? "code-fault"];
  if (rejected.rejection !== "code-fault") return { why: note, runs: [], verifierReport: null };
  const verify = db.prepare("SELECT id, seq FROM units WHERE target_unit_id = ? AND type = 'verify' ORDER BY seq DESC LIMIT 1").get(unit.id) as
    { id: Unit["id"]; seq: number } | undefined;
  const outcome = db.prepare("SELECT id, data_json FROM events WHERE type = 'verify.outcome' AND unit_id = ? ORDER BY id DESC LIMIT 1").get(unit.id) as
    { id: number; data_json: string } | undefined;
  const ci = db.prepare("SELECT id FROM events WHERE type = 'pr.checks_failed' AND unit_id = ? ORDER BY id DESC LIMIT 1").get(unit.id) as
    { id: number } | undefined;
  // The pull request's CI found the fault after the verifier passed it; its note holds the failing logs.
  if (ci && (!outcome || ci.id > outcome.id)) return { why: note, runs: [], verifierReport: null };
  const why = outcome ? `The verifier rejected your work: ${(JSON.parse(outcome.data_json) as { reason: string }).reason}` : note;
  const attempt = verify ? listAttempts(db, verify.id).at(-1) : undefined;
  if (!verify || !attempt) return { why, runs: [], verifierReport: null };
  const all = listEvidenceRuns(db, attempt.id);
  const outcomeOf = (r: EvidenceRun) => (r.timedOut ? "timed out" : `exit ${r.exitCode}`);
  const runs = all
    .filter((r) => r.at === "head" && (r.timedOut || r.exitCode !== 0))
    .map((r) => {
      const trunk = all.filter((x) => x.at === "base" && x.label === r.label).at(-1);
      return {
        id: r.id,
        label: r.label,
        command: r.command,
        outcome: outcomeOf(r),
        trunk: trunk ? outcomeOf(trunk) : null,
        scripts: scriptsOf(r.command),
        tail: tailOf(db, boot, r),
      };
    });
  const reportPath = layout(boot).handoff(getProject(db, unit.projectId).id, verify.seq, attempt.n);
  const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8").trim() : null;
  return { why, runs, verifierReport: report ? report.slice(0, REPORT_CHARS) : null };
}
