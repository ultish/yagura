import type { ProjectSummary } from "../api";
import { clock } from "./format";
import { needsYou } from "./scene";

type Tone = "bell" | "lamp" | "pine" | "muted";

// What a project is doing, in a few words, and the one colour that says so: vermilion needs you, amber is at work, pine is done.
export function projectStatus(s: ProjectSummary): { text: string; tone: Tone } {
  const n = needsYou(s);
  if (s.project.andonReason) return { text: `Andon: ${s.project.andonReason}`, tone: "bell" };
  if (n) return { text: `${n} ${n === 1 ? "needs" : "need"} you`, tone: "bell" };
  if (s.running || s.planning) return { text: `${s.running} agent${s.running === 1 ? "" : "s"} at work${s.planning ? ", planning" : ""}`, tone: "lamp" };
  if (s.project.state === "closed") return { text: `Closed ${clock(s.project.closedAt)}`, tone: "pine" };
  if (s.project.state === "framing") return { text: `Starts after ${s.project.after.join(", ")}`, tone: "muted" };
  return { text: "Idle", tone: "muted" };
}
