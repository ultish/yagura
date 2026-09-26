import type { Attempt } from "@yagura/core";
import type { ProjectDetail, UnitView } from "../api";
import { duration, sha } from "./format";

export type StageName = "plan" | "work" | "verify" | "land";
export type Light = "lit" | "flame" | "bell" | "ember" | "wait" | "off";
export interface Stage {
  name: StageName;
  light: Light;
  label: string | null;
}

export type Tone = "bell" | "lamp" | "info" | "pine" | "muted";
export type Group = "bell" | "lit" | "waiting" | "landed" | "cancelled";

const running = (attempts: Attempt[]) => attempts.find((a) => a.state === "running") ?? null;
const handedOff = (u: UnitView) => u.attempts.some((a) => a.state === "handed_off");
const elapsed = (a: Attempt, now: number) => (a.startedAt ? duration(now - Date.parse(a.startedAt)) : "");

export function verifiersOf(d: ProjectDetail, u: UnitView): UnitView[] {
  return d.units.filter((v) => v.type === "verify" && v.targetUnitId === u.id);
}

export function openGateFor(d: ProjectDetail, u: UnitView) {
  return d.gates.find((g) => g.unitId === u.id && g.state === "open") ?? null;
}

export function waitingReason(d: ProjectDetail, u: UnitView): string | null {
  return d.waiting.find((w) => w.unitId === u.id)?.reason ?? null;
}

export function stages(d: ProjectDetail, u: UnitView, now: number): Stage[] {
  const work = running(u.attempts);
  const verifier = verifiersOf(d, u).find((v) => running(v.attempts));
  const verifying = verifier ? running(verifier.attempts) : null;
  const gate = openGateFor(d, u);
  const blockedAtLand = u.state === "blocked" && u.verdict !== null;
  const blockedAtVerify = u.state === "blocked" && !blockedAtLand && handedOff(u) && verifiersOf(d, u).length > 0;
  const past = (s: string[]) => s.includes(u.state);

  const workLight: Stage = work
    ? { name: "work", light: "flame", label: `worker · ${elapsed(work, now)}` }
    : past(["handed_off", "verifying", "verified", "landing", "landed", "done"]) || blockedAtVerify || blockedAtLand
      ? { name: "work", light: "lit", label: null }
      : u.state === "blocked"
        ? { name: "work", light: "ember", label: "blocked" }
        : waitingReason(d, u)
          ? { name: "work", light: "wait", label: null }
          : { name: "work", light: "off", label: null };
  const verifyLight: Stage = verifying
    ? { name: "verify", light: "flame", label: `U${verifier!.seq} · ${elapsed(verifying, now)}` }
    : past(["verified", "landing", "landed", "done"]) || blockedAtLand
      ? { name: "verify", light: "lit", label: null }
      : blockedAtVerify
        ? { name: "verify", light: "ember", label: "blocked" }
        : u.state === "verifying" || u.state === "handed_off"
          ? { name: "verify", light: "wait", label: "queued" }
          : { name: "verify", light: "off", label: null };
  const landLight: Stage = past(["landed", "done"])
    ? { name: "land", light: "lit", label: null }
    : u.state === "landing"
      ? { name: "land", light: "flame", label: "landing" }
      : blockedAtLand
        ? { name: "land", light: "ember", label: "blocked" }
        : u.state === "verified" && gate
          ? { name: "land", light: "bell", label: "land?" }
          : { name: "land", light: "off", label: null };
  return [{ name: "plan", light: "lit", label: null }, workLight, verifyLight, landLight];
}

export function statusLine(d: ProjectDetail, u: UnitView, now: number): { text: string; tone: Tone } {
  const work = running(u.attempts);
  const tries = `try ${u.attempts.length} of ${u.maxAttempts}`;
  const verifier = verifiersOf(d, u).at(-1);
  const repo = u.repoId ?? "the repo";
  switch (u.state) {
    case "running":
      return { text: work ? `Worker running for ${elapsed(work, now)} (${tries}).` : "Worker starting.", tone: "lamp" };
    case "ready":
    case "draft": {
      const w = waitingReason(d, u);
      return w ? { text: `Waiting: ${w}.`, tone: "muted" } : { text: "Queued; starts when an agent slot is free.", tone: "muted" };
    }
    case "handed_off":
      return { text: "Handed off; verification is queued.", tone: "info" };
    case "verifying": {
      const v = verifier && running(verifier.attempts);
      return v ? { text: `U${verifier!.seq} is verifying (${elapsed(v, now)}).`, tone: "lamp" } : { text: `Verification queued${verifier ? ` (U${verifier.seq})` : ""}.`, tone: "info" };
    }
    case "verified":
      return openGateFor(d, u)
        ? { text: `Verified${verifier ? ` by U${verifier.seq}` : ""} at ${u.verdict?.tier ?? "?"}. Ready to land on ${repo}.`, tone: "bell" }
        : { text: `Verified at ${u.verdict?.tier ?? "?"}. Landing next.`, tone: "info" };
    case "landing":
      return { text: `Landing on ${repo}.`, tone: "lamp" };
    case "landed":
    case "done":
      return { text: u.landedSha ? `Landed ${sha(u.landedSha)} on ${repo}${u.verdict ? ` at ${u.verdict.tier}` : ""}.` : "Done.", tone: "pine" };
    case "blocked":
      return { text: `Blocked. ${u.blockedReason ?? "No reason recorded."}`, tone: "bell" };
    case "rejected":
    case "failed":
      return { text: `Attempt ${u.state}; yagura is deciding whether to retry.`, tone: "muted" };
    case "abandoned":
      return { text: "Cancelled.", tone: "muted" };
  }
}

export function groupOf(d: ProjectDetail, u: UnitView): Group {
  if (u.state === "blocked" || openGateFor(d, u)) return "bell";
  if (["landed", "done"].includes(u.state)) return "landed";
  if (u.state === "abandoned") return "cancelled";
  if (["running", "handed_off", "verifying", "verified", "landing"].includes(u.state)) return "lit";
  return "waiting";
}

export function latestAttempt(u: UnitView): Attempt | null {
  return running(u.attempts) ?? u.attempts.at(-1) ?? null;
}
