import type { Attempt } from "@yagura/core";
import type { ProjectDetail, UnitView } from "../api";
import { duration, sha } from "./format";

export const isBuild = (u: { type: string }) => u.type === "work";

const ROLES: Record<string, string> = { plan: "project lead", work: "worker" };
// The role yagura stored when it started the agent decides its name; the unit's type is only for attempts from before roles were stored.
const STORED: Record<string, string> = {
  planner: "project lead",
  worker: "worker",
  judge: "judge",
  lead: "unit lead",
  watchman: "watchman",
};
export const roleOf = (unitType: string, _harness?: string, _attemptN?: number, role?: string | null) =>
  (role && STORED[role]) || (ROLES[unitType] ?? unitType);

export type StageName = "plan" | "work" | "judge" | "merge";
export type Light = "lit" | "flame" | "bell" | "ember" | "wait" | "off";
export interface Stage {
  name: StageName;
  light: Light;
  label: string | null;
  href: string | null;
}

export type Tone = "bell" | "lamp" | "info" | "pine" | "muted";
export type Group = "bell" | "lit" | "waiting" | "merged" | "dropped";

const running = (attempts: Attempt[]) => attempts.find((a) => a.state === "running") ?? null;
const runningJudge = (u: UnitView) => running(u.attempts.filter((a) => a.role === "judge"));
const elapsed = (a: Attempt, now: number) => (a.startedAt ? duration(now - Date.parse(a.startedAt)) : "");

// A plan row is an agent job, not a slice of work: it is named by its agent once one has started.
export const jobName = (u: UnitView): string => {
  const a = u.attempts.at(-1);
  return a ? `A${a.agentNo}` : `its ${u.type}`;
};

export function openGateFor(d: ProjectDetail, u: UnitView) {
  return d.gates.find((g) => g.unitId === u.id && g.state === "open") ?? null;
}

export function waitingReason(d: ProjectDetail, u: UnitView): string | null {
  return d.waiting.find((w) => w.unitId === u.id)?.reason ?? null;
}

export function stages(d: ProjectDetail, u: UnitView, now: number): Stage[] {
  const builder = running(u.attempts.filter((a) => a.role !== "judge" && a.role !== "lead"));
  const judge = runningJudge(u);
  const gate = openGateFor(d, u);
  const past = (s: string[]) => s.includes(u.state);

  const workLight: Stage = builder
    ? { name: "work", light: "flame", label: `worker · ${elapsed(builder, now)}`, href: null }
    : past(["judging", "ready", "merged"])
      ? { name: "work", light: "lit", label: null, href: null }
      : u.state === "stuck"
        ? { name: "work", light: "ember", label: "stuck", href: null }
        : waitingReason(d, u)
          ? { name: "work", light: "wait", label: null, href: null }
          : { name: "work", light: "off", label: null, href: null };
  const judgeLight: Stage = judge
    ? { name: "judge", light: "flame", label: `judge · ${elapsed(judge, now)}`, href: null }
    : past(["ready", "merged"])
      ? { name: "judge", light: "lit", label: null, href: null }
      : u.state === "judging"
        ? { name: "judge", light: "wait", label: "queued", href: null }
        : { name: "judge", light: "off", label: null, href: null };
  const mergeLight: Stage = past(["merged"])
    ? { name: "merge", light: "lit", label: null, href: null }
    : u.state === "ready" && gate
      ? { name: "merge", light: "bell", label: gate.kind === "land" ? "merge?" : "asks you", href: null }
      : u.state === "ready"
        ? { name: "merge", light: "flame", label: "ready", href: null }
        : { name: "merge", light: "off", label: null, href: null };
  const lastRun = (attempts: Attempt[]) => running(attempts) ?? attempts.at(-1) ?? null;
  const unitHref = `/p/${d.project.id}/u/${u.seq}`;
  const workRun = lastRun(u.attempts.filter((a) => a.role !== "judge" && a.role !== "lead"));
  const judgeRun = lastRun(u.attempts.filter((a) => a.role === "judge"));
  return [
    { name: "plan", light: "lit", label: null, href: unitHref },
    { ...workLight, href: workRun ? `/a/${workRun.id}` : null },
    { ...judgeLight, href: judgeRun ? `/a/${judgeRun.id}` : null },
    { ...mergeLight, href: mergeLight.light === "off" ? null : unitHref },
  ];
}

export function statusLine(d: ProjectDetail, u: UnitView, now: number): { text: string; tone: Tone } {
  const work = running(u.attempts);
  const tries = `try ${u.attempts.filter((a) => a.role !== "judge" && a.role !== "lead").length} of ${u.maxAttempts}`;
  const repo = u.repoId ?? "the repo";
  switch (u.state) {
    case "building":
      return { text: work ? `Worker running for ${elapsed(work, now)} (${tries}).` : "Worker starting.", tone: "lamp" };
    case "waiting": {
      const w = waitingReason(d, u);
      return w ? { text: `Waiting: ${w}.`, tone: "muted" } : { text: "Queued; starts when an agent slot is free.", tone: "muted" };
    }
    case "judging": {
      const j = runningJudge(u);
      return j ? { text: `The judge is looking at it (${elapsed(j, now)}).`, tone: "lamp" } : { text: "Handed off; the judge is next.", tone: "info" };
    }
    case "ready": {
      const ask = openGateFor(d, u);
      return ask
        ? { text: `Approved; its pull request on ${repo} waits for you: ${ask.question}`, tone: "bell" }
        : { text: `Approved; waiting for CI and the merge on ${repo}.`, tone: "info" };
    }
    case "merged":
      return { text: u.mergedSha ? `Merged ${sha(u.mergedSha)} on ${repo}.` : "Done.", tone: "pine" };
    case "stuck": {
      const ask = openGateFor(d, u);
      return ask ? { text: `Stuck; it asks you: ${ask.question}`, tone: "bell" } : { text: `Stuck. ${u.blockedReason ?? "No reason recorded."}`, tone: "bell" };
    }
    case "dropped":
      return { text: "Dropped.", tone: "muted" };
  }
}

export interface DepLine {
  tone: "pine" | "amber" | "bell" | "muted";
  // Only a unit that is really waiting moves; a line that is just a relationship stays still.
  moving: boolean;
  label: string;
}

// How an `after` line on the project page looks: `dep.unitId` comes after `dep.dependsOn`.
export function depLine(d: ProjectDetail, dep: { unitId: number; dependsOn: number }): DepLine {
  const later = d.units.find((u) => u.id === dep.unitId)!;
  const earlier = d.units.find((u) => u.id === dep.dependsOn)!;
  const named = `U${later.seq} comes after U${earlier.seq}`;
  if (earlier.state === "dropped") return { tone: "muted", moving: false, label: `${named} (dropped)` };
  if (earlier.state === "merged") return { tone: "pine", moving: false, label: `${named} (merged)` };
  const waiting = d.waiting.some((w) => w.unitId === later.id);
  if (!waiting) return { tone: "amber", moving: false, label: named };
  const needsYou = d.gates.some((g) => g.unitId === earlier.id && g.state === "open");
  const why = `U${later.seq} waits for U${earlier.seq} to merge`;
  return { tone: needsYou ? "bell" : "amber", moving: true, label: needsYou ? `${why}, and U${earlier.seq} waits for you` : why };
}

export function groupOf(d: ProjectDetail, u: UnitView): Group {
  if (u.state === "stuck" || openGateFor(d, u)) return "bell";
  if (u.state === "merged") return "merged";
  if (u.state === "dropped") return "dropped";
  if (["building", "judging", "ready"].includes(u.state)) return "lit";
  return "waiting";
}

// What the developer can do to a unit, on its page and its project row alike. The daemon refuses the rest.
export type UnitAction = "answer" | "retry" | "ask-lead" | "stop" | "drop" | "disagree";
export function unitActions(u: { state: string; type: string }, openGates: number, agentRunning: boolean): UnitAction[] {
  const out: UnitAction[] = [];
  if (openGates) out.push("answer");
  if (u.state === "stuck" && !agentRunning) out.push("retry");
  if (u.type === "work" && ((u.state === "stuck" && !agentRunning) || u.state === "ready")) out.push("ask-lead");
  if (agentRunning) out.push("stop");
  if (["waiting", "stuck", "ready"].includes(u.state) && !agentRunning) out.push("drop");
  if (u.state === "merged") out.push("disagree");
  return out;
}

// The unit's colour: vermilion when it needs the developer, pine once merged, amber while it moves.
export function unitTone(state: string, openGates: number): "bell" | "lamp" | "pine" | "muted" {
  if (openGates || state === "stuck") return "bell";
  if (state === "merged") return "pine";
  if (state === "dropped" || state === "waiting") return "muted";
  return "lamp";
}

export function latestAttempt(u: UnitView): Attempt | null {
  return running(u.attempts) ?? u.attempts.at(-1) ?? null;
}
