import type { UnitState } from "@yagura/core";

type Pt = readonly [number, number];
export interface Edge {
  key: string;
  d: string;
  mid: Pt;
}

export const MAP_W = 920;
export const MAP_H = 196;
export const NODE: Record<UnitState, Pt> = {
  waiting: [70, 55],
  building: [260, 55],
  judging: [450, 55],
  ready: [640, 55],
  merged: [840, 55],
  stuck: [450, 140],
  dropped: [840, 140],
};
export const MAP_STATES = Object.keys(NODE) as UnitState[];

const quad = (a: Pt, c: Pt, b: Pt): Edge => ({
  key: "",
  d: `M${a[0]},${a[1]} Q${c[0]},${c[1]} ${b[0]},${b[1]}`,
  mid: [(a[0] + 2 * c[0] + b[0]) / 4, (a[1] + 2 * c[1] + b[1]) / 4],
});
const straight = (a: Pt, b: Pt): Edge => ({ key: "", d: `M${a[0]},${a[1]} L${b[0]},${b[1]}`, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
const loop = (a: Pt): Edge => ({
  key: "",
  d: `M${a[0] - 10},${a[1] - 18} C${a[0] - 34},${a[1] - 62} ${a[0] + 34},${a[1] - 62} ${a[0] + 10},${a[1] - 18}`,
  mid: [a[0], a[1] - 51],
});

// The moves a unit normally makes, drawn whether or not this unit made them; any other move is drawn only once it happens.
const DRAWN: Record<string, Edge> = {
  "waiting>building": straight(NODE.waiting, NODE.building),
  "building>judging": quad(NODE.building, [355, 25], NODE.judging),
  "judging>building": quad(NODE.judging, [355, 85], NODE.building),
  "judging>ready": straight(NODE.judging, NODE.ready),
  "ready>building": quad(NODE.ready, [450, -10], NODE.building),
  "ready>merged": straight(NODE.ready, NODE.merged),
  "building>stuck": quad(NODE.building, [300, 130], NODE.stuck),
  "judging>stuck": straight(NODE.judging, NODE.stuck),
  "stuck>building": quad(NODE.stuck, [250, 150], NODE.building),
  "stuck>dropped": straight(NODE.stuck, NODE.dropped),
};
export const BASE_EDGES = Object.keys(DRAWN);

export function edge(from: UnitState, to: UnitState): Edge {
  const key = `${from}>${to}`;
  const known = DRAWN[key];
  if (known) return { ...known, key };
  const a = NODE[from];
  const b = NODE[to];
  if (from === to) return { ...loop(a), key };
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  return { ...quad(a, [(a[0] + b[0]) / 2 - dy * 0.25, (a[1] + b[1]) / 2 + dx * 0.25], b), key };
}

// How many times the unit made each move, keyed `from>to`.
export function moveCounts(moves: readonly { from: UnitState; to: UnitState }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of moves) counts.set(`${m.from}>${m.to}`, (counts.get(`${m.from}>${m.to}`) ?? 0) + 1);
  return counts;
}

// The states the unit has been in; a unit starts out waiting.
export function visited(moves: readonly { from: UnitState; to: UnitState }[]): Set<UnitState> {
  return new Set<UnitState>(["waiting", ...moves.flatMap((m) => [m.from, m.to])]);
}

// One path through every move in order, for a dot to travel the whole story.
export function wholePath(moves: readonly { from: UnitState; to: UnitState }[]): string {
  return moves
    .map((m, i) => {
      const d = edge(m.from, m.to).d;
      return i === 0 ? d : d.replace(/^M[^ QLC]+ ?/, "");
    })
    .join(" ");
}
