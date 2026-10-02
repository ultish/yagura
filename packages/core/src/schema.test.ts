import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ATTEMPT_STATES, FAILURE_MODES, PASS_TIERS, FAIL_TIERS, UNIT_STATES, UNIT_TYPES, UNIT_TRANSITIONS, canTransition, meetsTier } from "./domain.js";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const now = "2026-09-26T00:00:00Z";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(schema);
  db.prepare("INSERT INTO repos (id, url, default_branch, created_at) VALUES ('testbed', 'file:///tb', 'main', ?)").run(now);
  db.prepare("INSERT INTO projects (id, name, goal, predicate, min_tier, created_at) VALUES ('p', 'P', 'g', 'pred', 'unit-verified', ?)").run(now);
});

function insertUnit(fields: Record<string, unknown>) {
  const row = { project_id: "p", seq: 1, type: "work", repo_id: "testbed", goal: "g", timebox_seconds: 600, created_at: now, updated_at: now, ...fields };
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO units (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(row));
}

describe("schema", () => {
  it("accepts every TS enum value the SQL CHECKs guard", () => {
    UNIT_TYPES.forEach((type, i) =>
      insertUnit({
        seq: i + 1,
        type,
        repo_id: type === "plan" || type === "measure" ? null : "testbed",
        target_unit_id: ["verify", "rebase", "ci-fix", "review-triage", "review"].includes(type) ? 1 : null,
      }),
    );
    UNIT_STATES.forEach((state) => db.prepare("UPDATE units SET state = ? WHERE seq = 1").run(state));
    const attempt = db.prepare("INSERT INTO attempts (unit_id, n, harness) VALUES (1, 1, 'claude')").run().lastInsertRowid;
    ATTEMPT_STATES.forEach((s) => db.prepare("UPDATE attempts SET state = ? WHERE id = ?").run(s, attempt));
    FAILURE_MODES.forEach((m) => db.prepare("UPDATE attempts SET failure_mode = ? WHERE id = ?").run(m, attempt));
    [...PASS_TIERS, ...FAIL_TIERS].forEach((tier, i) =>
      db
        .prepare("INSERT INTO verdicts (unit_id, attempt_id, tier, repo_id, head_sha, created_at) VALUES (1, ?, ?, 'testbed', ?, ?)")
        .run(attempt, tier, `sha${i}`, now),
    );
  });

  it("rejects values outside the enums", () => {
    expect(() => insertUnit({ type: "deploy" })).toThrow(/CHECK/);
    insertUnit({});
    expect(() => db.prepare("UPDATE units SET state = 'wip' WHERE seq = 1").run()).toThrow(/CHECK/);
  });

  it("requires a repo for repo-writing units and a target for fix/verify units", () => {
    expect(() => insertUnit({ repo_id: null })).toThrow(/CHECK/);
    expect(() => insertUnit({ type: "verify" })).toThrow(/CHECK/);
    expect(insertUnit({ type: "plan", repo_id: null }).changes).toBe(1);
  });

  it("rejects dependencies on missing units and self-dependencies", () => {
    insertUnit({});
    expect(() => db.prepare("INSERT INTO unit_deps VALUES (1, 99, 'needs-source')").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO unit_deps VALUES (1, 1, 'needs-source')").run()).toThrow(/CHECK/);
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
});

describe("unit state machine", () => {
  it("defines transitions for every state and only to known states", () => {
    expect(Object.keys(UNIT_TRANSITIONS).sort()).toEqual([...UNIT_STATES].sort());
    for (const targets of Object.values(UNIT_TRANSITIONS)) for (const t of targets) expect(UNIT_STATES).toContain(t);
  });

  it("walks the happy path and refuses shortcuts", () => {
    const path = ["draft", "ready", "running", "handed_off", "verifying", "verified", "landing", "landed"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    expect(canTransition("running", "verified")).toBe(false);
    expect(canTransition("handed_off", "landed")).toBe(false);
    expect(canTransition("landed", "ready")).toBe(false);
  });

  it("can abandon any non-terminal unit and nothing leaves a terminal state", () => {
    const terminal = Object.entries(UNIT_TRANSITIONS)
      .filter(([, targets]) => targets.length === 0)
      .map(([s]) => s);
    expect(terminal.sort()).toEqual(["abandoned", "done", "landed"]);
    for (const [state, targets] of Object.entries(UNIT_TRANSITIONS)) if (!terminal.includes(state)) expect(targets).toContain("abandoned");
  });
});

describe("tiers", () => {
  it("ranks pass tiers and never lets a failure tier pass", () => {
    expect(meetsTier("deployed-verified", "unit-verified")).toBe(true);
    expect(meetsTier("unit-verified", "unit-verified")).toBe(true);
    expect(meetsTier("build-only", "unit-verified")).toBe(false);
    expect(meetsTier("verifier-blocked", "build-only")).toBe(false);
    expect(meetsTier("verifier-failed", "build-only")).toBe(false);
  });
});
