import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadBootstrap, resolveSetting, setSetting, UnknownSetting, effectiveSettings } from "./config.js";
import { IllegalTransition, type ProjectId, type RepoId } from "./domain.js";
import { addProject, addRepo, addUnit, createAttempt, getUnit, openStore, transitionUnit, updateAttempt, getAttempt, type Db } from "./store.js";

let db: Db;
const project = "p" as ProjectId;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "testbed", url: "file:///tb", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "pred", minTier: "unit-verified", repos: ["testbed" as RepoId] });
});

const newUnit = () =>
  addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "testbed" as RepoId,
    goal: "Implement apply_discount",
    writeScope: ["app/**"],
    acceptance: ["SAVE10 takes 10% off"],
    verify: "python3 -m unittest",
    timeboxSeconds: 600,
    maxAttempts: 2,
  });

describe("store", () => {
  it("reopens an existing database without re-applying the schema", () => {
    const path = join(mkdtempSync(join(tmpdir(), "yagura-db-")), "yagura.db");
    const first = openStore(path);
    addRepo(first, { id: "r", url: "file:///r", defaultBranch: "main" });
    first.close();
    const second = openStore(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 1 });
  });

  it("numbers units per project and round-trips their fields", () => {
    const a = newUnit();
    const b = newUnit();
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a).toMatchObject({ state: "draft", writeScope: ["app/**"], acceptance: ["SAVE10 takes 10% off"], forbidScope: [] });
  });

  it("applies legal transitions, refuses illegal ones, and records each in events", () => {
    const u = newUnit();
    transitionUnit(db, u.id, "ready");
    transitionUnit(db, u.id, "running", { attempt: 1 });
    expect(() => transitionUnit(db, u.id, "landed")).toThrow(IllegalTransition);
    expect(getUnit(db, u.id).state).toBe("running");
    const events = db.prepare("SELECT data_json FROM events WHERE type = 'unit.state' ORDER BY id").all() as { data_json: string }[];
    expect(events.map((e) => JSON.parse(e.data_json))).toEqual([
      { from: "draft", to: "ready" },
      { from: "ready", to: "running", attempt: 1 },
    ]);
  });

  it("numbers attempts per unit and patches them", () => {
    const u = newUnit();
    const a1 = createAttempt(db, u.id, "claude", null);
    const a2 = createAttempt(db, u.id, "claude", "opus");
    expect([a1.n, a2.n]).toEqual([1, 2]);
    updateAttempt(db, a1.id, { state: "running", pid: 42, pluginVersions: { pstack: "0.5.0" } });
    expect(getAttempt(db, a1.id)).toMatchObject({ state: "running", pid: 42, pluginVersions: { pstack: "0.5.0" } });
  });
});

describe("settings", () => {
  it("resolves the narrowest layer and reports where the value came from", () => {
    expect(resolveSetting(db, "max_parallel_agents")).toEqual({ value: 4, source: "default" });
    setSetting(db, "global", "", "max_parallel_agents", 8);
    setSetting(db, "project", project, "max_parallel_agents", 2);
    expect(resolveSetting(db, "max_parallel_agents")).toEqual({ value: 8, source: "global" });
    expect(resolveSetting(db, "max_parallel_agents", { projectId: project, repoId: "testbed" as RepoId })).toEqual({ value: 2, source: "project" });
  });

  it("validates values and rejects unknown keys", () => {
    expect(() => setSetting(db, "global", "", "max_parallel_agents", 0)).toThrow();
    expect(() => setSetting(db, "global", "", "max_parallel_agent", 3)).toThrow(UnknownSetting);
  });

  it("lists every setting with its effective value", () => {
    const all = effectiveSettings(db);
    expect(all["role.worker.model"]).toEqual({ value: null, source: "default" });
    expect(all["harness.claude.permission_mode"].value).toBe("bypassPermissions");
  });
});

describe("bootstrap", () => {
  it("layers env vars over yagura.yaml over defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "yagura-home-"));
    writeFileSync(join(home, "yagura.yaml"), "port: 8100\nbind: devvm.local\n");
    const b = loadBootstrap({ YAGURA_HOME: home, YAGURA_PORT: "9000" });
    expect(b).toMatchObject({ home, port: 9000, bind: "devvm.local", packsDir: join(home, "packs") });
    expect(b.skillsDir).toMatch(/plugins\/yagura$/);
  });
});
