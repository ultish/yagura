import type { SessionRecorder } from "./agent.js";
import type { IsoTime } from "./domain.js";
import { missingSkills } from "./skills.js";
import { now, recordEvent, type Db } from "./store.js";

export const TURN_STATES = ["running", "done", "failed", "stopped"] as const;
export type TurnState = (typeof TURN_STATES)[number];
export const SESSION_END_REASONS = ["cleared", "rolled", "lost"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export interface ThreadSession<S = unknown> {
  id: number;
  threadId: number;
  harnessSessionId: string;
  seen: S | null;
  lastContextPeak: number;
  startedAt: IsoTime;
}

export interface WatchmanTurn {
  id: number;
  threadId: number;
  threadTitle: string;
  messageId: number;
  pid: number | null;
  state: TurnState;
  model: string | null;
  contextPeak: number;
  costUsd: number;
  sessionId: number | null;
  logPath: string;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
}

export class TurnBusy extends Error {}

type Row = Record<string, unknown>;
const toTurn = (r: Row): WatchmanTurn => ({
  id: r.id as number,
  threadId: r.thread_id as number,
  threadTitle: (r.title as string) ?? "",
  messageId: r.message_id as number,
  pid: (r.pid as number | null) ?? null,
  state: r.state as TurnState,
  model: (r.model as string | null) ?? null,
  contextPeak: r.context_peak as number,
  costUsd: (r.cost_usd as number | undefined) ?? 0,
  sessionId: (r.session_id as number | null) ?? null,
  logPath: r.log_path as string,
  startedAt: r.started_at as IsoTime,
  endedAt: (r.ended_at as IsoTime | null) ?? null,
});

const SELECT = "SELECT w.*, t.title FROM watchman_turns w JOIN threads t ON t.id = w.thread_id";

const alive = (pid: number | null) => {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A turn a crashed process left marked running must not hold the thread forever.
export function runningTurn(db: Db, threadId: number): WatchmanTurn | null {
  const r = db.prepare(`${SELECT} WHERE w.thread_id = ? AND w.state = 'running' ORDER BY w.id DESC LIMIT 1`).get(threadId) as Row | undefined;
  if (!r) return null;
  const turn = toTurn(r);
  if (alive(turn.pid)) return turn;
  endTurn(db, turn.id, "failed");
  return null;
}

export function assertThreadFree(db: Db, threadId: number): void {
  if (runningTurn(db, threadId)) throw new TurnBusy(`thread ${threadId} is already waiting on the watchman`);
}

export function beginTurn(db: Db, threadId: number, messageId: number, logPath: string): number {
  return Number(
    db.prepare("INSERT INTO watchman_turns (thread_id, message_id, log_path, started_at) VALUES (?, ?, ?, ?)").run(threadId, messageId, logPath, now())
      .lastInsertRowid,
  );
}

export function endTurn(db: Db, id: number, state: Exclude<TurnState, "running">): void {
  db.prepare("UPDATE watchman_turns SET state = ?, ended_at = ? WHERE id = ? AND state = 'running'").run(state, now(), id);
}

export function getTurn(db: Db, id: number): WatchmanTurn {
  const r = db.prepare(`${SELECT} WHERE w.id = ?`).get(id) as Row | undefined;
  if (!r) throw new Error(`watchman turn ${id} not found`);
  return toTurn(r);
}

export function listTurns(db: Db, recent = 20): WatchmanTurn[] {
  return (
    db
      .prepare(`${SELECT} WHERE w.state = 'running' OR w.id IN (SELECT id FROM watchman_turns ORDER BY id DESC LIMIT ?) ORDER BY w.id DESC`)
      .all(recent) as Row[]
  ).map(toTurn);
}

export function stopTurn(db: Db, id: number): boolean {
  const turn = getTurn(db, id);
  if (turn.state !== "running") return false;
  endTurn(db, id, "stopped");
  recordEvent(db, "watchman.stopped", {}, { thread: turn.threadId, turn: id });
  if (turn.pid)
    try {
      process.kill(-turn.pid, "SIGTERM");
    } catch {}
  return true;
}

export function turnRecorder(db: Db, turn: { id: number; threadId: number; messageId: number }): SessionRecorder {
  const { id, threadId, messageId } = turn;
  return {
    env: { YAGURA_THREAD: String(threadId), YAGURA_ROLE: "watchman" },
    started: (pid) => {
      db.prepare("UPDATE watchman_turns SET pid = ? WHERE id = ?").run(pid, id);
      recordEvent(db, "watchman.started", {}, { thread: threadId, message: messageId, pid });
    },
    session: (e) => {
      db.prepare("UPDATE watchman_turns SET model = ?, session_id = ? WHERE id = ?").run(e.model, attachSession(db, threadId, e.sessionId), id);
    },
    usage: (contextPeak) => db.prepare("UPDATE watchman_turns SET context_peak = ? WHERE id = ?").run(contextPeak, id),
    cost: (usd) => db.prepare("UPDATE watchman_turns SET cost_usd = cost_usd + ? WHERE id = ?").run(usd, id),
    finished: (skills) => {
      const missing = missingSkills("watchman", skills);
      if (missing.length) recordEvent(db, "watchman.method_miss", {}, { thread: threadId, message: messageId, missing, loaded: skills });
      return missing;
    },
  };
}

export function currentSession<S>(db: Db, threadId: number): ThreadSession<S> | null {
  const r = db
    .prepare(
      `SELECT s.*, (SELECT context_peak FROM watchman_turns WHERE session_id = s.id ORDER BY id DESC LIMIT 1) AS peak
       FROM thread_sessions s WHERE s.thread_id = ? AND s.ended_at IS NULL`,
    )
    .get(threadId) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id as number,
    threadId,
    harnessSessionId: r.harness_session_id as string,
    seen: r.seen_json ? (JSON.parse(r.seen_json as string) as S) : null,
    lastContextPeak: (r.peak as number | null) ?? 0,
    startedAt: r.started_at as IsoTime,
  };
}

// The turn that reports a new harness session makes it the thread's current one.
function attachSession(db: Db, threadId: number, harnessSessionId: string): number {
  const current = currentSession(db, threadId);
  if (current?.harnessSessionId === harnessSessionId) return current.id;
  if (current) endSession(db, threadId, "rolled");
  return Number(
    db.prepare("INSERT INTO thread_sessions (thread_id, harness_session_id, started_at) VALUES (?, ?, ?)").run(threadId, harnessSessionId, now())
      .lastInsertRowid,
  );
}

export function endSession(db: Db, threadId: number, reason: SessionEndReason): boolean {
  const ended = db.prepare("UPDATE thread_sessions SET ended_at = ?, ended_reason = ? WHERE thread_id = ? AND ended_at IS NULL").run(now(), reason, threadId);
  if (ended.changes) recordEvent(db, "watchman.session_ended", {}, { thread: threadId, reason });
  return ended.changes > 0;
}

export function markSeen(db: Db, sessionId: number, seen: unknown): void {
  db.prepare("UPDATE thread_sessions SET seen_json = ? WHERE id = ?").run(JSON.stringify(seen), sessionId);
}

export function sessionStarts(db: Db, threadId: number): number[] {
  return (
    db
      .prepare("SELECT MIN(message_id) AS m FROM watchman_turns WHERE thread_id = ? AND session_id IS NOT NULL GROUP BY session_id ORDER BY m")
      .all(threadId) as { m: number }[]
  ).map((r) => r.m);
}
