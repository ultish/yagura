import type { ProjectDetail, UnitView } from "../api";
import { navigate } from "../api";
import { sha } from "../lib/format";
import { type Light, type Stage, isBuild, stages } from "../lib/units";
import { Castle, SceneDefs } from "./Tower";

const XS = { plan: 456, work: 636, verify: 816, land: 996 } as const;
const ROW = 56;
const TOP = 80;
const mono = { fontFamily: "JetBrains Mono, monospace", fontSize: 12 } as const;

function Beacon({ x, y, stage }: { x: number; y: number; stage: Stage }) {
  const text = (fill: string) =>
    stage.label ? (
      <text x={x + 20} y={y + 5} style={{ ...mono, fill }}>
        {stage.label}
      </text>
    ) : null;
  switch (stage.light) {
    case "lit":
      return (
        <g>
          <circle cx={x} cy={y} r="16" fill="url(#yg-lamp)" />
          <circle cx={x} cy={y} r="6.5" style={{ fill: "var(--lamp)" }} />
        </g>
      );
    case "flame":
      return (
        <g>
          <circle className="breathe" cx={x} cy={y} r="30" fill="url(#yg-lamp)" />
          <circle cx={x} cy={y} r="14" fill="none" style={{ stroke: "var(--lamp)" }} strokeOpacity=".5" />
          <circle className="flame" cx={x} cy={y} r="8.5" style={{ fill: "var(--lamp)" }} />
          {text("var(--amber-text)")}
        </g>
      );
    case "bell":
      return (
        <g>
          <circle className="bellglow" cx={x} cy={y} r="30" fill="url(#yg-bell)" />
          <g className="swing">
            <path d={`M${x} ${y - 19} L${x} ${y - 11}`} style={{ stroke: "var(--timber)" }} strokeWidth="1.2" />
            <path d={`M${x - 8} ${y + 7} Q${x} ${y - 15} ${x + 8} ${y + 7} L${x + 11} ${y + 11} L${x - 11} ${y + 11} Z`} style={{ fill: "var(--bell)" }} />
          </g>
          {text("var(--bell-text)")}
        </g>
      );
    case "ember":
      return (
        <g>
          <circle className="ember" cx={x} cy={y} r="18" fill="url(#yg-bell)" />
          <circle className="ember" cx={x} cy={y} r="6.5" style={{ fill: "var(--bell-text)" }} />
          {text("var(--bell-text)")}
        </g>
      );
    case "wait":
      return (
        <g>
          <circle cx={x} cy={y} r="6.5" style={{ fill: "var(--beacon-off)", stroke: "var(--lamp)" }} strokeWidth="1.5" strokeDasharray="2 3" />
          {text("var(--muted)")}
        </g>
      );
    default:
      return <circle cx={x} cy={y} r="6.5" style={{ fill: "var(--beacon-off)", stroke: "var(--beacon-off-line)" }} strokeWidth="1.5" />;
  }
}

const reached = (l: Light) => l === "lit" || l === "flame" || l === "bell";

export function visibleUnits(d: ProjectDetail): UnitView[] {
  const work = d.units.filter((u) => isBuild(u) && u.state !== "abandoned");
  const landed = work.filter((u) => u.state === "landed" || u.state === "done");
  const rest = work.filter((u) => u.state !== "landed" && u.state !== "done");
  return [...landed.slice(-4), ...rest];
}

export function Beacons({ d, now }: { d: ProjectDetail; now: number }) {
  const units = visibleUnits(d);
  const height = Math.max(440, TOP + units.length * ROW + 40);
  const rowY = new Map(units.map((u, i) => [u.id, TOP - 5 + i * ROW]));
  const castleY = height - 408;
  const landedEarlier =
    d.units.filter((u) => isBuild(u) && (u.state === "landed" || u.state === "done")).length -
    units.filter((u) => u.state === "landed" || u.state === "done").length;
  return (
    <svg
      viewBox={`0 0 1440 ${height}`}
      role="img"
      aria-label={`Beacon chains for ${units.length} units from plan to work, verify and land, ending at the ${d.repos[0]?.defaultBranch ?? "main"} keep`}
      style={{ display: "block", width: "100%", height: "auto" }}
    >
      <SceneDefs />
      <path
        d={`M0 ${height - 30} C 260 ${height - 48} 520 ${height - 36} 780 ${height - 44} S 1200 ${height - 54} 1440 ${height - 42} L1440 ${height} L0 ${height} Z`}
        style={{ fill: "var(--ridge2)" }}
      />
      <g style={{ ...mono, fill: "var(--muted)" }} textAnchor="middle">
        {Object.entries(XS).map(([name, x]) => (
          <text key={name} x={x} y="36">
            {name}
          </text>
        ))}
      </g>
      <Castle
        x={1240}
        y={castleY}
        name={d.repos[0]?.defaultBranch ?? "main"}
        line1={d.lastLanded ? `${sha(d.lastLanded.sha)} · U${d.lastLanded.seq}` : "nothing landed yet"}
        line2={d.repos.map((r) => r.id).join(", ")}
        glow={!!d.lastLanded}
      />
      {landedEarlier > 0 && (
        <text x="36" y="44" style={{ ...mono, fill: "var(--muted)" }}>
          +{landedEarlier} landed earlier
        </text>
      )}
      {units.map((u) => {
        const y = rowY.get(u.id)!;
        const st = stages(d, u, now);
        const xs = st.map((s) => XS[s.name]);
        const lastReached = st.reduce((acc, s, i) => (reached(s.light) ? i : acc), 0);
        const ember = st.findIndex((s) => s.light === "ember");
        const landed = u.state === "landed" || u.state === "done";
        return (
          <g key={u.id}>
            <g
              role="link"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              onClick={() => navigate(`/p/${d.project.id}/u/${u.seq}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/p/${d.project.id}/u/${u.seq}`)}
            >
              <text x="36" y={y + 5} style={{ fontFamily: "Zen Kaku Gothic New, sans-serif", fontSize: 15, fill: "var(--text)" }}>
                <tspan style={{ ...mono, fontSize: 12.5, fill: "var(--muted)" }}>U{u.seq} </tspan>
                {u.goal.length > 44 ? `${u.goal.slice(0, 43)}…` : u.goal}
              </text>
            </g>
            <path d={`M${xs[0]} ${y} L${landed ? 1166 : xs[lastReached]} ${y}`} style={{ stroke: "var(--seg-lit)" }} strokeWidth="2.5" />
            {ember > 0 && <path d={`M${xs[ember - 1]} ${y} L${xs[ember]} ${y}`} style={{ stroke: "var(--seg-ember)" }} strokeWidth="2.5" />}
            {!landed && <path d={`M${xs[Math.max(lastReached, ember)]} ${y} L${xs[3]} ${y}`} style={{ stroke: "var(--seg-dark)" }} strokeWidth="2.5" />}
            {st.map((s) => (
              <Beacon key={s.name} x={XS[s.name]} y={y} stage={s} />
            ))}
          </g>
        );
      })}
      {d.deps
        .filter((dep) => dep.kind !== "scope-overlap" && d.waiting.some((w) => w.unitId === dep.unitId))
        .map((dep) => {
          const y1 = rowY.get(dep.unitId as never);
          const y2 = rowY.get(dep.dependsOn as never);
          if (y1 === undefined || y2 === undefined) return null;
          const a = d.units.find((u) => u.id === dep.unitId)!;
          const b = d.units.find((u) => u.id === dep.dependsOn)!;
          return (
            <g key={`${dep.unitId}-${dep.dependsOn}`}>
              <path
                className="signal"
                d={`M${XS.plan + 6} ${y1 - 4} C ${XS.plan + 100} ${y1 - 30} ${XS.land - 90} ${y2 + 40} ${XS.land - 6} ${y2 + 6}`}
                fill="none"
                style={{ stroke: "var(--lamp)" }}
                strokeWidth="1.5"
                strokeDasharray="3 7"
                opacity=".8"
              />
              <text x={(XS.plan + XS.land) / 2} y={(y1 + y2) / 2 + 4} textAnchor="middle" style={{ ...mono, fontSize: 11.5, fill: "var(--amber-text)" }}>
                U{a.seq} waits for U{b.seq} to land
              </text>
            </g>
          );
        })}
    </svg>
  );
}
