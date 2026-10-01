import type { AttemptId, IsoTime } from "./domain.js";
import { getAttempt, getUnit, now, recordEvent, type Db } from "./store.js";

export const STEER_STATES = ["pending", "sent", "delivered", "undelivered"] as const;
export type SteerState = (typeof STEER_STATES)[number];

export interface Steer {
  id: number;
  attemptId: AttemptId;
  body: string;
  state: SteerState;
  reason: string | null;
  logLine: number | null;
  createdAt: IsoTime;
  deliveredAt: IsoTime | null;
}

export class SteerRefused extends Error {}

type Row = Record<string, unknown>;
const toSteer = (r: Row): Steer => ({
  id: r.id as number,
  attemptId: r.attempt_id as AttemptId,
  body: r.body as string,
  state: r.state as SteerState,
  reason: (r.reason as string | null) ?? null,
  logLine: (r.log_line as number | null) ?? null,
  createdAt: r.created_at as IsoTime,
  deliveredAt: (r.delivered_at as IsoTime | null) ?? null,
});

export function addSteer(db: Db, attemptId: AttemptId, body: string): Steer {
  const text = body.trim();
  if (!text) throw new SteerRefused("the message is empty");
  const attempt = getAttempt(db, attemptId);
  if (attempt.state !== "running") throw new SteerRefused(`this agent is not running (${attempt.state})`);
  const id = Number(db.prepare("INSERT INTO steers (attempt_id, body, created_at) VALUES (?, ?, ?)").run(attemptId, text, now()).lastInsertRowid);
  const unit = getUnit(db, attempt.unitId);
  recordEvent(db, "attempt.steered", { projectId: unit.projectId, unitId: unit.id, attemptId }, { steer: id, body: text });
  return getSteer(db, id);
}

export function getSteer(db: Db, id: number): Steer {
  const r = db.prepare("SELECT * FROM steers WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new Error(`steer ${id} not found`);
  return toSteer(r);
}

export function listSteers(db: Db, attemptId: AttemptId): Steer[] {
  return (db.prepare("SELECT * FROM steers WHERE attempt_id = ? ORDER BY id").all(attemptId) as Row[]).map(toSteer);
}

export function steerChannel(db: Db, attemptId: AttemptId): SteerChannel {
  const set = (id: number, fields: string, ...values: unknown[]) => db.prepare(`UPDATE steers SET ${fields} WHERE id = ?`).run(...values, id);
  return {
    pending: () => listSteers(db, attemptId).filter((s) => s.state === "pending"),
    sent: (id) => set(id, "state = 'sent'"),
    delivered: (id, line) => set(id, "state = 'delivered', log_line = ?, delivered_at = ?", line, now()),
    undelivered: (id, reason) => set(id, "state = 'undelivered', reason = ?", reason),
  };
}

export interface SteerChannel {
  pending(): { id: number; body: string }[];
  sent(id: number): void;
  delivered(id: number, line: number): void;
  undelivered(id: number, reason: string): void;
}
