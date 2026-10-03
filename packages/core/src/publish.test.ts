import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import { setSetting, type Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { Engine } from "./engine.js";
import { setValue } from "./envvalues.js";
import { commitAll, git, readFileAt } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { landUnit, liveVerdict } from "./land.js";
import { layout } from "./paths.js";
import { applyDelta, PlanDelta } from "./plan.js";
import { cleanUpTestBuilds, listPublications, moveConsumer, publishJobs, qualifiedVersion, upstreamArtifact, watchRelease } from "./publish.js";
import { runWorkUnit } from "./runner.js";
import { readiness } from "./schedule.js";
import { staleSource } from "./sources.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  answerGate,
  getRepo,
  getUnit,
  getUnitBySeq,
  listAttempts,
  listGates,
  listUnits,
  openStore,
  setMergePolicy,
  setProjectEnvironment,
  type Db,
} from "./store.js";
import { runVerifyUnit } from "./verify.js";

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
let nexus: string;
let origins: { lib: string; app: string };

// A folder stands in for Nexus: publishing copies into <version>/, and a version is available when its folder exists.
const PUBLISH = {
  version: "cat VERSION",
  command: 'mkdir -p "$NEXUS/$YAGURA_VERSION" && cp VERSION "$NEXUS/$YAGURA_VERSION/"',
  suffix: "-SNAPSHOT",
  available: 'test -d "$NEXUS/$YAGURA_VERSION"',
  unpublish: 'rm -rf "$NEXUS/$YAGURA_VERSION"',
};

async function origin(root: string, name: string, publish?: object): Promise<string> {
  const seed = join(root, `${name}-seed`);
  mkdirSync(join(seed, ".agents/verify"), { recursive: true });
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  if (publish) writeFileSync(join(seed, "VERSION"), "1.5.0-SNAPSHOT\n");
  writeFileSync(
    join(seed, ".agents/verify/verify.json"),
    JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f README.md", tier: "unit-verified" }], publish }),
  );
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  const bare = join(root, `${name}.git`);
  await git(["clone", "--quiet", "--bare", seed, bare]);
  return bare;
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-publish-"));
  nexus = join(root, "nexus");
  mkdirSync(nexus);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  origins = { lib: await origin(root, "lib", PUBLISH), app: await origin(root, "app") };
  addRepo(db, { id: "lib", url: origins.lib, defaultBranch: "main", packStatus: "proven" });
  addRepo(db, { id: "app", url: origins.app, defaultBranch: "main", packStatus: "proven" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["lib", "app"] as RepoId[] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setValue(db, "local" as EnvironmentId, { name: "NEXUS", value: nexus });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  setMergePolicy(db, project, "auto");
  setSetting(db, "project", project, "review.enabled", false);
  process.env.FAKE_MODE = "engine";
  const unit = (key: string, repo: string, deps: unknown[] = []) => ({
    key,
    repo,
    goal: `write ${key}`,
    write: [`${key}/**`],
    accept: ["a"],
    verify: "true",
    deps,
  });
  applyDelta(db, project, PlanDelta.parse({ add: [unit("lib", "lib"), unit("app", "app", [{ on: "lib", kind: "needs-source" }])] }), null);
});

const verify = async (seq: number) => {
  const v = listUnits(db, project).filter((u) => u.type === "verify" && u.targetUnitId === getUnitBySeq(db, project, seq).id && u.state === "ready")[0]!;
  await runVerifyUnit(ctx, v.id);
};
const runJobs = async () => {
  for (const job of publishJobs(db, project)) await job.run(ctx);
};
const trunkFile = (repo: "lib" | "app", path: string) => readFileAt(origins[repo], "main", path);

describe("published artifacts", () => {
  it("names a test build by project, unit, and head, without a snapshot marker in the middle", () => {
    expect(qualifiedVersion("1.5.0-SNAPSHOT\n", "Orders API" as ProjectId, 3, "a1b2c3d4e5f6" as never, "-SNAPSHOT")).toBe(
      "1.5.0-yg-orders-api-u3-a1b2c3d-SNAPSHOT",
    );
    expect(qualifiedVersion("2.0.1", "web" as ProjectId, 12, "0123456789" as never, "")).toBe("2.0.1-yg-web-u12-0123456");
  });

  it("publishes the upstream's verified head for its consumer, moves the consumer to the release once CI publishes it, and cleans up", async () => {
    const [lib, app] = [getUnitBySeq(db, project, 1), getUnitBySeq(db, project, 2)];
    await runWorkUnit(ctx, lib.id);
    await verify(1);
    const head = liveVerdict(db, lib.id)!.head_sha;
    expect(getRepo(db, "lib" as RepoId).publish).toMatchObject({ suffix: "-SNAPSHOT" });
    expect(readiness(db, project).waiting.map((w) => w.reason)).toEqual(["waits for the test build of U1 in lib"]);

    await runJobs();
    const test = `1.5.0-yg-p-u1-${head.slice(0, 7)}-SNAPSHOT`;
    expect(listPublications(db, lib.id)).toMatchObject([{ kind: "test", state: "published", version: test, baseVersion: "1.5.0", baseReleased: false }]);
    expect(existsSync(join(nexus, test, "VERSION"))).toBe(true);
    expect(readiness(db, project).ready.map((u) => u.seq)).toEqual([2]);

    await runWorkUnit(ctx, app.id);
    expect(listAttempts(db, app.id)[0]!.sources).toMatchObject([{ unit: "U1", version: test }]);
    expect(readFileSync(layout(ctx.boot).brief(project, 2, 1), "utf8")).toContain(`published as ${test}: pin exactly this version`);
    await verify(2);
    expect(
      JSON.parse((db.prepare("SELECT artifact_versions_json AS v FROM verdicts WHERE unit_id = ? AND voided_at IS NULL").get(app.id) as { v: string }).v),
    ).toEqual({
      U1: test,
    });

    expect((await landUnit(ctx, lib.id)).outcome).toBe("landed");
    await runJobs();
    expect(upstreamArtifact(db, getUnit(db, lib.id), "app" as RepoId)).toEqual({ wait: "waits for lib 1.5.0 from U1's landing to be released" });

    mkdirSync(join(nexus, "1.5.0"));
    await watchRelease(ctx, lib.id);
    expect(upstreamArtifact(db, getUnit(db, lib.id), "app" as RepoId)).toEqual({ version: "1.5.0" });
    const stale = staleSource(db, getUnit(db, app.id))!;
    expect(await moveConsumer(ctx, app.id, stale)).toBe("repinned");
    const repin = listAttempts(db, app.id).at(-1)!;
    expect(repin).toMatchObject({ harness: "yagura-repin", state: "handed_off" });
    expect(await git(["show", `${repin.headSha}:app/deps.txt`], { gitDir: layout(ctx.boot).mirror("app" as RepoId) })).toBe("lib=1.5.0");
    expect(getUnit(db, app.id).state).toBe("verifying");

    await verify(2);
    expect(staleSource(db, getUnit(db, app.id))).toBeNull();
    expect((await landUnit(ctx, app.id)).outcome).toBe("landed");
    expect(await trunkFile("app", "app/deps.txt")).toBe("lib=1.5.0");

    expect(publishJobs(db, project).map((j) => j.key)).toEqual([`unpublish:${lib.id}`]);
    expect(await cleanUpTestBuilds(ctx, lib.id)).toBe(1);
    expect(existsSync(join(nexus, test))).toBe(false);
    expect(existsSync(join(nexus, "1.5.0"))).toBe(true);
  }, 90_000);

  it("blocks the consumer when the upstream landed without changing a version that was already released", async () => {
    mkdirSync(join(nexus, "1.5.0"));
    const [lib, app] = [getUnitBySeq(db, project, 1), getUnitBySeq(db, project, 2)];
    await runWorkUnit(ctx, lib.id);
    await verify(1);
    await runJobs();
    expect(listPublications(db, lib.id)[0]).toMatchObject({ baseVersion: "1.5.0", baseReleased: true });
    expect((await landUnit(ctx, lib.id)).outcome).toBe("landed");
    await runJobs();
    const reason =
      "U1 landed without changing lib's version: 1.5.0 was already released before it, so no release carries its change. Bump the version the way lib does";
    expect(listPublications(db, lib.id).find((p) => p.kind === "release")).toMatchObject({ state: "unchanged", reason });
    expect(readiness(db, project).stuck).toMatchObject([{ unit: { id: app.id }, reason }]);
  }, 60_000);

  it("runs the whole flow from the engine: a consumer that starts after the upstream landed waits for the release and pins it", async () => {
    setSetting(db, "global", "", "forge.poll_seconds", 1);
    const log: string[] = [];
    const engine = new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) });
    await engine.runUntilIdle();
    const [lib, app] = [getUnitBySeq(db, project, 1), getUnitBySeq(db, project, 2)];
    expect(getUnit(db, lib.id).state).toBe("landed");
    expect(getUnit(db, app.id).state).not.toBe("landed");
    expect(upstreamArtifact(db, getUnit(db, lib.id), "app" as RepoId)).toEqual({ wait: "waits for lib 1.5.0 from U1's landing to be released" });

    mkdirSync(join(nexus, "1.5.0"));
    await new Promise((r) => setTimeout(r, 1100));
    await engine.runUntilIdle();
    expect(getUnit(db, app.id).state).toBe("landed");
    expect(await trunkFile("app", "app/deps.txt")).toBe("lib=1.5.0");
    expect(
      listPublications(db, lib.id)
        .filter((p) => p.kind === "test")
        .every((p) => p.state === "removed"),
    ).toBe(true);
  }, 90_000);
  it("from the engine, a consumer verified on the test build is re-pinned to the release and lands after it", async () => {
    setSetting(db, "global", "", "forge.poll_seconds", 1);
    setMergePolicy(db, project, "human");
    const engine = new Engine(ctx, { projectId: project, tickMs: 50 });
    const [lib, app] = [getUnitBySeq(db, project, 1), getUnitBySeq(db, project, 2)];
    const land = (seq: number) => {
      const unitId = getUnitBySeq(db, project, seq).id;
      for (const g of listGates(db, project, "open").filter((x) => x.kind === "land" && x.unitId === unitId)) answerGate(db, g.id, "land");
    };
    await engine.runUntilIdle();
    const test = listPublications(db, lib.id)[0]!.version!;
    expect([getUnit(db, lib.id).state, getUnit(db, app.id).state]).toEqual(["verified", "verified"]);
    expect(await git(["show", `${liveVerdict(db, app.id)!.head_sha}:app/deps.txt`], { gitDir: layout(ctx.boot).mirror("app" as RepoId) })).toBe(`lib=${test}`);

    land(1);
    land(2);
    await engine.runUntilIdle();
    expect([getUnit(db, lib.id).state, getUnit(db, app.id).state]).toEqual(["landed", "verified"]);

    mkdirSync(join(nexus, "1.5.0"));
    await new Promise((r) => setTimeout(r, 1100));
    await engine.runUntilIdle();
    expect(listAttempts(db, app.id).map((a) => a.harness)).toEqual(["claude", "yagura-repin"]);
    land(2);
    await engine.runUntilIdle();
    expect(getUnit(db, app.id).state).toBe("landed");
    expect(await trunkFile("app", "app/deps.txt")).toBe("lib=1.5.0");
    expect(existsSync(join(nexus, test))).toBe(false);
  }, 90_000);
});
