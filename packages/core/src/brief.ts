import type { RenderedBrief } from "./domain.js";
import { skillMethod } from "./skills.js";

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
  const env = Object.entries(b.env).map(([k, v]) => `${k}=${v}${b.envNotes?.[k] ? ` (${b.envNotes[k]})` : ""}`);
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

## Pack changes
- <each change you made to the verify pack and why, or "none">

## Decisions
- <what you chose to test and how, what you deliberately did not test, and why>

## Notes, concerns, deviations
- <anything the planner or the next worker must know>`;

export function packContract(p: { packPath: string; provider: string; leaseVars: string[]; minTier: string; reason: string }): string[] {
  return [
    `This is a pack unit. ${p.reason}. Write a verify pack at ${p.packPath}/ so yagura can verify every later change to this repo.`,
    `${p.packPath}/verify.json: {"provider": "${p.provider}", "doctor"?: cmd, "deploy"?: cmd, "teardown"?: cmd, "checks": [{"name": "unit", "command": cmd, "tier": tier, "timeoutSeconds"?: n}], "features": [{"name", "doc"}], "protected": [globs]}. Check names are lowercase words joined by dashes.`,
    "Every command runs through sh -c with the repo checkout as its working directory and these variables: YAGURA_AT (base or head), YAGURA_SHA, YAGURA_EVIDENCE (a directory; files written there are kept as evidence), and the slot's variables: " +
      `${p.leaseVars.join(", ")}, plus the environment's values under ENV (use them by name; a literal copy of a value in a file is rejected). Read nothing else from the machine; put scripts under ${p.packPath}/bin/ and one feature doc per user-facing feature under ${p.packPath}/features/.`,
    "doctor checks read-only that the environment is worth driving. deploy builds and starts the checkout in the slot; teardown removes only what deploy created. Leave out deploy and teardown when the checks need nothing running.",
    `Tiers, strongest first: deployed-verified, live-local-verified, e2e-verified, unit-verified, build-only. A check's tier is what its passing proves. This project needs at least ${p.minTier}.`,
    "yagura proves the pack on your branch head, with no agent: doctor, deploy, every check, then teardown must all exit 0 against the repo as it is now. Run them yourself the same way before you hand off.",
  ];
}

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
  envNotes: Record<string, string>;
  environmentNotes: string;
  deploys: boolean;
  timeboxMinutes: number;
  standing: string;
  skills: string[];
  pack: { copy: string; lifecycle: string[] };
  earlier: string[];
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

The command runs with the checkout as its working directory and prints a run id (run:<id>), the exit code, and the output. Use the same command on base and head so yagura can pair them. Files written to $YAGURA_EVIDENCE are kept as evidence. ${behaviour}${v.deploys ? "\n\nThe verify pack deploys into your slot: before a run on the other side, yagura tears down the deployed side and deploys this one (runs labelled pack:deploy / pack:teardown). Batch your runs by side to avoid redeploying." : ""}

Recipe from the unit: ${v.verifyRecipe}

## THE VERIFY PACK (yours to keep working)
yagura ran the pack before you started${v.pack.lifecycle.length ? `:\n${list(v.pack.lifecycle)}` : " (checks above)."}

Your editable copy is ${v.pack.copy}; every evidence run, on base and on head, uses your copy. If the pack is wrong (a command that cannot work, a deploy that no longer matches how the app runs) or does not check what this change built, fix or extend it there. Edit files only; do not run git. When you finish, yagura re-runs the doctor and every check on both sides with your copy, commits your edit on its own, and lands it after this unit. Say what you changed and why under Pack changes. For a pack that has drifted a long way, pstack:maintain-verification-skill guides a full pass.
${v.earlier.length ? `\n## EARLIER VERIFICATIONS OF THIS UNIT\n${list(v.earlier)}\n` : ""}
## ENV
${list(Object.entries(v.leaseVars).map(([k, val]) => `${k}=${val}${v.envNotes[k] ? ` (${v.envNotes[k]})` : ""}`))}${v.environmentNotes.trim() ? `\n\nAbout this environment: ${v.environmentNotes.trim()}` : ""}

## TIMEBOX
${v.timeboxMinutes} minutes.

## FORBIDDEN
- editing either checkout, committing, pushing, or touching git (your pack copy is the one thing you may edit)
- claiming a result you did not capture with evidence run

## METHOD
Load the yagura-verifier skill first and follow it.${skillMethod(v.skills)}

## REPORT
Your final message is your verdict; nothing else you write is read. Use exactly this structure:

${VERIFIER_HANDOFF_TEMPLATE}

## STANDING ORDERS
${v.standing.trim() || "(none)"}
`;
}

export interface PlanBrief {
  project: { id: string; goal: string; predicate: string; minTier: string };
  repos: { id: string; path: string; trunkSha: string }[];
  status: string;
  playbooks: readonly string[];
  standing: string;
  timeboxMinutes: number;
  specPath?: string | null;
  scaffoldSkills?: string[];
  references?: string[];
}

export function renderPlanBrief(p: PlanBrief): string {
  return `# yagura plan brief

You are the planner for project ${p.project.id}. You never write code. You read the project's state and the code, then return a plan delta: the next units of work for other agents. yagura validates your delta and applies all of it or none of it.

## GOAL
${p.project.goal}

## DONE WHEN
${p.project.predicate}
(minimum verification tier: ${p.project.minTier})

## CODE (read-only checkouts at trunk)
${list(p.repos.map((r) => `${r.id}: ${r.path} @ ${r.trunkSha}`))}
${p.specPath ? `\n## SPEC\nThe developer's living spec for this project is ${p.specPath}. Read it before planning; it is kept current by the watchman and outranks older assumptions.\n` : ""}
## CURRENT STATE (generated by yagura from its records)
${p.status}

## HOW TO PLAN
- Only plan what the state calls for. Do not re-add work that is running, verifying, landed, or queued.
- Each unit is one worker session in one repo: small enough for about ${Math.round(p.timeboxMinutes)} minutes of focused work, complete enough to verify on its own.
- \`write\` lists the paths the unit may change (globs). Units whose write scopes overlap in the same repo run one after another; give independent work disjoint scopes so it can run in parallel.
- \`accept\` lines are checkable statements a verifier can prove by running code, one behaviour each.
- \`verify\` is the command a worker runs to check itself (for example the repo's test command).
- \`deps\` names units that must land first: a key from this delta or an existing unit such as "U3".
- \`playbook\` is one of: ${p.playbooks.join(", ")}.
- \`scaffold\`: true marks the unit that builds a new project's skeleton. ${p.scaffoldSkills?.length ? `This project names scaffold skills (${p.scaffoldSkills.join(", ")}): when a repo has no project skeleton yet, make its first unit a scaffold unit and let later units build on it.` : "This project names no scaffold skills; leave it false."}${p.references?.length ? `\n- Workers get read-only checkouts of reference repos that already do it right (${p.references.join(", ")}); point at them in \`context\` when a unit should follow their shape.` : ""}
- \`refs\` (optional) lists issue keys the unit addresses, e.g. "gitlab#123"; the project's own refs are added automatically.
- A blocked or failed unit can be retried with a note that changes what the next attempt does, split into new units, or cancelled.
- Ask the human only for a product or preference decision no experiment can settle, with a default.
- Set "done": true only when the DONE WHEN condition is met by landed, verified work.

## METHOD
Load the yagura-planner skill first and follow it.

## REPORT
End your final message with exactly one fenced json block holding the delta:

\`\`\`json
{
  "add": [
    {
      "key": "discount-on-create",
      "repo": "${p.repos[0]?.id ?? "repo-id"}",
      "goal": "one sentence a stranger could execute",
      "write": ["app/**", "tests/**"],
      "accept": ["checkable statement", "another"],
      "verify": "python3 -m unittest discover -s tests -v",
      "context": ["files or docs to read first"],
      "playbook": "feature",
      "deps": [{ "on": "U1", "kind": "needs-landed" }]
    }
  ],
  "amend": [],
  "retry": [],
  "cancel": [],
  "gates": [],
  "done": false,
  "summary": "what this plan does and why"
}
\`\`\`

## STANDING ORDERS
${p.standing.trim() || "(none)"}
`;
}
