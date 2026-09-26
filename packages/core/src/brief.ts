import type { RenderedBrief } from "./domain.js";

export const HANDOFF_TEMPLATE = `## Status
success | partial | blocked

## Branch
\`<branch you committed to>\`

## What I did
- <high-level summary, per file if useful>

## Measurements
- <metric>: <before> -> <after>   (or "(none)")

## Verification
<one of: deployed-verified | live-local-verified | e2e-verified | unit-verified | build-only | not-verified>
Self-report the strongest evidence you produced for the change itself, not for it compiling.

## Evidence
- <what you ran> -> <outcome>

## Notes, concerns, deviations
- <assumptions, surprises, anything the planner must know>

## Suggested follow-ups
- <tasks worth publishing next>`;

export class UnfillableBrief extends Error {
  constructor(readonly missing: string[]) {
    super(`brief cannot be spawned; missing: ${missing.join(", ")}`);
  }
}

export function missingBriefFields(brief: Pick<RenderedBrief, "goal" | "scope" | "acceptance" | "verify">): string[] {
  const missing: string[] = [];
  if (!brief.goal.trim()) missing.push("GOAL");
  if (brief.scope.write.length === 0) missing.push("SCOPE");
  if (brief.acceptance.length === 0) missing.push("ACCEPTANCE");
  if (!brief.verify.trim()) missing.push("VERIFY");
  return missing;
}

const list = (items: string[], empty = "(none)") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);

export function renderBrief(b: RenderedBrief): string {
  const missing = missingBriefFields(b);
  if (missing.length) throw new UnfillableBrief(missing);
  const env = Object.entries(b.env).map(([k, v]) => `${k}=${v}`);
  return `# yagura brief

You are running inside yagura. You cannot ask questions: everything you need is below. Work only in your worktree, stay inside SCOPE, and end with the handoff in REPORT as your final message.

## GOAL
${b.goal}

## REPO
- repo: ${b.repo.id}
- worktree: ${b.repo.worktree} (your working directory)
- branch: ${b.repo.branch}, starts at ${b.repo.baseSha}
- commit your work to this branch; do not push

## SCOPE
May write:
${list(b.scope.write)}
Must not write:
${list(b.scope.forbid)}

## CONTEXT
${list(b.context)}

## READONLY
${list(b.readonly.map((r) => `${r.repoId} at ${r.path} @ ${r.sha}`))}

## ACCEPTANCE
${list(b.acceptance)}

## VERIFY
${b.verify}

## ENV
${list(env)}

## TIMEBOX
${b.timeboxMinutes} minutes. If you run out, stop and hand off what you have with Status: partial.

## FORBIDDEN
${list(b.forbidden)}

## METHOD
${b.method}

## REPORT
Your final message is your handoff; nothing else you write is read. Use exactly this structure:

${b.report}

## STANDING ORDERS
${b.standing.trim() || "(none)"}
`;
}

export const VERIFIER_HANDOFF_TEMPLATE = `## Status
success | blocked
(success = you reached a verdict; blocked = you could not)

## Verification
<one of: deployed-verified | live-local-verified | e2e-verified | unit-verified | build-only | verifier-failed | verifier-blocked>

## Evidence
- run:<id> <what this run shows>

## Findings
- [x] <acceptance criterion>: met, run:<id>
- [ ] <acceptance criterion>: not met, run:<id>, <what is wrong>

## Notes, concerns, deviations
- <anything the planner or the next worker must know>`;

export interface VerifyBrief {
  target: { seq: number; goal: string; playbook: string | null; baseSha: string; headSha: string };
  acceptance: string[];
  verifyRecipe: string;
  diff: string;
  checks: { name: string; tier: string; base: string; head: string }[];
  headPath: string;
  basePath: string;
  scenarioDir: string;
  cli: string;
  leaseVars: Record<string, string>;
  timeboxMinutes: number;
  standing: string;
}

const DIFF_LIMIT = 60_000;

export function renderVerifyBrief(v: VerifyBrief): string {
  const diff = v.diff.length > DIFF_LIMIT ? `${v.diff.slice(0, DIFF_LIMIT)}\n… (diff truncated; read the full change in the head checkout)` : v.diff;
  const behaviour =
    v.target.playbook === "refactoring" || v.target.playbook === "visual-parity"
      ? "This is a behaviour-preserving change: your scenario must behave the same on base and head, and pass."
      : "Your scenario must FAIL on base and PASS on head. A scenario that passes on base proves nothing and your verdict will be discarded.";
  return `# yagura verify brief

You are a verifier inside yagura. You did not write this change and must not trust any description of it. Decide from evidence whether U${v.target.seq} meets its acceptance criteria. yagura only accepts evidence it captured itself: every claim you make must cite a run id that \`evidence run\` gave you.

## GOAL
Verify U${v.target.seq}: ${v.target.goal}

## ACCEPTANCE (what the change must do)
${list(v.acceptance)}

## CHECKOUTS (read-only)
- head (the change): ${v.headPath} @ ${v.target.headSha}
- base (trunk before the change): ${v.basePath} @ ${v.target.baseSha}
Every evidence run starts from a clean checkout of that SHA, so edits you make there are discarded and flagged as tampering.

## THE CHANGE
\`\`\`diff
${diff}
\`\`\`

## PACK CHECKS (already run by yagura)
${list(v.checks.map((c) => `${c.name} (${c.tier}): base ${c.base}, head ${c.head}`))}

## HOW TO CAPTURE EVIDENCE
Write scenario scripts in your scratch directory ${v.scenarioDir} (your working directory), then run them through yagura on both checkouts:

    ${v.cli} evidence run --at base --label <name> -- <command>
    ${v.cli} evidence run --at head --label <name> -- <command>

The command runs with the checkout as its working directory and prints a run id (run:<id>), the exit code, and the output. Use the same command on base and head so yagura can pair them. Files written to $YAGURA_EVIDENCE are kept as evidence. ${behaviour}

Recipe from the unit: ${v.verifyRecipe}

## ENV
${list(Object.entries(v.leaseVars).map(([k, val]) => `${k}=${val}`))}

## TIMEBOX
${v.timeboxMinutes} minutes.

## FORBIDDEN
- editing either checkout, committing, pushing, or touching git
- claiming a result you did not capture with evidence run

## METHOD
Load the yagura-verifier skill first and follow it.

## REPORT
Your final message is your verdict; nothing else you write is read. Use exactly this structure:

${VERIFIER_HANDOFF_TEMPLATE}

## STANDING ORDERS
${v.standing.trim() || "(none)"}
`;
}
