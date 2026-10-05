// The commands an agent records its work with (§27), and how each is called. The briefs and the commands share these lines.
export const RECORD_COMMANDS = ["handoff", "verdict", "finding", "rule", "amend", "review-finding", "decide", "plan", "check-done"] as const;
export type RecordCommand = (typeof RECORD_COMMANDS)[number];

export const RECORD_USAGE: Record<RecordCommand, string> = {
  handoff:
    'yagura handoff <success|partial|blocked> [--tier <tier>] --did "…" [--did "…"] [--evidence "…"] [--outside-scope "<path>=<why>"] [--for-others "…"] [--decision "…"] [--note "…"] [--follow-up "…"] [--finding "…"]',
  verdict: 'yagura verdict <tier> --runs <id,…> [--pack-change "…"] [--decision "…"] [--note "…"]',
  finding: 'yagura finding <criterion number> <met|unmet> --runs <id,…> [--note "…"]',
  rule: 'yagura rule T<n> <fix|dismiss|ask> --reason "…"',
  amend:
    'yagura amend T<n> replace --from "<criterion exactly as ACCEPTANCE words it>" --to "…" | add --text "…" | remove --text "…" | verify --command "…" | clear',
  "review-finding": 'yagura review-finding <blocking|should|nit> <path>[:<line>] --text "…"',
  decide: 'yagura decide <action> --reason "…" [--note "…"] [--question "…"] [--to "…"]',
  plan: "yagura plan --file <delta.json>   (or --file - to read it from stdin)",
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
