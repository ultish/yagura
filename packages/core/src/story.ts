import { listSteers } from "./steer.js";
import { existsSync, readFileSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import { listDisagreements, type Disagreement } from "./disagreements.js";
import { spendsAttempt, type ManagerAction, type Attempt, type Handoff, type IsoTime, type Unit, type UnitId } from "./domain.js";
import { getMergeRequest } from "./forge.js";
import { parseHandoff } from "./handoff.js";
import { liveVerdict } from "./land.js";
import { landWait } from "./publish.js";
import { listPackEdits } from "./packedits.js";
import { layout } from "./paths.js";
import { getGate, getProject, getUnit, listAttempts, listGates, listUnits, type Db, jobLabel, type Gate } from "./store.js";
import { isReviewThread, listThreadRows } from "./triage.js";
import { findingFates } from "./review.js";
import { describeOps, listAmendments } from "./amend.js";
import { listManagerDecisions, managerOn } from "./manager.js";

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
export type Actor = "planner" | "worker" | "verifier" | "reviewer" | "review-triage" | "rebase" | "pack" | "manager" | "person" | "yagura";
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
export interface ManagerTurn {
  decisionId: number;
  attemptId: number | null;
  agentNo: number | null;
  at: IsoTime;
  wake: string;
  action: ManagerAction;
  actionText: string;
  reason: string;
  note: string | null;
  costUsd: number;
  resumed: boolean;
}
export interface UnitStory {
  unit: Unit;
  projectId: string;
  tier: string | null;
  pr: { number: number; url: string } | null;
  costUsd: number;
  started: IsoTime | null;
  ended: IsoTime | null;
  entries: StoryEntry[];
  agents: StoryAgent[];
  // Questions waiting for the developer about this unit: land it.
  gates: Gate[];
  // The manager's wakes, oldest first: why it was woken, what it decided, and what it cost.
  manager: ManagerTurn[];
  managerOn: boolean;
}
// Every session that worked on a unit: the planner run that planned it (shared with the units it planned alongside),
// its own attempts, and the verifiers, triage, and rebases that targeted it.
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

type Ev = { id: number; ts: IsoTime; type: string; unit_id: number | null; data: Record<string, unknown> };

export function unitStory(db: Db, boot: Bootstrap, unit: Unit): UnitStory {
  const project = getProject(db, unit.projectId);
  const paths = layout(boot);
  const related = listUnits(db, project.id).filter((u) => u.targetUnitId === unit.id && u.type !== "plan");
  const unitIds = [unit.id, ...related.map((u) => u.id)];
  const events = (
    db.prepare(`SELECT id, ts, type, unit_id, data_json FROM events WHERE unit_id IN (${unitIds.map(() => "?").join(", ")}) ORDER BY id`).all(...unitIds) as {
      id: number;
      ts: IsoTime;
      type: string;
      unit_id: number | null;
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
  const handoffOf = (u: Unit, a: Attempt): Handoff | null => {
    const p = paths.handoff(project.id, u.seq, a.n);
    return existsSync(p) ? parseHandoff(readFileSync(p, "utf8")) : null;
  };
  const judgment = (ref: string, h: Handoff) => [
    ...bullets(h.decisions)
      .filter((l) => !/^T\d+\s*:/.test(l))
      .map((t, i) => line(`${ref}:chose:${i}`, "chose", t)),
    ...bullets(h.notes).map((t, i) => line(`${ref}:noted:${i}`, "noted", t)),
  ];
  const attemptOf = (u: Unit, a: Attempt) => ({ id: a.id, unitSeq: u.seq, n: a.n, agentNo: a.agentNo, model: a.model, costUsd: a.costUsd });
  const entries: StoryEntry[] = [];

  let planUnit: Unit | null = null;
  const created = events.find((e) => e.type === "unit.state" && e.unit_id === unit.id && e.data.to === "ready");
  const drain = created?.data.drain as number | undefined;
  if (created && drain) {
    const summary = db
      .prepare("SELECT unit_id, data_json FROM events WHERE project_id = ? AND type = 'plan.drain_finished' AND json_extract(data_json, '$.drain') = ?")
      .get(project.id, drain) as { unit_id: UnitId | null; data_json: string } | undefined;
    planUnit = summary?.unit_id ? getUnit(db, summary.unit_id) : null;
    const planAttempt = planUnit ? (listAttempts(db, planUnit.id).at(-1) ?? null) : null;
    entries.push({
      at: created.ts,
      actor: "planner",
      who: `Planner · drain ${drain}`,
      attempt: planUnit && planAttempt ? attemptOf(planUnit, planAttempt) : null,
      status: null,
      body: summary ? ((JSON.parse(summary.data_json) as { reason?: string }).reason ?? null) : null,
      lines: [],
      folded: null,
    });
  }

  // The verification that judged a head, by the head it judged.
  const verifyFor = new Map<string, { seq: number; agent: string; outcome: string; check: string; tier: string | null; reason: string }>();
  for (const v of related.filter((u) => u.type === "verify")) {
    const out = events.find((e) => e.type === "verify.outcome" && e.unit_id === unit.id && e.data.verifyUnit === v.seq);
    const head = listAttempts(db, v.id).at(-1)?.headSha;
    if (out && head)
      verifyFor.set(head, {
        seq: v.seq,
        agent: jobLabel(db, v),
        outcome: String(out.data.outcome),
        check: String(out.data.check ?? "agreed"),
        tier: (out.data.tier as string | null) ?? null,
        reason: String(out.data.reason),
      });
  }

  // The unit's own work: one entry per attempt that did the work; tries that cost no try fold into the next one.
  let folded: string[] = [];
  for (const a of listAttempts(db, unit.id)) {
    if (a.harness.startsWith("yagura-")) continue;
    const h = a.state === "handed_off" ? handoffOf(unit, a) : null;
    if (!h) {
      folded.push(`A${a.agentNo}: ${a.state}${a.failureMode ? ` (${a.failureMode})` : ""}${spendsAttempt(a) ? "" : ", not counted"}`);
      continue;
    }
    const ref = `a${a.id}`;
    const rejected = events.find(
      (e) => e.type === "unit.state" && e.unit_id === unit.id && e.data.to === "rejected" && e.id > 0 && sameAttempt(events, e, a.n),
    );
    const verified = a.headSha ? verifyFor.get(a.headSha) : undefined;
    const checks: StoryCheck[] = rejected
      ? [{ ok: false, text: `rejected: ${describeRejection(rejected.data)}` }]
      : verified
        ? [{ ok: verified.outcome === "verified", text: `${verified.outcome === "verified" ? "verified" : verified.outcome} by ${verified.agent}` }]
        : [];
    entries.push({
      at: a.startedAt ?? a.endedAt ?? unit.createdAt,
      actor: unit.type === "pack" ? "pack" : "worker",
      who: unit.type === "pack" ? "Pack writer" : "Worker",
      attempt: attemptOf(unit, a),
      status: { text: rejected ? "rejected" : h.status === "success" ? "handed off" : h.status, tone: rejected ? "bell" : "amber" },
      body: bullets(h.whatIDid)[0] ?? null,
      lines: [line(`${ref}:claimed:0`, "claimed", `Hands off ${h.status}, self-reported ${h.verification ?? "no tier"}.`, checks), ...judgment(ref, h)],
      folded: folded.length ? { summary: `${folded.length} earlier tr${folded.length === 1 ? "y" : "ies"} did not count`, items: folded } : null,
    });
    folded = [];
  }

  for (const v of related.filter((u) => u.type === "verify")) {
    for (const a of listAttempts(db, v.id)) {
      const h = handoffOf(v, a);
      const out = events.find((e) => e.type === "verify.outcome" && e.unit_id === unit.id && e.data.verifyUnit === v.seq);
      if (a.harness === "yagura-proof") {
        if (out)
          entries.push({
            at: a.startedAt ?? v.createdAt,
            actor: "yagura",
            who: `yagura · proof ${jobLabel(db, v)}`,
            attempt: null,
            status: { text: String(out.data.outcome), tone: out.data.outcome === "verified" ? "pine" : "bell" },
            body: null,
            lines: [
              line(`a${a.id}:claimed:0`, "claimed", "Ran the pack on its own head with no agent.", [
                { ok: out.data.outcome === "verified", text: String(out.data.reason) },
              ]),
            ],
            folded: null,
          });
        continue;
      }
      if (!h && !out) continue;
      const ref = `a${a.id}`;
      const lines: StoryLine[] = [];
      if (h) {
        const met = (h.findings.match(/^\s*-\s*\[x\]/gim) ?? []).length;
        const all = (h.findings.match(/^\s*-\s*\[[ x]\]/gim) ?? []).length;
        const checks: StoryCheck[] = out
          ? [
              ...String(out.data.reason)
                .split(/;\s*/)
                .map((t) => ({ ok: out.data.check !== "disagreed", text: t })),
              ...(out.data.tier && h.verification && out.data.tier !== h.verification && out.data.outcome === "verified"
                ? [{ ok: true, text: `capped at ${String(out.data.tier)}: no pack check proves more` }]
                : []),
            ]
          : [];
        lines.push(line(`${ref}:claimed:0`, "claimed", `${h.verification ?? "No tier"}${all ? `: ${met} of ${all} criteria met` : ""}.`, checks));
        bullets(h.packChanges).forEach((t, i) => {
          const edit = listPackEdits(db, unit.id).find((e) => e.attemptId === a.id);
          const state = edit
            ? edit.state === "dropped"
              ? { ok: false, text: `dropped: ${edit.reason}` }
              : {
                  ok: true,
                  text: edit.packUnitId ? `re-run on both sides; lands as U${getUnit(db, edit.packUnitId).seq}` : "re-run on both sides; lands after this unit",
                }
            : { ok: false, text: "not kept" };
          lines.push(line(`${ref}:pack:${i}`, "claimed", `Changed the pack: ${t}`, i === 0 ? [state] : []));
        });
        lines.push(...judgment(ref, h));
      }
      entries.push({
        at: a.startedAt ?? v.createdAt,
        actor: "verifier",
        who: "Verifier",
        attempt: attemptOf(v, a),
        status: out
          ? { text: out.data.check === "disagreed" ? "yagura disagreed" : String(out.data.outcome), tone: out.data.outcome === "verified" ? "pine" : "bell" }
          : null,
        body: null,
        lines,
        folded: null,
      });
    }
  }

  const threads = listThreadRows(db, unit.id);
  // yagura's own reviewer's findings are told in the reviewer's entry; only people's threads stand alone.
  for (const r of threads.filter((t) => !isReviewThread(t.threadId)))
    entries.push({
      at: r.createdAt,
      actor: "person",
      who: `${r.author} · ${r.path ? `review on ${r.path}${r.line ? `:${r.line}` : ""}` : "comment"}`,
      attempt: null,
      status: null,
      body: r.comments[0] ?? null,
      lines: [],
      folded: null,
    });

  // Each finding with what became of it: fixed in which commit, dismissed and why, asked, or kept as a note.
  for (const r of related.filter((u) => u.type === "review")) {
    const last = listAttempts(db, r.id)
      .filter((a) => a.state === "handed_off")
      .at(-1);
    const done = events.find((e) => e.unit_id === r.id && e.type === "review.done");
    if (!last || !done) continue;
    const ref = `a${last.id}`;
    const fates = findingFates(db, r) ?? [];
    const lines = fates.length
      ? fates.map((f, i) => line(`${ref}:finding:${i}`, "claimed", `[${f.severity}] ${f.path}${f.line ? `:${f.line}` : ""} — ${f.text} → ${f.fate}`))
      : [line(`${ref}:finding:0`, "claimed", "No findings.")];
    const raised = fates.filter((f) => f.severity !== "nit");
    const open = raised.filter((f) => {
      const t = threads.find((x) => x.threadId === `review:U${r.seq}:F${f.n}`);
      return !t?.decision || (t.decision === "asked" && t.gateId !== null && getGate(db, t.gateId).state === "open");
    }).length;
    entries.push({
      at: last.startedAt ?? r.createdAt,
      actor: "reviewer",
      who: /again/.test(r.goal) ? "Reviewer (the fixes)" : "Reviewer",
      attempt: attemptOf(r, last),
      status: open
        ? { text: `${open} to settle`, tone: "amber" }
        : raised.length
          ? { text: `${raised.length} settled`, tone: "pine" }
          : { text: "nothing to settle", tone: "pine" },
      body: null,
      lines,
      folded: null,
    });
  }

  // The manager's decisions: what it chose and why, which the developer can disagree with like any other claim.
  const decisions = listManagerDecisions(db, unit.id);
  for (const d of decisions) {
    const m = related.find((x) => x.id === d.managerUnitId);
    const a = d.attemptId ? listAttempts(db, d.managerUnitId).find((x) => x.id === d.attemptId) : undefined;
    entries.push({
      at: (a?.endedAt ?? d.createdAt) as IsoTime,
      actor: "manager",
      who: "Manager",
      attempt: m && a ? attemptOf(m, a) : null,
      status: { text: MANAGER_ACTION_TEXT[d.action], tone: d.action === "fallback" ? "muted" : "amber" },
      body:
        d.action === "fallback"
          ? `${d.reason}; the fixed rules decided.`
          : d.note
            ? `${d.action === "relay" ? "Note passed on" : "Note for the next worker"}: ${d.note}`
            : null,
      lines: d.action === "fallback" ? [] : [line(`m${d.id}`, "chose", `${MANAGER_ACTION_TEXT[d.action]}: ${d.reason}`)],
      folded: null,
    });
  }

  // Changes to what the unit must do, proposed from a review comment and decided by the developer.
  for (const a of listAmendments(db, unit.id)) {
    const rejected = a.state === "rejected";
    entries.push({
      at: (a.decidedAt ?? a.createdAt) as IsoTime,
      actor: a.state === "proposed" ? "yagura" : "person",
      who: a.state === "proposed" ? "Amendment" : "You",
      attempt: null,
      status:
        a.state === "approved"
          ? { text: "approved an amendment", tone: "pine" }
          : rejected
            ? { text: "rejected an amendment", tone: "muted" }
            : { text: "amendment waits for you", tone: "bell" },
      body: `${a.author} wrote: "${a.quote.slice(0, 240)}"\n${describeOps(a.changes).join("; ")}`,
      lines: [],
      folded: null,
    });
  }

  for (const t of related.filter((u) => u.type === "review-triage" || u.type === "rebase")) {
    const attempts = listAttempts(db, t.id);
    const done = attempts.filter((a) => a.state === "handed_off" && events.some((e) => e.unit_id === t.id && e.type === "unit.state" && e.data.to === "done"));
    const last = done.at(-1) ?? null;
    const failedTries = attempts.filter((a) => a !== last && a.startedAt).map((a) => `A${a.agentNo}: ${failReason(events, t, a)}`);
    if (!last) continue;
    const h = handoffOf(t, last);
    const ref = `a${last.id}`;
    const lines: StoryLine[] =
      t.type === "review-triage"
        ? threads
            .filter((r) => r.waveUnitId === t.id && r.decision)
            .map((r, i) =>
              line(
                `${ref}:thread:${i}`,
                "claimed",
                `${r.decision}: ${r.reason}`,
                r.decision === "asked" || isReviewThread(r.threadId)
                  ? []
                  : [{ ok: !!r.repliedAt, text: r.repliedAt ? "reply posted on the thread" : "reply pending" }],
              ),
            )
        : [line(`${ref}:claimed:0`, "claimed", "Rebased onto the moved trunk.")];
    if (h) lines.push(...judgment(ref, h));
    entries.push({
      at: last.startedAt ?? t.createdAt,
      actor: t.type === "review-triage" ? "review-triage" : "rebase",
      who: t.type === "review-triage" ? "Review triage" : "Rebase",
      attempt: attemptOf(t, last),
      status: { text: "done", tone: "pine" },
      body: null,
      lines,
      folded: failedTries.length
        ? {
            summary: `${failedTries.length} earlier tr${failedTries.length === 1 ? "y" : "ies"} did not count ($${attempts
              .filter((a) => a !== last)
              .reduce((s, a) => s + a.costUsd, 0)
              .toFixed(2)})`,
            items: failedTries,
          }
        : null,
    });
  }

  for (const u of [unit, ...related])
    for (const a of listAttempts(db, u.id))
      for (const st of listSteers(db, a.id))
        entries.push({
          at: st.createdAt,
          actor: "person",
          who: `You told ${ROLE[u.type] ?? u.type} A${a.agentNo}`,
          attempt: { id: a.id, unitSeq: u.seq, n: a.n, agentNo: a.agentNo, model: a.model, costUsd: 0 },
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

  for (const e of events.filter((x) => x.type === "gate.answered" && x.unit_id === unit.id))
    entries.push({
      at: e.ts,
      actor: "person",
      who: `You answered ${String(e.data.answer)}`,
      attempt: null,
      status: null,
      body: null,
      lines: [],
      folded: null,
    });

  for (const e of events.filter((x) => x.unit_id === unit.id && ["retro.passed", "retro.failed", "retro.reverted"].includes(x.type)))
    entries.push({
      at: e.ts,
      actor: "yagura",
      who: "After landing",
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

  const PUBLISHING: Record<string, { who: string; status: (d: Record<string, unknown>) => { text: string; tone: "pine" | "amber" | "bell" | "muted" } }> = {
    "publish.test": { who: "Test build", status: (d) => ({ text: `published ${String(d.version)}`, tone: "pine" }) },
    "publish.failed": { who: "Test build", status: () => ({ text: "publishing failed", tone: "bell" }) },
    "consumer.repinned": { who: "Re-pinned", status: () => ({ text: "moved to its sources' current versions", tone: "amber" }) },
  };
  for (const e of events.filter((x) => x.unit_id === unit.id && x.type in PUBLISHING)) {
    const p = PUBLISHING[e.type]!;
    const moved = e.type === "consumer.repinned" ? (e.data.moved as { repo: string; from: string; to: string }[]) : null;
    entries.push({
      at: e.ts,
      actor: "yagura",
      who: p.who,
      attempt: null,
      status: p.status(e.data),
      body: moved ? moved.map((m) => `${m.repo}: ${m.from} → ${m.to}`).join("; ") : e.data.reason ? String(e.data.reason) : null,
      lines: [],
      folded: null,
    });
  }

  const stillWaiting = unit.state === "verified" ? landWait(db, unit) : null;
  if (stillWaiting)
    entries.push({
      at: new Date().toISOString() as IsoTime,
      actor: "yagura",
      who: "Waiting",
      attempt: null,
      status: { text: stillWaiting.stuck ? "will not come" : "waiting", tone: stillWaiting.stuck ? "bell" : "amber" },
      body: stillWaiting.reason,
      lines: [],
      folded: null,
    });

  const landed = events.find((e) => e.type === "unit.landed" && e.unit_id === unit.id);
  const verdict = liveVerdict(db, unit.id);
  if (landed) {
    const sha = String(landed.data.sha);
    const carried = verdict?.head_sha === sha;
    entries.push({
      at: landed.ts,
      actor: "yagura",
      who: "Landed",
      attempt: null,
      status: { text: `landed ${sha.slice(0, 7)}`, tone: "pine" },
      body: null,
      lines: [
        line(
          "landed",
          "landed",
          landed.data.pr ? `Pull request #${String(landed.data.pr)} merged as ${sha.slice(0, 10)}.` : `Landed on trunk as ${sha.slice(0, 10)}.`,
          [
            carried
              ? { ok: true, text: "the merged patch is the one verified, so the verdict carries" }
              : { ok: false, text: "merged with a patch other than the one verified; the verdict did not carry" },
          ],
        ),
      ],
      folded: null,
    });
  }

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

  entries.sort((a, b) => a.at.localeCompare(b.at));
  const allAttempts = unitIds.flatMap((id) => listAttempts(db, id));
  const mr = getMergeRequest(db, unit.id);
  return {
    unit,
    projectId: project.id,
    tier: verdict?.tier ?? null,
    pr: mr ? { number: mr.number, url: mr.url } : null,
    costUsd: allAttempts.reduce((s, a) => s + a.costUsd, 0),
    agents: agentsOf(db, unit, related, planUnit, handoffOf, events),
    gates: listGates(db, project.id, "open").filter((g) => g.unitId === unit.id),
    managerOn: managerOn(db, unit),
    manager: decisions.map((d) => {
      const a = d.attemptId ? listAttempts(db, d.managerUnitId).find((x) => x.id === d.attemptId) : undefined;
      return {
        decisionId: d.id,
        attemptId: a?.id ?? null,
        agentNo: a?.agentNo ?? null,
        at: (a?.startedAt ?? d.createdAt) as IsoTime,
        wake: d.wake,
        action: d.action,
        actionText: MANAGER_ACTION_TEXT[d.action],
        reason: d.reason,
        note: d.note,
        costUsd: a?.costUsd ?? 0,
        resumed: !!a?.resumesAttemptId,
      };
    }),
    started: entries[0]?.at ?? null,
    ended: landed?.ts ?? null,
    entries,
  };
}

function sameAttempt(events: Ev[], rejected: Ev, n: number): boolean {
  const handedOff = [...events]
    .reverse()
    .find((e) => e.id < rejected.id && e.unit_id === rejected.unit_id && e.type === "unit.state" && e.data.to === "handed_off");
  return handedOff?.data.attempt === n;
}

function describeRejection(d: Record<string, unknown>): string {
  if (d.reason === "scope" && Array.isArray(d.violations))
    return `wrote outside its scope (${(d.violations as { path: string }[])
      .map((v) => v.path)
      .slice(0, 3)
      .join(", ")})`;
  if (d.reason === "skipped required skills") return `skipped ${(d.missing as string[] | undefined)?.join(", ") ?? "required skills"}`;
  return String(d.reason);
}

function failReason(events: Ev[], unit: Unit, a: Attempt): string {
  const e = events.filter((x) => x.unit_id === unit.id && (x.type === "triage.failed" || x.type === "engine.error" || x.type === "rebase.failed"));
  const after = e.find((x) => a.startedAt && x.ts >= a.startedAt);
  return after ? String(after.data.reason ?? after.data.error ?? after.type) : a.state;
}

export const MANAGER_ACTION_TEXT: Record<ManagerAction, string> = {
  resume: "resumed the builder",
  fresh: "started a fresh builder",
  split: "split the unit",
  planner: "sent it to the planner",
  ask: "asked you",
  stop: "stopped it",
  investigate: "asked for an investigation",
  relay: "passed a note on",
  ignore: "left a note alone",
  fallback: "no decision",
};

const ROLE: Partial<Record<string, string>> = {
  manager: "Manager",
  plan: "Planner",
  work: "Worker",
  pack: "Pack writer",
  verify: "Verifier",
  "review-triage": "Review triage",
  review: "Reviewer",
  rebase: "Rebase",
  investigate: "Investigator",
};

function agentsOf(db: Db, unit: Unit, related: Unit[], planUnit: Unit | null, handoffOf: (u: Unit, a: Attempt) => Handoff | null, events: Ev[]): StoryAgent[] {
  const rows: StoryAgent[] = [];
  const add = (u: Unit, a: Attempt, shared: boolean) => {
    if (a.harness.startsWith("yagura-") || !a.startedAt) return;
    const h = a.state === "handed_off" ? handoffOf(u, a) : null;
    const rejected = events.find((e) => e.unit_id === u.id && e.type === "unit.state" && e.data.to === "rejected" && sameAttempt(events, e, a.n));
    // A triage or rebase session counts only if its unit finished on it; otherwise say what stopped it.
    const finishes = u.type === "review-triage" || u.type === "rebase";
    const next = listAttempts(db, u.id).find((x) => x.startedAt && x.startedAt > a.startedAt!)?.startedAt ?? "9999";
    const finished =
      finishes && events.some((e) => e.unit_id === u.id && (e.type === "triage.done" || e.type === "rebase.done") && e.ts >= a.startedAt! && e.ts < next);
    const failedAfter = finishes && !finished ? { data: { reason: failReason(events, u, a) } } : undefined;
    const verdict = u.type === "verify" ? events.find((e) => e.type === "verify.outcome" && e.data.verifyUnit === u.seq) : undefined;
    const counted = a.state === "handed_off" && !rejected && !failedAfter && spendsAttempt(a);
    const outcome = rejected
      ? "rejected"
      : failedAfter
        ? "failed"
        : verdict
          ? String(verdict.data.outcome)
          : a.state === "handed_off"
            ? (h?.status ?? "handed off")
            : a.state === "running"
              ? "running"
              : a.state === "stopped"
                ? "stopped"
                : "failed";
    const tone = outcome === "running" ? "amber" : !counted ? "bell" : outcome === "verified" || outcome === "success" ? "pine" : "amber";
    const note = rejected
      ? describeRejection(rejected.data)
      : failedAfter
        ? String(failedAfter.data.reason)
        : verdict
          ? String(verdict.data.reason)
          : u.type === "manager"
            ? (listManagerDecisions(db, unit.id).find((d) => d.managerUnitId === u.id)?.reason ?? null)
            : u.type === "review"
              ? reviewSummary(events, u)
              : u.type === "plan"
                ? planSummary(db, u)
                : (bullets(h?.whatIDid ?? "")[0] ?? (a.failureMode ? `failed: ${a.failureMode}` : null));
    rows.push({
      attemptId: a.id,
      role: ROLE[u.type] ?? u.type,
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
  if (planUnit) for (const a of listAttempts(db, planUnit.id).slice(-1)) add(planUnit, a, true);
  for (const u of [unit, ...related]) for (const a of listAttempts(db, u.id)) add(u, a, false);
  return rows.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}

function reviewSummary(events: Ev[], review: Unit): string | null {
  const done = events.find((e) => e.unit_id === review.id && e.type === "review.done");
  if (!done) return null;
  const findings = done.data.findings as { severity: string; path: string; text: string }[];
  if (!findings.length) return "no findings";
  const first = findings[0]!;
  return `${findings.length} finding${findings.length === 1 ? "" : "s"}: [${first.severity}] ${first.path} — ${first.text}${findings.length > 1 ? " …" : ""}`;
}

function planSummary(db: Db, plan: Unit): string | null {
  const r = db.prepare("SELECT data_json FROM events WHERE type = 'plan.drain_finished' AND unit_id = ?").get(plan.id) as { data_json: string } | undefined;
  return r ? ((JSON.parse(r.data_json) as { reason?: string }).reason ?? null) : null;
}
