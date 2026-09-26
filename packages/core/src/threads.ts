import type { IsoTime, MessageRole, ProjectId, ProposalState, ThreadAutonomy, ThreadState } from "./domain.js";
import { getProject, now, recordEvent, type Db } from "./store.js";

export interface Thread {
  id: number;
  title: string;
  autonomy: ThreadAutonomy;
  state: ThreadState;
  reported: Record<string, string>;
  projects: ProjectId[];
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface ThreadMessage {
  id: number;
  threadId: number;
  role: MessageRole;
  body: string;
  turnLog: string | null;
  createdAt: IsoTime;
}

export interface ThreadDecision {
  id: number;
  threadId: number;
  text: string;
  sourceMessageId: number | null;
  supersededBy: number | null;
  createdAt: IsoTime;
}

export interface ThreadQuestion {
  id: number;
  threadId: number;
  text: string;
  sourceMessageId: number | null;
  answer: string | null;
  resolvedMessageId: number | null;
  createdAt: IsoTime;
}

export interface Proposal {
  id: number;
  threadId: number;
  messageId: number | null;
  body: unknown;
  state: ProposalState;
  result: unknown;
  createdAt: IsoTime;
  resolvedAt: IsoTime | null;
}

type Row = Record<string, unknown>;

export function createThread(db: Db, t: { title: string; autonomy?: ThreadAutonomy }): Thread {
  const at = now();
  const id = Number(db.prepare("INSERT INTO threads (title, autonomy, created_at, updated_at) VALUES (?, ?, ?, ?)").run(t.title, t.autonomy ?? "propose", at, at).lastInsertRowid);
  recordEvent(db, "thread.created", {}, { thread: id, title: t.title });
  return getThread(db, id);
}

export function getThread(db: Db, id: number): Thread {
  const r = db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new Error(`thread ${id} not found`);
  return {
    id: r.id as number,
    title: r.title as string,
    autonomy: r.autonomy as ThreadAutonomy,
    state: r.state as Thread["state"],
    reported: JSON.parse(r.reported_json as string),
    projects: (db.prepare("SELECT project_id FROM thread_projects WHERE thread_id = ? ORDER BY rowid").all(id) as { project_id: ProjectId }[]).map((x) => x.project_id),
    createdAt: r.created_at as IsoTime,
    updatedAt: r.updated_at as IsoTime,
  };
}

export function listThreads(db: Db): Thread[] {
  return (db.prepare("SELECT id FROM threads ORDER BY updated_at DESC, id DESC").all() as { id: number }[]).map((r) => getThread(db, r.id));
}

export function setThreadAutonomy(db: Db, id: number, autonomy: ThreadAutonomy): void {
  db.prepare("UPDATE threads SET autonomy = ?, updated_at = ? WHERE id = ?").run(autonomy, now(), id);
}

export function setThreadReported(db: Db, id: number, reported: Record<string, string>): void {
  db.prepare("UPDATE threads SET reported_json = ? WHERE id = ?").run(JSON.stringify(reported), id);
}

export function linkThreadProject(db: Db, threadId: number, projectId: ProjectId): void {
  getProject(db, projectId);
  db.prepare("INSERT OR IGNORE INTO thread_projects (thread_id, project_id) VALUES (?, ?)").run(threadId, projectId);
}

export function threadsForProject(db: Db, projectId: ProjectId): number[] {
  return (db.prepare("SELECT thread_id FROM thread_projects WHERE project_id = ?").all(projectId) as { thread_id: number }[]).map((r) => r.thread_id);
}

export function addMessage(db: Db, m: { threadId: number; role: MessageRole; body: string; turnLog?: string | null }): ThreadMessage {
  const at = now();
  const id = Number(
    db.prepare("INSERT INTO thread_messages (thread_id, role, body, turn_log, created_at) VALUES (?, ?, ?, ?, ?)").run(m.threadId, m.role, m.body, m.turnLog ?? null, at)
      .lastInsertRowid,
  );
  db.prepare("INSERT INTO search (body, kind, ref_id, project_id) VALUES (?, 'message', ?, NULL)").run(m.body, String(id));
  db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(at, m.threadId);
  recordEvent(db, "thread.message", {}, { thread: m.threadId, message: id, role: m.role });
  return getMessage(db, id);
}

const toMessage = (r: Row): ThreadMessage => ({
  id: r.id as number,
  threadId: r.thread_id as number,
  role: r.role as MessageRole,
  body: r.body as string,
  turnLog: (r.turn_log as string | null) ?? null,
  createdAt: r.created_at as IsoTime,
});

export function getMessage(db: Db, id: number): ThreadMessage {
  const r = db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new Error(`message ${id} not found`);
  return toMessage(r);
}

export function listMessages(db: Db, threadId: number, opts: { lastN?: number } = {}): ThreadMessage[] {
  const rows = db
    .prepare("SELECT * FROM (SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
    .all(threadId, opts.lastN ?? -1) as Row[];
  return rows.map(toMessage);
}

export function searchMessages(db: Db, query: string, threadId?: number): (ThreadMessage & { snippet: string })[] {
  if (!query.trim()) return [];
  const match = query.replace(/"/g, '""').split(/\s+/).filter(Boolean).map((t) => `"${t}"`).join(" ");
  const rows = db
    .prepare(
      `SELECT m.*, snippet(search, 0, '[', ']', '…', 12) AS snippet FROM search s JOIN thread_messages m ON m.id = CAST(s.ref_id AS INTEGER)
       WHERE search MATCH ? AND s.kind = 'message' AND (? IS NULL OR m.thread_id = ?) ORDER BY m.id DESC LIMIT 50`,
    )
    .all(match, threadId ?? null, threadId ?? null) as Row[];
  return rows.map((r) => ({ ...toMessage(r), snippet: r.snippet as string }));
}

const toDecision = (r: Row): ThreadDecision => ({
  id: r.id as number,
  threadId: r.thread_id as number,
  text: r.text as string,
  sourceMessageId: (r.source_message_id as number | null) ?? null,
  supersededBy: (r.superseded_by as number | null) ?? null,
  createdAt: r.created_at as IsoTime,
});

export function addDecision(db: Db, d: { threadId: number; text: string; sourceMessageId: number | null; supersedes?: number | null }): ThreadDecision {
  return db.transaction(() => {
    const id = Number(
      db.prepare("INSERT INTO thread_decisions (thread_id, text, source_message_id, created_at) VALUES (?, ?, ?, ?)").run(d.threadId, d.text, d.sourceMessageId, now()).lastInsertRowid,
    );
    if (d.supersedes != null) {
      const old = getDecision(db, d.supersedes);
      if (old.threadId !== d.threadId) throw new Error(`decision D${d.supersedes} belongs to another thread`);
      if (old.supersededBy !== null) throw new Error(`decision D${d.supersedes} is already superseded by D${old.supersededBy}`);
      db.prepare("UPDATE thread_decisions SET superseded_by = ? WHERE id = ?").run(id, d.supersedes);
    }
    return getDecision(db, id);
  })();
}

export function getDecision(db: Db, id: number): ThreadDecision {
  const r = db.prepare("SELECT * FROM thread_decisions WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new Error(`decision D${id} not found`);
  return toDecision(r);
}

export function listDecisions(db: Db, threadId: number, opts: { activeOnly?: boolean } = {}): ThreadDecision[] {
  const rows = db.prepare(`SELECT * FROM thread_decisions WHERE thread_id = ? ${opts.activeOnly ? "AND superseded_by IS NULL" : ""} ORDER BY id`).all(threadId) as Row[];
  return rows.map(toDecision);
}

const toQuestion = (r: Row): ThreadQuestion => ({
  id: r.id as number,
  threadId: r.thread_id as number,
  text: r.text as string,
  sourceMessageId: (r.source_message_id as number | null) ?? null,
  answer: (r.answer as string | null) ?? null,
  resolvedMessageId: (r.resolved_message_id as number | null) ?? null,
  createdAt: r.created_at as IsoTime,
});

export function addQuestion(db: Db, q: { threadId: number; text: string; sourceMessageId: number | null }): ThreadQuestion {
  const id = Number(
    db.prepare("INSERT INTO thread_questions (thread_id, text, source_message_id, created_at) VALUES (?, ?, ?, ?)").run(q.threadId, q.text, q.sourceMessageId, now()).lastInsertRowid,
  );
  return getQuestion(db, id);
}

export function getQuestion(db: Db, id: number): ThreadQuestion {
  const r = db.prepare("SELECT * FROM thread_questions WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new Error(`question Q${id} not found`);
  return toQuestion(r);
}

export function resolveQuestion(db: Db, id: number, answer: string, messageId: number | null): void {
  const q = getQuestion(db, id);
  if (q.resolvedMessageId !== null || q.answer !== null) throw new Error(`question Q${id} is already resolved`);
  db.prepare("UPDATE thread_questions SET answer = ?, resolved_message_id = ? WHERE id = ?").run(answer, messageId, id);
}

export function listQuestions(db: Db, threadId: number, opts: { openOnly?: boolean } = {}): ThreadQuestion[] {
  const rows = db.prepare(`SELECT * FROM thread_questions WHERE thread_id = ? ${opts.openOnly ? "AND answer IS NULL" : ""} ORDER BY id`).all(threadId) as Row[];
  return rows.map(toQuestion);
}

const toProposal = (r: Row): Proposal => ({
  id: r.id as number,
  threadId: r.thread_id as number,
  messageId: (r.message_id as number | null) ?? null,
  body: JSON.parse(r.body_json as string),
  state: r.state as ProposalState,
  result: r.result_json ? JSON.parse(r.result_json as string) : null,
  createdAt: r.created_at as IsoTime,
  resolvedAt: (r.resolved_at as IsoTime | null) ?? null,
});

export function addProposal(db: Db, p: { threadId: number; messageId: number | null; body: unknown }): Proposal {
  const id = Number(
    db.prepare("INSERT INTO proposals (thread_id, message_id, body_json, created_at) VALUES (?, ?, ?, ?)").run(p.threadId, p.messageId, JSON.stringify(p.body), now()).lastInsertRowid,
  );
  recordEvent(db, "proposal.created", {}, { thread: p.threadId, proposal: id });
  return getProposal(db, id);
}

export function getProposal(db: Db, id: number): Proposal {
  const r = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new Error(`proposal ${id} not found`);
  return toProposal(r);
}

export function listProposals(db: Db, threadId: number, state?: ProposalState): Proposal[] {
  const rows = db.prepare("SELECT * FROM proposals WHERE thread_id = ? AND (? IS NULL OR state = ?) ORDER BY id").all(threadId, state ?? null, state ?? null) as Row[];
  return rows.map(toProposal);
}

export function resolveProposal(db: Db, id: number, state: Exclude<ProposalState, "pending">, result: unknown): void {
  const p = getProposal(db, id);
  if (p.state !== "pending") throw new Error(`proposal ${id} is ${p.state}`);
  db.prepare("UPDATE proposals SET state = ?, result_json = ?, resolved_at = ? WHERE id = ?").run(state, JSON.stringify(result), now(), id);
  recordEvent(db, `proposal.${state}`, {}, { thread: p.threadId, proposal: id });
}
