import { existsSync, readFileSync } from "node:fs";
import type { HarnessAdapter } from "./harness/adapter.js";
import { logTimesPath } from "./paths.js";

export type CallOutcome = "ok" | "error" | "refused";

export interface TurnCall {
  name: string;
  arg: string;
  outcome: CallOutcome;
  why: string | null;
  output: string | null;
  atMs: number | null;
}

export interface TurnCalls {
  calls: TurnCall[];
  running: boolean;
}

const REFUSALS: [RegExp, string][] = [
  [/No such tool available/, "switched off for the watchman"],
  [/refused for the \w+ role/, "the watchman can only read yagura"],
  [/Permission to use \w+ has been denied|was blocked/, "not on the watchman's tool list, or outside its folders"],
];

export function classifyResult(output: string, isError: boolean): { outcome: CallOutcome; why: string | null } {
  if (!isError) return { outcome: "ok", why: null };
  const hit = REFUSALS.find(([re]) => re.test(output));
  return hit ? { outcome: "refused", why: hit[1] } : { outcome: "error", why: null };
}

function describe(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Bash":
      return str(i.command);
    case "Read":
    case "Write":
    case "Edit":
      return str(i.file_path);
    case "Grep":
    case "Glob":
      return `${str(i.pattern)}${i.path ? ` in ${str(i.path)}` : ""}`;
    case "Skill":
      return str(i.skill);
    default:
      return JSON.stringify(input ?? {}).slice(0, 160);
  }
}

export function readTurnCalls(adapter: HarnessAdapter, logPaths: string[]): TurnCalls {
  const calls: TurnCall[] = [];
  const open = new Map<string, TurnCall>();
  for (const path of logPaths) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n").slice(0, -1);
    const timesPath = logTimesPath(path);
    const times = existsSync(timesPath) ? readFileSync(timesPath, "utf8").split("\n").map(Number) : [];
    const start = times[0] || null;
    lines.forEach((raw, n) => {
      let events: ReturnType<HarnessAdapter["parse"]> = [];
      try {
        events = adapter.parse(raw);
      } catch {}
      for (const e of events) {
        if (e.kind === "tool_call") {
          const arg = describe(e.name, e.input);
          const isYagura = e.name === "Bash" && /^yagura\s/.test(arg);
          const call: TurnCall = {
            name: isYagura ? "yagura" : e.name,
            arg: isYagura ? arg.replace(/^yagura\s+/, "") : arg,
            outcome: "ok",
            why: null,
            output: null,
            atMs: start && times[n] ? times[n]! - start : null,
          };
          open.set(e.id, call);
          calls.push(call);
        } else if (e.kind === "tool_result") {
          const call = open.get(e.id);
          if (!call) continue;
          Object.assign(call, { output: e.output, ...classifyResult(e.output, e.isError) });
          open.delete(e.id);
        }
      }
    });
  }
  return { calls, running: open.size > 0 };
}
