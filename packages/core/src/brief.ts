import type { RenderedBrief } from "./domain.js";
import { recordInstructions } from "./record-usage.js";
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

## Decisions
- <each choice you made that the brief did not settle, what you deliberately did not do, and why>

## Outside scope
- <each path you changed that SCOPE did not list, and why the work needed it; "(none)" if you stayed inside>

## Notes, concerns, deviations
- <assumptions, surprises, anything the planner must know>

## For other units
- <only what other units running beside this one must know: a changed signature, a moved or renamed file, a convention you set; "none" if nothing>

## Suggested follow-ups
- <tasks worth publishing next>`;

// What a builder (worker, pack writer, rebase, fix worker) records when it finishes (§27).
export const WORKER_REPORT = recordInstructions(
  ["handoff"],
  [
    "- Status: success when the work is done, partial when you ran out of time with work left, blocked when you could not go on (say why with --note). Running it again replaces your handoff, so repeat everything you recorded before.",
    '- --did once per line of what you did. --tier: the strongest evidence you produced for the change itself, not for it compiling (deployed-verified, live-local-verified, e2e-verified, unit-verified, build-only, or not-verified). --evidence: what you ran and its outcome. --decision: each choice the brief did not settle, what you deliberately did not do, and why. --outside-scope "<path>=<why>": each path you changed that SCOPE did not list. --note: assumptions, surprises, anything the planner must know. --for-others: only what units running beside you must know (a changed signature, a moved file, a convention you set); leave it out when there is nothing. --follow-up: tasks worth doing next.',
  ],
);

// What an investigator records: its findings are the whole result (§26).
export const INVESTIGATION_REPORT = recordInstructions(
  ["handoff"],
  [
    "- --finding once per finding: what you found that answers the question, with the file, line, or command output that shows it; say plainly what you could not establish. --note: anything else the unit lead should know. Status: success, partial (out of time), or blocked.",
  ],
);

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

You are running inside yagura. You cannot ask questions: everything you need is below. Work only in your worktree, stay inside SCOPE where you can, and end with the handoff in REPORT as your final message.

## GOAL
${b.goal}

## REPO
- repo: ${b.repo.id}
- worktree: ${b.repo.worktree} (your working directory)
- branch: ${b.repo.branch}, starts at ${b.repo.baseSha}
- commit your work to this branch; do not push

## SCOPE
The planner's estimate of what this needs, made before the work existed. Prefer to stay inside it. If the work truly needs another file (a test for your change, a caller you must update), change it and list the path with the reason under "Outside scope" in your handoff; a path outside SCOPE with no reason is rejected, and the verifier and reviewer judge the reasons.
Expected to write:
${list(b.scope.write)}
Avoid (the planner's guess; justify if you must):
${list(b.scope.forbid)}
Never write (yagura rejects it):
${list(b.scope.hard ?? [])}

## CONTEXT
${list(b.context)}

## READONLY
${list(b.readonly.map((r) => `${r.repoId} at ${r.path} @ ${r.sha}${r.version ? `, published as ${r.version}: pin exactly this version wherever this repo depends on ${r.repoId}` : ""}`))}

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

export interface PlanBrief {
  project: { id: string; goal: string; predicate: string; minTier: string };
  repos: { id: string; path: string; trunkSha: string }[];
  status: string;
  playbooks: readonly string[];
  standing: string;
  timeboxMinutes: number;
  spec?: string | null;
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
${p.spec ? `\n## SPEC\nThe developer's living spec for this project, kept current by the watchman and the developer. Read it before planning; it outranks older assumptions.\n\n${p.spec.trim()}\n` : ""}
## CURRENT STATE (generated by yagura from its records)
${p.status}

## HOW TO PLAN
- Only plan what the state calls for. Do not re-add work that is running, verifying, landed, or queued.
- Each unit is one worker session in one repo: small enough for about ${Math.round(p.timeboxMinutes)} minutes of focused work, complete enough to verify on its own.
- \`write\` lists the paths you expect the unit to change (globs): an estimate, not a wall. A worker that needs more says why in its handoff and the reviewer judges it; only the verify pack is off limits. Leave out each repo's verify pack (\`.agents/verify\` unless the repo says otherwise): the verifiers keep it working, and a worker cannot change it. When the pack should check something new, say so in the unit's \`context\`; its verifier will extend the pack. A unit is a behaviour with its own tests, so put the test paths in its scope too. Units whose write scopes overlap in the same repo run one after another; give independent behaviours disjoint scopes so they can run in parallel, and never split tests into a unit of their own.
- \`why\` is one or two plain sentences telling the developer what the unit is for and why it exists now; the unit page shows it and the worker reads it. Give every unit one.
- \`accept\` lines are checkable statements a verifier can prove by running code, one behaviour each.
- \`verify\` is the command a worker runs to check itself (for example the repo's test command).
- \`deps\` names units that must land first: a key from this delta or an existing unit such as "U3".
- \`playbook\` is one of: ${p.playbooks.join(", ")}.
- \`scaffold\`: true marks the unit that builds a new project's skeleton. ${p.scaffoldSkills?.length ? `This project names scaffold skills (${p.scaffoldSkills.join(", ")}): when a repo has no project skeleton yet, make its first unit a scaffold unit and let later units build on it.` : "This project names no scaffold skills; leave it false."}${p.references?.length ? `\n- Workers get read-only checkouts of reference repos that already do it right (${p.references.join(", ")}); point at them in \`context\` when a unit should follow their shape.` : ""}
- \`disagreement\` (optional): when a unit fixes forward something the developer disagreed with (listed under "The developer disagrees" with a D number), set it to that number, e.g. 4 for D4. Every open disagreement needs such a unit, or a planner gate that asks the developer how to proceed.
- \`refs\` (optional) lists issue keys the unit addresses, e.g. "gitlab#123"; the project's own refs are added automatically.
- A blocked or failed unit can be retried with a note that changes what the next attempt does, split into new units, or cancelled.
- A unit that has not started can be amended in place, including its \`deps\` (the list replaces its old one). To move units off a blocked one, amend their deps; do not cancel and re-add them.
- Ask the human only for a product or preference decision no experiment can settle, with a default.
- Set "done": true only when the DONE WHEN condition is met by landed, verified work.

## METHOD
Load the yagura-planner skill first and follow it.

## REPORT
${recordInstructions(
  ["plan"],
  [
    "- Write the delta to a file in your scratch directory and record it with `yagura plan --file <path>`. yagura checks it the way applying it would (schema, repos, scopes, dependencies) and says at once what to fix; run it again with the corrected file. The delta has this shape:",
  ],
)}

\`\`\`json
{
  "add": [
    {
      "key": "discount-on-create",
      "repo": "${p.repos[0]?.id ?? "repo-id"}",
      "goal": "one sentence a stranger could execute",
      "why": "what this is for and why it comes now, in plain words",
      "write": ["app/**", "tests/**"],
      "accept": ["checkable statement", "another"],
      "verify": "python3 -m unittest discover -s tests -v",
      "context": ["files or docs to read first"],
      "playbook": "feature",
      "deps": [{ "on": "U1", "kind": "needs-landed" }]
    }
  ],
  "amend": [{ "unit": "U4", "deps": [{ "on": "discount-on-create" }] }],
  "retry": [{ "unit": "U2", "note": "what the next attempt must do differently" }],
  "cancel": [{ "unit": "U5", "reason": "why it is no longer needed" }],
  "gates": [],
  "done": false,
  "summary": "what this plan does and why"
}
\`\`\`

## STANDING ORDERS
${p.standing.trim() || "(none)"}
`;
}
