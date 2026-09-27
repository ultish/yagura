import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { Engine } from "./engine.js";
import { artifactName, listEvidenceRuns, readArtifact, runArtifacts } from "./evidence.js";
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
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs")], stdin: run.prompt }),
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
  mkdirSync(join(seed, ".agents/verify"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "seed\n");
  writeFileSync(
    join(seed, ".agents/verify/verify.json"),
    JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f README.md", tier: "unit-verified" }] }),
  );
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "all files landed", minTier: "unit-verified", repos: ["testbed" as RepoId] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  setMergePolicy(db, project, "auto");
  process.env.FAKE_MODE = "engine";
});

describe("Engine", () => {
  it("plans, runs disjoint units in parallel, serializes overlapping ones, verifies, lands, and closes", async () => {
    const log: string[] = [];
    await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();

    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.map((u) => [u.goal, u.state])).toEqual([
      ["write a", "landed"],
      ["write b", "landed"],
      ["write c", "landed"],
    ]);
    expect(getProject(db, project).state).toBe("closed");

    const events = db.prepare("SELECT id, type, unit_id FROM events WHERE type IN ('attempt.started', 'attempt.ended', 'unit.landed') ORDER BY id").all() as {
      id: number;
      type: string;
      unit_id: number;
    }[];
    const at = (type: string, unitId: number) => events.find((e) => e.type === type && e.unit_id === unitId)!.id;
    const [a, b, c] = work.map((u) => u.id);
    expect(at("attempt.started", b!)).toBeLessThan(at("attempt.ended", a!));
    expect(at("attempt.started", c!)).toBeGreaterThan(at("unit.landed", a!));

    const files = await git(["ls-tree", "-r", "--name-only", "main"], { cwd: origin });
    expect(
      files
        .split("\n")
        .filter((f) => f.startsWith("app/"))
        .sort(),
    ).toEqual([`app/a/extra/p-U${work[2]!.seq}.txt`, `app/a/p-U${work[0]!.seq}.txt`, `app/b/p-U${work[1]!.seq}.txt`]);
    expect(log.some((l) => l.startsWith("✔ project p closed"))).toBe(true);

    const verifyAttempt = listAttempts(db, listUnits(db, project).find((u) => u.type === "verify" && u.targetUnitId === a)!.id)[0]!;
    const headRun = listEvidenceRuns(db, verifyAttempt.id).find((r) => r.label === "s" && r.at === "head")!;
    const artifacts = runArtifacts(db, ctx.boot, headRun.id);
    expect(artifacts.map((x) => [x.kind, x.name, x.contentType])).toEqual([
      ["stdout", "stdout", "text/plain; charset=utf-8"],
      ["stderr", "stderr", "text/plain; charset=utf-8"],
      ["file", "notes/check.txt", "text/plain; charset=utf-8"],
      ["file", "pixel.png", "image/png"],
      ["file", "screen.svg", "image/svg+xml"],
    ]);
    const read = (i: number) => readArtifact(db, ctx.boot, artifacts[i]!.id);
    expect(read(0).toString()).toBe(`checking app/a/p-U${work[0]!.seq}.txt\n`);
    expect(read(2).toString()).toBe(`looked for app/a/p-U${work[0]!.seq}.txt at head\n`);
    expect(read(3).subarray(1, 4).toString()).toBe("PNG");
    expect(artifactName(db, artifacts[4]!.id)).toBe("screen.svg");

    const workAttempt = listAttempts(db, a!)[0]!;
    const diff = await diffRange(layout(ctx.boot).mirror("testbed" as RepoId), workAttempt.baseSha!, workAttempt.headSha!);
    expect(diff).toContain(`+++ b/app/a/p-U${work[0]!.seq}.txt\n@@ -0,0 +1 @@\n+work`);
  }, 60_000);

  it("writes, proves, and lands a verify pack first on a repo without one, then verifies work with it", async () => {
    const seed = join(mkdtempSync(join(tmpdir(), "yagura-nopack-")), "seed");
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "README.md"), "no pack here\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@t" });
    const bare = `${seed}.git`;
    await git(["clone", "--quiet", "--bare", seed, bare]);
    addRepo(db, { id: "nopack", url: bare, defaultBranch: "main" });
    const q = "q" as ProjectId;
    addProject(db, { id: q, name: "Q", goal: "g", predicate: "all files landed", minTier: "unit-verified", repos: ["nopack" as RepoId] });
    setProjectEnvironment(db, q, "local" as EnvironmentId);
    setMergePolicy(db, q, "auto");

    await new Engine(ctx, { projectId: q, tickMs: 50 }).runUntilIdle();

    const units = listUnits(db, q);
    const pack = units.find((u) => u.type === "pack")!;
    expect(pack).toMatchObject({ seq: 1, state: "landed", repoId: "nopack", goal: "Write a verify pack for nopack" });
    expect(getRepo(db, "nopack" as RepoId)).toMatchObject({ packStatus: "proven", packProvenSha: pack.landedSha });
    const proof = units.find((u) => u.type === "verify" && u.targetUnitId === pack.id)!;
    const proofAttempt = listAttempts(db, proof.id)[0]!;
    expect(proofAttempt).toMatchObject({ harness: "yagura-proof", skills: [] });
    expect(listEvidenceRuns(db, proofAttempt.id).map((r) => `${r.label}@${r.at}:${r.exitCode}`)).toEqual([
      "pack:doctor@head:0",
      "pack:deploy@head:0",
      "check:unit@head:0",
      "pack:teardown@head:0",
    ]);
    expect(await git(["show", "main:.agents/verify/verify.json"], { cwd: bare })).toContain('"deploy"');

    const work = units.filter((u) => u.type === "work");
    expect(work.map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
    const firstWorkVerify = units.find((u) => u.type === "verify" && u.targetUnitId === work[0]!.id)!;
    const packLanded = db.prepare("SELECT MIN(id) AS id FROM events WHERE type = 'unit.landed' AND unit_id = ?").get(pack.id) as { id: number };
    const verifyStarted = db.prepare("SELECT MIN(id) AS id FROM events WHERE type = 'attempt.started' AND unit_id = ?").get(firstWorkVerify.id) as {
      id: number;
    };
    expect(verifyStarted.id).toBeGreaterThan(packLanded.id);
    expect(listEvidenceRuns(db, listAttempts(db, firstWorkVerify.id)[0]!.id).map((r) => r.label)).toContain("pack:deploy");
    expect(getProject(db, q).state).toBe("closed");
  }, 60_000);

  it("sends a pack back to its agent when the proof fails", async () => {
    const seed = join(mkdtempSync(join(tmpdir(), "yagura-badpack-")), "seed");
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "README.md"), "x\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@t" });
    await git(["clone", "--quiet", "--bare", seed, `${seed}.git`]);
    addRepo(db, { id: "badpack", url: `${seed}.git`, defaultBranch: "main" });
    const q = "q" as ProjectId;
    addProject(db, { id: q, name: "Q", goal: "g", predicate: "p", minTier: "unit-verified", repos: ["badpack" as RepoId] });
    setProjectEnvironment(db, q, "local" as EnvironmentId);
    process.env.FAKE_PACK_CHECK = "test -f nothing-here";
    try {
      await new Engine(ctx, { projectId: q, tickMs: 50 }).runUntilIdle();
    } finally {
      delete process.env.FAKE_PACK_CHECK;
    }
    const pack = listUnits(db, q).find((u) => u.type === "pack")!;
    expect(pack.state).toBe("blocked");
    expect(pack.notes[0]).toMatch(/rejected the previous attempt: pack checks fail on the repo as it is: unit exit 1/);
    expect(listAttempts(db, pack.id).map((a) => a.state)).toEqual(["handed_off", "handed_off"]);
    expect(getRepo(db, "badpack" as RepoId).packStatus).toBe("missing");
    expect(listUnits(db, q).filter((u) => u.type === "pack")).toHaveLength(1);
  }, 60_000);

  it("stops at a land gate under merge: human and lands once it is answered", async () => {
    setMergePolicy(db, project, "human");
    const engine = new Engine(ctx, { projectId: project, tickMs: 50 });
    await engine.runUntilIdle();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.filter((u) => u.state === "verified").length).toBeGreaterThan(0);
    expect(work.some((u) => u.state === "landed")).toBe(false);
    const { listGates, answerGate } = await import("./store.js");
    for (const g of listGates(db, project, "open").filter((x) => x.kind === "land")) answerGate(db, g.id, "land");
    await engine.runUntilIdle();
    for (const g of listGates(db, project, "open").filter((x) => x.kind === "land")) answerGate(db, g.id, "land");
    await engine.runUntilIdle();
    expect(
      listUnits(db, project)
        .filter((u) => u.type === "work")
        .every((u) => u.state === "landed"),
    ).toBe(true);
  }, 60_000);

  it("does not start work while the project's andon is raised", async () => {
    const { setAndon } = await import("./store.js");
    setAndon(db, project, "investigating a bad deploy");
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    expect(listUnits(db, project)).toEqual([]);
  });
});
