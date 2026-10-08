import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { attemptRecorder } from "./agent.js";
import { RECORD_KINDS, type ProjectId, type RepoId, type Role, type Unit } from "./domain.js";
import { layout } from "./paths.js";
import { recordCli } from "./record-cli.js";
import { describeRecords, missingRecords, recordedHandoff } from "./records.js";
import { addProject, addRepo, addUnit, createAttempt, openStore, type Db } from "./store.js";

let home: string;
let db: Db;
const project = "p" as ProjectId;
const unitOf = (type: Unit["type"]) =>
  addUnit(db, {
    projectId: project,
    type,
    repoId: type === "plan" ? null : ("r" as RepoId),
    goal: "g",
    acceptance: ["shout('app') === 'HELLO, APP!'", "greet stays"],
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
  addProject(db, { id: project, name: "p", goal: "g", predicate: "x", repos: ["r" as RepoId] });
});

describe("agent records", () => {
  it("guards the record kinds with the same CHECK list the TS enum has", () => {
    const s = session(unitOf("work"), "worker");
    const insert = db.prepare("INSERT INTO agent_records (attempt_id, kind, key, data_json, created_at) VALUES (?, ?, ?, '{}', 't')");
    RECORD_KINDS.forEach((k) => insert.run(s.attempt.id, k, "x"));
    expect(() => insert.run(s.attempt.id, "status", "y")).toThrow(/CHECK/);
  });

  it("skips the plugin's Stop hook in a session without an attempt, never starting yagura", () => {
    const hooks = JSON.parse(readFileSync(new URL("../../../plugins/yagura/hooks/hooks.json", import.meta.url), "utf8"));
    const command = hooks.hooks.Stop[0].hooks[0].command as string;
    const run = spawnSync("sh", ["-c", command], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(spawnSync("sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", YAGURA_ATTEMPT: "1" }, encoding: "utf8" }).status).toBe(127);
  });

  it("lets a session without an attempt (the watchman's) stop, while its record commands still refuse", async () => {
    expect(await recordCli(["check-done", "--hook"], {}, () => "{}")).toEqual({ code: 0, output: "" });
    expect(await recordCli(["handoff", "done"], {}, () => "")).toEqual({
      code: 2,
      output: "yagura handoff only works inside a yagura session (YAGURA_ATTEMPT is not set)\n",
    });
  });

  it("refuses a caller without the attempt's token, and a role recording what is not its own", async () => {
    const s = session(unitOf("work"), "worker");
    expect(await recordCli(["handoff", "done"], { ...s.env, YAGURA_EVIDENCE_TOKEN: "0".repeat(48) })).toEqual({
      code: 2,
      output: "yagura handoff refused: YAGURA_EVIDENCE_TOKEN does not match this attempt's session\n",
    });
    const r = await s.call("decide", "fresh", "--reason", "x");
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^yagura decide was not recorded: the worker role does not record decisions\n/);
    const judge = await s.call("judge", "approve", "--runs", "1");
    expect(judge.output).toMatch(/^yagura judge was not recorded: the worker role does not record judges\n/);
  });

  it("records a worker's handoff once it is valid, and the engine reads it without parsing any text", async () => {
    const s = session(unitOf("work"), "worker");
    expect(s.missing()).toEqual([expect.stringMatching(/^no handoff: run `yagura handoff done`/)]);
    const bad = await s.call("handoff", "Success!", "--did", "x");
    expect(bad.code).toBe(1);
    expect(bad.output).toMatch(/status: Invalid enum value. Expected 'done' \| 'stuck', received 'Success!'/);
    const ok = await s.call(
      "handoff",
      "done",
      "--did",
      "added shout, with `## Notes` and ```fences``` that no parser reads",
      "--evidence",
      "run:42",
      "--decision",
      "kept the old greet",
    );
    expect(ok).toEqual({ code: 0, output: "recorded handoff\nnothing left to record\n" });
    expect(s.missing()).toEqual([]);
    expect(recordedHandoff(db, s.attempt.id)).toEqual({
      status: "done",
      reason: null,
      whatIDid: "- added shout, with `## Notes` and ```fences``` that no parser reads",
      evidence: ["run:42"],
      notes: "",
      decisions: "- kept the old greet",
      followUps: "",
    });
  });

  it("takes a stuck handoff only with its reason", async () => {
    const s = session(unitOf("work"), "worker");
    expect((await s.call("handoff", "stuck")).output).toMatch(/reason: stuck needs --reason/);
    expect((await s.call("handoff", "done", "--reason", "x")).output).toMatch(/reason: --reason only goes with stuck/);
    expect((await s.call("handoff", "stuck", "--reason", "the schema is ambiguous")).code).toBe(0);
    expect(recordedHandoff(db, s.attempt.id)).toMatchObject({ status: "stuck", reason: "the schema is ambiguous" });
  });

  it("takes each of the judge's three verdicts only with what it needs, and approval only with runs the judge recorded", async () => {
    const j = session(unitOf("work"), "judge");
    expect(j.missing()).toEqual([expect.stringMatching(/^no verdict: run `yagura judge approve/)]);
    expect((await j.call("judge", "approve")).output).toMatch(/runs: an approval needs the runs it rests on/);
    expect((await j.call("judge", "approve", "--runs", "nope")).output).toMatch(/--runs takes run ids like 12,14, not "nope"/);
    expect((await j.call("judge", "approve", "--runs", "99")).output).toMatch(/run:99 was not recorded by your yagura evidence run calls/);
    expect((await j.call("judge", "changes")).output).toMatch(/findings: changes need at least one --finding/);
    expect((await j.call("judge", "ask")).output).toMatch(/question: ask needs --question/);
    expect((await j.call("judge", "changes", "--finding", "a.ts:3 wrong", "--question", "q")).output).toMatch(/--question only goes with ask/);

    const run = Number(
      db
        .prepare(
          "INSERT INTO evidence_runs (attempt_id, at, sha, label, command, exit_code, duration_ms, created_at) VALUES (?, 'head', 'abc', 't', 'npm test', 0, 5, 'now')",
        )
        .run(j.attempt.id).lastInsertRowid,
    );
    expect(await j.call("judge", "approve", "--runs", `run:${run}`)).toEqual({ code: 0, output: "recorded judge\nnothing left to record\n" });
    expect(j.missing()).toEqual([]);

    const c = session(unitOf("work"), "judge");
    expect((await c.call("judge", "changes", "--finding", "src/a.ts:3 the discount is never applied", "--finding", "src/b.ts:9 skipped test")).code).toBe(0);
    expect(describeRecords(db, c.attempt.id)).toBe("Judge: changes\nFindings:\n- src/a.ts:3 the discount is never applied\n- src/b.ts:9 skipped test");
    const q = session(unitOf("work"), "judge");
    expect((await q.call("judge", "ask", "--question", "should empty carts be an error?")).code).toBe(0);
    expect(describeRecords(db, q.attempt.id)).toBe("Judge: ask\nQuestion: should empty carts be an error?");
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
    await fresh.call("handoff", "done", "--did", "all of it");
    expect(await fresh.hook()).toEqual({ code: 0, output: "" });
  });

  it("refuses a unit lead's decision that is not on its menu or lacks what it needs, and a plan file that is not a plan delta", async () => {
    const lead = session(unitOf("work"), "lead");
    expect((await lead.call("decide", "merge", "--reason", "x")).output).toMatch(/action: Invalid enum value/);
    expect((await lead.call("decide", "ask", "--reason", "it is the developer's call")).output).toMatch(/question: ask needs --question/);
    expect((await lead.call("decide", "answer", "--reason", "the judge asked")).output).toMatch(/note: answer needs --note/);
    expect((await lead.call("decide", "fresh", "--reason", "the first try misread the spec", "--note", "read SPEC.md")).code).toBe(0);
    expect(describeRecords(db, lead.attempt.id)).toBe("Decision: fresh: the first try misread the spec (note: read SPEC.md)");
    const planner = session(unitOf("plan"), "planner");
    const viaStdin = (json: string) => recordCli(["plan", "--file", "-"], planner.env, () => json);
    expect((await viaStdin("{ not json")).output).toMatch(/the file is not valid JSON/);
    expect((await viaStdin('{"gates":[{"key":"x"}]}')).output).toMatch(/^yagura plan was not recorded: /);
    expect((await viaStdin('{"add":[]}')).code).toBe(0);
  });

  it("checks a plan the way applying it would, while the planner can still fix it, and leaves nothing behind", async () => {
    const planner = session(unitOf("plan"), "planner");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n;
    const unitIn = (repo: string) => ({ key: "a", repo, goal: "g", acceptance: ["works"], playbook: "feature" });
    const refused = await planner.call("plan", "--json", JSON.stringify({ add: [unitIn("elsewhere")] }));
    expect(refused.code).toBe(1);
    expect(refused.output).toMatch(/^yagura plan was not recorded: .*elsewhere/);
    expect((await planner.call("plan", "--json", JSON.stringify({ add: [unitIn("r")] }))).code).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n).toBe(before);
  });
});
