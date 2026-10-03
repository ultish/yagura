import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "./config.js";
import { watchmanGuardSettings } from "./watchman-guard.js";

describe("the watchman's Bash guard", () => {
  it("lets through only the watchman's yagura reads, however broad the developer's own allow rules are", () => {
    const boot = { home: mkdtempSync(join(tmpdir(), "yagura-guard-")), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
    const settings = JSON.parse(watchmanGuardSettings(boot, SETTINGS["watchman.allowed_tools"].parse(undefined)));
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Bash");
    const run = (command: string) => {
      const r = spawnSync("sh", ["-c", hook.hooks[0].command], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
      return { code: r.status, why: r.stderr };
    };
    for (const ok of [
      "yagura show wordstat",
      "yagura git demo show HEAD:README.md 2>&1",
      "yagura git demo ls-tree -r origin/main | grep -i readme",
      "yagura env values local",
    ])
      expect(run(ok)).toEqual({ code: 0, why: "" });
    expect(run("npm install left-pad").code).toBe(2);
    expect(run("npm install left-pad").why).toMatch(/^yagura refused this command for the watchman: npm install is not one of its reads/);
    expect(run("yagura set max_parallel_agents 9").code).toBe(2);
    expect(run("yagura env add box").code).toBe(2);
    expect(run("yagura show p; rm -rf ~").code).toBe(2);
    expect(run("yagura show p > out.txt").code).toBe(2);
    expect(run("yagura show $(cat /etc/hosts)").code).toBe(2);
    expect(run("yagura show p | sh").why).toMatch(/sh is not a read-only filter/);
  });
});
