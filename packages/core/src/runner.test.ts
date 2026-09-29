import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { setSetting, type Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import { runWorkUnit } from "./runner.js";
import { setEnvironmentNotes, setValue } from "./envvalues.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  addUnit,
  getUnit,
  getUnitBySeq,
  listAttempts,
  openStore,
  setProjectEnvironment,
  transitionUnit,
  type Db,
} from "./store.js";

const fakeAgent = fileURLToPath(new URL("./harness/fixtures/fake-agent.mjs", import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command: (run) => ({ argv: [process.execPath, fakeAgent, ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
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
  const attempt = await runWorkUnit({ db, boot, adapters: { claude: fake }, cli: [] }, unit.id);
  return { unit: getUnit(db, unit.id), attempt, paths: layout(boot) };
}

describe("runWorkUnit", () => {
  it("runs an agent in its own worktree and records a clean handoff", async () => {
    const { unit, attempt, paths } = await run("success");
    expect(unit.state).toBe("verifying");
    expect(getUnitBySeq(db, project, 2)).toMatchObject({ type: "verify", state: "ready", targetUnitId: unit.id });
    expect(attempt.skills).toEqual(["yagura:yagura-worker", "pstack:poteto-mode"]);
    expect(attempt.missingSkills).toEqual([]);
    expect(attempt).toMatchObject({ state: "handed_off", handoffStatus: "success", selfTier: "unit-verified", model: "fake-model", contextPeak: 1200 });
    expect(attempt.pluginVersions).toEqual({ pstack: "0.5.0" });
    expect(attempt.headSha).not.toBe(attempt.baseSha);
    expect(readFileSync(join(attempt.worktreePath!, "app/orders.py"), "utf8")).toContain("brief had GOAL: true");
    expect(readFileSync(paths.brief(project, 1, 1), "utf8")).toContain("## ACCEPTANCE\n- SAVE10 takes 10% off");
    expect(readFileSync(paths.handoff(project, 1, 1), "utf8")).toMatch(/^## Status\nsuccess/);
    expect(
      readFileSync(paths.log(project, 1, 1), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(6);
    expect(await git(["log", "-1", "--format=%s"], { cwd: attempt.worktreePath! })).toBe("fake agent work");
    expect(await git(["diff", "--name-only", attempt.baseSha!, "HEAD"], { cwd: attempt.worktreePath! })).toBe("app/orders.py");
    expect(await git(["status", "--porcelain"], { cwd: attempt.worktreePath! })).toBe("");
    expect(readFileSync(paths.leftovers(project, 1, 1), "utf8")).toContain("app/__pycache__/orders.pyc");
  });

  it("rejects work that wrote outside its scope", async () => {
    const { unit, attempt } = await run("scope");
    expect(unit.state).toBe("rejected");
    expect(attempt).toMatchObject({ state: "handed_off", failureMode: "scope" });
    const ev = db.prepare("SELECT data_json FROM events WHERE type = 'unit.state' ORDER BY id DESC LIMIT 1").get() as { data_json: string };
    expect(JSON.parse(ev.data_json).violations).toEqual([{ path: "README.md", reason: "outside-write-scope" }]);
  });

  it("gives the agent the environment's values with their notes, and rejects work that writes one literally", async () => {
    addEnvironment(db, { id: "dev", name: "dev", provider: "local-process", capacity: 1 });
    setProjectEnvironment(db, project, "dev" as EnvironmentId);
    setEnvironmentNotes(db, "dev" as EnvironmentId, "deps run in the cluster");
    setValue(db, "dev" as EnvironmentId, { name: "MARKER", value: "edited by fake agent", note: "the text every fake edit starts with" });
    const { unit, attempt, paths } = await run("success");
    const brief = readFileSync(paths.brief(project, unit.seq, attempt.n), "utf8");
    expect(brief).toContain("## ENV\n- MARKER=edited by fake agent (the text every fake edit starts with)\n");
    expect(brief).toContain("- About this environment: deps run in the cluster");
    expect(unit.state).toBe("rejected");
    expect(attempt).toMatchObject({ state: "handed_off", failureMode: "scope" });
    expect(unit.notes).toEqual([
      'Attempt 1 wrote environment values literally: app/orders.py has "edited by fake agent", use $MARKER. Read values from the environment by name.',
    ]);
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
    await expect(runWorkUnit({ db, boot, adapters: { claude: fake }, cli: [] }, unit.id)).rejects.toThrow(/draft, not ready/);
    expect(existsSync(layout(boot).mirror("testbed" as RepoId))).toBe(false);
  });

  it("rejects an otherwise good attempt that skipped required skills, with a note for the retry", async () => {
    const { unit, attempt } = await run("noskills");
    expect(attempt.missingSkills).toEqual(["yagura:yagura-worker", "pstack:poteto-mode"]);
    expect(unit.state).toBe("rejected");
    expect(unit.notes[0]).toMatch(/skipped required skills \(yagura:yagura-worker, pstack:poteto-mode\)/);
  });

  it("lets a skipped skill through when enforcement is switched off", async () => {
    const { setSetting } = await import("./config.js");
    setSetting(db, "global", "", "method.enforce_required_skills", false);
    expect((await run("noskills")).unit.state).toBe("verifying");
  });

  it("stops a running agent on request and puts the unit back with the operator's note", async () => {
    const { stopAttempt } = await import("./agent.js");
    process.env.FAKE_MODE = "hang";
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
    transitionUnit(db, unit.id, "ready");
    const running = runWorkUnit({ db, boot, adapters: { claude: fake }, cli: [] }, unit.id);
    let attempt = listAttempts(db, unit.id)[0];
    for (let i = 0; i < 50 && !attempt?.pid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      attempt = listAttempts(db, unit.id)[0];
    }
    expect(stopAttempt(db, attempt!.id, "wrong approach; use the store")).toBe(true);
    const done = await running;
    expect(done.state).toBe("stopped");
    expect(getUnit(db, unit.id)).toMatchObject({ state: "ready", notes: ["Operator stopped attempt 1: wrong approach; use the store"] });
  });

  describe("project skills and reference repos", () => {
    const ctx = () => ({ db, boot, adapters: { claude: fake }, cli: [] });
    const unitWith = (scaffold: boolean) => {
      const u = addUnit(db, {
        projectId: project,
        type: "work",
        repoId: "testbed" as RepoId,
        goal: "Build it",
        writeScope: ["app/**"],
        acceptance: ["it builds"],
        verify: "true",
        scaffold,
        timeboxSeconds: 60,
        maxAttempts: 2,
      });
      transitionUnit(db, u.id, "ready");
      return u;
    };
    const runUnit = async (scaffold: boolean, skills: string) => {
      process.env.FAKE_MODE = "success";
      process.env.FAKE_SKILLS = skills;
      try {
        const u = unitWith(scaffold);
        const attempt = await runWorkUnit(ctx(), u.id);
        return { unit: getUnit(db, u.id), attempt, brief: readFileSync(layout(boot).brief(project, u.seq, attempt.n), "utf8") };
      } finally {
        delete process.env.FAKE_SKILLS;
      }
    };

    it("names the project's work skills in METHOD and rejects work that skipped one", async () => {
      setSetting(db, "project", project, "skills.work", ["setup-thing"]);
      const skipped = await runUnit(false, "");
      expect(skipped.brief).toContain("Then load these project skills with the Skill tool before you change anything, and follow them: setup-thing.");
      expect(skipped.attempt).toMatchObject({ missingSkills: ["setup-thing"], rejection: "skills" });
      expect(skipped.unit.state).toBe("rejected");
      const loaded = await runUnit(false, "setup-thing");
      expect(loaded.attempt.missingSkills).toEqual([]);
      expect(loaded.unit.state).toBe("verifying");
    });

    it("runs a scaffold unit with the scaffold skills instead of the work skills", async () => {
      setSetting(db, "project", project, "skills.work", ["setup-thing"]);
      setSetting(db, "project", project, "skills.scaffold", ["setup-gradle"]);
      const { unit, attempt, brief } = await runUnit(true, "setup-gradle");
      expect(brief).toContain("This is a scaffold unit: build the new project's skeleton the way the project skills below say, and nothing more.");
      expect(brief).toContain("follow them: setup-gradle.");
      expect(attempt.missingSkills).toEqual([]);
      expect(unit.state).toBe("verifying");
    });

    it("gives the worker a read-only trunk checkout of each reference repo", async () => {
      const ref = mkdtempSync(join(tmpdir(), "yagura-ref-"));
      writeFileSync(join(ref, "build.gradle.kts"), "plugins {}\n");
      await git(["init", "--quiet", "-b", "main"], { cwd: ref });
      await commitAll(ref, "init", { name: "t", email: "t@t" });
      addRepo(db, { id: "billing", url: ref, defaultBranch: "main" });
      setSetting(db, "project", project, "project.reference_repos", ["billing"]);
      const { brief } = await runUnit(false, "");
      const line = /^- billing at (\S+) @ ([0-9a-f]{40})$/m.exec(brief)!;
      expect(readFileSync(join(line[1]!, "build.gradle.kts"), "utf8")).toBe("plugins {}\n");
      expect(line[2]).toBe(await git(["rev-parse", "HEAD"], { cwd: ref }));
    });
  });
});
