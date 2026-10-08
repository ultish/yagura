import { listSteers } from "./steer.js";
import type { Bootstrap } from "./config.js";
import { listDisagreements, type Disagreement } from "./disagreements.js";
import { ROLE_NAMES, spendsAttempt, type Attempt, type Handoff, type IsoTime, type LeadAction, type Unit, type UnitId } from "./domain.js";
import { getMergeRequest } from "./forge.js";
import { getProject, getUnit, listAttempts, listGates, type Db, type Gate } from "./store.js";
import { dependencyEdges, type DepEdge } from "./chain.js";
import { savedHandoff } from "./finish.js";
import { getRecord } from "./records.js";

// A unit's page reads as one story: who did what, what each chose, and what yagura checked about it. Agents' lines are
// judgment unless a check sits beside them; a check is something yagura proved from its own records.
export type LineKind = "claimed" | "chose" | "noted" | "landed";
export interface StoryCheck {
  ok: boolean;
  text: string;
}
export interface StoryLine {
  ref: string;
  kind: LineKind;
  text: string;
  checks: StoryCheck[];
  disagreements: Disagreement[];
}
export type Actor = "planner" | "worker" | "judge" | "lead" | "person" | "yagura";
export interface StoryEntry {
  at: IsoTime;
  actor: Actor;
  who: string;
  attempt: { id: number; unitSeq: number; n: number; agentNo: number; model: string | null; costUsd: number } | null;
  status: { text: string; tone: "pine" | "amber" | "bell" | "muted" } | null;
  body: string | null;
  lines: StoryLine[];
  folded: { summary: string; items: string[] } | null;
}
export interface LeadTurn {
  decisionId: number;
  attemptId: number | null;
  agentNo: number | null;
  at: IsoTime;
  wake: string;
  action: LeadAction;
  actionText: string;
  reason: string;
  note: string | null;
  costUsd: number;
  resumed: boolean;
}
export interface UnitStory {
  unit: Unit;
  projectId: string;
  pr: { number: number; url: string } | null;
  costUsd: number;
  started: IsoTime | null;
  ended: IsoTime | null;
  entries: StoryEntry[];
  agents: StoryAgent[];
  // Questions waiting for the developer about this unit.
  gates: Gate[];
  // The unit lead's wakes, oldest first: why it was woken, what it decided, and what it cost.
  lead: LeadTurn[];
  // The units this one comes after and the units that come after it, with where each link stands.
  dependencies: DepEdge[];
}
// Every session that worked on a unit: the planner run that planned it (shared with the units planned beside it) and its own attempts.
export interface StoryAgent {
  attemptId: number;
  role: string;
  unitSeq: number;
  n: number;
  agentNo: number;
  model: string | null;
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
  costUsd: number;
  outcome: string;
  tone: "pine" | "amber" | "bell" | "muted";
  counted: boolean;
  shared: boolean;
  note: string | null;
}

const bullets = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l && !/^\(?(none|n\/a|nothing)\.?\)?$/i.test(l));

type Ev = { id: number; ts: IsoTime; type: string; unit_id: number | null; attempt_id: number | null; data: Record<string, unknown> };

export const LEAD_ACTION_TEXT: Record<LeadAction, string> = {
  resume: "sent the worker back",
  fresh: "started a fresh worker",
  answer: "answered the judge",
  reply: "replied on the pull request",
  ask: "asked you",
  replan: "asked the project lead to change the plan",
  drop: "dropped the unit",
};

const roleName = (a: Attempt) => {
  const name = a.role ? ROLE_NAMES[a.role] : "agent";
  return name[0]!.toUpperCase() + name.slice(1);
};

// The planning round that created a unit: its job row, whose one attempt is the planner's session.
function plannerOf(db: Db, unit: Unit): { unit: Unit; attempt: Attempt } | null {
  if (!unit.createdByDrainId) return null;
  const row = db.prepare("SELECT planner_attempt_id FROM drains WHERE id = ?").get(unit.createdByDrainId) as { planner_attempt_id: number | null } | undefined;
  if (!row?.planner_attempt_id) return null;
  const owner = db.prepare("SELECT unit_id FROM attempts WHERE id = ?").get(row.planner_attempt_id) as { unit_id: UnitId } | undefined;
  if (!owner) return null;
  const planUnit = getUnit(db, owner.unit_id);
  const attempt = listAttempts(db, planUnit.id).find((a) => a.id === row.planner_attempt_id);
  return attempt ? { unit: planUnit, attempt } : null;
}

export function unitStory(db: Db, _boot: Bootstrap, unit: Unit): UnitStory {
  const project = getProject(db, unit.projectId);
  const events = (
    db.prepare("SELECT id, ts, type, unit_id, attempt_id, data_json FROM events WHERE unit_id = ? ORDER BY id").all(unit.id) as {
      id: number;
      ts: IsoTime;
      type: string;
      unit_id: number | null;
      attempt_id: number | null;
      data_json: string;
    }[]
  ).map((e): Ev => ({ ...e, data: JSON.parse(e.data_json) }));
  const disagreements = listDisagreements(db, { unitId: unit.id });
  const line = (ref: string, kind: LineKind, text: string, checks: StoryCheck[] = []): StoryLine => ({
    ref,
    kind,
    text,
    checks,
    disagreements: disagreements.filter((d) => d.ref === ref),
  });
  const judgment = (ref: string, h: Handoff) => [
    ...bullets(h.decisions).map((t, i) => line(`${ref}:chose:${i}`, "chose", t)),
    ...bullets(h.notes).map((t, i) => line(`${ref}:noted:${i}`, "noted", t)),
  ];
  const attemptOf = (u: Unit, a: Attempt) => ({ id: a.id, unitSeq: u.seq, n: a.n, agentNo: a.agentNo, model: a.model, costUsd: a.costUsd });
  const entries: StoryEntry[] = [];

  const planner = plannerOf(db, unit);
  if (planner) {
    const finished = db.prepare("SELECT data_json FROM events WHERE type = 'plan.drain_finished' AND unit_id = ?").get(planner.unit.id) as
      { data_json: string } | undefined;
    entries.push({
      at: (planner.attempt.startedAt ?? unit.createdAt) as IsoTime,
      actor: "planner",
      who: `Project lead · ${planner.unit.goal.toLowerCase()}`,
      attempt: attemptOf(planner.unit, planner.attempt),
      status: null,
      body: finished ? ((JSON.parse(finished.data_json) as { reason?: string }).reason ?? null) : null,
      lines: [],
      folded: null,
    });
  }

  let folded: string[] = [];
  for (const a of listAttempts(db, unit.id)) {
    if (!a.startedAt) continue;
    const ref = `a${a.id}`;
    const h = a.state === "handed_off" && a.role !== "judge" && a.role !== "lead" ? savedHandoff(db, a.id) : null;
    const judge = a.role === "judge" ? getRecord(db, a.id, "judge") : null;
    const decision = a.role === "lead" ? getRecord(db, a.id, "decision") : null;
    if (!h && !judge && !decision) {
      folded.push(`A${a.agentNo}: ${a.state}${a.failureMode ? ` (${a.failureMode})` : ""}${spendsAttempt(a) ? "" : ", not counted"}`);
      continue;
    }
    const entry: StoryEntry = {
      at: a.startedAt,
      actor: a.role === "judge" ? "judge" : a.role === "lead" ? "lead" : "worker",
      who: roleName(a),
      attempt: attemptOf(unit, a),
      status: null,
      body: null,
      lines: [],
      folded: folded.length ? { summary: `${folded.length} earlier tr${folded.length === 1 ? "y" : "ies"} did not count`, items: folded } : null,
    };
    if (h) {
      entry.status = { text: h.status === "done" ? "handed off" : "stuck", tone: h.status === "done" ? "amber" : "bell" };
      entry.body = bullets(h.whatIDid)[0] ?? null;
      entry.lines = [line(`${ref}:claimed:0`, "claimed", `Hands off ${h.status}${h.reason ? `: ${h.reason}` : ""}.`), ...judgment(ref, h)];
    } else if (judge) {
      entry.status = { text: judge.verdict, tone: judge.verdict === "approve" ? "pine" : judge.verdict === "changes" ? "amber" : "bell" };
      entry.lines = [
        ...(judge.question ? [line(`${ref}:claimed:0`, "claimed", judge.question)] : []),
        ...judge.findings.map((f, i) => line(`${ref}:claimed:${i}`, "claimed", f)),
        ...(judge.runs.length ? [line(`${ref}:noted:0`, "noted", `Rests on ${judge.runs.map((id) => `run:${id}`).join(", ")}.`)] : []),
      ];
    } else if (decision) {
      entry.status = { text: LEAD_ACTION_TEXT[decision.action], tone: "amber" };
      entry.body = decision.note;
      entry.lines = [line(`${ref}:chose:0`, "chose", `${LEAD_ACTION_TEXT[decision.action]}: ${decision.reason}`)];
    }
    entries.push(entry);
    folded = [];
  }

  for (const a of listAttempts(db, unit.id))
    for (const st of listSteers(db, a.id))
      entries.push({
        at: st.createdAt,
        actor: "person",
        who: `You told ${roleName(a)} A${a.agentNo}`,
        attempt: { id: a.id, unitSeq: unit.seq, n: a.n, agentNo: a.agentNo, model: a.model, costUsd: 0 },
        status:
          st.state === "delivered"
            ? { text: "read", tone: "pine" }
            : st.state === "undelivered"
              ? { text: `not read: ${st.reason}`, tone: "bell" }
              : { text: "waiting for its current step", tone: "amber" },
        body: st.body,
        lines: [],
        folded: null,
      });

  for (const e of events.filter((x) => x.type === "gate.answered"))
    entries.push({ at: e.ts, actor: "person", who: `You answered ${String(e.data.answer)}`, attempt: null, status: null, body: null, lines: [], folded: null });

  for (const e of events.filter((x) => x.type === "unit.state" && (x.data.to === "stuck" || x.data.to === "dropped")))
    entries.push({
      at: e.ts,
      actor: "yagura",
      who: e.data.to === "stuck" ? "Stuck" : "Dropped",
      attempt: null,
      status: { text: String(e.data.to), tone: "bell" },
      body: e.data.reason ? String(e.data.reason) : null,
      lines: [],
      folded: null,
    });

  for (const e of events.filter((x) => ["retro.passed", "retro.failed", "retro.reverted"].includes(x.type)))
    entries.push({
      at: e.ts,
      actor: "yagura",
      who: "After merging",
      attempt: null,
      status:
        e.type === "retro.passed"
          ? { text: "trunk CI passed", tone: "pine" }
          : e.type === "retro.failed"
            ? { text: "trunk CI failed", tone: "bell" }
            : { text: "reverted", tone: "bell" },
      body: `${String(e.data.detail ?? "")}${e.data.fixUnit ? `; ${e.type === "retro.failed" ? "fix" : "follow-up"} queued as U${getUnit(db, e.data.fixUnit as never).seq}` : ""}`,
      lines: [],
      folded: null,
    });

  for (const e of events.filter((x) => x.type === "publish.test" || x.type === "publish.failed"))
    entries.push({
      at: e.ts,
      actor: "yagura",
      who: "Test build",
      attempt: null,
      status: e.type === "publish.test" ? { text: `published ${String(e.data.version)}`, tone: "pine" } : { text: "publishing failed", tone: "bell" },
      body: e.data.reason ? String(e.data.reason) : null,
      lines: [],
      folded: null,
    });

  const merged = unit.type === "work" ? events.find((e) => e.type === "unit.state" && e.data.to === "merged") : undefined;
  if (merged)
    entries.push({
      at: merged.ts,
      actor: "yagura",
      who: "Merged",
      attempt: null,
      status: { text: unit.mergedSha ? `merged ${unit.mergedSha.slice(0, 7)}` : "merged", tone: "pine" },
      body: null,
      lines: unit.mergedSha ? [line("merged", "landed", `Merged as ${unit.mergedSha.slice(0, 10)}.`)] : [],
      folded: null,
    });

  for (const d of disagreements)
    entries.push({
      at: d.createdAt,
      actor: "person",
      who: "You disagreed",
      attempt: null,
      status: { text: d.state === "planned" && d.followUpUnitId ? `following up with unit U${getUnit(db, d.followUpUnitId).seq}` : d.state, tone: "bell" },
      body: `About ${d.about}: ${d.reason}`,
      lines: [],
      folded: null,
    });

  // What yagura had to do about an agent's records: a reminder, a refused command.
  const refusedSoFar = new Map<StoryEntry, number>();
  for (const x of events) {
    if (!x.attempt_id || !["command.rejected", "records.reminded"].includes(x.type)) continue;
    const e = entries.find((en) => en.attempt?.id === x.attempt_id);
    if (!e) continue;
    const ref = `a${x.attempt_id}:records:${x.id}`;
    if (x.type === "command.rejected") {
      const n = (refusedSoFar.get(e) ?? 0) + 1;
      refusedSoFar.set(e, n);
      if (n <= 3) e.lines.push(line(ref, "noted", `Tried yagura ${String(x.data.command)}`, [{ ok: false, text: `refused: ${String(x.data.problem)}` }]));
    } else
      e.lines.push(
        line(ref, "noted", `Ended without recording: ${(x.data.missing as string[]).join("; ")}`, [
          { ok: false, text: "yagura asked for it once, in the same session" },
        ]),
      );
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  const attempts = listAttempts(db, unit.id);
  const mr = getMergeRequest(db, unit.id);
  return {
    unit,
    projectId: project.id,
    pr: mr ? { number: mr.number, url: mr.url } : null,
    costUsd: attempts.reduce((s, a) => s + a.costUsd, 0),
    agents: agentsOf(db, unit, attempts, planner),
    gates: listGates(db, project.id, "open").filter((g) => g.unitId === unit.id),
    lead: [],
    dependencies: dependencyEdges(db, unit),
    started: entries[0]?.at ?? null,
    ended: merged?.ts ?? null,
    entries,
  };
}

function agentsOf(db: Db, unit: Unit, attempts: Attempt[], planner: { unit: Unit; attempt: Attempt } | null): StoryAgent[] {
  const rows: StoryAgent[] = [];
  const add = (u: Unit, a: Attempt, shared: boolean) => {
    if (!a.startedAt) return;
    const h = a.state === "handed_off" && a.role === "worker" ? savedHandoff(db, a.id) : null;
    const judge = a.role === "judge" ? getRecord(db, a.id, "judge") : null;
    const counted = a.state === "handed_off" && spendsAttempt(a);
    const outcome = judge
      ? judge.verdict
      : a.state === "handed_off"
        ? (h?.status ?? "handed off")
        : a.state === "running"
          ? "running"
          : a.state === "stopped"
            ? "stopped"
            : "failed";
    const tone = outcome === "running" ? "amber" : !counted ? "bell" : outcome === "done" || outcome === "approve" ? "pine" : "amber";
    const note = h
      ? (bullets(h.whatIDid)[0] ?? h.reason)
      : judge
        ? (judge.question ?? judge.findings[0] ?? null)
        : a.failureMode
          ? `failed: ${a.failureMode}`
          : null;
    rows.push({
      attemptId: a.id,
      role: roleName(a),
      unitSeq: u.seq,
      n: a.n,
      agentNo: a.agentNo,
      model: a.model,
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      costUsd: a.costUsd,
      outcome,
      tone,
      counted,
      shared,
      note,
    });
  };
  if (planner) add(planner.unit, planner.attempt, true);
  for (const a of attempts) add(unit, a, false);
  return rows.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}
