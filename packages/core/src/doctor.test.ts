import { beforeEach, describe, expect, it } from "vitest";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { doctorWakes, requestDoctor } from "./doctor.js";
import { addEnvironment, addProject, addRepo, openStore, setProjectEnvironment, setProjectState, type Db } from "./store.js";

let db: Db;
const env = "box" as EnvironmentId;
const project = "p" as ProjectId;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "/r", defaultBranch: "main" });
  addEnvironment(db, { id: "box", name: "box", provider: "local-process", capacity: 1 });
});

describe("asking for a doctor", () => {
  it("starts one on a repo no doctor has looked at, even when its project is closed", () => {
    addProject(db, { id: project, name: "p", goal: "g", predicate: "x", repos: ["r" as RepoId] });
    setProjectEnvironment(db, project, env);
    setProjectState(db, project, "closed");
    expect(doctorWakes(db, env)).toEqual([]);
    expect(requestDoctor(db, env, "")).toEqual(["r"]);
    expect(doctorWakes(db, env)).toEqual([{ repoId: "r", trigger: "asked", detail: "The developer asked for a doctor.", projectId: null }]);
  });

  it("says there is no repo to look at when no project uses the environment", () => {
    expect(requestDoctor(db, env, "")).toEqual([]);
    expect(doctorWakes(db, env)).toEqual([]);
  });
});
