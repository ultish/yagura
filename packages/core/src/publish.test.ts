import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { setValue } from "./envvalues.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import { applyDelta, PlanDelta } from "./plan.js";
import { listPublications, publishTestBuild, qualifiedVersion } from "./publish.js";
import { runWorkerRound } from "./runner.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  getUnitBySeq,
  listAttempts,
  openStore,
  setMergePolicy,
  setProjectEnvironment,
  transitionUnit,
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
};

async function origin(root: string, name: string, publish = false): Promise<string> {
  const seed = join(root, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  if (publish) writeFileSync(join(seed, "VERSION"), "1.5.0-SNAPSHOT\n");
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
  origins = { lib: await origin(root, "lib", true), app: await origin(root, "app") };
  addRepo(db, { id: "lib", url: origins.lib, defaultBranch: "main" });
  addRepo(db, { id: "app", url: origins.app, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", repos: ["lib", "app"] as RepoId[] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setValue(db, "local" as EnvironmentId, { name: "NEXUS", value: nexus });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  setMergePolicy(db, project, "auto");
  process.env.FAKE_MODE = "engine";
  const unit = (key: string, repo: string, after: string[] = []) => ({ key, repo, goal: `write ${key}`, acceptance: ["a"], after });
  applyDelta(db, project, PlanDelta.parse({ add: [unit("lib", "lib"), unit("app", "app", ["lib"])] }), null);
});

describe("published artifacts", () => {
  it("names a test build by project, unit, and head; a snapshot stays a snapshot whatever the pack's suffix says", () => {
    expect(qualifiedVersion("1.5.0-SNAPSHOT\n", "Orders API" as ProjectId, 3, "a1b2c3d4e5f6" as never, "-SNAPSHOT")).toBe(
      "1.5.0-yg-orders-api-u3-a1b2c3d-SNAPSHOT",
    );
    expect(qualifiedVersion("1.5.0-SNAPSHOT", "web" as ProjectId, 4, "a1b2c3d4e5f6" as never, "")).toBe("1.5.0-yg-web-u4-a1b2c3d-SNAPSHOT");
    expect(qualifiedVersion("2.0.1", "web" as ProjectId, 12, "0123456789" as never, "")).toBe("2.0.1-yg-web-u12-0123456");
    expect(qualifiedVersion("2.0.1", "web" as ProjectId, 12, "0123456789" as never, "-rc")).toBe("2.0.1-yg-web-u12-0123456-rc");
  });

  it("publishes a worker's head as a snapshot under its own version, once, and leaves the snapshot where it is", async () => {
    const lib = getUnitBySeq(db, project, 1);
    transitionUnit(db, lib.id, "building", { round: { kind: "first" } });
    await runWorkerRound(ctx, lib.id);
    const head = listAttempts(db, lib.id)[0]!.headSha!;
    db.prepare("UPDATE repos SET publish_json = ? WHERE id = 'lib'").run(JSON.stringify(PUBLISH));

    const pub = await publishTestBuild(ctx, lib.id, head);
    expect(pub).toMatchObject({
      state: "published",
      kind: "test",
      sha: head,
      baseVersion: "1.5.0",
      version: `1.5.0-yg-p-u${lib.seq}-${head.slice(0, 7)}-SNAPSHOT`,
    });
    expect(existsSync(join(nexus, pub!.version!, "VERSION"))).toBe(true);
    expect(await publishTestBuild(ctx, lib.id, head)).toBeNull();
    expect(listPublications(db, lib.id)).toHaveLength(1);
  }, 60_000);

  it("records a failed publish with the command's reason", async () => {
    const lib = getUnitBySeq(db, project, 1);
    transitionUnit(db, lib.id, "building", { round: { kind: "first" } });
    await runWorkerRound(ctx, lib.id);
    const head = listAttempts(db, lib.id)[0]!.headSha!;
    db.prepare("UPDATE repos SET publish_json = ? WHERE id = 'lib'").run(JSON.stringify({ ...PUBLISH, command: "exit 3" }));
    const pub = await publishTestBuild(ctx, lib.id, head);
    expect(pub).toMatchObject({ state: "failed", reason: "publish exited 3: " });
  }, 60_000);
});
