import { z } from "zod";
import { HANDOFF_STATUSES, JUDGE_VERDICTS, LEAD_ACTIONS, type AttemptId, type Handoff, type RecordKind, type Role } from "./domain.js";
import { applyDelta, PlanDelta, PlanRejected } from "./plan.js";
import { getAttempt, getUnit, now, recordEvent, type Db } from "./store.js";

// What an agent records through its yagura commands. Each command's input is one of these schemas, checked when the agent
// calls it; the engine reads the stored records and never parses the agent's final message.
const text = z.string().trim().min(1);
const lines = z.array(text).default([]);
const runIds = z.array(z.number().int().positive()).default([]);

export const HandoffRecord = z
  .object({
    status: z.enum(HANDOFF_STATUSES),
    reason: text.nullable().default(null),
    did: lines,
    evidence: lines,
    decisions: lines,
    notes: lines,
    followUps: lines,
  })
  .strict()
  .superRefine((h, ctx) => {
    if (h.status === "stuck" && !h.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stuck needs --reason: what stops you", path: ["reason"] });
    if (h.status === "done" && h.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "--reason only goes with stuck", path: ["reason"] });
  });

// The judge answers with one of three verdicts, and each one carries what the engine needs to act on it.
export const JudgeRecord = z
  .object({
    verdict: z.enum(JUDGE_VERDICTS),
    runs: runIds,
    findings: lines,
    question: text.nullable().default(null),
  })
  .strict()
  .superRefine((j, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    if (j.verdict === "approve" && !j.runs.length) issue("an approval needs the runs it rests on (--runs <id,…>)", "runs");
    if (j.verdict === "changes" && !j.findings.length) issue('changes need at least one --finding "<file:line> what is wrong"', "findings");
    if (j.verdict === "ask" && !j.question) issue("ask needs --question", "question");
    if (j.verdict !== "changes" && j.findings.length) issue("--finding only goes with changes", "findings");
    if (j.verdict !== "ask" && j.question) issue("--question only goes with ask", "question");
  });

export const DecisionRecord = z
  .object({
    action: z.enum(LEAD_ACTIONS),
    reason: text,
    note: text.nullable().default(null),
    question: text.nullable().default(null),
  })
  .strict()
  .superRefine((d, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    if (d.action === "ask" && !d.question) issue("ask needs --question for the developer", "question");
    if ((d.action === "answer" || d.action === "reply") && !d.note) issue(`${d.action} needs --note: the words to send`, "note");
  });

export const RECORD_SCHEMAS = {
  handoff: HandoffRecord,
  judge: JudgeRecord,
  decision: DecisionRecord,
  plan: PlanDelta,
} as const;
export type LiveRecordKind = keyof typeof RECORD_SCHEMAS;
export type RecordData<K extends LiveRecordKind> = z.output<(typeof RECORD_SCHEMAS)[K]>;

// The record kinds each role may write; a command outside its role's list is refused.
export const ROLE_RECORDS: Partial<Record<Role, readonly LiveRecordKind[]>> = {
  worker: ["handoff"],
  judge: ["judge"],
  lead: ["decision", "plan"],
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

const runsOfAttempt = (db: Db, attemptId: AttemptId) =>
  new Set((db.prepare("SELECT id FROM evidence_runs WHERE attempt_id = ?").all(attemptId) as { id: number }[]).map((r) => r.id));

// Facts about the record that only the store can check: the runs a judge cites were recorded by its own session, and a plan delta
// yagura would refuse is refused while the agent can still fix it.
export function recordProblem<K extends LiveRecordKind>(db: Db, attemptId: AttemptId, kind: K, data: RecordData<K>): string | null {
  if (kind === "judge") {
    const mine = runsOfAttempt(db, attemptId);
    const bad = (data as RecordData<"judge">).runs.filter((id) => !mine.has(id));
    return bad.length ? `${bad.map((id) => `run:${id}`).join(", ")} ${bad.length === 1 ? "was" : "were"} not recorded by your yagura evidence run calls` : null;
  }
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
    case "judge":
      return has("judge")
        ? []
        : [
            'no verdict: run `yagura judge approve --runs <id,…>`, `yagura judge changes --finding "<file:line> what is wrong"`, or `yagura judge ask --question "…"`',
          ];
    case "lead":
      return has("decision") ? [] : [`no decision: run \`yagura decide <${LEAD_ACTIONS.join("|")}> --reason "…"\``];
    case "planner":
      return has("plan") ? [] : ["no plan: write the delta to a file and run `yagura plan --file <path>`"];
    case "watchman":
      return [];
    default:
      return has("handoff") ? [] : ['no handoff: run `yagura handoff done` when the unit\'s goal is met, or `yagura handoff stuck --reason "…"`'];
  }
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

// The engine's view of a finished attempt, built from its records; null when it recorded no handoff.
export function recordedHandoff(db: Db, attemptId: AttemptId): Handoff | null {
  const h = getRecord(db, attemptId, "handoff");
  if (h)
    return {
      status: h.status,
      reason: h.reason,
      whatIDid: bullets(h.did),
      evidence: h.evidence,
      notes: bullets(h.notes),
      decisions: bullets(h.decisions),
      followUps: bullets(h.followUps),
    };
  return null;
}

const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);

// What an attempt recorded, as text for the agents and pages that show it (unit lead, planner, a resumed worker); null when it recorded nothing.
export function describeRecords(db: Db, attemptId: AttemptId): string | null {
  const out: string[] = [];
  const h = getRecord(db, attemptId, "handoff");
  if (h)
    out.push(
      `Handoff: ${h.status}${h.reason ? `: ${h.reason}` : ""}`,
      ...section("What it did", h.did),
      ...section("Evidence it ran", h.evidence),
      ...section("Decisions", h.decisions),
      ...section("Notes", h.notes),
      ...section("Suggested follow-ups", h.followUps),
    );
  const j = getRecord(db, attemptId, "judge");
  if (j)
    out.push(
      `Judge: ${j.verdict}${j.runs.length ? ` (${j.runs.map((id) => `run:${id}`).join(", ")})` : ""}`,
      ...section("Findings", j.findings),
      ...(j.question ? [`Question: ${j.question}`] : []),
    );
  const d = getRecord(db, attemptId, "decision");
  if (d) out.push(`Decision: ${d.action}: ${d.reason}${d.note ? ` (note: ${d.note})` : ""}${d.question ? ` (question: ${d.question})` : ""}`);
  return out.length ? out.join("\n") : null;
}
