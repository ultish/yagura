import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import { runWorkUnit } from "./runner.js";
import { addProject, addRepo, addUnit, getUnit, listAttempts, openStore, transitionUnit, type Db } from "./store.js";

const fakeAgent = fileURLToPath(new URL("./harness/fixtures/fake-agent.mjs", import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  command: (run) => ({ argv: [process.execPath, fakeAgent], stdin: run.prompt }),
  parse: parseClaudeLine,
};

let db: Db;
let boot: Bootstrap;
const project = "p" as ProjectId;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-run-"));
  const origin = join(root, "origin");
  mkdirSync(join(origin, "app"), { recursive: true });
  writeFileSync(join(origin, "app/orders.py"), "x = 1\n");
  await git(["init", "--quiet", "-b", "main"], { cwd: origin });
  await commitAll(origin, "init", { name: "t", email: "t@t" });
  boot = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(":memory:");
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "pred", minTier: "unit-verified", repos: ["testbed" as RepoId] });
});

async function run(mode: string, timeboxSeconds = 60) {
  process.env.FAKE_MODE = mode;
  const unit = addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "testbed" as RepoId,
    goal: "Implement apply_discount",
    writeScope: ["app/**"],
    acceptance: ["SAVE10 takes 10% off"],
    verify: "python3 -m unittest",
    timeboxSeconds,
    maxAttempts: 2,
  });
  transitionUnit(db, unit.id, "ready");
  const attempt = await runWorkUnit({ db, boot, adapters: { claude: fake } }, unit.id);
  return { unit: getUnit(db, unit.id), attempt, paths: layout(boot) };
}

describe("runWorkUnit", () => {
  it("runs an agent in its own worktree and records a clean handoff", async () => {
    const { unit, attempt, paths } = await run("success");
    expect(unit.state).toBe("handed_off");
    expect(attempt).toMatchObject({ state: "handed_off", handoffStatus: "success", selfTier: "unit-verified", model: "fake-model", contextPeak: 1200 });
    expect(attempt.pluginVersions).toEqual({ pstack: "0.5.0" });
    expect(attempt.headSha).not.toBe(attempt.baseSha);
    expect(readFileSync(join(attempt.worktreePath!, "app/orders.py"), "utf8")).toContain("brief had GOAL: true");
    expect(readFileSync(paths.brief(project, 1, 1), "utf8")).toContain("## ACCEPTANCE\n- SAVE10 takes 10% off");
    expect(readFileSync(paths.handoff(project, 1, 1), "utf8")).toMatch(/^## Status\nsuccess/);
    expect(readFileSync(paths.log(project, 1, 1), "utf8").trim().split("\n")).toHaveLength(4);
    expect(await git(["log", "-1", "--format=%s"], { cwd: attempt.worktreePath! })).toMatch(/uncommitted changes left by U1 attempt 1/);
  });

  it("rejects work that wrote outside its scope", async () => {
    const { unit, attempt } = await run("scope");
    expect(unit.state).toBe("rejected");
    expect(attempt).toMatchObject({ state: "handed_off", failureMode: "scope" });
    const ev = db.prepare("SELECT data_json FROM events WHERE type = 'unit.state' ORDER BY id DESC LIMIT 1").get() as { data_json: string };
    expect(JSON.parse(ev.data_json).violations).toEqual([{ path: "README.md", reason: "outside-write-scope" }]);
  });

  it("blocks the unit when the agent hands off blocked", async () => {
    expect((await run("blocked")).unit.state).toBe("blocked");
  });

  it("writes a synthetic failure handoff when the agent ends without one", async () => {
    const { unit, attempt, paths } = await run("nohandoff");
    expect(unit.state).toBe("failed");
    expect(attempt).toMatchObject({ state: "failed", failureMode: "unknown" });
    expect(readFileSync(paths.handoff(project, 1, 1), "utf8")).toContain("yagura synthetic failure handoff");
  });

  it("kills an agent that exceeds its timebox", async () => {
    const started = Date.now();
    const { unit, attempt } = await run("hang", 1);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(unit.state).toBe("failed");
    expect(attempt.failureMode).toBe("timebox");
    expect(listAttempts(db, unit.id)).toHaveLength(1);
  });

  it("refuses to run a unit that is not ready", async () => {
    const unit = addUnit(db, {
      projectId: project,
      type: "work",
      repoId: "testbed" as RepoId,
      goal: "g",
      writeScope: ["app/**"],
      acceptance: ["a"],
      verify: "v",
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    await expect(runWorkUnit({ db, boot, adapters: { claude: fake } }, unit.id)).rejects.toThrow(/draft, not ready/);
    expect(existsSync(layout(boot).mirror("testbed" as RepoId))).toBe(false);
  });
});
