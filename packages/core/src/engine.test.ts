import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import { setSetting, type Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { Engine } from "./engine.js";
import { commitAll, diffRange, git } from "./git.js";
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
const project = "p" as ProjectId;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-engine-"));
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
  process.env.FAKE_MODE = "engine";
});

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
    expect(listUnits(db, project).filter((u) => u.type === "work" && u.state === "judging")).toHaveLength(2);
  }, 60_000);

  it("plans and runs disjoint units in parallel, leaves an overlapping one waiting, and ends each worker at judging", async () => {
    const log: string[] = [];
    await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();

    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.map((u) => [u.goal, u.state])).toEqual([
      ["write a", "judging"],
      ["write b", "judging"],
      ["write c", "waiting"],
    ]);
    expect(listUnits(db, project).filter((u) => u.type !== "work" && u.type !== "plan")).toEqual([]);

    const events = db.prepare("SELECT id, type, unit_id FROM events WHERE type IN ('attempt.started', 'attempt.ended') ORDER BY id").all() as {
      id: number;
      type: string;
      unit_id: number;
    }[];
    const at = (type: string, unitId: number) => events.find((e) => e.type === type && e.unit_id === unitId)!.id;
    const [a, b] = work.map((u) => u.id);
    expect(at("attempt.started", b!)).toBeLessThan(at("attempt.ended", a!));

    const workAttempt = listAttempts(db, a!)[0]!;
    const diff = await diffRange(layout(ctx.boot).mirror("testbed" as RepoId), workAttempt.baseSha!, workAttempt.headSha!);
    expect(diff).toContain(`+++ b/app/a/p-U${work[0]!.seq}.txt\n@@ -0,0 +1 @@\n+work`);

    const checkouts = join(ctx.boot.home, "worktrees", "testbed");
    expect(readdirSync(checkouts).length).toBeGreaterThan(1);
    const fallbacks = db.prepare("SELECT data_json FROM events WHERE type = 'parse.fallback'").all() as { data_json: string }[];
    expect(fallbacks).toEqual([]);
  }, 60_000);

  it("sticks a unit that crashes before it starts instead of starting it again every tick", async () => {
    setSetting(db, "project", project, "role.worker.harness", "missing-harness");
    const log: string[] = [];
    await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.filter((u) => u.state === "stuck").length).toBeGreaterThan(0);
    expect(log.filter((l) => l.startsWith("✗ work")).length).toBe(work.filter((u) => u.state === "stuck").length);
    expect(db.prepare("SELECT data_json FROM events WHERE type = 'unit.state' AND json_extract(data_json, '$.to') = 'stuck' LIMIT 1").get()).toEqual({
      data_json: JSON.stringify({ from: "waiting", to: "stuck", reason: "engine error before it started: no adapter for harness missing-harness" }),
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
