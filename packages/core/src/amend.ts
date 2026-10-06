import type { UnitId } from "./domain.js";
import { amendUnit, getUnit, now, recordEvent, type Db } from "./store.js";

// A change to what a unit must do, proposed by the arbiter from a review comment and applied only when the developer approves it (§ amendments).
export type AmendOp =
  | { kind: "replace"; from: string; to: string }
  | { kind: "add"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "verify"; command: string }
  | { kind: "scope"; path: string; why: string };

export interface Amendment {
  id: number;
  unitId: UnitId;
  gateId: number | null;
  threadId: string | null;
  author: string;
  quote: string;
  changes: AmendOp[];
  before: { acceptance: string[]; verify: string; writeScope?: string[] } | null;
  state: "proposed" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

const toAmendment = (r: Record<string, unknown>): Amendment => ({
  id: r.id as number,
  unitId: r.unit_id as UnitId,
  gateId: (r.gate_id as number | null) ?? null,
  threadId: (r.thread_id as string | null) ?? null,
  author: r.author as string,
  quote: r.quote as string,
  changes: JSON.parse(r.changes_json as string) as AmendOp[],
  before: r.before_json ? (JSON.parse(r.before_json as string) as Amendment["before"]) : null,
  state: r.state as Amendment["state"],
  createdAt: r.created_at as string,
  decidedAt: (r.decided_at as string | null) ?? null,
});

export const listAmendments = (db: Db, unitId: UnitId): Amendment[] =>
  (db.prepare("SELECT * FROM unit_amendments WHERE unit_id = ? ORDER BY id").all(unitId) as Record<string, unknown>[]).map(toAmendment);

// The model often wraps a criterion in backticks as code; the criterion itself has none.
const unquote = (s: string) =>
  s
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();
const norm = (s: string) => unquote(s).replace(/\s+/g, " ").toLowerCase();

// The model sometimes wraps the command in backticks or follows it with an explanation; only the command is a VERIFY.
const shellCommand = (body: string) => /`([^`]+)`/.exec(body)?.[1]?.trim() ?? body.split(/\s+[—–]\s+/)[0]!.trim();

// "- T3: replace: old => new", "- T3: add: …", "- T3: remove: …", "- T3: verify: command", per thread, from the arbiter's "## Amendments" section.
export function parseAmendments(text: string, count: number): Map<number, AmendOp[]> {
  const section = [...text.matchAll(/^##\s+Amendments\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/gim)].map((m) => m[1]).join("\n");
  const out = new Map<number, AmendOp[]>();
  for (const m of section.matchAll(/^-\s*T(\d+)\s*[:·-]\s*(replace|add|remove|verify)\s*:\s*(.+)$/gim)) {
    const i = Number(m[1]);
    if (i < 1 || i > count) continue;
    const kind = m[2]!.toLowerCase();
    const body = m[3]!.trim();
    let op: AmendOp | null = null;
    if (kind === "add") op = { kind: "add", text: unquote(body) };
    else if (kind === "remove") op = { kind: "remove", text: unquote(body) };
    else if (kind === "verify") op = { kind: "verify", command: shellCommand(body) };
    else {
      const [from, to] = body.split(/\s*=>\s*/);
      if (from && to) op = { kind: "replace", from: unquote(from), to: unquote(to) };
    }
    if (op) out.set(i, [...(out.get(i) ?? []), op]);
  }
  return out;
}

// What the unit's acceptance and verify command become, or why the changes cannot be applied to what it has now.
export function applyOps(acceptance: string[], verify: string, ops: AmendOp[]): { acceptance: string[]; verify: string } | { problem: string } {
  let next = [...acceptance];
  let command = verify;
  const find = (text: string) => next.findIndex((a) => norm(a) === norm(text));
  for (const op of ops) {
    if (op.kind === "scope") continue;
    if (op.kind === "add") next.push(op.text);
    else if (op.kind === "verify") command = op.command;
    else {
      const at = find(op.kind === "replace" ? op.from : op.text);
      if (at === -1) return { problem: `no acceptance criterion reads "${op.kind === "replace" ? op.from : op.text}"` };
      if (op.kind === "replace") next[at] = op.to;
      else next.splice(at, 1);
    }
  }
  next = next.filter((a, i) => next.findIndex((b) => norm(b) === norm(a)) === i);
  return { acceptance: next, verify: command };
}

export const describeOps = (ops: AmendOp[]): string[] =>
  ops.map((op) =>
    op.kind === "replace"
      ? `change "${op.from}" to "${op.to}"`
      : op.kind === "add"
        ? `add "${op.text}"`
        : op.kind === "remove"
          ? `remove "${op.text}"`
          : op.kind === "scope"
            ? `it may also write ${op.path} (${op.why})`
            : `the verify command becomes: ${op.command}`,
  );

// The arbiter's proposal, held until the developer answers the gate that carries it. An unusable one returns its problem and is not stored.
export function proposeAmendment(
  db: Db,
  p: { unitId: UnitId; gateId: number | null; threadId: string; author: string; quote: string; changes: AmendOp[] },
): { id: number } | { problem: string } {
  const unit = getUnit(db, p.unitId);
  const check = applyOps(unit.acceptance, unit.verify ?? "", p.changes);
  if ("problem" in check) return check;
  const id = Number(
    db
      .prepare("INSERT INTO unit_amendments (unit_id, gate_id, thread_id, author, quote, changes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.unitId, p.gateId, p.threadId, p.author, p.quote, JSON.stringify(p.changes), now()).lastInsertRowid,
  );
  recordEvent(db, "amendment.proposed", { projectId: unit.projectId, unitId: unit.id }, { amendment: id, by: p.author, changes: describeOps(p.changes) });
  return { id };
}

// The developer's answer to the gate: "fix" approves it and changes the unit; anything else rejects it and leaves the unit as it was.
export function settleAmendment(db: Db, unitId: UnitId, threadId: string, answer: string | null, by = "developer"): Amendment | null {
  const row = db
    .prepare("SELECT * FROM unit_amendments WHERE unit_id = ? AND thread_id = ? AND state = 'proposed' ORDER BY id DESC LIMIT 1")
    .get(unitId, threadId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const amendment = toAmendment(row);
  const unit = getUnit(db, unitId);
  const refs = { projectId: unit.projectId, unitId };
  if (answer !== "fix") {
    db.prepare("UPDATE unit_amendments SET state = 'rejected', decided_at = ? WHERE id = ?").run(now(), amendment.id);
    recordEvent(db, "amendment.rejected", refs, { amendment: amendment.id });
    return toAmendment({ ...row, state: "rejected" });
  }
  const applied = applyOps(unit.acceptance, unit.verify ?? "", amendment.changes);
  if ("problem" in applied) {
    db.prepare("UPDATE unit_amendments SET state = 'rejected', decided_at = ? WHERE id = ?").run(now(), amendment.id);
    recordEvent(db, "amendment.failed", refs, { amendment: amendment.id, problem: applied.problem });
    return null;
  }
  const before = { acceptance: unit.acceptance, verify: unit.verify ?? "", writeScope: unit.writeScope };
  const widened = amendment.changes.flatMap((op) => (op.kind === "scope" && !unit.writeScope.includes(op.path) ? [op.path] : []));
  amendUnit(db, unitId, {
    acceptance: applied.acceptance,
    verify: applied.verify,
    ...(widened.length ? { writeScope: [...unit.writeScope, ...widened] } : {}),
  });
  db.prepare("UPDATE unit_amendments SET state = 'approved', before_json = ?, decided_at = ? WHERE id = ?").run(JSON.stringify(before), now(), amendment.id);
  // A verifier's pack edit was written for the criteria as they stood; carried on, its checks fail the amended work on both sides and read as a broken environment.
  db.prepare("UPDATE pack_edits SET state = 'dropped', reason = ? WHERE target_unit_id = ? AND state = 'pending'").run(
    "the unit's acceptance was amended after this edit was written",
    unitId,
  );
  recordEvent(db, "amendment.approved", refs, { amendment: amendment.id, by, changes: describeOps(amendment.changes) });
  return toAmendment({ ...row, state: "approved", before_json: JSON.stringify(before) });
}

// A comment from an author the developer trusts: proposed and approved in one step, with no gate. Returns why it could not be applied, or null.
export function autoApproveAmendment(db: Db, p: { unitId: UnitId; threadId: string; author: string; quote: string; changes: AmendOp[] }): string | null {
  const made = proposeAmendment(db, { ...p, gateId: null });
  if ("problem" in made) return made.problem;
  const settled = settleAmendment(db, p.unitId, p.threadId, "fix", `${p.author} (trusted author)`);
  return settled?.state === "approved" ? null : "the amendment could not be applied";
}

// Lines for any agent's brief: what the developer changed, in their own words, and that the criteria above already reflect it.
export function amendmentContext(db: Db, unitId: UnitId): string[] {
  return listAmendments(db, unitId)
    .filter((a) => a.state === "approved")
    .map(
      (a) =>
        `The developer amended this unit during review, in answer to ${a.author}'s comment "${a.quote.slice(0, 300)}": ${describeOps(a.changes).join("; ")}. ACCEPTANCE and VERIFY already reflect it, and it outranks what an earlier attempt or a verifier's finding said about the original criteria.`,
    );
}
