import { TERMINAL_STATES, type DepKind, type Unit, type UnitId, type UnitState } from "./domain.js";
import { listPublications, upstreamArtifact } from "./publish.js";
import { getUnit, listAttempts, listDeps, listGates, type Db } from "./store.js";

export type EdgeTone = "pine" | "amber" | "bell" | "muted";

// One dependency, seen from one unit: it needs `other` (`needs`), or `other` needs it (`feeds`).
export interface DepEdge {
  direction: "needs" | "feeds";
  kind: DepKind;
  other: { id: UnitId; seq: number; repoId: string | null; goal: string; state: UnitState };
  // The test build the consumer was built against, or (for the upstream's own page) its latest test build.
  build: { version: string; repoId: string } | null;
  state: { text: string; tone: EdgeTone };
}

// What the edge is doing now, in words, from the consumer's side.
function edgeState(db: Db, consumer: Unit, upstream: Unit, kind: DepKind): DepEdge["state"] {
  const up = `U${upstream.seq}`;
  if (upstream.state === "abandoned") return { text: `${up} was cancelled`, tone: "muted" };
  if (TERMINAL_STATES.has(upstream.state)) return { text: `${up} landed`, tone: "pine" };
  if (kind === "scope-overlap")
    return ["draft", "ready"].includes(consumer.state)
      ? { text: `waits for ${up}: the same files`, tone: "amber" }
      : { text: `shares files with ${up}`, tone: "muted" };
  const gate = listGates(db, upstream.projectId, "open").find((g) => g.unitId === upstream.id);
  if (["draft", "ready"].includes(consumer.state)) {
    const artifact = upstreamArtifact(db, upstream, consumer.repoId);
    if (artifact && "wait" in artifact) return { text: artifact.wait, tone: "amber" };
    if (artifact && "stuck" in artifact) return { text: artifact.stuck, tone: "bell" };
    return { text: artifact ? `can start: ${up}'s test build is published` : `needs ${up}'s code`, tone: "amber" };
  }
  if (["running", "handed_off", "verifying"].includes(consumer.state)) return { text: `builds on ${up}; lands after ${up} lands`, tone: "amber" };
  if (gate) return { text: `${up} waits for you (${gate.question.split("\n")[0]!.slice(0, 80)})`, tone: "bell" };
  return { text: `waits for ${up} to land (now ${upstream.state})`, tone: "amber" };
}

// The version the consumer's worker was handed for `upstream`, else the upstream's latest published test build.
function buildFor(db: Db, consumer: Unit, upstream: Unit): DepEdge["build"] {
  const repoId = upstream.repoId ?? "";
  for (const a of listAttempts(db, consumer.id).slice().reverse()) {
    const hit = a.sources.find((s) => s.unit === `U${upstream.seq}` && s.version);
    if (hit) return { version: hit.version!, repoId };
  }
  const last = listPublications(db, upstream.id)
    .filter((p) => p.kind === "test" && p.state === "published")
    .at(-1);
  return last?.version ? { version: last.version, repoId } : null;
}

export function dependencyEdges(db: Db, unit: Unit): DepEdge[] {
  const edges: DepEdge[] = [];
  for (const d of listDeps(db, unit.projectId)) {
    if (d.unitId !== unit.id && d.dependsOn !== unit.id) continue;
    const consumer = d.unitId === unit.id ? unit : getUnit(db, d.unitId);
    const upstream = d.dependsOn === unit.id ? unit : getUnit(db, d.dependsOn);
    const other = d.unitId === unit.id ? upstream : consumer;
    edges.push({
      direction: d.unitId === unit.id ? "needs" : "feeds",
      kind: d.kind,
      other: { id: other.id, seq: other.seq, repoId: other.repoId, goal: other.goal, state: other.state },
      build: d.kind === "needs-source" ? buildFor(db, consumer, upstream) : null,
      state: edgeState(db, consumer, upstream, d.kind),
    });
  }
  return edges;
}
