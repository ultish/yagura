import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { UnitState } from "@yagura/core";
import { BASE_EDGES, MAP_H, MAP_STATES, MAP_W, NODE, edge, moveCounts, visited, wholePath } from "../lib/statemap";

type Move = { from: UnitState; to: UnitState };
const TONE: Record<string, string> = { bell: "var(--bell)", lamp: "var(--amber)", pine: "var(--pine)", muted: "var(--faint)" };
const SECONDS_PER_MOVE = 0.8;

// The unit's whole state machine, with every move it made lit. Nothing moves on its own: the current state pulses only
// while an agent works, a move seen live travels once, and Play replays the whole path once.
export function StateMap({
  moves,
  state,
  tone,
  working,
  label,
  picked,
  onPick,
}: {
  moves: Move[];
  state: UnitState;
  tone: string;
  working: boolean;
  label: string | null;
  picked: UnitState | null;
  onPick: (s: UnitState) => void;
}) {
  const seen = useRef(moves.length);
  const [trip, setTrip] = useState<{ key: number; d: string; seconds: number } | null>(null);
  useEffect(() => {
    if (moves.length > seen.current) {
      const fresh = moves.slice(seen.current);
      setTrip((t) => ({ key: (t?.key ?? 0) + 1, d: wholePath(fresh), seconds: Math.max(1.4, fresh.length * SECONDS_PER_MOVE) }));
    }
    seen.current = moves.length;
  }, [moves]);
  const play = () => setTrip((t) => ({ key: (t?.key ?? 0) + 1, d: wholePath(moves), seconds: Math.min(8, Math.max(1.4, moves.length * SECONDS_PER_MOVE)) }));

  const counts = moveCounts(moves);
  const been = visited(moves);
  const keys = [...new Set([...BASE_EDGES, ...counts.keys()])];
  const colour = TONE[tone] ?? TONE.lamp;
  const key = (s: UnitState) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(s);
    }
  };
  return (
    <div className="statemap">
      <div className="statemap-bar">
        <button type="button" className="btn sm" onClick={play} disabled={!moves.length} aria-label="Play the unit's path from the start">
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 1 L11 6 L2 11 Z" fill="var(--amber)" />
          </svg>
          Play from the start
        </button>
        <span className="muted statemap-hint">Click a state to pick out its entries in the timeline.</span>
      </div>
      <div className="statemap-scroll">
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="group" aria-label="The states this unit moved through" className="statemap-svg">
          {keys.map((k) => {
            const [from, to] = k.split(">") as [UnitState, UnitState];
            const e = edge(from, to);
            const n = counts.get(k) ?? 0;
            return (
              <g key={k}>
                <path d={e.d} className={n ? "statemap-edge lit" : "statemap-edge"} />
                {n > 1 && (
                  <text x={e.mid[0]} y={e.mid[1] - 6} textAnchor="middle" className="statemap-count mono">
                    ×{n}
                  </text>
                )}
              </g>
            );
          })}
          {MAP_STATES.map((s) => {
            const [x, y] = NODE[s];
            const now = s === state;
            return (
              <g
                key={s}
                role="button"
                tabIndex={0}
                aria-pressed={picked === s}
                aria-label={`${s}${now ? ", now" : been.has(s) ? "" : ", not reached"}`}
                className="statemap-node"
                onClick={() => onPick(s)}
                onKeyDown={key(s)}
              >
                <circle cx={x} cy={y} r={22} className={picked === s ? "statemap-pick on" : "statemap-pick"} />
                {now && <circle cx={x} cy={y} r={20} fill={colour} opacity={0.16} />}
                {now && working && <circle cx={x} cy={y} r={12} fill="none" stroke={colour} strokeWidth={2} className="statemap-pulse" />}
                <circle
                  cx={x}
                  cy={y}
                  r={now ? 12 : 8}
                  className={now ? undefined : been.has(s) ? "statemap-dot been" : "statemap-dot"}
                  style={now ? { fill: colour, stroke: colour } : undefined}
                />
                <text x={x} y={y + 30} textAnchor="middle" className={now || been.has(s) ? "statemap-name been mono" : "statemap-name mono"}>
                  {s}
                </text>
                {now && label && (
                  <text x={x} y={y + 47} textAnchor="middle" className="statemap-label mono">
                    {label}
                  </text>
                )}
              </g>
            );
          })}
          {trip && (
            <circle
              key={trip.key}
              r={6}
              className="statemap-trip"
              style={{ offsetPath: `path('${trip.d}')`, animationDuration: `${trip.seconds}s` }}
              onAnimationEnd={() => setTrip(null)}
            />
          )}
        </svg>
      </div>
    </div>
  );
}
