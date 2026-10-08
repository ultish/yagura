import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../domain.js";
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
    expect(events.filter((e) => e.kind === "text").map((e) => e.kind === "text" && e.text)).toEqual(["I'll read a.txt and then run ls.", "DONE"]);
    expect(events.some((e) => e.kind === "ignored" && e.type === "system:hook_started")).toBe(true);
  });
});

describe("claude command", () => {
  it("builds a headless stream-json invocation with plugin dirs and optional model", () => {
    const run = { prompt: "brief", bin: null, model: null, permissionMode: "bypassPermissions", pluginDirs: ["/y/plugins/yagura"], addDirs: [], extraArgs: [] };
    expect(claudeAdapter.command(run)).toEqual({
      argv: [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--permission-mode",
        "bypassPermissions",
        "--plugin-dir",
        "/y/plugins/yagura",
        "--disallowed-tools",
        "Bash(git push:*),Bash(gh pr:*),Bash(glab mr:*)",
      ],
      stdin: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"brief"}]}}\n',
    });
    expect(claudeAdapter.command({ ...run, model: "opus" }).argv.slice(-2)).toEqual(["--model", "opus"]);
  });

  it("passes allowed and denied tools as one list each, always denies pull request commands, and lets only a worker push", () => {
    const run = { prompt: "p", bin: null, model: null, permissionMode: "dontAsk", pluginDirs: [], addDirs: ["/h/projects/a"], extraArgs: [] };
    expect(claudeAdapter.command({ ...run, allowedTools: ["Skill", "Bash(yagura show:*)"], disallowedTools: ["Write", "Edit"] }).argv.slice(10)).toEqual([
      "--add-dir",
      "/h/projects/a",
      "--allowed-tools",
      "Skill,Bash(yagura show:*)",
      "--disallowed-tools",
      "Write,Edit,Bash(git push:*),Bash(gh pr:*),Bash(glab mr:*)",
    ]);
    expect(claudeAdapter.command({ ...run, pushes: true }).argv.slice(-2)).toEqual(["--disallowed-tools", "Bash(gh pr:*),Bash(glab mr:*)"]);
  });
});

describe("claude usage limit", () => {
  // Built from claude 2.1.292's own stream-json writer, not captured: replace with a real transcript once yagura logs one.
  it("reads the refused request as a limit until the window resets, and a warning as no refusal", () => {
    const events = readFileSync(new URL("./fixtures/claude-usage-limit.from-source.jsonl", import.meta.url), "utf8")
      .split("\n")
      .flatMap(parseClaudeLine);
    expect(events.filter((e) => e.kind === "limit")).toEqual([
      { kind: "limit", status: "allowed_warning", resetsAt: "2026-10-08T03:00:00.000Z" },
      { kind: "limit", status: "rejected", resetsAt: "2026-10-08T03:00:00.000Z" },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "final", isError: true, text: "You've hit your session limit · resets 2pm" });
  });

  it("reads a rate limit with no window (an API key's) as a refusal with no reset time", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Rate limited" }] }, error: "rate_limit" });
    expect(parseClaudeLine(line).at(-1)).toEqual({ kind: "limit", status: "rejected", resetsAt: null });
  });
});

describe("claude resume (real transcripts)", () => {
  const read = (f: string) =>
    readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")
      .split("\n")
      .flatMap(parseClaudeLine);

  it("passes the session to --resume", () => {
    const run = { prompt: "p", bin: null, model: null, permissionMode: "acceptEdits", pluginDirs: [], addDirs: [], extraArgs: [] };
    expect(claudeAdapter.command({ ...run, resume: "abc" }).argv.slice(-2)).toEqual(["--resume", "abc"]);
    expect(claudeAdapter.command(run).argv).not.toContain("--resume");
  });

  it("keeps the session id and replays nothing from the earlier round", () => {
    const events = read("claude-resume.jsonl");
    expect(events.filter((e) => e.kind === "session").map((e) => e.kind === "session" && e.sessionId)).toEqual(["62931194-a641-43c8-b229-468927482bf2"]);
    expect(events.filter((e) => e.kind === "text").map((e) => e.kind === "text" && e.text)).toEqual(["PERSIMMON"]);
    expect(events.at(-1)).toMatchObject({ kind: "final", text: "PERSIMMON", isError: false });
  });

  it("starts no session when the id is unknown", () => {
    const events = read("claude-resume-missing.jsonl");
    expect(events.some((e) => e.kind === "session")).toBe(false);
    expect(events).toEqual([{ kind: "final", text: "", isError: true, stopReason: null, costUsd: 0 }]);
  });
});

describe("claude steering (real transcript)", () => {
  const events = readFileSync(new URL("./fixtures/claude-steer.jsonl", import.meta.url), "utf8")
    .split("\n")
    .flatMap(parseClaudeLine);

  it("echoes each message it takes in, the brief first and a mid-run message after the step in progress", () => {
    const order = events
      .filter((e) => e.kind === "user_text" || e.kind === "tool_call" || e.kind === "final")
      .map((e) =>
        e.kind === "user_text"
          ? `you: ${e.text.slice(0, 20)}`
          : e.kind === "tool_call"
            ? `call: ${(e.input as { command: string }).command}`
            : `final: ${e.text}`,
      );
    expect(order).toEqual(["you: Run these three comm", "call: sleep 4 && echo one", "you: Change of plan: stop", "call: echo PINEAPPLE", "final: Done."]);
  });
});

describe("the watchman's tools (real transcripts, Haiku, dontAsk with yagura's allow-list)", () => {
  const read = (f: string) =>
    readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")
      .split("\n")
      .flatMap(parseClaudeLine);
  const calls = (events: HarnessEvent[]) => {
    const results = new Map(events.flatMap((e) => (e.kind === "tool_result" ? [[e.id, e]] : [])));
    return events.flatMap((e) => {
      if (e.kind !== "tool_call") return [];
      const input = e.input as { command?: string; file_path?: string; skill?: string };
      const result = results.get(e.id)!;
      const outcome = !result.isError
        ? "ran"
        : /don't ask mode/.test(result.output)
          ? "denied"
          : /No such tool available/.test(result.output)
            ? "no such tool"
            : "failed";
      return [`${e.name} ${input.command ?? input.file_path ?? input.skill}: ${outcome}`];
    });
  };

  it("runs the allow-listed yagura reads and refuses everything else", () => {
    expect(calls(read("claude-watchman-tools.jsonl"))).toEqual([
      "Skill yagura:yagura-watchman: ran",
      'Bash find /home/dev/scratch/demo.git -name "README*" -type f: denied',
      "Read /home/dev/scratch: denied",
      "Bash yagura git demo show README.md 2>&1: failed",
      "Bash yagura git demo ls-tree -r HEAD | grep -i readme: ran",
      "Bash yagura git demo show HEAD:README.md: ran",
      "Bash yagura set max_parallel_agents 9: denied",
      "Bash cat /etc/hosts: denied",
      'Bash echo "test" > notes.txt: denied',
      "Write /home/dev/scratch/yh6/threads/1/notes.txt: no such tool",
    ]);
  });

  it("resumes the same session on the next message", () => {
    const first = read("claude-watchman-tools.jsonl").find((e) => e.kind === "session");
    const events = read("claude-watchman-resume.jsonl");
    expect(events.filter((e) => e.kind === "session").map((e) => e.kind === "session" && e.sessionId)).toEqual([first?.kind === "session" && first.sessionId]);
    expect(calls(events)).toEqual(["Bash yagura git demo log -1 --pretty=format:%s: ran"]);
  });
});
