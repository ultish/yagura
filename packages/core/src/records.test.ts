import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { attemptRecorder } from "./agent.js";
import { RECORD_KINDS, type ProjectId, type RepoId, type Role, type Unit } from "./domain.js";
import { layout } from "./paths.js";
import { recordCli } from "./record-cli.js";
import { missingRecords, recordedAmendments, recordedHandoff, recordedRulings } from "./records.js";
import { addProject, addRepo, addUnit, createAttempt, openStore, type Db } from "./store.js";

let home: string;
let db: Db;
const project = "p" as ProjectId;
const unitOf = (type: Unit["type"], targetUnitId?: Unit["id"]) =>
  addUnit(db, {
    projectId: project,
    type,
    repoId: "r" as RepoId,
    targetUnitId,
    goal: "g",
    writeScope: ["app/**"],
    acceptance: ["shout('app') === 'HELLO, APP!'", "greet stays"],
    verify: "node check.js",
    timeboxSeconds: 60,
    maxAttempts: 1,
  });

// A session as yagura starts one: the attempt, its token, and its role in the environment.
function session(unit: Unit, role: Role) {
  const attempt = createAttempt(db, unit.id, "claude", null);
  const env = { ...process.env, YAGURA_HOME: home, ...attemptRecorder(db, { attempt, unit, projectId: project, role }).env };
  const call = (...argv: string[]) => recordCli(argv, env, () => "");
  const hook = () => recordCli(["check-done", "--hook"], env, () => "{}");
  return { attempt, env, call, hook, missing: () => missingRecords(db, attempt.id, role) };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yagura-records-"));
  db = openStore(layout({ home, packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" }).db);
  addRepo(db, { id: "r", url: "/r", defaultBranch: "main" });
  addProject(db, { id: project, name: "p", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["r" as RepoId] });
});

describe("agent records", () => {
  it("guards the record kinds with the same CHECK list the TS enum has", () => {
    const s = session(unitOf("work"), "worker");
    const insert = db.prepare("INSERT INTO agent_records (attempt_id, kind, key, data_json, created_at) VALUES (?, ?, ?, '{}', 't')");
    RECORD_KINDS.forEach((k) => insert.run(s.attempt.id, k, "x"));
    expect(() => insert.run(s.attempt.id, "status", "y")).toThrow(/CHECK/);
  });

  it("refuses a caller without the attempt's token, and a role recording what is not its own", async () => {
    const s = session(unitOf("work"), "worker");
    expect(await recordCli(["handoff", "success"], { ...s.env, YAGURA_EVIDENCE_TOKEN: "0".repeat(48) })).toEqual({
      code: 2,
      output: "yagura handoff refused: YAGURA_EVIDENCE_TOKEN does not match this attempt's session\n",
    });
    const r = await s.call("rule", "T1", "fix", "--reason", "x");
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^yagura rule was not recorded: the worker role does not record rulings\n/);
  });

  it("records a worker's handoff once it is valid, and the engine reads it without parsing any text", async () => {
    const s = session(unitOf("work"), "worker");
    expect(s.missing()).toEqual([expect.stringMatching(/^no handoff: run `yagura handoff/)]);
    const bad = await s.call("handoff", "Success!", "--did", "x");
    expect(bad.code).toBe(1);
    expect(bad.output).toMatch(/status: Invalid enum value. Expected 'success' \| 'partial' \| 'blocked', received 'Success!'/);
    const ok = await s.call(
      "handoff",
      "success",
      "--tier",
      "unit-verified",
      "--did",
      "added shout, with `## Notes` and ```fences``` that no parser reads",
      "--outside-scope",
      "test/shout.test.js=the test for the change",
      "--for-others",
      "shout() exists now",
    );
    expect(ok).toEqual({ code: 0, output: "recorded handoff\nnothing left to record\n" });
    expect(s.missing()).toEqual([]);
    expect(recordedHandoff(db, s.attempt.id, "the report")).toMatchObject({
      status: "success",
      verification: "unit-verified",
      whatIDid: "- added shout, with `## Notes` and ```fences``` that no parser reads",
      outsideScope: "- test/shout.test.js: the test for the change",
      forOthers: "- shout() exists now",
      raw: "the report",
    });
  });

  it("takes a verifier's verdict only with runs this attempt recorded, and criteria the unit has", async () => {
    const target = unitOf("work");
    const s = session(unitOf("verify", target.id), "verifier");
    const run = db
      .prepare(
        "INSERT INTO evidence_runs (attempt_id, at, sha, label, command, exit_code, duration_ms, created_at) VALUES (?, 'head', 'h', 's', 'c', 0, 1, 't')",
      )
      .run(s.attempt.id).lastInsertRowid as number;
    expect((await s.call("verdict", "unit-verified")).output).toMatch(/a pass tier needs the runs that prove it/);
    expect((await s.call("verdict", "unit-verified", "--runs", "999")).output).toMatch(/run:999 was not recorded by your yagura evidence run calls/);
    expect((await s.call("finding", "3", "met", "--runs", String(run))).output).toMatch(/criterion 3 does not exist; ACCEPTANCE has 2/);
    expect((await s.call("finding", "1", "met", "--runs", `run:${run}`)).code).toBe(0);
    expect((await s.call("verdict", "unit-verified", "--runs", String(run))).code).toBe(0);
    expect(recordedHandoff(db, s.attempt.id, "")).toMatchObject({
      verification: "unit-verified",
      citedRunIds: [run],
      findings: `- [x] criterion 1 (run:${run})`,
    });
  });

  it("asks the arbiter for a ruling on every thread of its wave, and checks an amendment against the unit as it stands", async () => {
    const target = unitOf("work");
    const wave = unitOf("review-triage", target.id);
    const thread = db.prepare(
      "INSERT INTO mr_threads (unit_id, thread_id, kind, author, comments_json, wave_unit_id, created_at) VALUES (?, ?, 'review-thread', 'ultish', '[]', ?, 't')",
    );
    thread.run(target.id, "A", wave.id);
    thread.run(target.id, "B", wave.id);
    const s = session(wave, "review-triage");
    expect((await s.call("rule", "T3", "fix", "--reason", "x")).output).toMatch(/T3 does not exist; this wave has 2 threads \(T1–T2\)/);
    expect((await s.call("rule", "T1", "ask", "--reason", "emojis contradict criterion 1")).output).toMatch(
      /an ask must say whether it changes what the unit must do/,
    );
    expect((await s.call("rule", "T1", "ask", "--reason", "emojis contradict criterion 1", "--changes-acceptance", "yes")).output).toMatch(
      /recorded ruling T1\nstill to record:\n- no ruling for T2[^\n]*\n- T1 changes what the unit must do but has no amendment/,
    );
    expect((await s.call("amend", "T1", "replace", "--from", "no such criterion", "--to", "x")).output).toMatch(
      /no acceptance criterion reads "no such criterion"/,
    );
    expect((await s.call("amend", "T1", "replace", "--from", "shout('app') === 'HELLO, APP!'", "--to", "shout('app') === 'HELLO, APP! 🎉'")).code).toBe(0);
    expect((await s.call("amend", "T1", "verify", "--command", "node check.js --emoji")).code).toBe(0);
    expect((await s.call("rule", "T2", "dismiss", "--reason", "the test covers it")).output).toMatch(/nothing left to record/);
    expect(recordedRulings(db, s.attempt.id)).toEqual(
      new Map([
        [1, { decision: "asked", reason: "emojis contradict criterion 1" }],
        [2, { decision: "dismissed", reason: "the test covers it" }],
      ]),
    );
    expect(recordedAmendments(db, s.attempt.id).get(1)).toEqual([
      { kind: "replace", from: "shout('app') === 'HELLO, APP!'", to: "shout('app') === 'HELLO, APP! 🎉'" },
      { kind: "verify", command: "node check.js --emoji" },
    ]);
  });

  it("blocks the agent's stop as a Claude Code hook while something is missing, at most twice, then lets it stop", async () => {
    const s = session(unitOf("work"), "worker");
    for (let i = 0; i < 2; i++) {
      const r = await s.hook();
      expect(r.code).toBe(0);
      expect(JSON.parse(r.output)).toEqual({ decision: "block", reason: expect.stringMatching(/- no handoff: run `yagura handoff/) });
    }
    expect(await s.hook()).toEqual({ code: 0, output: "" });
    const fresh = session(unitOf("work"), "worker");
    await fresh.call("handoff", "partial", "--did", "half of it");
    expect(await fresh.hook()).toEqual({ code: 0, output: "" });
  });

  it("refuses a unit lead's decision that is not on its menu, and a plan file that is not a plan delta", async () => {
    const lead = session(unitOf("manager", unitOf("work").id), "manager");
    expect((await lead.call("decide", "merge", "--reason", "x")).output).toMatch(/action: Invalid enum value/);
    expect((await lead.call("decide", "fresh", "--reason", "the first try misread the spec", "--note", "read SPEC.md")).code).toBe(0);
    const planner = session(
      addUnit(db, {
        projectId: project,
        type: "plan",
        repoId: null,
        goal: "plan",
        writeScope: [],
        acceptance: [],
        verify: null,
        timeboxSeconds: 60,
        maxAttempts: 1,
      }),
      "planner",
    );
    const viaStdin = (json: string) => recordCli(["plan", "--file", "-"], planner.env, () => json);
    expect((await viaStdin("{ not json")).output).toMatch(/the file is not valid JSON/);
    expect((await viaStdin('{"gates":[{"key":"x"}]}')).output).toMatch(/^yagura plan was not recorded: /);
    expect((await viaStdin('{"add":[]}')).code).toBe(0);
  });

  it("checks a plan the way applying it would, while the planner can still fix it, and leaves nothing behind", async () => {
    const planner = session(
      addUnit(db, {
        projectId: project,
        type: "plan",
        repoId: null,
        goal: "plan",
        writeScope: [],
        acceptance: [],
        verify: null,
        timeboxSeconds: 60,
        maxAttempts: 1,
      }),
      "planner",
    );
    const before = (db.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n;
    const unitIn = (repo: string) => ({ key: "a", repo, goal: "g", write: ["app/**"], accept: ["works"], verify: "true", playbook: "feature" });
    const refused = await planner.call("plan", "--json", JSON.stringify({ add: [unitIn("elsewhere")] }));
    expect(refused.code).toBe(1);
    expect(refused.output).toMatch(/^yagura plan was not recorded: .*elsewhere/);
    expect((await planner.call("plan", "--json", JSON.stringify({ add: [unitIn("r")] }))).code).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n).toBe(before);
  });
});
