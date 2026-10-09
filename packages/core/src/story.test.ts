import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { unitStory } from "./story.js";
import { addEnvironment, addProject, addRepo, listUnits, openStore, setMergePolicy, setProjectEnvironment, setRepoForge, type Db } from "./store.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs"), ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
  parse: parseClaudeLine,
};
const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;
const project = "p" as ProjectId;
let db: Db;
let ctx: RunContext;
let boot: Bootstrap;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-story-"));
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "README.md"), "seed\n");
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  const origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  boot = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "all files landed", repos: ["testbed" as RepoId] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  setMergePolicy(db, project, "auto");
  setSetting(db, "global", "", "forge.poll_seconds", 1);
  setRepoForge(db, "testbed" as RepoId, "gh", true);
  setSetting(db, "repo", "testbed", "forge.repo", "ultish/testbed");
  setSetting(db, "global", "", "forge.gh_bin", fixtures("fake-gh.mjs"));
  Object.assign(process.env, {
    FAKE_MODE: "engine",
    FAKE_ORIGIN: origin,
    FAKE_GH_ORIGIN: origin,
    FAKE_GH_STATE: join(root, "gh.json"),
    FAKE_JUDGE_CHANGES: "U3",
  });
});

afterEach(() => {
  delete process.env.FAKE_JUDGE_CHANGES;
});

describe("unitStory", () => {
  it("tells a unit sent back once as two rounds, each a worker then a judge, ending in the merge", async () => {
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    const u2 = listUnits(db, project).find((u) => u.type === "work" && u.seq === 3)!;
    const story = unitStory(db, boot, u2);

    expect(story.moves.map((m) => `${m.from}>${m.to}`)).toEqual([
      "waiting>building",
      "building>judging",
      "judging>building",
      "building>judging",
      "judging>ready",
      "ready>merged",
    ]);
    expect(story.rounds.map((r) => r.text)).toEqual(["Round 1 · first build", "Round 2 · sent back by the judge"]);
    const path = story.entries.filter((e) => e.actor !== "planner" && e.status?.text !== "base merged");
    expect(path.map((e) => [e.round, e.state, e.actor, e.status?.text])).toEqual([
      [1, "building", "worker", "handed off"],
      [1, "building", "yagura", "draft"],
      [1, "judging", "judge", "changes"],
      [2, "building", "worker", "handed off"],
      [2, "judging", "judge", "approved"],
      [2, "ready", "yagura", "ready"],
      [2, "merged", "yagura", "merged"],
    ]);
    const [first, , sentBack, again, approved] = path;
    expect(sentBack!.body).toBe("Sent it back with 1 finding.");
    expect(sentBack!.lines.map((l) => l.text)).toEqual(["app:1 U3 must say it was fixed"]);
    expect(again!.body).toMatch(new RegExp(`^Resumed A${first!.attempt!.agentNo}'s session`));
    expect(again!.body).toMatch(/\. .+ Handed off at [0-9a-f]{7}\.$/);
    expect(approved!.lines.map((l) => [l.text, l.checks])).toEqual([
      [expect.stringMatching(/^run:\d+ `true` · exit 0$/), [{ ok: true, text: "checked by yagura against runs it recorded" }]],
    ]);
    expect(story.pr).toMatchObject({ number: expect.any(Number), draft: false });
    expect(story.now).toEqual({ headline: `Merged into main as ${u2.mergedSha!.slice(0, 7)}.`, detail: [`2 rounds of work, PR #${story.pr!.number}.`] });
  }, 60_000);
});
