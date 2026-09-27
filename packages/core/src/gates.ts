import { resolveSetting } from "./config.js";
import type { IsoTime } from "./domain.js";
import { listGates, now, recordEvent, type Db, type Gate } from "./store.js";

// "hold" is what waiting already means, so a gate whose default is hold never times out.
export function gateDeadline(db: Db, gate: Gate): IsoTime | null {
  if (gate.state !== "open" || !gate.defaultOption || gate.defaultOption === "hold") return null;
  const hours = resolveSetting(db, "gates.timeout_hours", { projectId: gate.projectId }).value;
  if (hours === null) return null;
  return new Date(Date.parse(gate.createdAt) + hours * 3_600_000).toISOString() as IsoTime;
}

export const gateResolved = (gate: Gate, answer: string) => (gate.state === "answered" || gate.state === "defaulted") && gate.answer === answer;

export function defaultExpiredGates(db: Db, at = Date.now()): Gate[] {
  const expired = listGates(db, null, "open").filter((g) => {
    const deadline = gateDeadline(db, g);
    return deadline !== null && Date.parse(deadline) <= at;
  });
  for (const g of expired) {
    db.prepare("UPDATE gates SET state = 'defaulted', answer = ?, resolved_at = ? WHERE id = ? AND state = 'open'").run(g.defaultOption, now(), g.id);
    recordEvent(db, "gate.defaulted", { projectId: g.projectId, unitId: g.unitId }, { gate: g.id, kind: g.kind, answer: g.defaultOption });
  }
  return expired.map((g) => ({ ...g, state: "defaulted" as const, answer: g.defaultOption }));
}

export function recentlyResolvedGates(db: Db, limit = 20): Gate[] {
  const ids = db.prepare("SELECT id FROM gates WHERE state != 'open' ORDER BY resolved_at DESC, id DESC LIMIT ?").all(limit) as { id: number }[];
  const byId = new Map(listGates(db, null).map((g) => [g.id, g]));
  return ids.map(({ id }) => byId.get(id)!);
}
