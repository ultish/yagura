import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./harness/claude.js";
import { readTurnCalls } from "./turncalls.js";

const fixture = new URL("./harness/fixtures/claude-watchman-tools.jsonl", import.meta.url).pathname;

describe("readTurnCalls", () => {
  it("pairs each call of a real watchman turn with its result and says which were refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "turncalls-"));
    const log = join(dir, "1.jsonl");
    copyFileSync(fixture, log);
    const { calls, running } = readTurnCalls(claudeAdapter, [log]);
    expect(running).toBe(false);
    expect(calls.map((c) => [c.name, c.arg, c.outcome])).toEqual([
      ["Skill", "yagura:yagura-watchman", "ok"],
      ["Bash", 'find /home/dev/scratch/demo.git -name "README*" -type f', "refused"],
      ["Read", "/home/dev/scratch", "refused"],
      ["yagura", "git demo show README.md 2>&1", "error"],
      ["yagura", "git demo ls-tree -r HEAD | grep -i readme", "ok"],
      ["yagura", "git demo show HEAD:README.md", "ok"],
      ["yagura", "set max_parallel_agents 9", "refused"],
      ["Bash", "cat /etc/hosts", "refused"],
      ["Bash", 'echo "test" > notes.txt', "refused"],
      ["Write", "/home/dev/scratch/yh6/threads/1/notes.txt", "refused"],
    ]);
    expect(calls[5]!.output).toContain("MARIGOLD");
    expect(calls[9]!.why).toBe("switched off for the watchman");
  });

  it("reports a call with no result yet as running", () => {
    const dir = mkdtempSync(join(tmpdir(), "turncalls-"));
    const log = join(dir, "2.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "yagura show sbx" } }] },
    });
    writeFileSync(log, `${line}\n`);
    const r = readTurnCalls(claudeAdapter, [log]);
    expect(r.running).toBe(true);
    expect(r.calls[0]).toMatchObject({ name: "yagura", arg: "show sbx", output: null });
  });
});
