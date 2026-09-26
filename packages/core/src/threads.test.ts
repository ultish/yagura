import { beforeEach, describe, expect, it } from "vitest";
import { MESSAGE_ROLES, PROPOSAL_STATES, THREAD_AUTONOMIES, THREAD_STATES } from "./domain.js";
import { openStore, type Db } from "./store.js";
import {
  addDecision,
  addMessage,
  addProposal,
  addQuestion,
  createThread,
  listDecisions,
  listMessages,
  listQuestions,
  resolveQuestion,
  searchMessages,
} from "./threads.js";

let db: Db;
beforeEach(() => {
  db = openStore(":memory:");
});

describe("thread store", () => {
  it("accepts every TS enum value the migration's CHECKs guard, and rejects others", () => {
    const t = createThread(db, { title: "t" });
    for (const a of THREAD_AUTONOMIES) db.prepare("UPDATE threads SET autonomy = ? WHERE id = ?").run(a, t.id);
    for (const s of THREAD_STATES) db.prepare("UPDATE threads SET state = ? WHERE id = ?").run(s, t.id);
    for (const r of MESSAGE_ROLES) addMessage(db, { threadId: t.id, role: r, body: r });
    const p = addProposal(db, { threadId: t.id, messageId: null, body: {} });
    for (const s of PROPOSAL_STATES) db.prepare("UPDATE proposals SET state = ? WHERE id = ?").run(s, p.id);
    expect(() => db.prepare("UPDATE threads SET autonomy = 'yolo' WHERE id = ?").run(t.id)).toThrow(/CHECK/);
    expect(() => addMessage(db, { threadId: t.id, role: "bot" as never, body: "x" })).toThrow(/CHECK/);
  });

  it("keeps decisions forever and marks superseded ones instead of changing them", () => {
    const t = createThread(db, { title: "t" });
    const m = addMessage(db, { threadId: t.id, role: "watchman", body: "ok" });
    const d1 = addDecision(db, { threadId: t.id, text: "compare every field", sourceMessageId: m.id });
    const d2 = addDecision(db, { threadId: t.id, text: "ignore timestamp fields", sourceMessageId: m.id, supersedes: d1.id });
    expect(listDecisions(db, t.id, { activeOnly: true }).map((d) => d.text)).toEqual(["ignore timestamp fields"]);
    expect(listDecisions(db, t.id).map((d) => [d.text, d.supersededBy])).toEqual([
      ["compare every field", d2.id],
      ["ignore timestamp fields", null],
    ]);
    expect(() => addDecision(db, { threadId: t.id, text: "again", sourceMessageId: null, supersedes: d1.id })).toThrow(/already superseded/);
    expect(listDecisions(db, t.id)).toHaveLength(2);
  });

  it("resolves a question once, with the answering message", () => {
    const t = createThread(db, { title: "t" });
    const q = addQuestion(db, { threadId: t.id, text: "which cluster?", sourceMessageId: null });
    const m = addMessage(db, { threadId: t.id, role: "human", body: "dev-2" });
    resolveQuestion(db, q.id, "dev-2", m.id);
    expect(listQuestions(db, t.id, { openOnly: true })).toEqual([]);
    expect(listQuestions(db, t.id)[0]).toMatchObject({ answer: "dev-2", resolvedMessageId: m.id });
    expect(() => resolveQuestion(db, q.id, "dev-3", m.id)).toThrow(/already resolved/);
  });

  it("returns the last N messages oldest-first and finds old ones by full-text search", () => {
    const t = createThread(db, { title: "t" });
    const other = createThread(db, { title: "o" });
    addMessage(db, { threadId: t.id, role: "human", body: "the kafka topic is orders.v2" });
    for (let i = 0; i < 5; i++) addMessage(db, { threadId: t.id, role: "human", body: `filler ${i}` });
    addMessage(db, { threadId: other.id, role: "human", body: "kafka elsewhere" });
    expect(listMessages(db, t.id, { lastN: 2 }).map((m) => m.body)).toEqual(["filler 3", "filler 4"]);
    expect(searchMessages(db, "kafka", t.id).map((m) => m.body)).toEqual(["the kafka topic is orders.v2"]);
    expect(searchMessages(db, "kafka").map((m) => m.threadId).sort()).toEqual([t.id, other.id].sort());
  });
});
