// The commands an agent records its work with (§27), and how each is called. The briefs and the commands share these lines.
export const RECORD_COMMANDS = ["handoff", "judge", "decide", "plan", "check-done"] as const;
export type RecordCommand = (typeof RECORD_COMMANDS)[number];

export const RECORD_USAGE: Record<RecordCommand, string> = {
  handoff: 'yagura handoff done [--did "…"] [--evidence "run:12"] [--decision "…"] [--note "…"] [--follow-up "…"]  |  yagura handoff stuck --reason "…"',
  judge:
    'yagura judge approve --runs <id,…>  |  yagura judge changes --finding "<file:line> what is wrong" [--finding "…"]  |  yagura judge ask --question "…"',
  decide: 'yagura decide <action> --reason "…" [--note "…"] [--question "…"]',
  plan: "yagura plan --file <delta.json>   (or --file - for stdin, or --json '<delta>' inline)",
  "check-done": "yagura check-done   (says what you still have to record)",
};

// The REPORT section of a brief: what the role records and how, generated from the same usage lines the commands check against.
export function recordInstructions(commands: Exclude<RecordCommand, "check-done">[], notes: string[] = []): string {
  return [
    "Record your work with these yagura commands as you go. yagura reads only what you record, never your final message, and each command tells you at once if a value is wrong, so fix it and run it again:",
    ...commands.map((c) => `- \`${RECORD_USAGE[c]}\``),
    ...notes,
    `- \`${RECORD_USAGE["check-done"]}\``,
    "",
    "Then end with a short report for the developer, in any form: what you did and why. yagura shows it on your agent page and never reads it.",
  ].join("\n");
}
