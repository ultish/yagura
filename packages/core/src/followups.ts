import { HANDOFF_TEMPLATE } from "./brief.js";
import type { PromptRole } from "./prompts.js";
import { renderResumePrompt } from "./resume.js";
import { scopeNote } from "./runner.js";
import { renderScopeAsk } from "./triage.js";
import { renderRetry, renderRetryInSession, renderWatchmanUpdate } from "./watchman.js";

export interface FollowUp {
  when: string;
  text: string;
}

// Every message yagura may send an agent after its brief, rendered by the same functions that send it, with
// placeholders in angle brackets where a real run fills in its own facts.
export function followUps(role: PromptRole): FollowUp[] {
  const steer: FollowUp = {
    when: "You send it a message while it runs (any agent that can take one)",
    text: "<your message, exactly as you typed it; the agent reads it after its current step>",
  };
  const resume = (why: string, runs: boolean) =>
    renderResumePrompt({
      unit: "<project>/U<n>",
      attempt: 2,
      resumes: 1,
      branch: "<the attempt's branch>",
      why,
      runs: runs
        ? [
            {
              id: 0,
              label: "<scenario>",
              command: "<the verifier's command>",
              outcome: "exit 1",
              trunk: "exit 1",
              scripts: [],
              tail: "<the last lines of its output>",
            },
          ]
        : [],
      verifierReport: runs ? "<the verifier's report>" : null,
      timeboxMinutes: 30,
      report: HANDOFF_TEMPLATE,
    });
  switch (role) {
    case "worker":
    case "pack":
      return [
        {
          when: "The verifier rejected its work: the same session resumes, once",
          text: resume("The verifier rejected your work: <the verifier's reason>", true),
        },
        {
          when: "It changed a path outside SCOPE without a reason: the same session resumes, once",
          text: resume(scopeNote(1, ["<path>"], false), false),
        },
        steer,
      ];
    case "review-triage":
      return [{ when: "Its fix changed a path outside SCOPE without a reason: asked in the same session, once", text: renderScopeAsk(["<path>"]) }, steer];
    case "manager":
      return [
        {
          when: "Every decision after the first on a unit: the same session resumes with only what changed",
          text: "# yagura manager brief\n\nYou are the manager of <project>/U<n>. This session continues your earlier decisions about it: below is what changed since your last one.\n\n## WHY YOU WERE WOKEN\n<what happened to the unit>\n\n## THE UNIT NOW\n<its state, tries, and your earlier decisions>\n\n## WHAT HAPPENED SINCE YOUR LAST DECISION\n<each agent run since, with its handoff, verdicts, and notes>",
        },
        {
          when: "The session cannot be resumed: the whole record again, in a new session",
          text: "<the same brief with ## THE RECORD in place of the changes: everything yagura knows about the unit>",
        },
        steer,
      ];
    case "watchman":
      return [
        {
          when: "Every turn after the first in a session: only what changed",
          text: renderWatchmanUpdate({
            changes: "<new or changed decisions, questions, proposals, specs, and statuses>",
            mentioned: "<what the message mentions>",
            message: { id: 0, body: "<your message>" },
          }),
        },
        {
          when: "yagura rejected the records in its reply: retried in the same session, once",
          text: renderRetryInSession("<why yagura rejected the records>"),
        },
        {
          when: "The same, when the session cannot be resumed: the full brief again",
          text: renderRetry("<the full brief>", "<its previous reply>", "<why yagura rejected the records>"),
        },
      ];
    default:
      return [steer];
  }
}
