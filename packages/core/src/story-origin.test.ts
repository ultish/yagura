import { beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { unitStory } from "./story.js";
import { addProject, addRepo, addUnit, openStore, setProjectState, type Db } from "./store.js";
import { addProposal, createThread } from "./threads.js";

let db: Db;
const boot = {} as Bootstrap;
const unit = (projectId: string) =>
  addUnit(db, { projectId: projectId as ProjectId, type: "work", repoId: "r" as RepoId, goal: "g", acceptance: ["a"], timeboxSeconds: 60, maxAttempts: 2 });
const apply = (threadId: number, result: unknown) => {
  const p = addProposal(db, { threadId, messageId: null, body: {} });
  db.prepare("UPDATE proposals SET state = 'applied', result_json = ? WHERE id = ?").run(JSON.stringify(result), p.id);
};

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
  for (const id of ["rakko", "demo-app"]) {
    addProject(db, { id, name: id, goal: "g", predicate: "x", repos: ["r" as RepoId] });
    setProjectState(db, id as ProjectId, "active");
  }
});

describe("a unit's origin", () => {
  it("is the conversation whose proposal added the unit", () => {
    const thread = createThread(db, { title: "Copy button gives no feedback" });
    const u1 = unit("rakko");
    const u2 = unit("rakko");
    apply(thread.id, { repos: [], environments: [], projects: [], units: { rakko: ["U2"] } });
    expect(unitStory(db, boot, u1).origin).toBeNull();
    expect(unitStory(db, boot, u2).origin).toEqual({ threadId: thread.id, title: "Copy button gives no feedback" });
  });

  it("is the conversation that created the unit's project, even for a hyphenated id", () => {
    const thread = createThread(db, { title: "New app" });
    const u = unit("demo-app");
    apply(thread.id, { repos: [], environments: [], projects: ["demo-app"], units: {} });
    expect(unitStory(db, boot, u).origin?.threadId).toBe(thread.id);
  });

  it("ignores a proposal that was discarded or never applied", () => {
    const thread = createThread(db, { title: "Nope" });
    const u = unit("rakko");
    const p = addProposal(db, { threadId: thread.id, messageId: null, body: {} });
    db.prepare("UPDATE proposals SET result_json = ? WHERE id = ?").run(JSON.stringify({ units: { rakko: ["U1"] } }), p.id);
    expect(unitStory(db, boot, u).origin).toBeNull();
  });
});
