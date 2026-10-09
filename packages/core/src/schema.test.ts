import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTION_AUTHORS,
  ACTION_RUNNERS,
  ACTION_STATES,
  ATTEMPT_STATES,
  FAILURE_MODES,
  HANDOFF_STATUSES,
  RECORD_KINDS,
  ROLES,
  TERMINAL_STATES,
  UNIT_STATES,
  UNIT_TRANSITIONS,
  UNIT_TYPES,
  canTransition,
} from "./domain.js";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const now = "2026-09-26T00:00:00Z";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(schema);
  db.prepare("INSERT INTO repos (id, url, default_branch, created_at) VALUES ('testbed', 'file:///tb', 'main', ?)").run(now);
  db.prepare("INSERT INTO projects (id, name, goal, predicate, created_at) VALUES ('p', 'P', 'g', 'pred', ?)").run(now);
});

function insertUnit(fields: Record<string, unknown>) {
  const row = { project_id: "p", seq: 1, type: "work", repo_id: "testbed", goal: "g", timebox_seconds: 600, created_at: now, updated_at: now, ...fields };
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO units (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(row));
}

describe("schema", () => {
  it("starts at version 1", () => {
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
  });

  it("accepts every TS enum value the SQL CHECKs guard", () => {
    UNIT_TYPES.forEach((type, i) => insertUnit({ seq: i + 1, type, repo_id: type === "plan" ? null : "testbed" }));
    UNIT_STATES.forEach((state) => db.prepare("UPDATE units SET state = ? WHERE seq = 1").run(state));
    const attempt = db.prepare("INSERT INTO attempts (unit_id, n, harness) VALUES (1, 1, 'claude')").run().lastInsertRowid;
    ATTEMPT_STATES.forEach((s) => db.prepare("UPDATE attempts SET state = ? WHERE id = ?").run(s, attempt));
    FAILURE_MODES.forEach((m) => db.prepare("UPDATE attempts SET failure_mode = ? WHERE id = ?").run(m, attempt));
    HANDOFF_STATUSES.forEach((s) => db.prepare("UPDATE attempts SET handoff_status = ? WHERE id = ?").run(s, attempt));
    ROLES.forEach((r) => db.prepare("UPDATE attempts SET role = ? WHERE id = ?").run(r, attempt));
    const insert = db.prepare("INSERT INTO agent_records (attempt_id, kind, key, data_json, created_at) VALUES (?, ?, ?, '{}', ?)");
    RECORD_KINDS.forEach((k) => insert.run(attempt, k, "x", now));
    db.prepare("INSERT INTO environments (id, name, provider, capacity, created_at) VALUES ('dev', 'dev', 'local-process', 1, ?)").run(now);
    const action = db
      .prepare(
        "INSERT INTO actions (environment_id, name, purpose, command, state, author, created_at, updated_at) VALUES ('dev', 't', 'u', 'c', 'unproven', 'you', ?, ?)",
      )
      .run(now, now).lastInsertRowid;
    ACTION_STATES.forEach((s) => db.prepare("UPDATE actions SET state = ? WHERE id = ?").run(s, action));
    ACTION_AUTHORS.forEach((a) => db.prepare("UPDATE actions SET author = ? WHERE id = ?").run(a, action));
    ACTION_RUNNERS.forEach((by) =>
      db
        .prepare(
          "INSERT INTO action_runs (environment_id, repo_id, sha, command, duration_ms, output, by, created_at) VALUES ('dev', 'testbed', 's', 'c', 1, '', ?, ?)",
        )
        .run(by, now),
    );
  });

  it("rejects values outside the enums", () => {
    expect(() => insertUnit({ type: "deploy" })).toThrow(/CHECK/);
    insertUnit({});
    expect(() => db.prepare("UPDATE units SET state = 'wip' WHERE seq = 1").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE units SET state = 'landed' WHERE seq = 1").run()).toThrow(/CHECK/);
    const attempt = db.prepare("INSERT INTO attempts (unit_id, n, harness) VALUES (1, 1, 'claude')").run().lastInsertRowid;
    expect(() => db.prepare("UPDATE attempts SET role = 'verifier' WHERE id = ?").run(attempt)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO agent_records (attempt_id, kind, data_json, created_at) VALUES (?, 'verdict', '{}', ?)").run(attempt, now)).toThrow(
      /CHECK/,
    );
  });

  it("starts a unit waiting, and requires a repo for work units", () => {
    insertUnit({});
    expect(db.prepare("SELECT state FROM units WHERE seq = 1").get()).toEqual({ state: "waiting" });
    expect(() => insertUnit({ seq: 2, repo_id: null })).toThrow(/CHECK/);
    expect(insertUnit({ seq: 3, type: "plan", repo_id: null }).changes).toBe(1);
  });

  it("rejects dependencies on missing units and self-dependencies", () => {
    insertUnit({});
    expect(() => db.prepare("INSERT INTO unit_deps VALUES (1, 99)").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO unit_deps VALUES (1, 1)").run()).toThrow(/CHECK/);
  });

  it("allows only one active lease per environment slot", () => {
    insertUnit({});
    db.prepare("INSERT INTO attempts (unit_id, n, harness) VALUES (1, 1, 'claude'), (1, 2, 'claude')").run();
    db.prepare("INSERT INTO environments (id, name, provider, capacity, created_at) VALUES ('dev-kube', 'dev', 'kube-namespace', 2, ?)").run(now);
    const lease = db.prepare("INSERT INTO leases (environment_id, attempt_id, slot, state, requested_at) VALUES ('dev-kube', ?, 'ns-1', 'active', ?)");
    lease.run(1, now);
    expect(() => lease.run(2, now)).toThrow(/UNIQUE/);
    db.prepare("UPDATE leases SET state = 'released' WHERE attempt_id = 1").run();
    expect(lease.run(2, now).changes).toBe(1);
  });

  it("keeps global settings unscoped and scoped settings scoped", () => {
    const set = db.prepare("INSERT INTO settings (scope, scope_id, key, value_json, updated_at) VALUES (?, ?, 'max_parallel_agents', '4', ?)");
    expect(() => set.run("global", "p", now)).toThrow(/CHECK/);
    expect(() => set.run("project", "", now)).toThrow(/CHECK/);
    expect(set.run("global", "", now).changes).toBe(1);
  });

  it("indexes text for full-text search", () => {
    db.prepare("INSERT INTO search (body, kind, ref_id, project_id) VALUES ('touched PaymentService retry path', 'handoff', '7', 'p')").run();
    const hit = db.prepare("SELECT ref_id FROM search WHERE search MATCH 'PaymentService'").get() as { ref_id: string };
    expect(hit.ref_id).toBe("7");
  });

  it("has none of the tables the old judging and landing paths used", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const gone of [
      "verdicts",
      "verdict_artifacts",
      "measurements",
      "mr_state",
      "mr_decisions",
      "mr_threads",
      "pack_edits",
      "review_posts",
      "manager_decisions",
      "unit_amendments",
    ])
      expect(tables).not.toContain(gone);
  });
});

describe("unit state machine", () => {
  it("defines transitions for every state and only to known states", () => {
    expect(Object.keys(UNIT_TRANSITIONS).sort()).toEqual([...UNIT_STATES].sort());
    for (const targets of Object.values(UNIT_TRANSITIONS)) for (const t of targets) expect(UNIT_STATES).toContain(t);
  });

  it("walks the happy path and refuses shortcuts", () => {
    const path = ["waiting", "building", "judging", "ready", "merged"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    expect(canTransition("building", "ready")).toBe(false);
    expect(canTransition("waiting", "judging")).toBe(false);
    expect(canTransition("judging", "merged")).toBe(false);
    expect(canTransition("merged", "building")).toBe(false);
  });

  it("sends changes asked, comments, and conflicts back to building, and lets the unit lead decide from stuck", () => {
    expect(canTransition("judging", "building")).toBe(true);
    expect(canTransition("ready", "building")).toBe(true);
    for (const to of ["waiting", "building", "judging", "ready", "dropped"] as const) expect(canTransition("stuck", to)).toBe(true);
    for (const from of ["waiting", "building", "judging", "ready"] as const) expect(canTransition(from, "stuck")).toBe(true);
  });

  it("can drop any non-terminal unit, and nothing leaves a terminal state", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["dropped", "merged"]);
    for (const [state, targets] of Object.entries(UNIT_TRANSITIONS)) {
      if (TERMINAL_STATES.has(state as never)) expect(targets).toEqual([]);
      else expect(targets).toContain("dropped");
    }
  });
});
