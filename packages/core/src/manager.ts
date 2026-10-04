import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseHandoff } from "./handoff.js";
import { attemptRecorder, runAgentSession, write, type RunContext } from "./agent.js";
import { resolveSetting } from "./config.js";
import { MANAGER_ACTIONS, TERMINAL_STATES, spendsAttempt, type Attempt, type AttemptId, type ManagerAction, type Unit, type UnitId } from "./domain.js";
import { valueMap } from "./envvalues.js";
import { queueInvestigation } from "./investigate.js";
import { amendmentContext } from "./amend.js";
import { extractDelta, applyDelta, PlanRejected, scopesOverlap } from "./plan.js";
import { layout } from "./paths.js";
import { promptPlugin, standingFor } from "./prompts.js";
import { chooseResume } from "./resume.js";
import { failurePolicy } from "./schedule.js";
import {
  addGate,
  addUnit,
  addUnitNote,
  bumpMaxAttempts,
  createAttempt,
  getAttempt,
  getGate,
  getProject,
  getUnit,
  listAttempts,
  listDeps,
  listUnits,
  now,
  recordEvent,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { WATCHMAN_DENIED_TOOLS } from "./watchman.js";
import { watchmanGuardSettings } from "./watchman-guard.js";

export interface ManagerDecision {
  id: number;
  unitId: UnitId;
  managerUnitId: UnitId;
  attemptId: number | null;
  wake: string;
  action: ManagerAction;
  reason: string;
  note: string | null;
  tries: number;
  gateId: number | null;
  createdAt: string;
}

const toDecision = (r: Record<string, unknown>): ManagerDecision => ({
  id: r.id as number,
  unitId: r.unit_id as UnitId,
  managerUnitId: r.manager_unit_id as UnitId,
  attemptId: (r.attempt_id as number | null) ?? null,
  wake: r.wake as string,
  action: r.action as ManagerAction,
  reason: r.reason as string,
  note: (r.note as string | null) ?? null,
  tries: r.tries as number,
  gateId: (r.gate_id as number | null) ?? null,
  createdAt: r.created_at as string,
});

export const listManagerDecisions = (db: Db, unitId: UnitId): ManagerDecision[] =>
  (db.prepare("SELECT * FROM manager_decisions WHERE unit_id = ? ORDER BY id").all(unitId) as Record<string, unknown>[]).map(toDecision);

const managerUnits = (db: Db, target: Unit) => listUnits(db, target.projectId).filter((u) => u.type === "manager" && u.targetUnitId === target.id);

export const liveManagerUnit = (db: Db, target: Unit): Unit | null => managerUnits(db, target).find((u) => !TERMINAL_STATES.has(u.state)) ?? null;

export const managerOn = (db: Db, unit: Unit): boolean =>
  unit.type === "work" && resolveSetting(db, "manager.enabled", { projectId: unit.projectId, repoId: unit.repoId }).value;

// The attempts a unit has had, counted the way a decision records them, so a decision belongs to one state of the unit.
const triesOf = (db: Db, unit: Unit) => listAttempts(db, unit.id).length;

// Decisions that count toward the cap: all but the fixed rules stepping in.
const spent = (ds: ManagerDecision[]) => ds.filter((d) => d.action !== "fallback").length;

// A manager woken by a worker's note, not by a failure, has only `relay` and `ignore` to choose from.
const NOTE_ACTIONS: readonly ManagerAction[] = ["relay", "ignore"];
export const isNoteWake = (manager: Unit) => manager.context[1] === "note";
// The developer asked the unit lead to look at a stuck unit, with a note.
export const isAskedWake = (manager: Unit) => manager.context[1] === "asked";
const STUCK = new Set(["failed", "rejected", "blocked"]);
const failureDecisions = (ds: ManagerDecision[]) => ds.filter((d) => !NOTE_ACTIONS.includes(d.action));

const liveSiblings = (db: Db, target: Unit) =>
  listUnits(db, target.projectId).filter((u) => u.id !== target.id && u.type === "work" && u.repoId === target.repoId && !TERMINAL_STATES.has(u.state));

export type ManagerNeed = { kind: "wake"; wake: string } | { kind: "waiting" } | { kind: "cap"; cap: number } | { kind: "answered"; answer: string | null };

// What a failed or rejected build unit needs from its unit lead now, or null when the fixed rules should decide.
export function managerNeed(db: Db, target: Unit): ManagerNeed | null {
  if (!managerOn(db, target)) return null;
  // A unit blocked after the developer asked for a look is also woken once more for the findings of an investigation it asked for.
  const continuing = target.state === "blocked" && listManagerDecisions(db, target.id).at(-1)?.action === "investigate";
  if (target.state !== "failed" && target.state !== "rejected" && !continuing) return null;
  if (liveManagerUnit(db, target)) return { kind: "waiting" };
  const ds = failureDecisions(listManagerDecisions(db, target.id));
  const last = ds.at(-1);
  const tries = triesOf(db, target);
  const cap = resolveSetting(db, "manager.max_decisions_per_unit", { projectId: target.projectId, repoId: target.repoId }).value;
  if (last?.action === "investigate" && last.tries === tries) {
    // The unit lead asked to find something out: it waits for the investigator, then is woken once with what it found.
    const inv = listUnits(db, target.projectId)
      .filter((u) => u.type === "investigate" && u.targetUnitId === target.id && u.id > last.managerUnitId)
      .at(-1);
    if (inv && !TERMINAL_STATES.has(inv.state) && inv.state !== "failed" && inv.state !== "blocked") return { kind: "waiting" };
    if (inv && !managerUnits(db, target).some((m) => m.id > inv.id)) {
      if (spent(ds) > cap) return { kind: "cap", cap };
      return {
        kind: "wake",
        wake: `The investigation U${inv.seq} you asked for ${inv.state === "done" ? "has finished" : "failed"}: ${inv.context[0] ?? inv.goal}`,
      };
    }
    return null;
  }
  if (last && last.tries === tries) {
    if (last.action !== "ask" || !last.gateId) return null;
    const gate = getGate(db, last.gateId);
    return gate.state === "open" ? { kind: "waiting" } : { kind: "answered", answer: gate.answer };
  }
  if (spent(ds) >= cap) return { kind: "cap", cap };
  const why = db
    .prepare(
      "SELECT data_json FROM events WHERE unit_id = ? AND type = 'unit.state' AND json_extract(data_json, '$.to') IN ('rejected', 'failed') ORDER BY id DESC LIMIT 1",
    )
    .get(target.id) as { data_json: string } | undefined;
  const reason = (why ? (JSON.parse(why.data_json) as { reason?: string }).reason : null) ?? null;
  return { kind: "wake", wake: `U${target.seq} was ${target.state}${reason ? `: ${reason}` : ""}` };
}

export function queueManager(db: Db, target: Unit, wake: string, kind: "failure" | "note" | "asked" = "failure"): Unit {
  const unit = addUnit(db, {
    projectId: target.projectId,
    type: "manager",
    repoId: target.repoId,
    targetUnitId: target.id,
    goal: `Decide what happens to U${target.seq}: ${target.goal}`,
    writeScope: [],
    acceptance: [],
    verify: null,
    context: kind === "failure" ? [wake] : [wake, kind],
    timeboxSeconds: resolveSetting(db, "timebox.verify_seconds", { projectId: target.projectId, repoId: target.repoId }).value,
    maxAttempts: 1,
  });
  transitionUnit(db, unit.id, "ready", { target: target.seq });
  recordEvent(db, "manager.queued", { projectId: target.projectId, unitId: target.id }, { wake, managerUnit: unit.seq });
  return getUnit(db, unit.id);
}

// The developer asks the unit lead to look at a stuck unit now, with a note; it answers with the usual menu. Not limited by the decision cap.
export function wakeManager(db: Db, target: Unit, note: string): { ok: true; unit: Unit } | { ok: false; reason: string } {
  if (target.type !== "work") return { ok: false, reason: `U${target.seq} is a ${target.type} unit; only work units have a unit lead` };
  if (!managerOn(db, target)) return { ok: false, reason: "the unit lead is switched off for this project (manager.enabled)" };
  if (!STUCK.has(target.state)) return { ok: false, reason: `U${target.seq} is ${target.state}; the unit lead looks at blocked, failed, or rejected units` };
  if (liveManagerUnit(db, target)) return { ok: false, reason: `U${target.seq}'s unit lead is already deciding` };
  return {
    ok: true,
    unit: queueManager(
      db,
      target,
      `The developer asked you to look at U${target.seq} now${note.trim() ? `: ${note.trim().replace(/[.!?]+$/, "")}. Answer what they wrote first.` : "."}`,
      "asked",
    ),
  };
}

// A fresh builder was chosen for this very state of the unit, so the runner does not resume the last session.
export function managerForcesFresh(db: Db, unit: Unit): boolean {
  const last = failureDecisions(listManagerDecisions(db, unit.id)).at(-1);
  return !!last && last.action === "fresh" && last.tries === triesOf(db, unit);
}

const NO_NOTE = new Set(["", "none", "n/a", "nothing", "no notes"]);

// What a work unit's latest handoff says other units must know, or null when it says nothing.
function handoffNote(db: Db, boot: RunContext["boot"], target: Unit): { attempt: Attempt; note: string } | null {
  const attempt = listAttempts(db, target.id)
    .filter((a) => a.state === "handed_off")
    .at(-1);
  const file = attempt ? layout(boot).handoff(target.projectId, target.seq, attempt.n) : null;
  const handoff = file && existsSync(file) ? parseHandoff(readFileSync(file, "utf8")) : null;
  const lines = (handoff?.forOthers ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => !NO_NOTE.has(l.replace(/[.()]/g, "").toLowerCase()));
  return attempt && lines.length ? { attempt, note: lines.join("\n") } : null;
}

// Wakes the unit lead of a healthy work unit whose worker left a note while other units are live in its repo, once per attempt.
export function wakeOnNote(db: Db, boot: RunContext["boot"], target: Unit): Unit | null {
  if (!managerOn(db, target) || TERMINAL_STATES.has(target.state) || target.state === "failed" || target.state === "rejected" || target.state === "ready")
    return null;
  if (liveManagerUnit(db, target) || !liveSiblings(db, target).length) return null;
  const found = handoffNote(db, boot, target);
  if (!found) return null;
  const seen = db
    .prepare("SELECT 1 FROM events WHERE type = 'manager.note_woken' AND unit_id = ? AND json_extract(data_json, '$.attemptId') = ?")
    .get(target.id, found.attempt.id);
  if (seen) return null;
  recordEvent(db, "manager.note_woken", { projectId: target.projectId, unitId: target.id }, { attemptId: found.attempt.id });
  return queueManager(db, target, `The worker of U${target.seq} says other units must know: ${excerpt(found.note, 600)}`, "note");
}

// A manager unit that failed or crashed before deciding: the fixed rules decide, and the record says so.
export function settleManagerUnit(db: Db, manager: Unit): void {
  if (manager.type !== "manager" || !manager.targetUnitId) return;
  const target = getUnit(db, manager.targetUnitId);
  const has = db.prepare("SELECT 1 FROM manager_decisions WHERE manager_unit_id = ?").get(manager.id);
  if (!has)
    recordDecision(
      db,
      target,
      manager,
      null,
      isNoteWake(manager) || isAskedWake(manager) ? "ignore" : "fallback",
      "the unit lead session failed before it decided",
      null,
      null,
    );
  transitionUnit(db, manager.id, "abandoned", { reason: "the unit lead session failed; the fixed rules decide" });
}

function recordDecision(
  db: Db,
  target: Unit,
  manager: Unit,
  attemptId: number | null,
  action: ManagerAction,
  reason: string,
  note: string | null,
  gateId: number | null,
): void {
  db.prepare(
    "INSERT INTO manager_decisions (unit_id, manager_unit_id, attempt_id, wake, action, reason, note, tries, gate_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(target.id, manager.id, attemptId, manager.context[0] ?? "", action, reason, note, triesOf(db, target), gateId, now());
  recordEvent(
    db,
    "manager.decided",
    { projectId: target.projectId, unitId: target.id, attemptId: (attemptId ?? undefined) as AttemptId | undefined },
    { action, reason, note, managerUnit: manager.seq },
  );
}

export type Decision =
  | { ok: true; action: Exclude<ManagerAction, "fallback">; reason: string; note: string | null; question: string | null; to: string | null }
  | { ok: false; problem: string };

const MENU = MANAGER_ACTIONS.filter((a): a is Exclude<ManagerAction, "fallback"> => a !== "fallback");

// "## Decision" with "action:", "reason:", and optionally "note:" or "question:" lines.
export function parseDecision(text: string): Decision {
  // The report is the last thing in the answer, but the analysis above it may use a "## Decision" heading of its own, so the
  // sections are tried from the last to the first and the first usable one wins.
  const heads = [...text.matchAll(/^##\s+Decision\s*$/gim)];
  if (!heads.length) return { ok: false, problem: "the answer has no ## Decision section" };
  let problem: Decision | null = null;
  for (let i = heads.length - 1; i >= 0; i--) {
    const found = parseDecisionSection(text.slice(heads[i]!.index + heads[i]![0].length));
    if (found.ok) return found;
    problem ??= found;
  }
  return problem!;
}

function parseDecisionSection(rest: string): Decision {
  const end = rest.search(/^##\s/m);
  const fields = new Map<string, string>();
  let key: string | null = null;
  for (const line of (end === -1 ? rest : rest.slice(0, end)).split("\n")) {
    const kv = /^(action|reason|note|question|to)\s*:\s*(.*)$/i.exec(line.trim());
    if (kv) {
      key = kv[1]!.toLowerCase();
      fields.set(key, kv[2]!.trim());
    } else if (key && line.trim()) fields.set(key, `${fields.get(key)} ${line.trim()}`);
  }
  const action = fields.get("action")?.toLowerCase().replace(/[`"']/g, "");
  if (!action || !(MENU as readonly string[]).includes(action))
    return { ok: false, problem: `its Decision section has no usable "action:" line (one of ${MENU.join(", ")})` };
  const reason = fields.get("reason");
  if (!reason) return { ok: false, problem: "the decision has no reason" };
  return {
    ok: true,
    action: action as (typeof MENU)[number],
    reason,
    note: fields.get("note") || null,
    question: fields.get("question") || null,
    to: fields.get("to") || null,
  };
}

const ROLE_OF_UNIT: Record<string, string> = {
  work: "worker",
  pack: "pack writer",
  verify: "verifier",
  review: "reviewer",
  "review-triage": "review triage",
  rebase: "rebase",
  investigate: "investigator",
};

function excerpt(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n… (cut; the whole file is at the path above)` : t;
}

// Everything yagura knows about the agents that worked on the unit after `afterAttemptId`, trouble first.
function record(db: Db, ctx: RunContext, target: Unit, afterAttemptId: number): string[] {
  const units = [target, ...listUnits(db, target.projectId).filter((u) => u.targetUnitId === target.id && u.type !== "plan" && u.type !== "manager")];
  const rows = units.flatMap((u) => listAttempts(db, u.id).map((a) => ({ u, a }))).filter((x) => x.a.id > afterAttemptId);
  rows.sort((x, y) => x.a.id - y.a.id);
  const paths = layout(ctx.boot);
  const out: string[] = [];
  for (const { u, a } of rows) {
    const role = ROLE_OF_UNIT[u.type] ?? u.type;
    const file = paths.handoff(u.projectId, u.seq, a.n);
    const handoff = existsSync(file) ? readFileSync(file, "utf8") : null;
    const facts = [
      `${a.state}${a.failureMode ? ` (${a.failureMode})` : ""}`,
      a.handoffStatus ? `handoff ${a.handoffStatus}` : null,
      a.rejection ? `rejected for ${a.rejection}` : null,
      a.missingSkills.length ? `skipped skills: ${a.missingSkills.join(", ")}` : null,
      `$${a.costUsd.toFixed(2)}`,
    ].filter(Boolean);
    out.push(`### A${a.agentNo} ${role} · ${facts.join(" · ")}\n${handoff ? `Handoff (${file}):\n${excerpt(handoff, 1800)}` : "No handoff was recorded."}`);
  }
  const events = db
    .prepare(
      `SELECT ts, type, data_json FROM events WHERE unit_id = ? AND type IN ('verify.outcome', 'unit.note', 'disagreement.recorded', 'gate.answered', 'attempt.beyond_scope', 'rebase.done', 'consumer.repinned')
       ORDER BY id DESC LIMIT 12`,
    )
    .all(target.id) as { ts: string; type: string; data_json: string }[];
  const later = events.reverse().filter((e) => e.ts > (afterAttemptId ? (getAttempt(db, afterAttemptId as never).startedAt ?? "") : ""));
  for (const e of later) out.push(`- ${e.type}: ${excerpt(e.data_json, 400)}`);
  return out;
}

function managerBrief(db: Db, ctx: RunContext, manager: Unit, target: Unit, previous: Attempt | null, resumed: boolean): string {
  const project = getProject(db, target.projectId);
  const attempts = listAttempts(db, target.id);
  const used = attempts.filter(spendsAttempt).length;
  const policy = failurePolicy(target, attempts);
  const decisions = listManagerDecisions(db, target.id);
  const worker = resolveSetting(db, "role.worker.harness", { projectId: project.id, repoId: target.repoId }).value;
  const choice = chooseResume(attempts, {
    enabled: resolveSetting(db, "work.resume_on_rejection", { projectId: project.id, repoId: target.repoId }).value,
    canResume: ctx.adapters[worker]?.canResume ?? false,
    maxContext: resolveSetting(db, "work.resume_max_context", { projectId: project.id, repoId: target.repoId }).value,
  });
  const canResume = Boolean(choice.resume && choice.resume.worktreePath && existsSync(choice.resume.worktreePath));
  const dependents = listDeps(db, project.id).filter((d) => d.dependsOn === target.id && d.kind !== "scope-overlap").length;
  const siblings = listUnits(db, project.id).filter(
    (u) => u.id !== target.id && u.type === "work" && u.repoId === target.repoId && !TERMINAL_STATES.has(u.state),
  );
  const sibling = (u: Unit) =>
    `- U${u.seq} (${u.state}): ${u.goal}; writes ${u.writeScope.join(", ") || "(unspecified)"}${scopesOverlap(target.writeScope, u.writeScope) ? " (overlaps this unit)" : ""}`;
  const noteWake = isNoteWake(manager);
  const since = resumed && previous ? previous.id : 0;
  const seen = record(db, ctx, target, since);
  const standing = standingFor(db, project.id, "manager");
  return `# yagura manager brief

You are the manager of ${project.id}/U${target.seq}. ${resumed ? "This session continues your earlier decisions about it: below is what changed since your last one." : "This is your first decision about it: below is its whole record."} yagura's records, not this session, are the truth.

## WHY YOU WERE WOKEN
${manager.context[0] ?? `U${target.seq} needs a decision`}

## THE UNIT NOW
- U${target.seq} (${target.repoId}): ${target.goal}
${target.description ? `- Why it exists: ${target.description}\n` : ""}- State: ${target.state}. Tries used: ${used} of ${target.maxAttempts}.
- Expected to write: ${target.writeScope.join(", ") || "(unspecified)"}
- Acceptance: ${target.acceptance.join("; ") || "(none)"}
${amendmentContext(db, target.id)
  .map((l) => `- ${l}\n`)
  .join("")}${
    noteWake
      ? ""
      : `- The fixed rules, without you, would ${policy.action === "retry" ? "retry it" : "block it"} (${policy.reason}).
- Resume the builder is ${canResume ? "available" : `not available${choice.fresh ? ` (${choice.fresh})` : ""}`}.
- ${dependents ? `${dependents} other unit(s) depend on this one, so it cannot be split; use planner instead.` : "Nothing depends on this unit, so it can be split."}
`
  }${siblings.length ? `\n## OTHER UNITS IN THIS REPO NOW\n${siblings.map(sibling).join("\n")}\n` : ""}${decisions.length ? `\n## YOUR EARLIER DECISIONS ON THIS UNIT\n${decisions.map((d) => `- ${d.action}: ${d.reason}${d.note ? ` (note: ${d.note})` : ""}`).join("\n")}\n` : ""}
## ${resumed ? "WHAT HAPPENED SINCE YOUR LAST DECISION" : "THE RECORD"}
${seen.length ? seen.join("\n\n") : "Nothing new is recorded."}

${
  noteWake
    ? `## THE MENU (pick exactly one)
- \`relay\`: give the note to other units that are live in this repo. Give \`to:\` (their U numbers, comma separated) and \`note:\` (what they should know, in your words). Relay only what changes how they work, such as an interface or a file this unit changed.
- \`ignore\`: the note matters to nobody else. Give a \`reason:\`.`
    : `## THE MENU (pick exactly one)
- \`resume\`: the same worker session continues with the findings and your note. Only when resume is available above.
- \`fresh\`: a new worker starts from trunk with your note. Use it when the old session went down a wrong path.
- \`split\`: replace this unit with smaller ones. Add a \`\`\`json plan delta with only "add" (the new units); this unit is cancelled. Not possible when other units depend on it.
- \`investigate\`: start an investigator, a worker that reads and runs things in a copy of the code, changes nothing, and reports findings. You are woken again with what it found, and decide then. Give \`question:\`, what it should find out. Use it when you cannot tell why the unit keeps failing.
- \`planner\`: block the unit and hand it to the planner, with your reason. Use it when the plan is the problem.
- \`ask\`: ask the developer; give a \`question:\`. They answer retry or stop.
- \`stop\`: block the unit for the developer.`
}

## REPORT
End your final message with:

## Status
success

## Decision
action: <one of the menu>
reason: <one or two sentences the developer will read>
note: <optional: what the next worker should do differently; for relay, what the other units should know>
question: <only for ask and investigate>
to: <only for relay: the U numbers>
${standing ? `\n## STANDING ORDERS\n${standing}\n` : ""}
## METHOD
Load the yagura-manager skill first and follow it. You may read files and use read-only \`yagura\` commands; change nothing.
`;
}

// The handoff's answer, checked and acted on. A problem means nothing was done and the fixed rules decide.
function applyDecision(
  ctx: RunContext,
  target: Unit,
  manager: Unit,
  d: Extract<Decision, { ok: true }>,
  text: string,
): { problem: string | null; gateId: number | null } {
  const { db } = ctx;
  if (isNoteWake(manager) !== NOTE_ACTIONS.includes(d.action))
    return { problem: `${d.action} is not on the menu for this wake (${isNoteWake(manager) ? "relay or ignore" : "a failure"})`, gateId: null };
  const tries = triesOf(db, target);
  const retry = (note: string | null) => {
    if (note) addUnitNote(db, target.id, `The unit lead says: ${note}`);
    bumpMaxAttempts(db, target.id, tries + 1);
    transitionUnit(db, target.id, "ready", { by: "manager", reason: d.reason });
  };
  switch (d.action) {
    case "fresh":
      retry(d.note);
      return { problem: null, gateId: null };
    case "resume": {
      const attempts = listAttempts(db, target.id);
      const worker = resolveSetting(db, "role.worker.harness", { projectId: target.projectId, repoId: target.repoId }).value;
      const choice = chooseResume(attempts, {
        enabled: resolveSetting(db, "work.resume_on_rejection", { projectId: target.projectId, repoId: target.repoId }).value,
        canResume: ctx.adapters[worker]?.canResume ?? false,
        maxContext: resolveSetting(db, "work.resume_max_context", { projectId: target.projectId, repoId: target.repoId }).value,
      });
      if (!choice.resume || !choice.resume.worktreePath || !existsSync(choice.resume.worktreePath))
        return { problem: `resume is not possible: ${choice.fresh ?? "the last session's worktree is gone"}`, gateId: null };
      retry(d.note);
      return { problem: null, gateId: null };
    }
    case "ignore":
      return { problem: null, gateId: null };
    case "investigate": {
      if (!d.question) return { problem: "an investigation needs a question", gateId: null };
      queueInvestigation(db, target, d.question);
      return { problem: null, gateId: null };
    }
    case "relay": {
      if (!d.note) return { problem: "a relay needs a note", gateId: null };
      const live = new Map(liveSiblings(db, target).map((u) => [u.seq, u]));
      const to = [...(d.to ?? "").matchAll(/U?(\d+)/gi)].map((m) => live.get(Number(m[1])));
      if (!to.length || to.some((u) => !u))
        return { problem: `to must name live units in this repo (${[...live.keys()].map((n) => `U${n}`).join(", ") || "none"})`, gateId: null };
      for (const u of new Set(to)) addUnitNote(db, u!.id, `The unit lead says, from U${target.seq}: ${d.note}`);
      return { problem: null, gateId: null };
    }
    case "stop":
    case "planner": {
      const reason = d.action === "stop" ? `the unit lead stopped it: ${d.reason}` : `the unit lead sent it to the project lead: ${d.reason}`;
      // A unit the developer asked about may already be blocked: it stays so, and the reason goes on its notes for the next reader.
      if (target.state === "blocked") addUnitNote(db, target.id, reason);
      else transitionUnit(db, target.id, "blocked", { by: "manager", reason });
      return { problem: null, gateId: null };
    }
    case "ask": {
      const gateId = addGate(db, {
        projectId: target.projectId,
        unitId: target.id,
        kind: "manager",
        question: `U${target.seq}: ${d.question ?? d.reason}`,
        options: ["retry", "stop"],
        defaultOption: "stop",
      });
      return { problem: null, gateId };
    }
    case "split": {
      if (listDeps(db, target.projectId).some((x) => x.dependsOn === target.id && x.kind !== "scope-overlap"))
        return { problem: "other units depend on this one, so it cannot be split; send it to the project lead", gateId: null };
      const extracted = extractDelta(text);
      if (!extracted.ok) return { problem: extracted.reason, gateId: null };
      const delta = extracted.delta;
      if (!delta.add.length) return { problem: "a split must add at least one unit", gateId: null };
      if (delta.amend.length || delta.retry.length || delta.gates.length || delta.done || delta.cancel.some((c) => c.unit !== `U${target.seq}`))
        return { problem: "a split may only add units (and cancel this one)", gateId: null };
      try {
        db.transaction(() => {
          transitionUnit(db, target.id, "abandoned", { by: "manager", reason: `split by the unit lead: ${d.reason}` });
          applyDelta(db, target.projectId, { ...delta, cancel: [] }, null);
        })();
      } catch (e) {
        if (e instanceof PlanRejected) return { problem: `the split was rejected: ${e.message}`, gateId: null };
        throw e;
      }
      return { problem: null, gateId: null };
    }
  }
}

// Acting on the developer's answer to a question the unit lead asked.
export function applyAskAnswer(db: Db, target: Unit, answer: string | null): void {
  if (answer === "retry") {
    bumpMaxAttempts(db, target.id, triesOf(db, target) + 1);
    addUnitNote(db, target.id, "The developer said to try again.");
    transitionUnit(db, target.id, "ready", { by: "developer" });
  } else transitionUnit(db, target.id, "blocked", { by: "developer", reason: "the unit lead asked and the developer chose to stop" });
}

export async function runManagerUnit(ctx: RunContext, unitId: UnitId): Promise<Attempt | null> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.type !== "manager" || !unit.targetUnitId) throw new Error(`U${unit.seq} is not a unit lead unit`);
  if (unit.state !== "ready") throw new Error(`U${unit.seq} is ${unit.state}, not ready`);
  const target = getUnit(db, unit.targetUnitId);
  const finish = () => {
    transitionUnit(db, unit.id, "handed_off", {});
    transitionUnit(db, unit.id, "done", {});
  };
  if (!isNoteWake(unit) && !(isAskedWake(unit) ? STUCK.has(target.state) : target.state === "failed" || target.state === "rejected")) {
    transitionUnit(db, unit.id, "running", { target: target.seq });
    recordEvent(db, "manager.skipped", { projectId: unit.projectId, unitId: target.id }, { reason: `U${target.seq} is ${target.state}` });
    finish();
    return null;
  }
  const project = getProject(db, unit.projectId);
  const sctx = { projectId: project.id, repoId: unit.repoId };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.manager.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);
  const dir = paths.managerDir(project.id, target.seq);
  mkdirSync(dir, { recursive: true });

  const earlier = managerUnits(db, target)
    .filter((m) => m.id !== unit.id)
    .flatMap((m) => listAttempts(db, m.id))
    .filter((a) => a.state === "handed_off")
    .sort((a, b) => a.id - b.id);
  const previous = earlier.at(-1) ?? null;
  const resumeId = adapter.canResume && previous?.sessionId ? previous.sessionId : undefined;

  const attempt = createAttempt(db, unit.id, harnessId, setting("role.manager.model"));
  const logPath = paths.log(project.id, unit.seq, attempt.n);
  transitionUnit(db, unit.id, "running", { attempt: attempt.n, target: target.seq });
  updateAttempt(db, attempt.id, { state: "running", startedAt: now(), resumesAttemptId: resumeId ? previous!.id : null });

  const ask = async (resume: string | undefined) => {
    const prompt = managerBrief(db, ctx, unit, target, previous, Boolean(resume));
    write(paths.brief(project.id, unit.seq, attempt.n), prompt);
    let started = false;
    const base = attemptRecorder(db, {
      attempt,
      unit,
      projectId: project.id,
      role: "manager",
      inheritedSkills: resume ? earlier.flatMap((a) => a.skills) : undefined,
    });
    const result = await runAgentSession(ctx, {
      recorder: {
        ...base,
        session: (e) => {
          started = true;
          base.session(e);
        },
      },
      adapter,
      run: {
        prompt,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.manager.model"),
        permissionMode: setting("harness.claude.watchman_permission_mode"),
        pluginDirs: [promptPlugin(db, boot, project.id, { attemptId: attempt.id, role: "manager" })],
        addDirs: [],
        extraArgs: setting("harness.claude.extra_args"),
        resume,
        allowedTools: setting("watchman.allowed_tools"),
        disallowedTools: WATCHMAN_DENIED_TOOLS,
        settings: watchmanGuardSettings(boot, setting("watchman.allowed_tools")),
      },
      cwd: dir,
      env: valueMap(db, project.environmentId),
      timeboxSeconds: unit.timeboxSeconds,
      logPath,
    });
    return { result, lost: Boolean(resume) && !started };
  };

  let run = await ask(resumeId);
  if (run.lost) {
    recordEvent(db, "manager.session_lost", { projectId: project.id, unitId: target.id, attemptId: attempt.id }, { resumed: previous?.sessionId });
    run = await ask(undefined);
  }
  const final = run.result.final;
  const text = final && !final.isError && !run.result.timedOut ? final.text : null;
  if (text) write(paths.handoff(project.id, unit.seq, attempt.n), text);
  updateAttempt(db, attempt.id, {
    state: text ? "handed_off" : "failed",
    endedAt: now(),
    exitCode: run.result.exitCode,
    handoffStatus: text ? "success" : null,
    ...(text ? {} : { failureMode: "unknown" as const }),
  });

  let action: ManagerAction = isNoteWake(unit) || isAskedWake(unit) ? "ignore" : "fallback";
  let reason = "";
  let note: string | null = null;
  let gateId: number | null = null;
  if (!text) reason = run.result.timedOut ? "the unit lead ran out of time" : "the unit lead ended without an answer";
  else if (run.result.missingSkills.length) reason = `the unit lead skipped required skills: ${run.result.missingSkills.join(", ")}`;
  else {
    const parsed = parseDecision(text);
    if (!parsed.ok) reason = parsed.problem;
    else {
      const applied = applyDecision(ctx, getUnit(db, target.id), unit, parsed, text);
      if (applied.problem) reason = `${parsed.action} was not possible: ${applied.problem}`;
      else {
        action = parsed.action;
        reason = parsed.reason;
        note = parsed.note;
        gateId = applied.gateId;
      }
    }
  }
  recordDecision(db, getUnit(db, target.id), unit, attempt.id, action, reason, note, gateId);
  finish();
  return getAttempt(db, attempt.id);
}
