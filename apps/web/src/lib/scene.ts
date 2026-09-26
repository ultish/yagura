import type { ProjectSummary } from "../api";

export interface PlacedTower {
  s: ProjectSummary;
  x: number;
  y: number;
  scale: number;
  dim: boolean;
  ringing: boolean;
  sub: string;
}

export interface Arc {
  from: PlacedTower;
  to: PlacedTower;
  label: string;
}

const DAY = 24 * 3600 * 1000;
const MAX_TOWERS = 6;

export const needsYou = (s: ProjectSummary) => s.openGates + s.blocked + (s.project.andonReason ? 1 : 0);
const busy = (s: ProjectSummary) => s.running > 0 || s.planning;
const dark = (s: ProjectSummary) => s.project.state === "closed" || s.project.state === "framing";

function rank(s: ProjectSummary): number {
  if (dark(s)) return 3;
  if (needsYou(s)) return 0;
  if (busy(s)) return 1;
  return 2;
}

export function subLabel(s: ProjectSummary, all: ProjectSummary[]): string {
  const p = s.project;
  if (p.state === "closed") return "closed";
  if (p.state === "framing") {
    const open = p.after.filter((a) => all.find((x) => x.project.id === a)?.project.state !== "closed");
    return open.length ? `after ${open.join(", ")}` : "ready to start";
  }
  if (p.andonReason) return "andon";
  const parts: string[] = [];
  if (s.running) parts.push(`${s.running} agent${s.running === 1 ? "" : "s"}`);
  if (s.planning) parts.push("planning");
  const n = needsYou(s);
  if (n) parts.push(`${n} need${n === 1 ? "s" : ""} you`);
  return parts.join(" · ") || "idle";
}

export function layoutScene(all: ProjectSummary[], now: number, width = 1440): { towers: PlacedTower[]; quiet: number; arcs: Arc[] } {
  const visible = all.filter((s) => s.project.state !== "closed" || !s.project.closedAt || now - Date.parse(s.project.closedAt) < DAY);
  const sorted = [...visible].sort((a, b) => rank(a) - rank(b) || a.project.createdAt.localeCompare(b.project.createdAt));
  const urgent = sorted.filter((s) => rank(s) < 2).length;
  const shown = sorted.slice(0, Math.max(MAX_TOWERS, urgent));
  const n = shown.length;
  const towers = shown.map((s, i): PlacedTower => {
    const isDark = dark(s);
    return {
      s,
      x: Math.round((width * (i + 0.5)) / Math.max(n, 1)),
      y: isDark ? 204 : 228 - (i % 2) * 8,
      scale: isDark ? 0.7 : n > 4 ? 0.74 : 0.82,
      dim: isDark,
      ringing: !isDark && needsYou(s) > 0,
      sub: subLabel(s, all),
    };
  });
  const byId = new Map(towers.map((t) => [t.s.project.id as string, t]));
  const arcs: Arc[] = [];
  for (const t of towers)
    for (const a of t.s.project.after) {
      const to = byId.get(a);
      if (to && to.s.project.state !== "closed") arcs.push({ from: t, to, label: `${t.s.project.id} waits on ${a}` });
    }
  return { towers, quiet: visible.length - shown.length, arcs };
}
