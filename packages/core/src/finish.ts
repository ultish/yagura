import { existsSync, readFileSync } from "node:fs";
import type { SessionResult } from "./agent.js";
import type { AttemptId, Handoff, Role } from "./domain.js";
import { parseHandoff } from "./handoff.js";
import { missingRecords, noteFallback, recordedHandoff } from "./records.js";
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

// A finished attempt's handoff read again later (story, audit, follow-ups, notes to other units): its records, else its saved report.
export function savedHandoff(db: Db, attemptId: AttemptId, reportPath: string | null): Handoff | null {
  const report = reportPath && existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  return recordedHandoff(db, attemptId, report ?? "") ?? (report ? parseHandoff(report) : null);
}

// The handoff the engine acts on: from the records, or, while the roles move over, from the reports the session ended with
// (latest first: after a reminder the last one may be short), recorded as a fallback.
export function readHandoff(db: Db, attemptId: AttemptId, reports: (string | null)[]): Handoff | null {
  const texts = reports.filter((r): r is string => !!r);
  const recorded = recordedHandoff(db, attemptId, texts[0] ?? "");
  if (recorded || !texts.length) return recorded;
  const parsed = texts.map(parseHandoff).find((h) => h !== null) ?? null;
  noteFallback(db, attemptId, "parseHandoff", parsed !== null);
  return parsed;
}
