import { listSteers } from "./steer.js";
import type { Bootstrap } from "./config.js";
import { listDisagreements, type Disagreement } from "./disagreements.js";
import { ROLE_NAMES, spendsAttempt, type Attempt, type IsoTime, type LeadAction, type Unit, type UnitId, type UnitState } from "./domain.js";
import { getMergeRequest } from "./forge.js";
import { getEvidenceRun } from "./evidence.js";
import { getProject, getRepo, getUnit, listAttempts, listGates, type Db, type Gate } from "./store.js";
import { dependencyEdges, type DepEdge } from "./chain.js";
import { getRecord } from "./records.js";
import type { WorkerRound } from "./resume.js";

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
  // The event that placed the entry; entries are in this order.
  id: number;
  at: IsoTime;
  actor: Actor;
  who: string;
  attempt: { id: number; unitSeq: number; n: number; agentNo: number; model: string | null; costUsd: number } | null;
  status: { text: string; tone: "pine" | "amber" | "bell" | "muted" } | null;
  body: string | null;
  lines: StoryLine[];
  folded: { summary: string; items: string[] } | null;
  // The state the unit was in, and the worker round it belonged to (0 before the first build).
  state: UnitState | null;
  round: number;
}
export interface StateMove {
  id: number;
  at: IsoTime;
  from: UnitState;
  to: UnitState;
}
export interface StoryRound {
  n: number;
  at: IsoTime;
  text: string;
}
export interface UnitStory {
  unit: Unit;
  projectId: string;
  base: string | null;
  pr: { number: number; url: string; repo: string; draft: boolean } | null;
  costUsd: number;
  started: IsoTime | null;
  ended: IsoTime | null;
  moves: StateMove[];
  rounds: StoryRound[];
  entries: StoryEntry[];
  agents: StoryAgent[];
  // What is happening now and why, for the top of the page.
  now: { headline: string; detail: string[] };
  running: { attemptId: number; agentNo: number; role: string; startedAt: IsoTime } | null;
  gates: Gate[];
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

type Ev = { id: number; ts: IsoTime; type: string; attempt_id: number | null; data: Record<string, unknown> };

export const LEAD_ACTION_TEXT: Record<LeadAction, string> = {
  resume: "sent the worker back",
  fresh: "started a fresh worker",
  answer: "answered the judge",
  reply: "replied on the pull request",
  ask: "asked you",
  replan: "asked the project lead to change the plan",
  drop: "dropped the unit",
};

const WAKE_TEXT: Record<string, string> = {
  stuck: "the worker getting stuck",
  "judge-asks": "the judge's question",
  rounds: "round after round of changes",
  "ci-failed": "CI failing twice",
  conflict: "a conflict the worker could not resolve",
  developer: "your note",
};
const wakeText = (trigger: unknown, pr: number | null) =>
  trigger === "comment" ? `a comment on ${pr ? `PR #${pr}` : "the pull request"}` : (WAKE_TEXT[String(trigger)] ?? String(trigger));

const roleName = (a: Attempt) => {
  const name = a.role ? ROLE_NAMES[a.role] : "agent";
  return name[0]!.toUpperCase() + name.slice(1);
};

const findLast = <T>(xs: readonly T[], f: (x: T) => boolean): T | undefined => {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return xs[i];
  return undefined;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

function roundText(n: number, r: WorkerRound | undefined, by: Ev | undefined, pr: number | null): string {
  const after = by ? `, after ${wakeText(by.data.trigger, pr)}` : "";
  switch (r?.kind) {
    case undefined:
    case "first":
      return `Round ${n} · first build`;
    case "changes":
      return `Round ${n} · sent back by the judge`;
    case "conflict":
      return `Round ${n} · ${r.base} moved: a conflict in ${r.files.join(", ")}`;
    case "fresh":
      return `Round ${n} · a fresh worker${by ? ` from the unit lead${after}` : ""}`;
    case "lead":
      return `Round ${n} · sent back by the unit lead${after}`;
  }
}

export function unitStory(db: Db, _boot: Bootstrap, unit: Unit): UnitStory {
  const project = getProject(db, unit.projectId);
  const events = (
    db.prepare("SELECT id, ts, type, attempt_id, data_json FROM events WHERE unit_id = ? ORDER BY id").all(unit.id) as (Omit<Ev, "data"> & {
      data_json: string;
    })[]
  ).map(({ data_json, ...e }): Ev => ({ ...e, data: JSON.parse(data_json) as Record<string, unknown> }));
  const mr = getMergeRequest(db, unit.id);
  const attempts = listAttempts(db, unit.id);
  const disagreements = listDisagreements(db, { unitId: unit.id });

  const moves: StateMove[] = events
    .filter((e) => e.type === "unit.state")
    .map((e) => ({ id: e.id, at: e.ts, from: e.data.from as UnitState, to: e.data.to as UnitState }));
  const rounds: (StoryRound & { id: number })[] = [];
  if (unit.type === "work")
    for (const e of events.filter((x) => x.type === "unit.state" && x.data.to === "building")) {
      const by = e.data.by === "lead" ? findLast(events, (x) => x.type === "lead.decided" && x.id < e.id) : undefined;
      rounds.push({
        id: e.id,
        n: rounds.length + 1,
        at: e.ts,
        text: roundText(rounds.length + 1, e.data.round as WorkerRound | undefined, by, mr?.number ?? null),
      });
    }
  const placed = (id: number) => ({
    id,
    state: findLast(moves, (m) => m.id <= id)?.to ?? null,
    round: rounds.filter((r) => r.id <= id).length,
  });
  const firstEvent = (attemptId: number) => events.find((e) => e.attempt_id === attemptId)?.id ?? 0;

  const line = (ref: string, kind: LineKind, text: string, checks: StoryCheck[] = []): StoryLine => ({
    ref,
    kind,
    text,
    checks,
    disagreements: disagreements.filter((d) => d.ref === ref),
  });
  // A run an agent cites is checked against what yagura recorded: the command, and how it ended.
  const runLine = (ref: string, id: number): StoryLine => {
    const run = (() => {
      try {
        return getEvidenceRun(db, id);
      } catch {
        return null;
      }
    })();
    if (!run) return line(ref, "claimed", `run:${id}`, [{ ok: false, text: "yagura has no such run" }]);
    const ok = run.exitCode === 0 && !run.timedOut && !run.tampered;
    const how = run.timedOut ? "timed out" : run.tampered ? "tampered" : `exit ${run.exitCode}`;
    return line(ref, "claimed", `run:${id} \`${run.command}\` · ${how}`, [{ ok, text: "checked by yagura against runs it recorded" }]);
  };
  const citedRuns = (texts: string[]) => [...new Set(texts.flatMap((t) => [...t.matchAll(/\brun:(\d+)\b/g)].map((m) => Number(m[1]))))];
  const attemptOf = (u: Unit, a: Attempt) => ({ id: a.id, unitSeq: u.seq, n: a.n, agentNo: a.agentNo, model: a.model, costUsd: a.costUsd });
  const entries: StoryEntry[] = [];

  const planner = plannerOf(db, unit);
  if (planner) {
    const finished = db.prepare("SELECT data_json FROM events WHERE type = 'plan.drain_finished' AND unit_id = ?").get(planner.unit.id) as
      { data_json: string } | undefined;
    entries.push({
      ...placed(0),
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
  for (const a of attempts) {
    if (!a.startedAt) continue;
    const ref = `a${a.id}`;
    const h = a.role === "worker" || a.role === null ? getRecord(db, a.id, "handoff") : null;
    const judge = a.role === "judge" ? getRecord(db, a.id, "judge") : null;
    const decision = a.role === "lead" ? getRecord(db, a.id, "decision") : null;
    const running = a.state === "running" || a.state === "queued";
    if (!h && !judge && !decision && !running) {
      folded.push(`A${a.agentNo}: ${a.state}${a.failureMode ? ` (${a.failureMode})` : ""}${spendsAttempt(a) ? "" : ", not counted"}`);
      continue;
    }
    const entry: StoryEntry = {
      ...placed(firstEvent(a.id)),
      at: a.startedAt,
      actor: a.role === "judge" ? "judge" : a.role === "lead" ? "lead" : "worker",
      who: roleName(a),
      attempt: attemptOf(unit, a),
      status: null,
      body: null,
      lines: [],
      folded: folded.length ? { summary: `${folded.length} earlier tr${folded.length === 1 ? "y" : "ies"} did not count`, items: folded } : null,
    };
    const resumed = a.resumesAttemptId ? attempts.find((x) => x.id === a.resumesAttemptId) : undefined;
    if (h) {
      entry.status = { text: h.status === "done" ? "handed off" : "stuck", tone: h.status === "done" ? "amber" : "bell" };
      const said = h.did[0] ?? (h.status === "stuck" ? h.reason : null);
      const did = said ? said[0]!.toUpperCase() + said.slice(1) : null;
      const at = a.headSha ? ` at ${a.headSha.slice(0, 7)}` : "";
      entry.body = [
        resumed ? `Resumed A${resumed.agentNo}'s session.` : null,
        did ? `${did}${/[.!?]$/.test(did) ? "" : "."}` : null,
        at && h.status === "done" ? `Handed off${at}.` : null,
      ]
        .filter(Boolean)
        .join(" ");
      entry.lines = [
        ...(h.status === "stuck" && h.reason && h.did.length ? [line(`${ref}:claimed:0`, "claimed", `Stuck: ${h.reason}`)] : []),
        ...citedRuns(h.evidence).map((id) => runLine(`${ref}:run:${id}`, id)),
        ...h.decisions.map((t, i) => line(`${ref}:chose:${i}`, "chose", t)),
        ...h.notes.map((t, i) => line(`${ref}:noted:${i}`, "noted", t)),
      ];
    } else if (judge) {
      entry.status = {
        text: judge.verdict === "approve" ? "approved" : judge.verdict === "changes" ? "changes" : "asks",
        tone: judge.verdict === "approve" ? "pine" : judge.verdict === "changes" ? "amber" : "bell",
      };
      const looked = a.headSha ? ` ${a.headSha.slice(0, 7)}` : "";
      entry.body =
        judge.verdict === "approve"
          ? `Approved${looked}.`
          : judge.verdict === "changes"
            ? `Sent it back with ${plural(judge.findings.length, "finding")}.`
            : `Asks: ${judge.question}`;
      entry.lines = [...judge.findings.map((f, i) => line(`${ref}:claimed:${i}`, "claimed", f)), ...judge.runs.map((id) => runLine(`${ref}:run:${id}`, id))];
    } else if (decision) {
      const woke = events.find((e) => e.type === "lead.woken" && e.attempt_id === a.id);
      entry.status = { text: LEAD_ACTION_TEXT[decision.action], tone: decision.action === "ask" ? "bell" : "amber" };
      entry.body = decision.question ?? decision.note ?? decision.reply;
      entry.lines = [
        ...(woke ? [line(`${ref}:noted:woke`, "noted", `Woken by ${wakeText(woke.data.trigger, mr?.number ?? null)}.`)] : []),
        line(`${ref}:chose:0`, "chose", decision.reason),
      ];
    } else {
      entry.status = { text: "working", tone: "amber" };
      entry.body = a.role === "judge" ? `Judging${a.headSha ? ` ${a.headSha.slice(0, 7)}` : ""} now.` : a.role === "lead" ? "Deciding now." : "Building now.";
    }
    entries.push(entry);
    folded = [];
  }

  for (const a of attempts)
    for (const st of listSteers(db, a.id)) {
      const ev = events.find((e) => e.type === "attempt.steered" && e.data.steer === st.id);
      entries.push({
        ...placed(ev?.id ?? firstEvent(a.id)),
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
    }

  const yagura = (e: Ev, who: string, status: StoryEntry["status"], body: string | null, lines: StoryLine[] = []): StoryEntry => ({
    ...placed(e.id),
    at: e.ts,
    actor: "yagura",
    who,
    attempt: null,
    status,
    body,
    lines,
    folded: null,
  });
  const base = unit.base ?? (unit.repoId ? getRepo(db, unit.repoId).defaultBranch : null);
  for (const e of events) {
    const to = e.data.to as UnitState | undefined;
    if (e.type === "pr.opened")
      entries.push(
        yagura(e, "yagura", { text: "draft", tone: "muted" }, `Pushed ${unit.branch ?? "the branch"} and opened PR #${String(e.data.number)} as a draft.`),
      );
    else if (e.type === "unit.base_merged")
      entries.push(
        yagura(
          e,
          "yagura",
          { text: "base merged", tone: "muted" },
          `Merged ${base ?? "the base"} into the branch cleanly, at ${String(e.data.head).slice(0, 7)}.`,
        ),
      );
    else if (e.type === "ci.rerun")
      entries.push(
        yagura(
          e,
          "yagura",
          { text: "CI failed", tone: "bell" },
          `CI failed on ${String(e.data.head).slice(0, 7)} (${(e.data.failing as string[]).join(", ")}); yagura ran it again.`,
        ),
      );
    else if (e.type === "gate.answered")
      entries.push({ ...yagura(e, "You", { text: "answered", tone: "pine" }, String(e.data.answer === "land" ? "merge" : e.data.answer)), actor: "person" });
    else if (e.type === "unit.state" && to === "ready")
      entries.push(
        yagura(
          e,
          "yagura",
          { text: "ready", tone: "pine" },
          `${mr ? `PR #${mr.number} is out of draft` : "Ready"}: the judge approved ${String(e.data.head ?? "").slice(0, 7)}. It merges when CI passes${project.mergePolicy === "human" ? " and you say merge" : ""}.`,
        ),
      );
    else if (e.type === "unit.state" && to === "merged")
      entries.push(
        yagura(e, "yagura", { text: "merged", tone: "pine" }, `Merged into ${base ?? "the base"} with a merge commit.`, [
          ...(unit.mergedSha ? [line("merged", "landed", `Merged as ${unit.mergedSha.slice(0, 10)}.`)] : []),
        ]),
      );
    else if (e.type === "unit.state" && (to === "stuck" || to === "dropped"))
      entries.push(yagura(e, "yagura", { text: to, tone: "bell" }, e.data.reason ? String(e.data.reason) : null));
    else if (e.type === "unit.state" && e.data.reason && (to === "judging" || to === "waiting") && e.data.by !== "lead")
      entries.push(yagura(e, "yagura", { text: to, tone: "muted" }, String(e.data.reason)));
  }

  for (const d of disagreements) {
    const ev = events.find((e) => e.type === "disagreement.recorded" && e.data.disagreement === d.id);
    entries.push({
      ...placed(ev?.id ?? Number.MAX_SAFE_INTEGER),
      at: d.createdAt,
      actor: "person",
      who: "You disagreed",
      attempt: null,
      status: { text: d.state === "planned" && d.followUpUnitId ? `following up with unit U${getUnit(db, d.followUpUnitId).seq}` : d.state, tone: "bell" },
      body: `About ${d.about}: ${d.reason}`,
      lines: [],
      folded: null,
    });
  }

  // What yagura had to do about an agent's records: a reminder, a refused command.
  const refusedSoFar = new Map<StoryEntry, number>();
  for (const x of events) {
    if (!x.attempt_id || !["command.rejected", "records.reminded"].includes(x.type)) continue;
    const e = entries.find((en) => en.attempt?.id === x.attempt_id && en.actor !== "person");
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
  entries.sort((a, b) => a.id - b.id || a.at.localeCompare(b.at));
  const live = attempts.find((a) => a.state === "running");
  const gates = listGates(db, project.id, "open").filter((g) => g.unitId === unit.id);
  const merged = moves.find((m) => m.to === "merged");
  return {
    unit,
    projectId: project.id,
    base,
    pr: mr ? { number: mr.number, url: mr.url, repo: mr.forgeRepo, draft: mr.status?.draft ?? !["ready", "merged"].includes(unit.state) } : null,
    costUsd: attempts.reduce((s, a) => s + a.costUsd, 0),
    agents: agentsOf(db, unit, attempts, planner),
    now: nowOf(unit, { entries, rounds, gates, events, mr: mr ? { number: mr.number } : null, base, running: live ?? null, deps: dependencyEdges(db, unit) }),
    running: live?.startedAt ? { attemptId: live.id, agentNo: live.agentNo, role: roleName(live), startedAt: live.startedAt } : null,
    gates,
    dependencies: dependencyEdges(db, unit),
    started: entries.find((e) => e.actor !== "planner")?.at ?? null,
    ended: merged?.at ?? null,
    moves,
    rounds: rounds.map(({ n, at, text }) => ({ n, at, text })),
    entries,
  };
}

function nowOf(
  unit: Unit,
  s: {
    entries: StoryEntry[];
    rounds: StoryRound[];
    gates: Gate[];
    events: Ev[];
    mr: { number: number } | null;
    base: string | null;
    running: Attempt | null;
    deps: DepEdge[];
  },
): UnitStory["now"] {
  const last = (actor: Actor) => findLast(s.entries, (e) => e.actor === actor && e.status?.text !== "working");
  const reason = String(findLast(s.events, (e) => e.type === "unit.state")?.data.reason ?? "");
  const round = s.rounds.length;
  const pr = s.mr ? `PR #${s.mr.number}` : "the pull request";
  const finding = (e: StoryEntry | undefined) => e?.lines.filter((l) => l.kind === "claimed" && !l.ref.includes(":run:")).map((l) => l.text) ?? [];
  const agent = s.running ? `A${s.running.agentNo}` : null;
  switch (unit.state) {
    case "waiting": {
      const before = s.deps.filter((d) => d.direction === "needs" && d.other.state !== "merged");
      return before.length
        ? { headline: `Waiting for ${before.map((d) => `U${d.other.seq}`).join(", ")} to merge.`, detail: [] }
        : { headline: "Queued. A worker starts when an agent slot is free.", detail: reason ? [reason] : [] };
    }
    case "building": {
      const r = s.rounds.at(-1);
      const judge = last("judge");
      const cause = r?.text.replace(/^Round \d+ · /, "") ?? "";
      const why = round > 1 ? [`${cause[0]!.toUpperCase()}${cause.slice(1)}.`, ...finding(judge)] : [];
      return {
        headline: agent ? `Worker ${agent} is building round ${round}.` : `A worker starts round ${round} next.`,
        detail: why,
      };
    }
    case "judging": {
      const worker = last("worker");
      const judge = last("judge");
      const sentBack = judge && judge.status?.text === "changes" && round > 1 ? [`Round ${round - 1} was sent back: ${finding(judge).join("; ")}`] : [];
      return {
        headline: agent ? `Judge ${agent} is looking at round ${round}.` : `The judge looks at round ${round} next.`,
        detail: [...sentBack, ...(worker?.body ? [`Worker A${worker.attempt!.agentNo}: ${worker.body}`] : [])],
      };
    }
    case "ready": {
      const judge = last("judge");
      const merge = s.gates.find((g) => g.kind === "land");
      const said = judge ? `Judge A${judge.attempt!.agentNo}: ${judge.body ?? "approved."}` : "The judge approved it.";
      return merge
        ? { headline: "Approved. Waits for your go to merge.", detail: [said, `${pr} is out of draft.`] }
        : { headline: "Approved. Waits for CI and the merge.", detail: [said, `${pr} is out of draft.`] };
    }
    case "merged":
      return {
        headline: `Merged into ${s.base ?? "its base"}${unit.mergedSha ? ` as ${unit.mergedSha.slice(0, 7)}` : ""}.`,
        detail: [`${plural(round, "round")} of work${s.mr ? `, ${pr}` : ""}.`],
      };
    case "stuck": {
      const ask = s.gates.find((g) => g.kind === "lead") ?? s.gates[0];
      if (ask) return { headline: "Waits for you.", detail: [reason, `Its unit lead asks you: ${ask.question}`].filter(Boolean) };
      if (s.running) return { headline: `Its unit lead ${agent} is deciding.`, detail: reason ? [reason] : [] };
      return { headline: "Stuck.", detail: reason ? [reason] : ["No reason was recorded."] };
    }
    case "dropped":
      return { headline: "Dropped.", detail: reason ? [reason] : [] };
  }
}

function agentsOf(db: Db, unit: Unit, attempts: Attempt[], planner: { unit: Unit; attempt: Attempt } | null): StoryAgent[] {
  const rows: StoryAgent[] = [];
  const add = (u: Unit, a: Attempt, shared: boolean) => {
    if (!a.startedAt) return;
    const h = a.role === "worker" ? getRecord(db, a.id, "handoff") : null;
    const judge = a.role === "judge" ? getRecord(db, a.id, "judge") : null;
    const decision = a.role === "lead" ? getRecord(db, a.id, "decision") : null;
    const counted = a.state === "handed_off" && spendsAttempt(a);
    const outcome = judge
      ? judge.verdict
      : decision
        ? decision.action
        : a.state === "handed_off"
          ? (h?.status ?? "handed off")
          : a.state === "running"
            ? "running"
            : a.state === "stopped"
              ? "stopped"
              : "failed";
    const tone = outcome === "running" ? "amber" : !counted ? "bell" : outcome === "done" || outcome === "approve" ? "pine" : "amber";
    const note = h
      ? (h.did[0] ?? h.reason)
      : judge
        ? (judge.question ?? judge.findings[0] ?? null)
        : decision
          ? decision.reason
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
