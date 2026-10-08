import { existsSync, readFileSync } from "node:fs";
import type { SessionResult } from "./agent.js";
import { FAILURE_MODES, type AttemptId, type FailureMode, type Handoff, type Role } from "./domain.js";
import { describeRecords, missingRecords, recordedHandoff } from "./records.js";
import { getAttempt, getUnit, recordEvent, type Db } from "./store.js";

// How an agent's session is closed out (§27): its final message is kept as the report for the developer, anything its role
// still has to record is asked for once in the same session, and the engine reads the records.
export const cleanEnd = (s: SessionResult) => !!s.final && !s.final.isError && !s.timedOut;
export const reportOf = (s: SessionResult): string | null => (cleanEnd(s) ? s.final!.text : null);

// What the developer reads on the agent page: the report it ended with and, after a reminder, what it said then.
export const sessionReport = (first: SessionResult, last: SessionResult): string | null => {
  const reports = [reportOf(first), last === first ? null : reportOf(last)].filter((r): r is string => !!r);
  return reports.length ? reports.join("\n\n---\n\n_After yagura's reminder to record its work:_\n\n") : null;
};

export const renderRecordReminder = (missing: string[]) =>
  `# yagura: you have not recorded your work\n\nyagura reads only what you record with its commands, never your final message. Still missing:\n${missing
    .map((m) => `- ${m}`)
    .join("\n")}\n\nRecord it with those commands now (each one tells you at once if a value is wrong), then end with your report again.`;

// One reminder, in the same session, when the agent ended cleanly but left something unrecorded. A session that was cut off
// (timebox, stop, error) is not reminded: that goes down the failure path.
export async function ensureRecorded(
  db: Db,
  attemptId: AttemptId,
  role: Role,
  session: SessionResult,
  resume: ((prompt: string, sessionId: string) => Promise<SessionResult>) | null,
): Promise<SessionResult> {
  const missing = missingRecords(db, attemptId, role);
  const sessionId = getAttempt(db, attemptId).sessionId;
  if (!missing.length || !cleanEnd(session) || !resume || !sessionId) return session;
  const unit = getUnit(db, getAttempt(db, attemptId).unitId);
  recordEvent(db, "records.reminded", { projectId: unit.projectId, unitId: unit.id, attemptId }, { role, missing });
  return resume(renderRecordReminder(missing), sessionId);
}

// What another agent or the developer is shown of a finished attempt: what it recorded, then the report it wrote.
export function attemptAccount(db: Db, attemptId: AttemptId, reportPath: string | null): string | null {
  const recorded = describeRecords(db, attemptId);
  const report = reportPath && existsSync(reportPath) ? readFileSync(reportPath, "utf8").trim() : null;
  if (!recorded) return report;
  return report ? `${recorded}\n\nIts report:\n${report}` : recorded;
}

// An attempt's handoff, read from what it recorded.
export const savedHandoff = (db: Db, attemptId: AttemptId): Handoff | null => recordedHandoff(db, attemptId);

export interface ExitFacts {
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  finalText: string | null;
  finalIsError: boolean;
  stderrTail: string;
}

export function classifyFailure(f: ExitFacts): FailureMode {
  const text = `${f.finalText ?? ""}\n${f.stderrTail}`.toLowerCase();
  if (f.timedOut) return "timebox";
  if (f.exitCode === 137 || f.signal === "SIGKILL" || /out of memory|oomkilled/.test(text)) return "oom";
  if (/prompt is too long|context (window|length)|maximum context/.test(text)) return "context-exhausted";
  if (/fetch failed|etimedout|econn|socket hang up|enotfound|network/.test(text)) return "network";
  if (/tool_use_failed|tool-error|tool error/.test(text)) return "tool-error";
  if (f.finalIsError || (f.exitCode !== null && f.exitCode !== 0)) return "harness-error";
  return "unknown";
}

export function syntheticFailureHandoff(p: {
  unit: string;
  attempt: number;
  mode: FailureMode;
  branch: string | null;
  startedAt: string;
  endedAt: string;
  lastActivity: string | null;
  facts: ExitFacts;
}): string {
  if (!(FAILURE_MODES as readonly string[]).includes(p.mode)) throw new Error(`unknown failure mode ${p.mode}`);
  return `<!-- yagura synthetic failure handoff: unit ${p.unit} attempt ${p.attempt} mode ${p.mode} -->
## Status
blocked

## Branch
${p.branch ? `\`${p.branch}\`` : "(no branch)"}

## What I did
(the agent ended without a handoff; written by yagura)

## Failure
- mode: ${p.mode}
- exit: code ${p.facts.exitCode ?? "none"}, signal ${p.facts.signal ?? "none"}, timed out: ${p.facts.timedOut}
- started: ${p.startedAt}
- ended: ${p.endedAt}
- last activity: ${p.lastActivity ?? "(none)"}
- final message: ${p.facts.finalText ? p.facts.finalText.slice(0, 500) : "(none)"}
- stderr tail: ${p.facts.stderrTail.slice(-500) || "(empty)"}
`;
}
