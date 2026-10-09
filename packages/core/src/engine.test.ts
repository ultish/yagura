import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import { setSetting, type Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { Engine } from "./engine.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  getProject,
  getRepo,
  getUnit,
  setAndon,
  listAttempts,
  listUnits,
  openStore,
  setMergePolicy,
  setProjectEnvironment,
  setRepoForge,
  type Db,
} from "./store.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs"), ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
  parse: parseClaudeLine,
};
const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;

let db: Db;
let ctx: RunContext;
let origin: string;
let root: string;
const project = "p" as ProjectId;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "yagura-engine-"));
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "README.md"), "seed\n");
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "all files landed", repos: ["testbed" as RepoId] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  setMergePolicy(db, project, "auto");
  setSetting(db, "global", "", "forge.poll_seconds", 1);
  process.env.FAKE_MODE = "engine";
  process.env.FAKE_ORIGIN = origin;
  ghState = join(root, "gh.json");
});

afterEach(() => {
  for (const k of ["FAKE_JUDGE_CHANGES", "FAKE_BASE_MOVE", "FAKE_JUDGE", "FAKE_WORKER_STUCK", "FAKE_DOCTOR"]) delete process.env[k];
});

let ghState: string;
// The repo lands through pull requests on a fake GitHub over the same origin.
function onFakeGithub() {
  setRepoForge(db, "testbed" as RepoId, "gh", true);
  setSetting(db, "repo", "testbed", "forge.repo", "ultish/testbed");
  setSetting(db, "global", "", "forge.gh_bin", fixtures("fake-gh.mjs"));
  process.env.FAKE_GH_ORIGIN = origin;
  process.env.FAKE_GH_STATE = ghState;
}
const ghPrs = () =>
  (JSON.parse(readFileSync(ghState, "utf8")) as { prs: { number: number; head: string; title: string; body: string; state: string; isDraft: boolean }[] }).prs;
const states = (unitId: number) =>
  (
    db.prepare("SELECT json_extract(data_json, '$.to') AS to_ FROM events WHERE type = 'unit.state' AND unit_id = ? ORDER BY id").all(unitId) as {
      to_: string;
    }[]
  ).map((r) => r.to_);
const workUnits = () => listUnits(db, project).filter((u) => u.type === "work");

describe("Engine", () => {
  it("stops starting work past 70% of the wall-clock budget, and raises an andon when it is spent", async () => {
    setSetting(db, "project", project, "project.budget_hours", 1);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(ago(50), project);
    const log: string[] = [];
    const engine = new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) });
    await engine.runUntilIdle();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.map((u) => u.state)).toEqual(["waiting", "waiting", "waiting"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.type = 'work'").get()).toEqual({ n: 0 });
    expect(log).toContain("  p: 83% of the wall-clock budget used; no new work starts, verified work keeps landing");
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(ago(70), project);
    await engine.tick();
    expect(getProject(db, project).andonReason).toBe("the wall-clock budget of 1h is used up; what was verified has landed, and the rest waits for you");
  });

  it("raises an andon once the project's agents have spent its cost budget, and starts nothing after", async () => {
    setSetting(db, "project", project, "project.budget_usd", 0.025);
    const log: string[] = [];
    const engine = new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) });
    await engine.runUntilIdle();
    const andon = getProject(db, project).andonReason;
    expect(andon).toMatch(
      /^the cost budget of \$0\.03 is used up \(\$0\.0\d spent\); running agents finish and nothing new starts\. Raise project\.budget_usd to continue$/,
    );
    const sessions = (db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n;
    expect(getProject(db, project).state).not.toBe("closed");
    await engine.tick();
    expect((db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n).toBe(sessions);

    setSetting(db, "project", project, "project.budget_usd", 100);
    setAndon(db, project, null);
    await engine.runUntilIdle();
    expect(listUnits(db, project).filter((u) => u.type === "work" && u.state === "merged")).toHaveLength(3);
  }, 60_000);

  it("takes a unit right the first time from its draft pull request to a merge commit on main", async () => {
    onFakeGithub();
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();

    const [a, b, c] = workUnits();
    expect(workUnits().map((u) => [u.goal, u.state])).toEqual([
      ["write a", "merged"],
      ["write b", "merged"],
      ["write c", "merged"],
    ]);
    expect(states(a!.id)).toEqual(["building", "judging", "ready", "merged"]);
    expect(listAttempts(db, a!.id).map((x) => x.role)).toEqual(["worker", "judge"]);
    expect(
      ghPrs()
        .map((p) => `${p.head} ${p.state} draft:${p.isDraft}`)
        .sort(),
    ).toEqual([`yagura/p/u${a!.seq} MERGED draft:false`, `yagura/p/u${b!.seq} MERGED draft:false`, `yagura/p/u${c!.seq} MERGED draft:false`]);
    const pr = ghPrs().find((p) => p.head === `yagura/p/u${a!.seq}`)!;
    expect(pr.title).toBe("write a");
    expect(pr.body).toBe(`write a\n\n## Acceptance\n- a file exists\n\nBuilt by yagura: p/U${a!.seq}.`);

    const merge = getUnit(db, a!.id).mergedSha!;
    const parents = (await git(["log", "-1", "--format=%P", merge], { gitDir: origin })).split(" ");
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(getUnit(db, a!.id).approvedSha);
    const message = await git(["log", "-1", "--format=%B", merge], { gitDir: origin });
    expect(message).toMatch(
      new RegExp(`^p/U${a!.seq}: write a \\(#\\d\\)\\n\\nWorkers: A\\d+ \\(fake-model\\)\\nJudge: A\\d+ approved [0-9a-f]{10}, on run:\\d+$`),
    );
    expect(await git(["show", `main:app/a/p-U${a!.seq}.txt`], { gitDir: origin })).toBe("work");
    expect(getProject(db, project).state).toBe("closed");
  }, 60_000);

  it("sends a unit back to its own worker with the judge's findings, and merges it after the second judge approves", async () => {
    onFakeGithub();
    const planned = new Engine(ctx, { projectId: project, tickMs: 50 });
    process.env.FAKE_JUDGE_CHANGES = "U3";
    await planned.runUntilIdle();
    const u2 = workUnits().find((u) => u.seq === 3)!;
    expect(states(u2.id)).toEqual(["building", "judging", "building", "judging", "ready", "merged"]);
    const attempts = listAttempts(db, u2.id);
    expect(attempts.map((x) => [x.role, x.state])).toEqual([
      ["worker", "handed_off"],
      ["judge", "handed_off"],
      ["worker", "handed_off"],
      ["judge", "handed_off"],
    ]);
    expect(attempts[2]!.resumesAttemptId).toBe(attempts[0]!.id);
    expect(await git(["show", `main:app/a/p-U3.txt`], { gitDir: origin })).toBe("work\n# fixed after findings: true");
    expect(ghPrs().filter((p) => p.head === "yagura/p/u3")).toHaveLength(1);
    const commits = await git(["log", "--format=%s", `${getUnit(db, u2.id).mergedSha}^2`, "--not", `${getUnit(db, u2.id).mergedSha}^1`], { gitDir: origin });
    expect(commits.split("\n")).toContain("fix after findings");
  }, 60_000);

  it("merges a base that moved cleanly into a waiting unit's branch, and merges that unit after", async () => {
    onFakeGithub();
    setSetting(db, "project", project, "project.max_in_flight", 1);
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    const based = db.prepare("SELECT unit_id FROM events WHERE type = 'unit.base_merged'").all() as { unit_id: number }[];
    expect(based.length).toBeGreaterThan(0);
    const unit = getUnit(db, based[0]!.unit_id as never);
    expect(unit.state).toBe("merged");
    const branchLog = await git(["log", "--format=%s", `${unit.mergedSha}^2`, "-3"], { gitDir: origin });
    expect(branchLog).toContain(`Merge main into yagura/p/u${unit.seq}`);
  }, 60_000);

  it("sends a conflict with the base back to the worker, who merges and resolves it, then the judge and the merge", async () => {
    onFakeGithub();
    process.env.FAKE_BASE_MOVE = "U3";
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    const u2 = workUnits().find((u) => u.seq === 3)!;
    expect(states(u2.id)).toEqual(["building", "building", "judging", "ready", "merged"]);
    const conflict = db
      .prepare(
        "SELECT json_extract(data_json, '$.round.kind') AS kind, json_extract(data_json, '$.round.files') AS files FROM events WHERE type = 'unit.state' AND unit_id = ? ORDER BY id LIMIT 1 OFFSET 1",
      )
      .get(u2.id);
    expect(conflict).toEqual({ kind: "conflict", files: JSON.stringify(["app/a/p-U3.txt"]) });
    expect(await git(["show", "main:app/a/p-U3.txt"], { gitDir: origin })).toBe("work, merged with the base");
  }, 60_000);

  it("wakes the unit lead when a worker is stuck, and the fresh worker it starts takes the unit to a merge", async () => {
    process.env.FAKE_WORKER_STUCK = "U3";
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    const u2 = workUnits().find((u) => u.seq === 3)!;
    expect(states(u2.id)).toEqual(["building", "stuck", "building", "judging", "ready", "merged"]);
    expect(listAttempts(db, u2.id).map((x) => x.role)).toEqual(["worker", "lead", "worker", "judge"]);
    expect(
      workUnits()
        .filter((u) => u.seq !== 3)
        .flatMap((u) => listAttempts(db, u.id).map((x) => x.role)),
    ).not.toContain("lead");
  }, 60_000);

  it("sticks a unit that crashes before it starts instead of starting it again every tick", async () => {
    setSetting(db, "project", project, "role.worker.harness", "missing-harness");
    const log: string[] = [];
    await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.filter((u) => u.state === "stuck").length).toBeGreaterThan(0);
    expect(log.filter((l) => l.startsWith("✗ worker")).length).toBe(work.filter((u) => u.state === "stuck").length);
    expect(db.prepare("SELECT data_json FROM events WHERE type = 'unit.state' AND json_extract(data_json, '$.to') = 'stuck' LIMIT 1").get()).toEqual({
      data_json: JSON.stringify({ from: "building", to: "stuck", reason: "engine error: no adapter for harness missing-harness", trigger: "engine" }),
    });
  });

  it("does not start work while the project's andon is raised", async () => {
    const { setAndon } = await import("./store.js");
    setAndon(db, project, "investigating a bad deploy");
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    expect(listUnits(db, project)).toEqual([]);
  });

  it("starts no agent while the account's usage limit holds, says so once, and carries on when it clears", async () => {
    const { clearHold, holdHarness } = await import("./limits.js");
    const until = new Date(Date.now() + 3_600_000).toISOString();
    holdHarness(db, "claude", until, "You've hit your session limit");
    const log: string[] = [];
    const engine = new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) });
    await engine.runUntilIdle();
    await engine.tick();
    expect(listUnits(db, project)).toEqual([]);
    expect(log.filter((l) => l.includes("usage limit on claude: no new agents until"))).toHaveLength(1);
    expect(clearHold(db, "claude")).toBe(true);
    await engine.runUntilIdle();
    expect(listUnits(db, project).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("the doctor", () => {
  const doctors = () => listUnits(db, project).filter((u) => u.type === "doctor");
  const env = "local" as EnvironmentId;

  it("looks at each repo once when the project starts, and its proven actions reach the workers' briefs", async () => {
    const { listActions } = await import("./actions.js");
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    expect(doctors().map((u) => [u.goal, u.state])).toEqual([["Doctor: testbed in local", "merged"]]);
    expect(listActions(db, env).map((a) => [a.name, a.repoId, a.state, a.author])).toEqual([["test", "testbed", "proven", "doctor"]]);
    const workerBrief = readFileSync(layout(ctx.boot).brief(project, workUnits().at(-1)!.seq, 1), "utf8");
    expect(workerBrief).toContain("- `test` (proven): Runs the whole suite.\n  `true`");
  }, 60_000);

  it("is woken once by a broken action, never again by its own failed fix, and again when the developer asks", async () => {
    const { findAction, reportBroken } = await import("./actions.js");
    const { doctorWake, requestDoctor } = await import("./doctor.js");
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    const test = findAction(db, env, "testbed" as RepoId, "test")!;
    reportBroken(db, test.id, "gradle: command not found", null as never);
    expect(doctorWake(db, project, "testbed" as RepoId)).toEqual({
      trigger: "broken",
      detail: "An action for this repo is broken.\n- test: gradle: command not found",
    });

    process.env.FAKE_DOCTOR = "fail";
    const { runDoctorRound } = await import("./doctor.js");
    await runDoctorRound(ctx, project, "testbed" as RepoId, doctorWake(db, project, "testbed" as RepoId)!);
    expect(doctors().map((u) => u.state)).toEqual(["merged", "merged"]);
    expect(findAction(db, env, "testbed" as RepoId, "test")!.state).toBe("broken");
    expect(doctorWake(db, project, "testbed" as RepoId)).toBeNull();

    delete process.env.FAKE_DOCTOR;
    requestDoctor(db, env, "nexus is back up");
    expect(doctorWake(db, project, "testbed" as RepoId)).toEqual({
      trigger: "asked",
      detail: "The developer asked for a doctor.\nThey said: nexus is back up",
    });
  }, 90_000);
});
