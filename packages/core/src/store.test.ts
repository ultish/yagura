import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSetting,
  describeSettings,
  exportSettings,
  importSettings,
  loadBootstrap,
  resolveSetting,
  setSetting,
  SettingsImportInvalid,
  UnknownSetting,
  effectiveSettings,
} from "./config.js";
import { IllegalTransition, UNIT_STATES, UNIT_TRANSITIONS, type ProjectId, type RepoId, type UnitState } from "./domain.js";
import {
  addGate,
  addProject,
  addRepo,
  addUnit,
  createAttempt,
  getUnit,
  listUnits,
  openStore,
  schemaVersion,
  transitionUnit,
  updateAttempt,
  getAttempt,
  type Db,
} from "./store.js";
import { LATEST_VERSION } from "./migrations.js";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

let db: Db;
const project = "p" as ProjectId;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "testbed", url: "file:///tb", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "pred", repos: ["testbed" as RepoId] });
});

const newUnit = () =>
  addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "testbed" as RepoId,
    goal: "Implement apply_discount",
    acceptance: ["SAVE10 takes 10% off"],
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

  it("takes the write lock before a transaction reads, so another process cannot commit between its read and its write", () => {
    const path = join(mkdtempSync(join(tmpdir(), "yagura-db-")), "yagura.db");
    const mine = openStore(path);
    addRepo(mine, { id: "r", url: "file:///r", defaultBranch: "main" });
    const other = new Database(path);
    other.pragma("busy_timeout = 0");
    let otherWrite = "committed";
    mine.transaction(() => {
      mine.prepare("SELECT COUNT(*) AS n FROM repos").get();
      try {
        other.prepare("INSERT INTO repos (id, url, default_branch, created_at) VALUES ('x', 'file:///x', 'main', 't')").run();
      } catch (e) {
        otherWrite = (e as Error).message;
      }
      mine.prepare("INSERT INTO repos (id, url, default_branch, created_at) VALUES ('y', 'file:///y', 'main', 't')").run();
    })();
    expect(otherWrite).toBe("database is locked");
    expect(mine.prepare("SELECT id FROM repos ORDER BY id").all()).toEqual([{ id: "r" }, { id: "y" }]);
  });

  it("waits for another process that holds the write lock, and retries a transaction that still comes back busy", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "yagura-db-")), "yagura.db");
    const mine = openStore(path);
    addRepo(mine, { id: "r", url: "file:///r", defaultBranch: "main" });
    const script = `const D = require(${JSON.stringify(createRequire(import.meta.url).resolve("better-sqlite3"))}); const d = new D(${JSON.stringify(path)}); d.pragma("busy_timeout = 5000"); d.exec("BEGIN IMMEDIATE"); console.log("locked"); setTimeout(() => { d.exec("COMMIT"); process.exit(0); }, 700);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    mine.pragma("busy_timeout = 50");
    const started = Date.now();
    mine.transaction(() => {
      mine.prepare("INSERT INTO repos (id, url, default_branch, created_at) VALUES ('z', 'file:///z', 'main', 't')").run();
    })();
    expect(Date.now() - started).toBeGreaterThan(400);
    expect(mine.prepare("SELECT id FROM repos ORDER BY id").all()).toEqual([{ id: "r" }, { id: "z" }]);
  });

  it("brings a fresh database to the latest schema version", () => {
    expect(schemaVersion(db)).toBe(LATEST_VERSION);
  });

  it("numbers units per project and round-trips their fields", () => {
    const a = newUnit();
    const b = newUnit();
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a).toMatchObject({
      state: "waiting",
      acceptance: ["SAVE10 takes 10% off"],
      context: [],
      after: [],
      base: null,
      branch: null,
      approvedSha: null,
      mergedSha: null,
    });
  });

  it("applies legal transitions, refuses illegal ones, and records each in events", () => {
    const u = newUnit();
    transitionUnit(db, u.id, "building", { attempt: 1 });
    expect(() => transitionUnit(db, u.id, "ready")).toThrow(IllegalTransition);
    expect(getUnit(db, u.id).state).toBe("building");
    transitionUnit(db, u.id, "judging");
    const events = db.prepare("SELECT data_json FROM events WHERE type = 'unit.state' ORDER BY id").all() as { data_json: string }[];
    expect(events.map((e) => JSON.parse(e.data_json))).toEqual([
      { from: "waiting", to: "building", attempt: 1 },
      { from: "building", to: "judging" },
    ]);
  });

  it("cancels a unit's open merge question when it leaves ready, and keeps every other question", () => {
    const u = newUnit();
    for (const to of ["building", "judging", "ready"] as const) transitionUnit(db, u.id, to);
    const land = addGate(db, { projectId: u.projectId, unitId: u.id, kind: "land", question: "Merge U1 at abc?", options: ["land", "hold"] });
    const lead = addGate(db, { projectId: u.projectId, unitId: u.id, kind: "lead", question: "U1's unit lead asks: why?", options: [] });
    transitionUnit(db, u.id, "judging");
    expect(db.prepare("SELECT id, state FROM gates ORDER BY id").all()).toEqual([
      { id: land, state: "cancelled" },
      { id: lead, state: "open" },
    ]);
  });

  it("allows every move UNIT_TRANSITIONS lists and refuses every other", () => {
    const at = (state: UnitState) => {
      const u = newUnit();
      db.prepare("UPDATE units SET state = ? WHERE id = ?").run(state, u.id);
      return u;
    };
    for (const from of UNIT_STATES)
      for (const to of UNIT_STATES) {
        const u = at(from);
        if (UNIT_TRANSITIONS[from].includes(to)) {
          transitionUnit(db, u.id, to);
          expect(getUnit(db, u.id).state).toBe(to);
        } else {
          expect(() => transitionUnit(db, u.id, to)).toThrow(IllegalTransition);
          expect(getUnit(db, u.id).state).toBe(from);
        }
      }
  });

  it("keeps the units a unit comes after, in either order they were given", () => {
    const first = newUnit();
    const second = newUnit();
    const third = addUnit(db, {
      projectId: project,
      type: "work",
      repoId: "testbed" as RepoId,
      goal: "g",
      acceptance: ["a"],
      after: [second.id, first.id, first.id],
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    expect(third.after).toEqual([first.id, second.id]);
    expect(getUnit(db, third.id).after).toEqual([first.id, second.id]);
    expect(listUnits(db, project).map((u) => u.after)).toEqual([[], [], [first.id, second.id]]);
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
    setSetting(db, "global", "", "max_attempts", 8);
    setSetting(db, "repo", "testbed", "max_attempts", 4);
    setSetting(db, "project", project, "max_attempts", 2);
    expect(resolveSetting(db, "max_attempts")).toEqual({ value: 8, source: "global" });
    expect(resolveSetting(db, "max_attempts", { repoId: "testbed" as RepoId })).toEqual({ value: 4, source: "repo" });
    expect(resolveSetting(db, "max_attempts", { projectId: project, repoId: "testbed" as RepoId })).toEqual({ value: 2, source: "project" });
  });

  it("validates values and rejects unknown keys", () => {
    expect(() => setSetting(db, "global", "", "max_parallel_agents", 0)).toThrow();
    expect(() => setSetting(db, "global", "", "max_parallel_agent", 3)).toThrow(UnknownSetting);
  });

  it("refuses an override at a layer the setting is never read at", () => {
    expect(() => setSetting(db, "project", project, "max_parallel_agents", 9)).toThrow("max_parallel_agents cannot be set per project; it is global only");
    expect(() => setSetting(db, "environment", "dev", "max_attempts", 9)).toThrow(
      "max_attempts cannot be set per environment; it can be set globally or per project or repo",
    );
    setSetting(db, "environment", "dev", "timebox.judge_seconds", 600);
    expect(describeSettings(db, { environmentId: "dev" as never }, "environment").map((s) => [s.key, s.source])).toEqual([
      ["role.doctor.harness", "default"],
      ["role.doctor.model", "default"],
      ["timebox.doctor_seconds", "default"],
      ["timebox.judge_seconds", "environment"],
      ["skills.scaffold", "default"],
      ["skills.work", "default"],
      ["lease.keep", "default"],
      ["lease.keep_hours", "default"],
    ]);
    expect(() => importSettings(db, "project:\n  p:\n    watchman.context_tokens: 9000\n")).toThrow(
      "project.p.watchman.context_tokens: watchman.context_tokens cannot be set per project; it is global only",
    );
  });

  it("clears a layer's value so the next layer shows through", () => {
    setSetting(db, "global", "", "max_attempts", 5);
    setSetting(db, "project", project, "max_attempts", 3);
    expect(clearSetting(db, "project", project, "max_attempts")).toBe(true);
    expect(clearSetting(db, "project", project, "max_attempts")).toBe(false);
    expect(resolveSetting(db, "max_attempts", { projectId: project })).toEqual({ value: 5, source: "global" });
    expect(() => clearSetting(db, "global", "", "nope")).toThrow(UnknownSetting);
  });

  it("describes every setting with its default and a plain description", () => {
    setSetting(db, "global", "", "max_parallel_agents", 6);
    const info = describeSettings(db);
    expect(info.find((s) => s.key === "max_parallel_agents")).toEqual({
      key: "max_parallel_agents",
      value: 6,
      source: "global",
      default: 4,
      description: "Most agents running at once, across every project",
      layers: [],
    });
    expect(info.filter((s) => !s.description)).toEqual([]);
  });

  it("exports explicit values by layer as YAML and imports them into another store", () => {
    setSetting(db, "global", "", "max_parallel_agents", 6);
    setSetting(db, "global", "", "harness.claude.extra_args", ["--verbose"]);
    setSetting(db, "project", project, "max_attempts", 3);
    const text = exportSettings(db);
    expect(text).toBe("global:\n  harness.claude.extra_args:\n    - --verbose\n  max_parallel_agents: 6\nproject:\n  p:\n    max_attempts: 3\n");
    const other = openStore(":memory:");
    setSetting(other, "global", "", "max_attempts", 9);
    expect(importSettings(other, text)).toBe(3);
    expect(exportSettings(other)).toBe(
      "global:\n  harness.claude.extra_args:\n    - --verbose\n  max_attempts: 9\n  max_parallel_agents: 6\nproject:\n  p:\n    max_attempts: 3\n",
    );
  });

  it("imports nothing when any value in the file is wrong, and says where", () => {
    expect(() => importSettings(db, "global:\n  max_parallel_agents: 6\n  max_attempts: 0\n")).toThrow("global.max_attempts: Number must be greater than 0");
    expect(() => importSettings(db, "repo:\n  testbed:\n    colour: red\n")).toThrow("repo.testbed.colour: unknown setting");
    expect(() => importSettings(db, "globals: {}\n")).toThrow(/Unrecognized key/);
    expect(() => importSettings(db, "global: [\n")).toThrow(SettingsImportInvalid);
    expect(resolveSetting(db, "max_parallel_agents").source).toBe("default");
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

describe("deleting an environment", () => {
  it("refuses while an open project uses it or a slot is held, then removes it with its values and settings", async () => {
    const { addEnvironment, deleteEnvironment, getProject, setProjectEnvironment, setProjectState } = await import("./store.js");
    const { setValue, listValues } = await import("./envvalues.js");
    const { setSetting } = await import("./config.js");
    const db = openStore(":memory:");
    addRepo(db, { id: "r", url: "/r", defaultBranch: "main" });
    addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", repos: ["r" as RepoId] });
    const env = "box" as never;
    addEnvironment(db, { id: "box", name: "box", provider: "local-process", capacity: 1 });
    setValue(db, env, { name: "REDIS_URL", value: "redis://box:6379" });
    setSetting(db, "environment", "box", "lease.keep", "failed");
    setProjectEnvironment(db, "p" as ProjectId, env);
    expect(() => deleteEnvironment(db, env)).toThrow("environment box is used by p; move those projects to another environment first");
    setProjectState(db, "p" as ProjectId, "closed");
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      acceptance: [],
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    const a = createAttempt(db, unit.id, "claude", null);
    db.prepare("INSERT INTO leases (environment_id, attempt_id, slot, state, requested_at) VALUES ('box', ?, '0', 'active', 'now')").run(a.id);
    expect(() => deleteEnvironment(db, env)).toThrow("environment box has slots in use or kept; wait for them or delete the kept ones first");
    db.prepare("UPDATE leases SET state = 'released'").run();
    deleteEnvironment(db, env);
    expect(db.prepare("SELECT COUNT(*) AS n FROM environments").get()).toEqual({ n: 0 });
    expect(listValues(db, env)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE scope = 'environment'").get()).toEqual({ n: 0 });
    expect(getProject(db, "p" as ProjectId).environmentId).toBeNull();
  });
});
