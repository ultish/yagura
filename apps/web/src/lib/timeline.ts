import type { HarnessEvent, LogLine } from "../api";

export type Step =
  | { kind: "skill"; id: string; at: number | null; skill: string; ok: boolean }
  | { kind: "text"; id: string; at: number | null; text: string }
  | {
      kind: "tool";
      id: string;
      at: number | null;
      name: string;
      summary: string;
      diff: { old: string; new: string } | null;
      output: string | null;
      isError: boolean;
      children: Step[];
    }
  | { kind: "final"; id: string; at: number | null; text: string; isError: boolean; costUsd: number | null };

export interface Timeline {
  steps: Step[];
  startedAt: number | null;
  model: string | null;
  plugins: Record<string, string>;
  contextPeak: number;
  lastActivity: string | null;
}

const WORKTREE = /\/(?:worktrees\/[^/]+\/[^/\s]+|turns|threads\/\d+)\//;

export function shortPath(p: string): string {
  const m = WORKTREE.exec(p);
  return m ? p.slice(m.index + m[0].length) : p.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

function summarize(name: string, input: unknown): { summary: string; diff: { old: string; new: string } | null } {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Bash":
      return {
        summary:
          str(i.command)
            .split("\n")[0]!
            .replace(/\/\S*\/(worktrees\/\S+?\/)/g, "") + (str(i.command).includes("\n") ? " …" : ""),
        diff: null,
      };
    case "Read":
    case "Write":
    case "NotebookEdit":
      return { summary: shortPath(str(i.file_path)), diff: null };
    case "Edit":
    case "MultiEdit":
      return { summary: shortPath(str(i.file_path)), diff: typeof i.old_string === "string" ? { old: str(i.old_string), new: str(i.new_string) } : null };
    case "Grep":
    case "Glob":
      return { summary: `${str(i.pattern)}${i.path ? ` in ${shortPath(str(i.path))}` : ""}`, diff: null };
    case "Task":
    case "Agent":
      return { summary: str(i.description) || str(i.prompt).slice(0, 80), diff: null };
    default:
      return { summary: JSON.stringify(input ?? {}).slice(0, 120), diff: null };
  }
}

export function buildTimeline(lines: LogLine[]): Timeline {
  const t: Timeline = { steps: [], startedAt: null, model: null, plugins: {}, contextPeak: 0, lastActivity: null };
  const calls = new Map<string, Extract<Step, { kind: "tool" | "skill" }>>();
  const place = (step: Step, parentId: string | null) => {
    const parent = parentId ? calls.get(parentId) : undefined;
    if (parent && parent.kind === "tool") parent.children.push(step);
    else t.steps.push(step);
  };
  for (const line of lines) {
    if (t.startedAt === null && line.at) t.startedAt = line.at;
    line.events.forEach((e: HarnessEvent, j) => {
      const id = `${line.line}.${j}`;
      switch (e.kind) {
        case "session":
          t.model = e.model;
          t.plugins = e.plugins;
          break;
        case "usage":
          t.contextPeak = Math.max(t.contextPeak, e.contextTokens);
          break;
        case "text":
          if (e.text.trim()) place({ kind: "text", id, at: line.at, text: e.text }, e.parentId);
          break;
        case "tool_call": {
          if (e.name === "Skill") {
            const step: Step = { kind: "skill", id, at: line.at, skill: String((e.input as { skill?: unknown })?.skill ?? "?"), ok: true };
            calls.set(e.id, step);
            place(step, e.parentId);
            break;
          }
          const s = summarize(e.name, e.input);
          const step: Step = { kind: "tool", id, at: line.at, name: e.name, summary: s.summary, diff: s.diff, output: null, isError: false, children: [] };
          calls.set(e.id, step);
          place(step, e.parentId);
          t.lastActivity = `${e.name} ${s.summary}`.slice(0, 120);
          break;
        }
        case "tool_result": {
          const call = calls.get(e.id);
          if (call?.kind === "tool") {
            call.output = e.output;
            call.isError = e.isError;
          } else if (call?.kind === "skill") call.ok = !e.isError;
          break;
        }
        case "final": {
          const prev = t.steps.at(-1);
          if (prev?.kind === "text" && prev.text.trim() === e.text.trim()) t.steps.pop();
          t.steps.push({ kind: "final", id, at: line.at, text: e.text, isError: e.isError, costUsd: e.costUsd });
          break;
        }
      }
    });
  }
  return t;
}
