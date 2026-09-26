import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { findByRef, findUnitsByCommit, traceUnit } from "./audit.js";
import { setSetting } from "./config.js";
import { landUnit } from "./land.js";
import { layout } from "./paths.js";
import { runWorkUnit } from "./runner.js";
import { addEnvironment, addProject, addRepo, addUnit, getUnitBySeq, openStore, setProjectEnvironment, transitionUnit, type Db } from "./store.js";
import { runVerifyUnit } from "./verify.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const fake: HarnessAdapter = { id: "claude", command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs")], stdin: run.prompt }), parse: parseClaudeLine };
const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;
const author = { name: "t", email: "t@t" };

let db: Db;
let ctx: RunContext;
let root: string;
let origin: string;
const project = "p" as ProjectId;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "yagura-land-"));
  const seed = join(root, "seed");
  mkdirSync(join(seed, "app"), { recursive: true });
  mkdirSync(join(seed, ".agents/verify"), { recursive: true });
  writeFileSync(join(seed, "app/orders.py"), "x = 1\n");
  writeFileSync(join(seed, "README.md"), "readme\n");
  writeFileSync(join(seed, ".agents/verify/verify.json"), JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f app/orders.py", tier: "unit-verified" }] }));
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", author);
  origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["testbed" as RepoId], refs: ["gitlab#42"] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 1 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
});

async function verifiedUnit() {
  const work = addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "testbed" as RepoId,
    goal: "Implement apply_discount. Then more detail.",
    writeScope: ["app/**"],
    acceptance: ["a"],
    verify: "v",
    playbook: "feature",
    timeboxSeconds: 60,
    maxAttempts: 2,
  });
  transitionUnit(db, work.id, "ready");
  process.env.FAKE_MODE = "success";
  await runWorkUnit(ctx, work.id);
  process.env.FAKE_MODE = "verify-pass";
  await runVerifyUnit(ctx, getUnitBySeq(db, project, 2).id);
  expect(getUnitBySeq(db, project, 1).state).toBe("verified");
  return work;
}

async function advanceTrunk(file: string, content: string) {
  const clone = join(root, `clone-${Math.random().toString(36).slice(2)}`);
  await git(["clone", "--quiet", origin, clone]);
  writeFileSync(join(clone, file), content);
  await commitAll(clone, `trunk edits ${file}`, author);
  await git(["push", "--quiet", "origin", "HEAD:main"], { cwd: clone });
}

const originMain = () => git(["rev-parse", "main"], { cwd: origin });

describe("landUnit (forge none)", () => {
  it("lands the unit as one squashed commit on trunk, with an audit trail in its trailers", async () => {
    const work = await verifiedUnit();
    const trunkBefore = await originMain();
    setSetting(db, "global", "", "yagura.url", "http://devvm:7300");
    const result = await landUnit(ctx, work.id);
    expect(result).toMatchObject({ outcome: "landed", reason: "squashed onto trunk" });
    expect(result.unit).toMatchObject({ state: "landed", landedSha: result.landedSha });
    expect(await originMain()).toBe(result.landedSha);
    expect(await git(["rev-parse", `${result.landedSha}^`], { cwd: origin })).toBe(trunkBefore);
    const message = await git(["log", "-1", "--format=%B", "main"], { cwd: origin });
    expect(message).toMatch(/^Implement apply_discount\n\n- edited app\/orders.py\n\n/);
    expect(message).toContain("Yagura-Project: p\nYagura-Unit: U1\n");
    expect(message).toMatch(/Yagura-Attempt: \d+ \(fake-model, pstack 0\.5\.0\)/);
    expect(message).toContain("Yagura-Branch: yg/p/u1-1");
    expect(message).toMatch(/Yagura-Verdict: unit-verified by U2 \(run:\d+/);
    expect(message).toContain("Yagura-Link: http://devvm:7300/p/p/u/1");
    expect(message).toContain("Refs: gitlab#42");
  });

  it("rebases onto a moved trunk, squashes, and carries the verdict when the patch is unchanged", async () => {
    const work = await verifiedUnit();
    await advanceTrunk("README.md", "readme v2\n");
    const result = await landUnit(ctx, work.id);
    expect(result).toMatchObject({ outcome: "landed", reason: "rebased onto the moved trunk and squashed; patch unchanged" });
    expect(await originMain()).toBe(result.landedSha);
    expect(await git(["log", "--format=%s", "-3", "main"], { cwd: origin })).toBe("Implement apply_discount\ntrunk edits README.md\ninit");
    const verdicts = db.prepare("SELECT head_sha, voided_at IS NOT NULL AS voided FROM verdicts WHERE unit_id = ? ORDER BY id").all(work.id);
    expect(verdicts).toEqual([
      { head_sha: expect.any(String), voided: 1 },
      { head_sha: result.landedSha, voided: 0 },
    ]);
  });

  it("traces a landed commit and an issue back to the units, agents, and evidence behind them", async () => {
    const work = await verifiedUnit();
    const { landedSha } = await landUnit(ctx, work.id);
    const [unit] = findUnitsByCommit(db, landedSha!.slice(0, 10));
    const trace = traceUnit(db, ctx.boot, unit!);
    expect(trace.unit.seq).toBe(1);
    expect(trace.work.map((a) => a.state)).toEqual(["handed_off"]);
    expect(trace.verifications[0]!.runs.map((r) => r.label)).toContain("scenario");
    expect(trace.verdicts.at(-1)).toMatchObject({ headSha: landedSha, voided: false });
    expect(findByRef(db, "gitlab#42").units.map((u) => u.seq)).toEqual([1]);
    expect(findUnitsByCommit(db, "not-a-sha")).toEqual([]);
  });

  it("blocks instead of landing when trunk conflicts with the change", async () => {
    const work = await verifiedUnit();
    await advanceTrunk("app/orders.py", "x = 99\n");
    const before = await originMain();
    const result = await landUnit(ctx, work.id);
    expect(result).toMatchObject({ outcome: "blocked", reason: expect.stringMatching(/conflicts with main/) });
    expect(result.unit.state).toBe("blocked");
    expect(await originMain()).toBe(before);
  });

  it("refuses to land a unit that is not verified", async () => {
    const work = addUnit(db, { projectId: project, type: "work", repoId: "testbed" as RepoId, goal: "g", writeScope: ["app/**"], acceptance: ["a"], verify: "v", timeboxSeconds: 60, maxAttempts: 1 });
    await expect(landUnit(ctx, work.id)).rejects.toThrow(/draft, not verified/);
  });
});
