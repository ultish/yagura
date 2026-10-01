import { existsSync, readFileSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import { listDisagreements, type Disagreement } from "./disagreements.js";
import { spendsAttempt, type Attempt, type Handoff, type IsoTime, type Unit, type UnitId } from "./domain.js";
import { getMergeRequest } from "./forge.js";
import { parseHandoff } from "./handoff.js";
import { liveVerdict } from "./land.js";
import { listPackEdits } from "./packedits.js";
import { layout } from "./paths.js";
import { getProject, getUnit, listAttempts, listUnits, type Db } from "./store.js";
import { listThreadRows } from "./triage.js";

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
export type Actor = "planner" | "worker" | "verifier" | "review-triage" | "rebase" | "pack" | "person" | "yagura";
export interface StoryEntry {
  at: IsoTime;
  actor: Actor;
  who: string;
  attempt: { id: number; unitSeq: number; n: number; model: string | null; costUsd: number } | null;
  status: { text: string; tone: "pine" | "amber" | "bell" | "muted" } | null;
  body: string | null;
  lines: StoryLine[];
  folded: { summary: string; items: string[] } | null;
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
}
// Every session that worked on a unit: the planner run that planned it (shared with the units it planned alongside),
// its own attempts, and the verifiers, triage, and rebases that targeted it.
export interface StoryAgent {
  attemptId: number;
  role: string;
  unitSeq: number;
  n: number;
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
  const attemptOf = (u: Unit, a: Attempt) => ({ id: a.id, unitSeq: u.seq, n: a.n, model: a.model, costUsd: a.costUsd });
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
  const verifyFor = new Map<string, { seq: number; outcome: string; check: string; tier: string | null; reason: string }>();
  for (const v of related.filter((u) => u.type === "verify")) {
    const out = events.find((e) => e.type === "verify.outcome" && e.unit_id === unit.id && e.data.verifyUnit === v.seq);
    const head = listAttempts(db, v.id).at(-1)?.headSha;
    if (out && head)
      verifyFor.set(head, {
        seq: v.seq,
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
      folded.push(`${unit.seq}.${a.n}: ${a.state}${a.failureMode ? ` (${a.failureMode})` : ""}${spendsAttempt(a) ? "" : ", not counted"}`);
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
        ? [{ ok: verified.outcome === "verified", text: `${verified.outcome === "verified" ? "verified" : verified.outcome} by U${verified.seq}` }]
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
            who: `yagura · proof U${v.seq}`,
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
  for (const r of threads)
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

  for (const t of related.filter((u) => u.type === "review-triage" || u.type === "rebase")) {
    const attempts = listAttempts(db, t.id);
    const done = attempts.filter((a) => a.state === "handed_off" && events.some((e) => e.unit_id === t.id && e.type === "unit.state" && e.data.to === "done"));
    const last = done.at(-1) ?? null;
    const failedTries = attempts.filter((a) => a !== last && a.startedAt).map((a) => `${t.seq}.${a.n}: ${failReason(events, t, a)}`);
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
                r.decision === "asked" ? [] : [{ ok: !!r.repliedAt, text: r.repliedAt ? "reply posted on the thread" : "reply pending" }],
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
      status: { text: d.state === "planned" && d.followUpUnitId ? `follow-up U${getUnit(db, d.followUpUnitId).seq}` : d.state, tone: "bell" },
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

const ROLE: Partial<Record<string, string>> = {
  plan: "Planner",
  work: "Worker",
  pack: "Pack writer",
  verify: "Verifier",
  "review-triage": "Review triage",
  rebase: "Rebase",
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
        ? "did not count"
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
          : u.type === "plan"
            ? planSummary(db, u)
            : (bullets(h?.whatIDid ?? "")[0] ?? (a.failureMode ? `failed: ${a.failureMode}` : null));
    rows.push({
      attemptId: a.id,
      role: ROLE[u.type] ?? u.type,
      unitSeq: u.seq,
      n: a.n,
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

function planSummary(db: Db, plan: Unit): string | null {
  const r = db.prepare("SELECT data_json FROM events WHERE type = 'plan.drain_finished' AND unit_id = ?").get(plan.id) as { data_json: string } | undefined;
  return r ? ((JSON.parse(r.data_json) as { reason?: string }).reason ?? null) : null;
}
