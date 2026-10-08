import type { Unit, UnitId, UnitState } from "./domain.js";
import { getUnit, listDeps, listGates, type Db } from "./store.js";

export type EdgeTone = "pine" | "amber" | "bell" | "muted";

// One `after` link, seen from one unit: it comes after `other` (`needs`), or `other` comes after it (`feeds`).
export interface DepEdge {
  direction: "needs" | "feeds";
  other: { id: UnitId; seq: number; repoId: string | null; goal: string; state: UnitState };
  state: { text: string; tone: EdgeTone };
}

// What the link is doing now, in words, from the later unit's side.
function edgeState(db: Db, later: Unit, earlier: Unit): DepEdge["state"] {
  const up = `U${earlier.seq}`;
  if (earlier.state === "dropped") return { text: `${up} was dropped`, tone: "bell" };
  if (earlier.state === "merged") return { text: `${up} merged`, tone: "pine" };
  const gate = listGates(db, earlier.projectId, "open").find((g) => g.unitId === earlier.id);
  if (gate) return { text: `${up} waits for you (${gate.question.split("\n")[0]!.slice(0, 80)})`, tone: "bell" };
  if (later.state === "waiting") return { text: `waits for ${up} to merge (now ${earlier.state})`, tone: "amber" };
  return { text: `${up} is ${earlier.state}`, tone: "amber" };
}

export function dependencyEdges(db: Db, unit: Unit): DepEdge[] {
  const edges: DepEdge[] = [];
  for (const d of listDeps(db, unit.projectId)) {
    if (d.unitId !== unit.id && d.dependsOn !== unit.id) continue;
    const later = d.unitId === unit.id ? unit : getUnit(db, d.unitId);
    const earlier = d.dependsOn === unit.id ? unit : getUnit(db, d.dependsOn);
    const other = d.unitId === unit.id ? earlier : later;
    edges.push({
      direction: d.unitId === unit.id ? "needs" : "feeds",
      other: { id: other.id, seq: other.seq, repoId: other.repoId, goal: other.goal, state: other.state },
      state: edgeState(db, later, earlier),
    });
  }
  return edges;
}
