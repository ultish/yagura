import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getAction, saveAction } from "./actions.js";
import { runAction } from "./actionrun.js";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, RepoId } from "./domain.js";
import { setValue } from "./envvalues.js";
import { commitAll, git } from "./git.js";
import { layout } from "./paths.js";
import { addEnvironment, addRepo, openStore, type Db } from "./store.js";

let ctx: { db: Db; boot: Bootstrap };
let nexus: string;
let head: string;
const env = "dev" as EnvironmentId;
const lib = "lib" as RepoId;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-actionrun-"));
  const seed = join(root, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "VERSION"), "1.5.0-SNAPSHOT\n");
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  head = await git(["rev-parse", "HEAD"], { cwd: seed });
  const origin = join(root, "lib.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
  ctx = { db: openStore(layout(boot).db), boot };
  nexus = join(root, "nexus");
  mkdirSync(nexus);
  addEnvironment(ctx.db, { id: env, name: "dev", provider: "local-process", capacity: 1 });
  setValue(ctx.db, env, { name: "NEXUS", value: nexus });
  addRepo(ctx.db, { id: lib, url: origin, defaultBranch: "main" });
});

const save = (name: string, command: string, repoId: RepoId | null = lib) =>
  saveAction(ctx.db, { environmentId: env, repoId, name, use: `the ${name} action`, command });

describe("running an action", () => {
  it("proves it on a clean checkout of the repo's main with the environment's values, or breaks it with the reason", async () => {
    const ok = save("has-version", 'test -f VERSION && test -d "$NEXUS"');
    const [run] = await runAction(ctx, ok.id, null, { by: "you" });
    expect(run).toMatchObject({ sha: head, exitCode: 0, by: "you", actionId: ok.id });
    expect(getAction(ctx.db, ok.id).state).toBe("proven");

    const bad = save("read-missing", "cat MISSING");
    await runAction(ctx, bad.id, null, { by: "you" });
    expect(getAction(ctx.db, bad.id)).toMatchObject({ state: "broken", reason: `exit 1 on ${head.slice(0, 7)}: cat: MISSING: No such file or directory` });
    expect(readdirSync(join(ctx.boot.home, "checkouts"))).toEqual([]);
  });

  it("checks publishing as one: the version, a publish under a check version that is never a release, and the wait until it can be fetched", async () => {
    save("version", "cat VERSION");
    const publish = save("publish-snapshot", 'mkdir -p "$NEXUS/$YAGURA_VERSION"');
    const available = save("snapshot-available", 'test -d "$NEXUS/$YAGURA_VERSION"');
    const runs = await runAction(ctx, available.id, null, { by: "you" }, { pollMs: 10 });
    expect(runs.map((r) => [r.command, r.exitCode])).toEqual([
      ["cat VERSION", 0],
      ['mkdir -p "$NEXUS/$YAGURA_VERSION"', 0],
      ['test -d "$NEXUS/$YAGURA_VERSION"', 0],
    ]);
    expect(existsSync(join(nexus, `1.5.0-yg-check-${head.slice(0, 7)}-SNAPSHOT`))).toBe(true);
    expect([getAction(ctx.db, publish.id).state, getAction(ctx.db, available.id).state]).toEqual(["proven", "proven"]);
  });

  it("asks which repo for an action that applies to every repo", async () => {
    const all = save("test", "true", null);
    await expect(runAction(ctx, all.id, null, { by: "you" })).rejects.toThrow("test applies to every repo here; say which repo to run it on");
    expect((await runAction(ctx, all.id, lib, { by: "you" }))[0]!.exitCode).toBe(0);
  });
});
