import { z } from "zod";
import { applyOps, type AmendOp } from "./amend.js";
import {
  CHANGE_KINDS,
  NEEDS_APPROVAL,
  FAIL_TIERS,
  HANDOFF_STATUSES,
  MANAGER_ACTIONS,
  PASS_TIERS,
  SEVERITIES,
  type AttemptId,
  type ChangeKind,
  type Handoff,
  type ManagerAction,
  type RecordKind,
  type Role,
  type Severity,
  type UnitId,
} from "./domain.js";
import { applyDelta, PlanDelta, PlanRejected } from "./plan.js";
import type { PrThreadDecision } from "./triage.js";
import { getAttempt, getUnit, now, recordEvent, type Db } from "./store.js";

// What an agent records through its yagura commands (§27). Each command's input is one of these schemas, checked when the agent
// calls it; the engine reads the stored records and never parses the agent's final message.
const text = z.string().trim().min(1);
const lines = z.array(text).default([]);
const runIds = z.array(z.number().int().positive()).default([]);
const threadNo = z.number().int().positive();
const MENU = MANAGER_ACTIONS.filter((a): a is Exclude<ManagerAction, "fallback"> => a !== "fallback");

export const HandoffRecord = z
  .object({
    status: z.enum(HANDOFF_STATUSES),
    tier: z
      .enum([...PASS_TIERS, ...FAIL_TIERS, "not-verified"])
      .nullable()
      .default(null),
    did: lines,
    evidence: lines,
    outsideScope: z.array(z.object({ path: text, reason: text }).strict()).default([]),
    forOthers: lines,
    decisions: lines,
    notes: lines,
    followUps: lines,
    findings: lines,
  })
  .strict();
export const VerdictRecord = z
  .object({ tier: z.enum([...PASS_TIERS, ...FAIL_TIERS]), runs: runIds, packChanges: lines, decisions: lines, notes: lines })
  .strict();
export const FindingRecord = z.object({ criterion: z.number().int().positive(), met: z.boolean(), runs: runIds, note: text.nullable().default(null) }).strict();
// A ruling names every change the thread needs (§28), and the decision has to follow from that set: no changes is a dismissal,
// code alone is a fix, and anything that changes what the unit must do or what the project plans is a question for the developer.
export const RulingRecord = z
  .object({
    thread: threadNo,
    decision: z.enum(["fix", "dismiss", "ask"]),
    reason: text,
    changes: z.array(z.enum(CHANGE_KINDS)).default([]),
    planNote: text.nullable().default(null),
    instruction: text.nullable().default(null),
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["changes"] });
    if (new Set(r.changes).size !== r.changes.length) issue("a change is named twice");
    if (r.decision === "dismiss" && r.changes.length) issue("a dismissal changes nothing: --changes none");
    if (r.decision !== "dismiss" && !r.changes.length)
      issue(`${r.decision === "ask" ? "an ask" : "a fix"} must name what changes: --changes code,acceptance,verify,scope,plan`);
    if (r.decision === "fix" && !r.changes.includes("code")) issue("a fix changes code: name code in --changes, or rule ask");
    if (r.changes.includes("plan") && !r.planNote) issue("plan needs --plan-note: the follow-up the project lead should plan");
    if (!r.changes.includes("plan") && r.planNote) issue("--plan-note only goes with plan in --changes");
    // An ask's reason is the question for the developer, so the worker's instruction is recorded apart from it; a fix's reason is the instruction.
    if (r.decision === "ask" && r.changes.includes("code") && !r.instruction)
      issue("an ask that changes code needs --instruction: what the worker must change if the developer answers Fix");
    if (r.instruction && !(r.decision === "ask" && r.changes.includes("code"))) issue("--instruction only goes with an ask that changes code");
  });
const AmendOpRecord = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replace"), from: text, to: text }).strict(),
  z.object({ kind: z.literal("add"), text }).strict(),
  z.object({ kind: z.literal("remove"), text }).strict(),
  z.object({ kind: z.literal("verify"), command: text }).strict(),
  z.object({ kind: z.literal("scope"), path: text, why: text }).strict(),
]);
export const AmendmentRecord = z.object({ thread: threadNo, ops: z.array(AmendOpRecord).min(1) }).strict();
export const ReviewFindingRecord = z
  .object({ n: z.number().int().positive(), severity: z.enum(SEVERITIES), path: text, line: z.number().int().positive().nullable().default(null), text })
  .strict();
export const DecisionRecord = z
  .object({
    action: z.enum(MANAGER_ACTIONS).exclude(["fallback"]),
    reason: text,
    note: text.nullable().default(null),
    question: text.nullable().default(null),
    to: text.nullable().default(null),
  })
  .strict();

export const RECORD_SCHEMAS = {
  handoff: HandoffRecord,
  verdict: VerdictRecord,
  finding: FindingRecord,
  ruling: RulingRecord,
  amendment: AmendmentRecord,
  "review-finding": ReviewFindingRecord,
  decision: DecisionRecord,
  plan: PlanDelta,
} as const satisfies Record<RecordKind, z.ZodTypeAny>;
export type RecordData<K extends RecordKind> = z.output<(typeof RECORD_SCHEMAS)[K]>;

// The record kinds each role may write; a command outside its role's list is refused.
export const ROLE_RECORDS: Partial<Record<Role, readonly RecordKind[]>> = {
  worker: ["handoff"],
  pack: ["handoff"],
  rebase: ["handoff"],
  "ci-fix": ["handoff"],
  reviewer: ["handoff", "review-finding"],
  verifier: ["verdict", "finding"],
  "review-triage": ["ruling", "amendment"],
  manager: ["decision", "plan"],
  planner: ["plan"],
};

export const issuesOf = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");

export function putRecord<K extends RecordKind>(db: Db, attemptId: AttemptId, kind: K, key: string, data: RecordData<K>): void {
  db.prepare(
    `INSERT INTO agent_records (attempt_id, kind, key, data_json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id, kind, key) DO UPDATE SET data_json = excluded.data_json, created_at = excluded.created_at`,
  ).run(attemptId, kind, key, JSON.stringify(data), now());
}

export function listRecords<K extends RecordKind>(db: Db, attemptId: AttemptId, kind: K): { key: string; data: RecordData<K> }[] {
  return (
    db.prepare("SELECT key, data_json FROM agent_records WHERE attempt_id = ? AND kind = ? ORDER BY id").all(attemptId, kind) as {
      key: string;
      data_json: string;
    }[]
  ).map((r) => ({ key: r.key, data: JSON.parse(r.data_json) as RecordData<K> }));
}

export const getRecord = <K extends RecordKind>(db: Db, attemptId: AttemptId, kind: K, key = ""): RecordData<K> | null =>
  listRecords(db, attemptId, kind).find((r) => r.key === key)?.data ?? null;

export const hasRecords = (db: Db, attemptId: AttemptId) => !!db.prepare("SELECT 1 FROM agent_records WHERE attempt_id = ? LIMIT 1").get(attemptId);

// The threads a triage wave rules on, numbered T1.. in the order its brief lists them.
export const waveThreadCount = (db: Db, triageUnitId: UnitId) =>
  (db.prepare("SELECT COUNT(*) AS n FROM mr_threads WHERE wave_unit_id = ?").get(triageUnitId) as { n: number }).n;

const runsOfAttempt = (db: Db, attemptId: AttemptId) =>
  new Set((db.prepare("SELECT id FROM evidence_runs WHERE attempt_id = ?").all(attemptId) as { id: number }[]).map((r) => r.id));

// Facts about the record that only the store can check: the runs it cites were recorded by this attempt, the thread and criterion
// it names exist, and an amendment applies to the unit as it stands.
export function recordProblem<K extends RecordKind>(db: Db, attemptId: AttemptId, kind: K, data: RecordData<K>): string | null {
  const unit = getUnit(db, getAttempt(db, attemptId).unitId);
  const target = unit.targetUnitId ? getUnit(db, unit.targetUnitId) : unit;
  const unknownRuns = (ids: number[]) => {
    const mine = runsOfAttempt(db, attemptId);
    const bad = ids.filter((id) => !mine.has(id));
    return bad.length ? `${bad.map((id) => `run:${id}`).join(", ")} ${bad.length === 1 ? "was" : "were"} not recorded by your yagura evidence run calls` : null;
  };
  if (kind === "verdict") {
    const v = data as RecordData<"verdict">;
    if ((PASS_TIERS as readonly string[]).includes(v.tier) && !v.runs.length) return `a pass tier needs the runs that prove it (--runs <id,…>)`;
    return unknownRuns(v.runs);
  }
  if (kind === "finding") {
    const f = data as RecordData<"finding">;
    if (f.criterion > target.acceptance.length) return `criterion ${f.criterion} does not exist; ACCEPTANCE has ${target.acceptance.length}`;
    return unknownRuns(f.runs);
  }
  if (kind === "plan") {
    // Applied for real and rolled back, so a delta yagura would refuse after the session is refused now, while the agent can fix it.
    const rollback = new Error("dry run");
    try {
      db.transaction(() => {
        applyDelta(db, unit.projectId, data as RecordData<"plan">, null);
        throw rollback;
      })();
    } catch (e) {
      if (e instanceof PlanRejected) return e.message;
      if (e !== rollback) throw e;
    }
  }
  if (kind === "ruling" || kind === "amendment") {
    const n = waveThreadCount(db, unit.id);
    const t = (data as { thread: number }).thread;
    if (t > n) return `T${t} does not exist; this wave has ${n} thread${n === 1 ? "" : "s"} (T1${n > 1 ? `–T${n}` : ""})`;
    if (kind === "ruling") {
      const r = data as RecordData<"ruling">;
      const needs = r.changes.filter((c) => NEEDS_APPROVAL.includes(c));
      if (r.decision === "fix" && needs.length && !trustedAuthorOf(db, unit, t))
        return `${needs.join(", ")} change${needs.length === 1 ? "s" : ""} what the unit must do or plans, so the developer decides: rule ask`;
    }
    if (kind === "amendment") {
      // An amendment carries only changes its ruling declared, so the gate and the record never disagree.
      const ruling = listRecords(db, attemptId, "ruling").find((r) => r.data.thread === t)?.data;
      if (!ruling) return `rule on T${t} first (yagura rule T${t} … --changes …), then record its amendment`;
      for (const op of (data as RecordData<"amendment">).ops) {
        const declared: ChangeKind = op.kind === "verify" ? "verify" : op.kind === "scope" ? "scope" : "acceptance";
        if (!ruling.changes.includes(declared)) return `T${t}'s ruling does not name ${declared} in --changes; rule it again with ${declared} if it changes`;
      }
      const applied = applyOps(target.acceptance, target.verify ?? "", (data as RecordData<"amendment">).ops as AmendOp[]);
      if ("problem" in applied) return applied.problem;
    }
  }
  return null;
}

// The thread's author is one the developer trusts, so a fix may carry its amendment without asking.
function trustedAuthorOf(db: Db, wave: { id: UnitId; projectId: string; repoId: string | null }, t: number): boolean {
  const row = db.prepare("SELECT author FROM mr_threads WHERE wave_unit_id = ? ORDER BY rowid LIMIT 1 OFFSET ?").get(wave.id, t - 1) as
    { author: string } | undefined;
  if (!row) return false;
  const trusted = db
    .prepare(
      "SELECT value_json FROM settings WHERE key = 'review.trusted_authors' AND ((scope = 'project' AND scope_id = ?) OR (scope = 'repo' AND scope_id = ?) OR scope = 'global')",
    )
    .all(wave.projectId, wave.repoId ?? "") as { value_json: string }[];
  return trusted.some((s) => (JSON.parse(s.value_json) as string[]).some((a) => a.toLowerCase() === row.author.toLowerCase()));
}

// What a role must have recorded before it finishes, as instructions it can act on. Empty means done.
export function missingRecords(db: Db, attemptId: AttemptId, role: Role): string[] {
  const has = (kind: RecordKind, key = "") => getRecord(db, attemptId, kind, key) !== null;
  switch (role) {
    case "verifier":
      return has("verdict") ? [] : ["no verdict: run `yagura verdict <tier> --runs <id,…>` (and `yagura finding` for each criterion)"];
    case "review-triage": {
      const unit = getUnit(db, getAttempt(db, attemptId).unitId);
      const rulings = listRecords(db, attemptId, "ruling").map((r) => r.data);
      const ruled = new Set(rulings.map((r) => r.thread));
      const ops = new Map(listRecords(db, attemptId, "amendment").map((r) => [r.data.thread, r.data.ops.map((o) => o.kind as string)]));
      const has = (t: number, ...kinds: string[]) => (ops.get(t) ?? []).some((k) => kinds.includes(k));
      return [
        ...Array.from({ length: waveThreadCount(db, unit.id) }, (_, i) => i + 1)
          .filter((t) => !ruled.has(t))
          .map((t) => `no ruling for T${t}: run \`yagura rule T${t} <fix|dismiss|ask> --changes <…> --reason "…"\``),
        ...rulings.flatMap((r) => [
          ...(r.changes.includes("acceptance") && !has(r.thread, "replace", "add", "remove")
            ? [
                `T${r.thread} names acceptance but records no criterion change: run \`yagura amend T${r.thread} replace --from "<criterion exactly as ACCEPTANCE words it>" --to "<the concrete new criterion>"\` (or add / remove)`,
              ]
            : []),
          ...(r.changes.includes("verify") && !has(r.thread, "verify")
            ? [`T${r.thread} names verify but records no new command: run \`yagura amend T${r.thread} verify --command "…"\``]
            : []),
          ...(r.changes.includes("scope") && !has(r.thread, "scope")
            ? [`T${r.thread} names scope but records no path: run \`yagura amend T${r.thread} scope --path "<path>" --text "<why the fix needs it>"\``]
            : []),
        ]),
      ];
    }
    case "manager":
      return has("decision") ? [] : [`no decision: run \`yagura decide <${MENU.join("|")}> --reason "…"\``];
    case "planner":
      return has("plan") ? [] : ["no plan: write the delta to a file and run `yagura plan --file <path>`"];
    case "watchman":
      return [];
    default:
      return has("handoff") ? [] : ['no handoff: run `yagura handoff <success|partial|blocked> --did "…"` with the rest of your report as flags'];
  }
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

// The engine's view of a finished attempt, built from its records; null when it recorded no handoff or verdict.
export function recordedHandoff(db: Db, attemptId: AttemptId, raw: string): Handoff | null {
  const h = getRecord(db, attemptId, "handoff");
  if (h)
    return {
      status: h.status,
      branch: null,
      whatIDid: bullets(h.did),
      measurements: "",
      verification: h.tier,
      evidence: h.evidence,
      notes: bullets(h.notes),
      forOthers: bullets(h.forOthers),
      followUps: bullets(h.followUps),
      packChanges: "",
      findings: bullets(h.findings),
      decisions: bullets(h.decisions),
      outsideScope: h.outsideScope.map((o) => `- ${o.path}: ${o.reason}`).join("\n"),
      raw,
    };
  const v = getRecord(db, attemptId, "verdict");
  if (!v) return null;
  const findings = listRecords(db, attemptId, "finding")
    .map((r) => r.data)
    .sort((a, b) => a.criterion - b.criterion);
  const cited = [...new Set([...v.runs, ...findings.flatMap((f) => f.runs)])];
  return {
    status: "success",
    branch: null,
    whatIDid: "",
    measurements: "",
    verification: v.tier,
    evidence: v.runs.map((id) => `run:${id}`),
    notes: bullets(v.notes),
    forOthers: "",
    followUps: "",
    packChanges: bullets(v.packChanges),
    findings: findings
      .map(
        (f) =>
          `- [${f.met ? "x" : " "}] criterion ${f.criterion}${f.note ? `: ${f.note}` : ""}${f.runs.length ? ` (${f.runs.map((id) => `run:${id}`).join(", ")})` : ""}`,
      )
      .join("\n"),
    decisions: bullets(v.decisions),
    outsideScope: "",
    raw,
    citedRunIds: cited,
  };
}

export const recordedRulings = (db: Db, attemptId: AttemptId): Map<number, { decision: PrThreadDecision; reason: string }> =>
  new Map(
    listRecords(db, attemptId, "ruling").map((r) => [
      r.data.thread,
      { decision: ({ fix: "fixed", dismiss: "dismissed", ask: "asked" } as const)[r.data.decision], reason: r.data.reason },
    ]),
  );

export const recordedAmendments = (db: Db, attemptId: AttemptId): Map<number, AmendOp[]> =>
  new Map(listRecords(db, attemptId, "amendment").map((r) => [r.data.thread, r.data.ops as AmendOp[]]));

export const recordedReviewFindings = (db: Db, attemptId: AttemptId): { n: number; severity: Severity; path: string; line: number | null; text: string }[] =>
  listRecords(db, attemptId, "review-finding")
    .map((r) => r.data)
    .sort((a, b) => a.n - b.n);

// Every use of an old parser while records are rolled out is visible on the unit (§27 step 5).
export function noteFallback(db: Db, attemptId: AttemptId, parser: string, ok: boolean): void {
  const a = getAttempt(db, attemptId);
  const unit = getUnit(db, a.unitId);
  recordEvent(db, "parse.fallback", { projectId: unit.projectId, unitId: unit.id, attemptId }, { parser, ok });
}

const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);

// What an attempt recorded, as text for the agents and pages that show it (unit lead, planner, a resumed worker); null when it recorded nothing.
export function describeRecords(db: Db, attemptId: AttemptId): string | null {
  const out: string[] = [];
  const h = getRecord(db, attemptId, "handoff");
  if (h)
    out.push(
      `Handoff: ${h.status}${h.tier ? `, self-reported ${h.tier}` : ""}`,
      ...section("What it did", h.did),
      ...section("Evidence it ran", h.evidence),
      ...section("Findings", h.findings),
      ...section("Decisions", h.decisions),
      ...section(
        "Outside scope",
        h.outsideScope.map((o) => `${o.path}: ${o.reason}`),
      ),
      ...section("For other units", h.forOthers),
      ...section("Notes", h.notes),
      ...section("Suggested follow-ups", h.followUps),
    );
  const v = getRecord(db, attemptId, "verdict");
  if (v) {
    const findings = listRecords(db, attemptId, "finding")
      .map((r) => r.data)
      .sort((a, b) => a.criterion - b.criterion);
    out.push(
      `Verdict: ${v.tier}${v.runs.length ? ` (${v.runs.map((id) => `run:${id}`).join(", ")})` : ""}`,
      ...section(
        "Findings",
        findings.map(
          (f) =>
            `criterion ${f.criterion} ${f.met ? "met" : "not met"}${f.runs.length ? ` (${f.runs.map((id) => `run:${id}`).join(", ")})` : ""}${f.note ? `: ${f.note}` : ""}`,
        ),
      ),
      ...section("Pack changes", v.packChanges),
      ...section("Decisions", v.decisions),
      ...section("Notes", v.notes),
    );
  }
  const rulings = listRecords(db, attemptId, "ruling").map((r) => r.data);
  if (rulings.length)
    out.push(
      ...section(
        "Rulings",
        rulings.sort((a, b) => a.thread - b.thread).map((r) => `T${r.thread}: ${r.decision} (changes: ${r.changes.join(", ") || "none"}): ${r.reason}`),
      ),
    );
  const amendments = listRecords(db, attemptId, "amendment").map((r) => r.data);
  if (amendments.length)
    out.push(
      ...section(
        "Amendments",
        amendments.flatMap((a) => a.ops.map((op) => `T${a.thread}: ${JSON.stringify(op)}`)),
      ),
    );
  const findings = listRecords(db, attemptId, "review-finding").map((r) => r.data);
  if (findings.length)
    out.push(
      ...section(
        "Review findings",
        findings.map((f) => `F${f.n} [${f.severity}] ${f.path}${f.line ? `:${f.line}` : ""}: ${f.text}`),
      ),
    );
  const d = getRecord(db, attemptId, "decision");
  if (d)
    out.push(
      `Decision: ${d.action}: ${d.reason}${d.note ? ` (note: ${d.note})` : ""}${d.question ? ` (question: ${d.question})` : ""}${d.to ? ` (to: ${d.to})` : ""}`,
    );
  return out.length ? out.join("\n") : null;
}
