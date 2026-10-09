import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { listPublications, qualifiedVersion } from "./publish.js";
import { Engine } from "./engine.js";
import { readiness } from "./schedule.js";
import { saveAction } from "./actions.js";
import { addEnvironment, addProject, addRepo, getUnitBySeq, openStore, setMergePolicy, setProjectEnvironment, type Db } from "./store.js";

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
const publishActions = (command = 'mkdir -p "$NEXUS/$YAGURA_VERSION" && cp VERSION "$NEXUS/$YAGURA_VERSION/"') => {
  const save = (name: string, cmd: string) =>
    saveAction(db, { environmentId: "local" as EnvironmentId, repoId: "lib" as RepoId, name, use: `the ${name} contract`, command: cmd });
  save("version", "cat VERSION");
  save("publish-snapshot", command);
  save("snapshot-available", 'test -d "$NEXUS/$YAGURA_VERSION"');
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

const lib = () => getUnitBySeq(db, project, 1);
const app = () => getUnitBySeq(db, project, 2);

describe("test builds", () => {
  it("names a test build by project, unit, and merge commit; a snapshot stays a snapshot", () => {
    expect(qualifiedVersion("1.5.0-SNAPSHOT\n", "Orders API" as ProjectId, 3, "a1b2c3d4e5f6" as never)).toBe("1.5.0-yg-orders-api-u3-a1b2c3d-SNAPSHOT");
    expect(qualifiedVersion("2.0.1", "web" as ProjectId, 12, "0123456789" as never)).toBe("2.0.1-yg-web-u12-0123456");
  });

  it("publishes a merged library from its merge commit with the repo's actions, and the unit after it starts pinned to that version", async () => {
    publishActions();
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    const [pub] = listPublications(db, lib().id);
    expect(pub).toMatchObject({ state: "published", sha: lib().mergedSha, version: `1.5.0-yg-p-u1-${lib().mergedSha!.slice(0, 7)}-SNAPSHOT` });
    expect(existsSync(join(nexus, pub!.version!, "VERSION"))).toBe(true);
    expect(app().state).toBe("merged");
    const brief = readFileSync(layout(ctx.boot).brief(project, app().seq, 1), "utf8");
    expect(brief).toContain(
      `- U1 (lib) is published as ${pub!.version}: depend on exactly this version wherever app uses lib. It is a test build, never a release.`,
    );
    expect(brief).toContain(`- YAGURA_VERSION_LIB=${pub!.version}`);
  }, 90_000);

  it("keeps the unit after it waiting with the reason when publishing fails, and wakes the doctor", async () => {
    publishActions("echo 'nexus said 401' >&2; exit 3");
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    expect(listPublications(db, lib().id).map((p) => [p.state, p.reason])).toEqual([["failed", "publish-snapshot exited 3: nexus said 401"]]);
    expect(readiness(db, project).waiting.map((w) => [w.unit.seq, w.reason])).toEqual([
      [2, "U1's test build failed: publish-snapshot exited 3: nexus said 401"],
    ]);
    const woken = db
      .prepare(
        "SELECT json_extract(data_json, '$.repo') AS repo, json_extract(data_json, '$.trigger') AS trigger FROM events WHERE type = 'doctor.woken' ORDER BY id",
      )
      .all();
    expect(woken).toEqual([
      { repo: "app", trigger: "first" },
      { repo: "lib", trigger: "first" },
      { repo: "lib", trigger: "broken" },
    ]);
  }, 90_000);
});
