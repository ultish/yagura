import { z } from "zod";
import {
  FAIL_TIERS,
  HANDOFF_STATUSES,
  MANAGER_ACTIONS,
  PASS_TIERS,
  type AttemptId,
  type Handoff,
  type ManagerAction,
  type RecordKind,
  type Role,
  type UnitId,
} from "./domain.js";
import { applyDelta, PlanDelta, PlanRejected } from "./plan.js";
import { getAttempt, getUnit, now, recordEvent, type Db } from "./store.js";

// What an agent records through its yagura commands (§27). Each command's input is one of these schemas, checked when the agent
// calls it; the engine reads the stored records and never parses the agent's final message.
const text = z.string().trim().min(1);
const lines = z.array(text).default([]);
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
  decision: DecisionRecord,
  plan: PlanDelta,
} as const;
export type LiveRecordKind = keyof typeof RECORD_SCHEMAS;
export type RecordData<K extends LiveRecordKind> = z.output<(typeof RECORD_SCHEMAS)[K]>;

// The record kinds each role may write; a command outside its role's list is refused.
export const ROLE_RECORDS: Partial<Record<Role, readonly LiveRecordKind[]>> = {
  worker: ["handoff"],
  "ci-fix": ["handoff"],
  manager: ["decision", "plan"],
  planner: ["plan"],
};

export const issuesOf = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");

export function putRecord<K extends LiveRecordKind>(db: Db, attemptId: AttemptId, kind: K, key: string, data: RecordData<K>): void {
  db.prepare(
    `INSERT INTO agent_records (attempt_id, kind, key, data_json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id, kind, key) DO UPDATE SET data_json = excluded.data_json, created_at = excluded.created_at`,
  ).run(attemptId, kind, key, JSON.stringify(data), now());
}

export function listRecords<K extends LiveRecordKind>(db: Db, attemptId: AttemptId, kind: K): { key: string; data: RecordData<K> }[] {
  return (
    db.prepare("SELECT key, data_json FROM agent_records WHERE attempt_id = ? AND kind = ? ORDER BY id").all(attemptId, kind) as {
      key: string;
      data_json: string;
    }[]
  ).map((r) => ({ key: r.key, data: JSON.parse(r.data_json) as RecordData<K> }));
}

export const getRecord = <K extends LiveRecordKind>(db: Db, attemptId: AttemptId, kind: K, key = ""): RecordData<K> | null =>
  listRecords(db, attemptId, kind).find((r) => r.key === key)?.data ?? null;

export const hasRecords = (db: Db, attemptId: AttemptId) => !!db.prepare("SELECT 1 FROM agent_records WHERE attempt_id = ? LIMIT 1").get(attemptId);

// Facts about the record that only the store can check: a plan delta yagura would refuse is refused while the agent can still fix it.
export function recordProblem<K extends LiveRecordKind>(db: Db, attemptId: AttemptId, kind: K, data: RecordData<K>): string | null {
  if (kind !== "plan") return null;
  const unit = getUnit(db, getAttempt(db, attemptId).unitId);
  // Applied for real and rolled back.
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
  return null;
}

// What a role must have recorded before it finishes, as instructions it can act on. Empty means done.
export function missingRecords(db: Db, attemptId: AttemptId, role: Role): string[] {
  const has = (kind: LiveRecordKind, key = "") => getRecord(db, attemptId, kind, key) !== null;
  switch (role) {
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

// The engine's view of a finished attempt, built from its records; null when it recorded no handoff.
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
  return null;
}

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
  const d = getRecord(db, attemptId, "decision");
  if (d)
    out.push(
      `Decision: ${d.action}: ${d.reason}${d.note ? ` (note: ${d.note})` : ""}${d.question ? ` (question: ${d.question})` : ""}${d.to ? ` (to: ${d.to})` : ""}`,
    );
  return out.length ? out.join("\n") : null;
}
