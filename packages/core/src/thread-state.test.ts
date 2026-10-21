import { describe, expect, it } from "vitest";
import { openStore } from "./store.js";
import { addMessage, createThread, getThread, setThreadState } from "./threads.js";

describe("closing a conversation", () => {
  it("closes and reopens, recording each change once", () => {
    const db = openStore(":memory:");
    const t = createThread(db, { title: "Copy button" });
    expect(t.state).toBe("open");
    setThreadState(db, t.id, "closed");
    setThreadState(db, t.id, "closed");
    expect(getThread(db, t.id).state).toBe("closed");
    setThreadState(db, t.id, "open");
    const events = db.prepare("SELECT data_json FROM events WHERE type = 'thread.state' ORDER BY id").all() as { data_json: string }[];
    expect(events.map((e) => JSON.parse(e.data_json).state)).toEqual(["closed", "open"]);
  });

  it("reopens when a person writes in it, and stays closed for the watchman and the system", () => {
    const db = openStore(":memory:");
    const t = createThread(db, { title: "Copy button" });
    setThreadState(db, t.id, "closed");
    addMessage(db, { threadId: t.id, role: "system", body: "Applied proposal 1" });
    addMessage(db, { threadId: t.id, role: "watchman", body: "done" });
    expect(getThread(db, t.id).state).toBe("closed");
    addMessage(db, { threadId: t.id, role: "human", body: "one more thing" });
    expect(getThread(db, t.id).state).toBe("open");
  });
});
