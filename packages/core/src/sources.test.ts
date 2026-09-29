import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { landUnit, liveVerdict } from "./land.js";
import { layout } from "./paths.js";
import { applyDelta, PlanDelta } from "./plan.js";
import { addVerifyUnit, runWorkUnit } from "./runner.js";
import { readiness } from "./schedule.js";
import { reverifyAgainstSources, staleSource } from "./sources.js";
import { addEnvironment, addProject, addRepo, getUnit, getUnitBySeq, listAttempts, listUnits, openStore, setProjectEnvironment, type Db } from "./store.js";
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

async function origin(root: string, name: string): Promise<string> {
  const seed = join(root, `${name}-seed`);
  mkdirSync(join(seed, ".agents/verify"), { recursive: true });
  writeFileSync(join(seed, "README.md"), `${name}\n`);
  writeFileSync(
    join(seed, ".agents/verify/verify.json"),
    JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f README.md", tier: "unit-verified" }] }),
  );
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  const bare = join(root, `${name}.git`);
  await git(["clone", "--quiet", "--bare", seed, bare]);
  return bare;
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-sources-"));
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "lib", url: await origin(root, "lib"), defaultBranch: "main" });
  addRepo(db, { id: "app", url: await origin(root, "app"), defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["lib", "app"] as RepoId[] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
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

describe("needs-source", () => {
  it("starts the consumer on the source's verified head, mounts it read-only, and re-verifies after the source lands", async () => {
    const [lib, app] = [getUnitBySeq(db, project, 1), getUnitBySeq(db, project, 2)];
    expect(readiness(db, project).waiting.map((w) => w.reason)).toEqual(["waiting for U1 (needs-source, now ready)"]);
    await runWorkUnit(ctx, lib.id);
    await verify(1);
    const libHead = liveVerdict(db, lib.id)!.head_sha;
    expect(readiness(db, project).ready.map((u) => u.seq)).toEqual([2]);

    await runWorkUnit(ctx, app.id);
    const work = listAttempts(db, app.id)[0]!;
    expect(work.sources).toMatchObject([{ unit: "U1", repoId: "lib", sha: libHead }]);
    const mount = work.sources[0]!.path;
    expect(readFileSync(join(mount, "lib", "p-U1.txt"), "utf8")).toBe("work\n");
    expect(readFileSync(layout(ctx.boot).brief(project, 2, 1), "utf8")).toContain(`## READONLY\n- lib at ${mount} @ ${libHead}`);
    await verify(2);
    expect(
      JSON.parse(
        (db.prepare("SELECT dep_shas_json FROM verdicts WHERE unit_id = ? AND voided_at IS NULL").get(app.id) as { dep_shas_json: string }).dep_shas_json,
      ),
    ).toEqual({
      U1: libHead,
    });
    expect(staleSource(db, getUnit(db, app.id))).toBeNull();

    const landedLib = await landUnit(ctx, lib.id);
    expect(landedLib.outcome).toBe("landed");
    const stale = staleSource(db, getUnit(db, app.id));
    expect(stale).toBe(`U1 is now at ${landedLib.landedSha!.slice(0, 10)}, not the ${libHead.slice(0, 10)} it was verified against`);
    reverifyAgainstSources(db, getUnit(db, app.id), stale!, (u) => addVerifyUnit(db, u));
    expect(getUnit(db, app.id).state).toBe("verifying");
    await verify(2);
    expect(staleSource(db, getUnit(db, app.id))).toBeNull();
    expect((await landUnit(ctx, app.id)).outcome).toBe("landed");
  }, 60_000);
});
