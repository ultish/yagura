import type { HarnessEvent } from "../domain.js";
import type { HarnessAdapter, HarnessRun } from "./adapter.js";

type Block = { type: string; [k: string]: unknown };
type Usage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String(c.text) : JSON.stringify(c))).join("\n");
  return JSON.stringify(content ?? "");
}

type RateLimitInfo = { status?: string; resetsAt?: number };
const LIMIT_STATUSES = ["allowed", "allowed_warning", "rejected"] as const;

function limitEvent(info: RateLimitInfo | undefined, refused: boolean): HarnessEvent {
  const status = refused ? "rejected" : (LIMIT_STATUSES.find((s) => s === info?.status) ?? "allowed");
  return { kind: "limit", status, resetsAt: typeof info?.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null };
}

export function parseClaudeLine(line: string): HarnessEvent[] {
  if (!line.trim()) return [];
  const o = JSON.parse(line) as Record<string, unknown>;
  const parentId = (o.parent_tool_use_id as string | null | undefined) ?? null;

  if (o.type === "system" && o.subtype === "init") {
    const plugins: Record<string, string> = {};
    for (const p of (o.plugins as { name: string; version?: string }[] | undefined) ?? []) plugins[p.name] = p.version ?? "unknown";
    return [{ kind: "session", sessionId: String(o.session_id), model: (o.model as string) ?? null, plugins }];
  }

  if (o.type === "assistant") {
    const message = o.message as { content: Block[]; usage?: Usage };
    const events: HarnessEvent[] = [];
    for (const b of message.content) {
      if (b.type === "text" && typeof b.text === "string" && b.text) events.push({ kind: "text", text: b.text, parentId });
      if (b.type === "tool_use") events.push({ kind: "tool_call", id: String(b.id), name: String(b.name), input: b.input, parentId });
    }
    const u = message.usage;
    if (u)
      events.push({
        kind: "usage",
        outputTokens: u.output_tokens ?? 0,
        contextTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      });
    // claude reports a refused request as an assistant message; a usage limit carries the window it hit.
    if (o.error === "rate_limit") events.push(limitEvent((o.api_error_params as { rate_limit_info?: RateLimitInfo } | undefined)?.rate_limit_info, true));
    return events;
  }

  if (o.type === "user") {
    const message = o.message as { content: Block[] | string };
    if (o.isReplay === true) return [{ kind: "user_text", text: stringifyContent(message.content) }];
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter((b) => b.type === "tool_result")
      .map((b) => ({
        kind: "tool_result" as const,
        id: String(b.tool_use_id),
        output: stringifyContent(b.content),
        isError: b.is_error === true,
        parentId,
      }));
  }

  if (o.type === "result")
    return [
      {
        kind: "final",
        text: typeof o.result === "string" ? o.result : "",
        isError: o.is_error === true,
        stopReason: (o.terminal_reason as string) ?? (o.stop_reason as string) ?? null,
        costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
      },
    ];

  if (o.type === "rate_limit_event") return [limitEvent(o.rate_limit_info as RateLimitInfo | undefined, false)];

  return [{ kind: "ignored", type: [o.type, o.subtype].filter(Boolean).join(":") }];
}

// yagura alone pushes and opens PRs or MRs (§14, §15); a skill's landing steps must not reach the forge from any session.
export const LANDING_DENIED_TOOLS = ["Bash(git push:*)", "Bash(gh pr:*)", "Bash(glab mr:*)"];

const claudeMessage = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command(run: HarnessRun) {
    const argv = [
      run.bin ?? "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--permission-mode",
      run.permissionMode,
      ...run.pluginDirs.flatMap((d) => ["--plugin-dir", d]),
      ...run.addDirs.flatMap((d) => ["--add-dir", d]),
      ...(run.allowedTools?.length ? ["--allowed-tools", run.allowedTools.join(",")] : []),
      "--disallowed-tools",
      [...(run.disallowedTools ?? []), ...LANDING_DENIED_TOOLS].join(","),
      ...(run.settings ? ["--settings", run.settings] : []),
      ...(run.model ? ["--model", run.model] : []),
      ...(run.resume ? ["--resume", run.resume] : []),
      ...run.extraArgs,
    ];
    return { argv, stdin: claudeMessage(run.prompt) };
  },
  message: claudeMessage,
  parse: parseClaudeLine,
};
