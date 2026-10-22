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

describe("naming a project in a conversation", () => {
  const setup = async () => {
    const { addProject, addRepo, addUnit, setProjectState } = await import("./store.js");
    const db = openStore(":memory:");
    addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
    for (const id of ["pstack-claude", "other"]) {
      addProject(db, { id, name: id, goal: "g", predicate: "x", repos: ["r" as never] });
      setProjectState(db, id as never, "active");
    }
    addUnit(db, { projectId: "other" as never, type: "work", repoId: "r" as never, goal: "g", acceptance: ["a"], timeboxSeconds: 60, maxAttempts: 2 });
    return { db, thread: createThread(db, { title: "pull from upstream" }) };
  };

  it("links the project to the thread, so the watchman can add units to it", async () => {
    const { db, thread } = await setup();
    addMessage(db, { threadId: thread.id, role: "human", body: "@pstack-claude pull from upstream" });
    expect(getThread(db, thread.id).projects).toEqual(["pstack-claude"]);
  });

  it("links the project of a unit that is named, and each project once", async () => {
    const { db, thread } = await setup();
    addMessage(db, { threadId: thread.id, role: "human", body: "look at @other/U1 and @other, and @pstack-claude" });
    expect(getThread(db, thread.id).projects.sort()).toEqual(["other", "pstack-claude"]);
  });

  it("does not link a project the watchman or the system mentions, or a name that is not a project", async () => {
    const { db, thread } = await setup();
    addMessage(db, { threadId: thread.id, role: "watchman", body: "have you thought about @pstack-claude?" });
    addMessage(db, { threadId: thread.id, role: "system", body: "applied: @other" });
    addMessage(db, { threadId: thread.id, role: "human", body: "ping @nobody-here" });
    expect(getThread(db, thread.id).projects).toEqual([]);
  });
});
