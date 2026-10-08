import type { Attempt, Sha } from "./domain.js";

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

// Why a worker is building again: its first round, the judge's findings, a conflict with the base, or a fresh start after a failure.
export type WorkerRound =
  | { kind: "first" }
  | { kind: "changes"; findings: string[] }
  | { kind: "conflict"; base: string; baseSha: Sha; files: string[] }
  | { kind: "fresh"; reason: string }
  | { kind: "lead"; note: string };

export function roundText(r: WorkerRound): string {
  switch (r.kind) {
    case "first":
      return "Build the unit's goal.";
    case "changes":
      return `The judge looked at your work and asked for changes:\n${r.findings.map((f) => `- ${f}`).join("\n")}`;
    case "conflict":
      return `yagura could not merge \`${r.base}\` (now at ${r.baseSha}) into your branch; these files conflict:\n${r.files.map((f) => `- ${f}`).join("\n")}\n\nMerge the base into your branch with \`git merge ${r.baseSha}\`, resolve those files, run the tests, commit the merge, and hand off. Never rebase.`;
    case "fresh":
      return `A fresh worker takes over: ${r.reason}. The branch keeps what earlier workers committed.`;
    case "lead":
      return `Your unit lead sends the unit back to you: ${r.note}`;
  }
}

export interface ResumePrompt {
  unit: string;
  attempt: number;
  resumes: number;
  branch: string;
  round: WorkerRound;
  timeboxMinutes: number;
  report: string;
}

export function renderResumePrompt(p: ResumePrompt): string {
  return `# yagura: your unit is back with you

This is attempt ${p.attempt} of ${p.unit}, resuming your own session from attempt ${p.resumes}. You are in the same checkout on the same branch \`${p.branch}\`, brought up to date with anything yagura merged into it. Do what is asked below, commit, and hand off again. Everything in your brief still holds.

## WHY
${roundText(p.round)}

## TIMEBOX
${p.timeboxMinutes} ${p.timeboxMinutes === 1 ? "minute" : "minutes"} for this round.

## REPORT
${p.report}`;
}
