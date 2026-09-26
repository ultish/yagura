import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeAdapter, parseClaudeLine } from "./claude.js";

const lines = readFileSync(new URL("./fixtures/claude-basic.jsonl", import.meta.url), "utf8").split("\n");
const events = lines.flatMap(parseClaudeLine);

describe("claude stream-json parser (real transcript)", () => {
  it("reads the session with model and plugin versions", () => {
    const session = events.find((e) => e.kind === "session");
    expect(session).toMatchObject({ kind: "session", model: "claude-haiku-4-5-20251001" });
    expect(session?.kind === "session" && session.plugins.pstack).toBe("0.5.0");
  });

  it("pairs each tool call with its result", () => {
    const calls = events.filter((e) => e.kind === "tool_call");
    const results = events.filter((e) => e.kind === "tool_result");
    expect(calls.map((c) => c.kind === "tool_call" && c.name)).toEqual(["Read", "Bash"]);
    expect(results.map((r) => r.kind === "tool_result" && r.id)).toEqual(calls.map((c) => c.kind === "tool_call" && c.id));
    expect(results[1]).toMatchObject({ output: "a.txt", isError: false });
  });

  it("tracks context size from per-message usage", () => {
    const peak = Math.max(...events.map((e) => (e.kind === "usage" ? e.contextTokens : 0)));
    expect(peak).toBe(8 + 344 + 23155);
  });

  it("ends with the final message and cost", () => {
    expect(events.at(-1)).toEqual({ kind: "final", text: "DONE", isError: false, stopReason: "completed", costUsd: 0.024625 });
  });

  it("drops empty thinking blocks and marks other system events ignored", () => {
    expect(events.filter((e) => e.kind === "text").map((e) => e.kind === "text" && e.text)).toEqual([
      "I'll read a.txt and then run ls.",
      "DONE",
    ]);
    expect(events.some((e) => e.kind === "ignored" && e.type === "system:hook_started")).toBe(true);
  });
});

describe("claude command", () => {
  it("builds a headless stream-json invocation with plugin dirs and optional model", () => {
    const run = { prompt: "brief", bin: null, model: null, permissionMode: "bypassPermissions", pluginDirs: ["/y/plugins/yagura"], addDirs: [], extraArgs: [] };
    expect(claudeAdapter.command(run)).toEqual({
      argv: ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--plugin-dir", "/y/plugins/yagura"],
      stdin: "brief",
    });
    expect(claudeAdapter.command({ ...run, model: "opus" }).argv.slice(-2)).toEqual(["--model", "opus"]);
  });
});
