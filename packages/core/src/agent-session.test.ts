import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSession, type SessionRecorder } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { layout } from "./paths.js";
import { openStore } from "./store.js";

const NOISE = "bash: cannot set terminal process group (-1): Inappropriate ioctl for device\nbash: no job control in this shell\n";
const crashing: HarnessAdapter = {
  id: "claude",
  canResume: false,
  command: (run) => ({
    argv: [
      "/bin/sh",
      "-c",
      `printf '${NOISE}' >&2; printf 'stdin was: ' >&2; cat >&2; echo >&2; echo "flag: $1" >&2; echo 'Fatal error: e.toLowerCase is not a function' >&2; exit 1`,
      "sh",
      "a b",
    ],
    stdin: run.prompt,
  }),
  parse: () => [],
};
const recorder: SessionRecorder = {
  env: { YAGURA_ROLE: "planner", YAGURA_EVIDENCE_TOKEN: "t0ken" },
  started: () => {},
  session: () => {},
  usage: () => {},
  cost: () => {},
  finished: () => [],
};

describe("runAgentSession", () => {
  it("keeps a session's whole stderr and a command that starts it again, and leaves shell noise out of the tail it reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "yagura-session-"));
    const boot: Bootstrap = { home: join(root, "home"), skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
    const ctx = { db: openStore(layout(boot).db), boot, adapters: {}, cli: [] };
    const logPath = join(root, "logs", "u1.1.jsonl");
    const result = await runAgentSession(ctx, {
      recorder,
      adapter: crashing,
      run: { prompt: "the brief", bin: null, model: null, permissionMode: "bypassPermissions", pluginDirs: [], addDirs: [], extraArgs: [] },
      cwd: root,
      env: { DEPLOY_TOKEN: "s3cret" },
      timeboxSeconds: 30,
      logPath,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).not.toMatch(/job control|terminal process group/);
    expect(result.stderrTail).toMatch(/Fatal error: e\.toLowerCase is not a function/);
    const stderr = readFileSync(join(root, "logs", "u1.1.stderr"), "utf8");
    expect(stderr.startsWith(NOISE)).toBe(true);
    expect(stderr).toMatch(/stdin was: the brief\nflag: a b\nFatal error/);

    const cmd = readFileSync(join(root, "logs", "u1.1.cmd"), "utf8");
    expect(cmd).toMatch(/also set, values not kept: DEPLOY_TOKEN YAGURA_EVIDENCE_TOKEN/);
    expect(cmd).not.toMatch(/s3cret|t0ken/);
    expect(cmd).toMatch(/YAGURA_ROLE='planner'/);
    const again = spawnSync("/bin/sh", [join(root, "logs", "u1.1.cmd")], { encoding: "utf8" });
    expect(again.status).toBe(1);
    expect(again.stderr).toBe(stderr);
  });
});
