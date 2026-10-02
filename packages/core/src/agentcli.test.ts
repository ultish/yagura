import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { agentRefusal, gitRead } from "./agentcli.js";
import type { Bootstrap } from "./config.js";
import { commitAll, git } from "./git.js";
import { layout } from "./paths.js";
import { registerRepo } from "./repos.js";
import { openStore, type Db } from "./store.js";

describe("agentRefusal", () => {
  const watchman = { YAGURA_ROLE: "watchman" };
  const refused = (cmd: string, env: NodeJS.ProcessEnv = watchman) => agentRefusal(cmd.split(" "), env) !== null;

  it("lets the developer run anything", () => {
    expect(refused("set max_parallel_agents 9", {})).toBe(false);
    expect(refused("gate answer 3 yes", {})).toBe(false);
  });

  it("lets an agent read yagura", () => {
    const reads = [
      "show sbx",
      "show sbx 3",
      "logs sbx 3 --attempt 2",
      "trace abc123",
      "gates",
      "settings --project sbx",
      "settings export",
      "thread",
      "thread list",
      "thread show 4",
      "thread search --thread 4 quoted words",
      "thread mentions @sbx/U3",
      "env values box",
      "env presets",
      "env notes box",
      "template list",
      "project skills sbx",
      "git sbx log --oneline origin/main",
    ];
    expect(reads.filter((c) => refused(c))).toEqual([]);
  });

  it("refuses every change, whatever the role, and anything it does not know", () => {
    const writes = [
      "set max_parallel_agents 9",
      "unset max_parallel_agents",
      "settings import /tmp/s.yaml",
      "gate answer 3 yes",
      "andon sbx --clear",
      "land sbx 3",
      "unit requeue sbx 3",
      "repo set sbx --forge gh",
      "project set sbx --merge auto",
      "proposal apply 2",
      "thread set 4 --autonomy go",
      "thread clear 4",
      "thread --autonomy go set 4",
      "env notes set box --text x",
      "env notes --text x set box",
      "env value set box A 1",
      "template save box t",
      "talk hello",
      "steer sbx/U3 stop",
      "daemon",
      "drive sbx",
      "unknown",
    ];
    expect(writes.filter((c) => !refused(c))).toEqual([]);
    expect(refused("set max_parallel_agents 9", { YAGURA_ROLE: "worker" })).toBe(true);
    expect(agentRefusal(["land", "sbx", "3"], watchman)).toMatch(/^yagura land sbx 3: refused for the watchman role/);
  });
});

describe("gitRead", () => {
  let root: string;
  let db: Db;
  let boot: Bootstrap;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "yagura-agentcli-"));
    boot = { home: join(root, "home"), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
    db = openStore(layout(boot).db);
    const seed = join(root, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "README.md"), "# sbx\nhello trunk\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "first commit", { name: "yagura", email: "yagura@localhost" });
    await git(["clone", "--quiet", "--bare", seed, join(root, "sbx.git")]);
    await registerRepo({ db, boot }, { source: join(root, "sbx.git") });
  });

  it("reads trunk from the mirror", async () => {
    expect(await gitRead(db, boot, ["sbx", "log", "--format=%s", "origin/main"])).toEqual({ code: 0, output: "first commit\n" });
    expect(await gitRead(db, boot, ["sbx", "show", "origin/main:README.md"])).toEqual({ code: 0, output: "# sbx\nhello trunk\n" });
    expect(await gitRead(db, boot, ["sbx", "grep", "-n", "trunk", "origin/main"])).toEqual({ code: 0, output: "origin/main:README.md:2:hello trunk\n" });
  });

  it("refuses git commands that change things and options that write, run programs, or read outside the repo", async () => {
    expect(await gitRead(db, boot, ["sbx", "push", "origin", ":main"])).toEqual({
      code: 2,
      output: "yagura git: only log, show, ls-tree, diff, grep, blame are allowed, not push\n",
    });
    for (const [sub, arg] of [
      ["log", "--output=/tmp/x"],
      ["diff", "--no-index"],
      ["grep", "-Ovim"],
      ["diff", "--ext-diff"],
    ] as const)
      expect(await gitRead(db, boot, ["sbx", sub, arg, "origin/main"])).toEqual({ code: 2, output: `yagura git: ${arg} is not allowed\n` });
  });

  it("reads trunk when no revision is given, and refuses the mirror's stale HEAD and local branch", async () => {
    expect(await gitRead(db, boot, ["sbx", "log", "--format=%s"])).toEqual({ code: 0, output: "first commit\n" });
    expect(await gitRead(db, boot, ["sbx", "log", "--format=%s", "--", "README.md"])).toEqual({ code: 0, output: "first commit\n" });
    for (const rev of ["HEAD", "HEAD:README.md", "main~1", "main"])
      expect(await gitRead(db, boot, ["sbx", "show", rev])).toEqual({
        code: 2,
        output: `yagura git: ${rev} is the mirror's copy from when it was cloned; trunk is origin/main (e.g. origin/main:README.md)\n`,
      });
  });

  it("passes git's own failure back", async () => {
    const result = await gitRead(db, boot, ["sbx", "show", "origin/main:missing.txt"]);
    expect(result.code).toBe(128);
    expect(result.output).toMatch(/missing\.txt/);
  });
});
