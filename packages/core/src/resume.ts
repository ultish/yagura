import type { Attempt, Unit } from "./domain.js";

export function contextWindow(model: string | null): number {
  return /1m|\[1m\]/.test(model ?? "") ? 1_000_000 : 200_000;
}

export type ResumeChoice = { resume: Attempt; fresh: null } | { resume: null; fresh: string | null };

// A worker that is sent back (changes asked, a conflict) resumes its own session, which keeps its context, unless that session is
// gone, cannot resume, or is nearly full.
export function chooseResume(attempts: Attempt[], opts: { enabled: boolean; canResume: boolean; maxContext: number }): ResumeChoice {
  const last = attempts.filter((a) => a.role === "worker" || a.role === null).at(-1);
  if (!last || last.state !== "handed_off") return { resume: null, fresh: null };
  const fresh = (why: string): ResumeChoice => ({ resume: null, fresh: `attempt ${last.n} ${why}` });
  if (!opts.enabled) return fresh("is not resumed: resume is off");
  if (!opts.canResume) return fresh(`ran on ${last.harness}, which cannot resume`);
  if (!last.sessionId || !last.worktreePath || !last.branch || !last.baseSha) return fresh("left no session to resume");
  const share = last.contextPeak / contextWindow(last.model);
  if (share > opts.maxContext) return fresh(`peaked at ${Math.round(share * 100)}% of its context window`);
  return { resume: last, fresh: null };
}

export interface ResumePrompt {
  unit: string;
  attempt: number;
  resumes: number;
  branch: string;
  why: string;
  timeboxMinutes: number;
  report: string;
}

export function renderResumePrompt(p: ResumePrompt): string {
  return `# yagura: your unit was sent back

This is attempt ${p.attempt} of ${p.unit}, resuming your own session from attempt ${p.resumes}. You are in the same worktree on the same branch \`${p.branch}\`; your earlier commits are still there. Do what is asked below, commit, and hand off again. Everything in your brief still holds: METHOD and FORBIDDEN.

## WHY
${p.why}

## TIMEBOX
${p.timeboxMinutes} ${p.timeboxMinutes === 1 ? "minute" : "minutes"} for this round.

## REPORT
${p.report}`;
}

// What the unit was last told, which a resumed worker reads first.
export const sendBackReason = (unit: Unit) => unit.notes.at(-1) ?? "changes were asked for";
