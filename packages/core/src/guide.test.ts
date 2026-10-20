import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectId, RepoId } from "./domain.js";
import { createGuideUnit, GUIDE_CREATE_PLAYBOOK, guideCreationUnder } from "./guide.js";
import { addProject, addRepo, getUnit, openStore, setProjectState, transitionUnit, type Db } from "./store.js";

let db: Db;
const repo = "r" as RepoId;
const project = "p" as ProjectId;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
  addRepo(db, { id: "other", url: "file:///o", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", repos: [repo] });
  setProjectState(db, project, "active");
});

describe("createGuideUnit", () => {
  it("adds one work unit on the repo, carrying the developer's note", () => {
    const u = createGuideUnit(db, { projectId: project, repoId: repo, note: "start with the REST API" });
    expect(getUnit(db, u.id)).toMatchObject({ type: "work", repoId: repo, playbook: GUIDE_CREATE_PLAYBOOK, state: "waiting" });
    expect(u.context.join("\n")).toContain("pstack:create-verification-skill");
    expect(u.context.join("\n")).toContain("start with the REST API");
    expect(guideCreationUnder(db, repo)).toEqual({ projectId: project, seq: u.seq, state: "waiting" });
  });

  it("refuses a second creation while one is open, then allows one after it is dropped", () => {
    const u = createGuideUnit(db, { projectId: project, repoId: repo });
    expect(() => createGuideUnit(db, { projectId: project, repoId: repo })).toThrow(/already creating/);
    transitionUnit(db, u.id, "dropped", { reason: "test" });
    expect(guideCreationUnder(db, repo)).toBeNull();
    expect(() => createGuideUnit(db, { projectId: project, repoId: repo })).not.toThrow();
  });

  it("refuses a repo the project does not use, and a project that is not active", () => {
    expect(() => createGuideUnit(db, { projectId: project, repoId: "other" as RepoId })).toThrow(/does not use/);
    setProjectState(db, project, "closed");
    expect(() => createGuideUnit(db, { projectId: project, repoId: repo })).toThrow(/not active/);
  });
});
