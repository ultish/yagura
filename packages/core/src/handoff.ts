import { FAILURE_MODES, HANDOFF_STATUSES, PASS_TIERS, FAIL_TIERS } from "./domain.js";
import type { FailureMode, Handoff, HandoffStatus, Tier } from "./domain.js";

const SECTIONS = {
  status: "status",
  branch: "branch",
  whatIDid: "what i did",
  measurements: "measurements",
  verification: "verification",
  evidence: "evidence",
  notes: "notes",
  forOthers: "for other units",
  followUps: "suggested follow-ups",
  packChanges: "pack changes",
  findings: "findings",
  decisions: "decisions",
  outsideScope: "outside scope",
} as const;

function splitSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = text.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim().toLowerCase();
    const body = newline === -1 ? "" : part.slice(newline + 1).trim();
    const key = Object.entries(SECTIONS).find(([, h]) => heading.startsWith(h))?.[0];
    if (key && !sections.has(key)) sections.set(key, body);
  }
  return sections;
}

const firstWord = (s: string | undefined) => s?.replace(/[`*]/g, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

export function parseHandoff(finalMessage: string): Handoff | null {
  const start = finalMessage.search(/^##\s+Status\s*$/im);
  if (start === -1) return null;
  const text = finalMessage.slice(start);
  const s = splitSections(text);
  const status = firstWord(s.get("status"));
  if (!(HANDOFF_STATUSES as readonly string[]).includes(status)) return null;
  const tier = firstWord(s.get("verification"));
  const tiers: readonly string[] = [...PASS_TIERS, ...FAIL_TIERS, "not-verified"];
  const branch = s.get("branch")?.replace(/[`]/g, "").trim();
  return {
    status: status as HandoffStatus,
    branch: branch && !branch.startsWith("(") ? branch : null,
    whatIDid: s.get("whatIDid") ?? "",
    measurements: s.get("measurements") ?? "",
    verification: tiers.includes(tier) ? (tier as Tier | "not-verified") : null,
    evidence: (s.get("evidence") ?? "")
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter(Boolean),
    notes: s.get("notes") ?? "",
    forOthers: s.get("forOthers") ?? "",
    followUps: s.get("followUps") ?? "",
    packChanges: s.get("packChanges") ?? "",
    findings: s.get("findings") ?? "",
    decisions: s.get("decisions") ?? "",
    outsideScope: s.get("outsideScope") ?? "",
    raw: text,
  };
}

export interface ExitFacts {
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  finalText: string | null;
  finalIsError: boolean;
  stderrTail: string;
}

export function classifyFailure(f: ExitFacts): FailureMode {
  const text = `${f.finalText ?? ""}\n${f.stderrTail}`.toLowerCase();
  if (f.timedOut) return "timebox";
  if (f.exitCode === 137 || f.signal === "SIGKILL" || /out of memory|oomkilled/.test(text)) return "oom";
  if (/prompt is too long|context (window|length)|maximum context/.test(text)) return "context-exhausted";
  if (/fetch failed|etimedout|econn|socket hang up|enotfound|network/.test(text)) return "network";
  if (/tool_use_failed|tool-error|tool error/.test(text)) return "tool-error";
  if (f.finalIsError || (f.exitCode !== null && f.exitCode !== 0)) return "harness-error";
  return "unknown";
}

export function syntheticFailureHandoff(p: {
  unit: string;
  attempt: number;
  mode: FailureMode;
  branch: string | null;
  startedAt: string;
  endedAt: string;
  lastActivity: string | null;
  facts: ExitFacts;
}): string {
  if (!(FAILURE_MODES as readonly string[]).includes(p.mode)) throw new Error(`unknown failure mode ${p.mode}`);
  return `<!-- yagura synthetic failure handoff: unit ${p.unit} attempt ${p.attempt} mode ${p.mode} -->
## Status
blocked

## Branch
${p.branch ? `\`${p.branch}\`` : "(no branch)"}

## What I did
(the agent ended without a handoff; written by yagura)

## Failure
- mode: ${p.mode}
- exit: code ${p.facts.exitCode ?? "none"}, signal ${p.facts.signal ?? "none"}, timed out: ${p.facts.timedOut}
- started: ${p.startedAt}
- ended: ${p.endedAt}
- last activity: ${p.lastActivity ?? "(none)"}
- final message: ${p.facts.finalText ? p.facts.finalText.slice(0, 500) : "(none)"}
- stderr tail: ${p.facts.stderrTail.slice(-500) || "(empty)"}
`;
}
