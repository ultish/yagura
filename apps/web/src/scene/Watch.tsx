import type { ProjectSummary } from "../api";
import { navigate } from "../api";
import { layoutScene } from "../lib/scene";
import { Pine, SceneDefs, Tower } from "./Tower";

const STARS = [
  [80, 26, 1.2, 0.6], [190, 60, 1, 0.4], [340, 20, 1.4, 0.7], [455, 80, 1, 0.4], [520, 34, 1.1, 0.5], [700, 16, 1.3, 0.6], [760, 64, 1, 0.35],
  [880, 30, 1.2, 0.55], [1050, 52, 1, 0.45], [1240, 80, 1, 0.4], [1330, 36, 1.2, 0.6], [1400, 92, 1, 0.35], [40, 98, 1, 0.35], [610, 92, 1, 0.3],
] as const;
const PINES = [[150, 232, 0.78], [368, 230, 0.64], [735, 224, 0.7], [1110, 220, 0.67], [1390, 226, 0.74]] as const;
const label = { fontFamily: "JetBrains Mono, monospace", fontSize: 11.5 } as const;

export function Watch({ projects, now }: { projects: ProjectSummary[]; now: number }) {
  const { towers, quiet, arcs } = layoutScene(projects, now);
  const aria = towers.length
    ? `Projects as fire-watch towers: ${towers.map((t) => `${t.s.project.id}, ${t.sub}`).join("; ")}`
    : "No projects yet: an empty ridge";
  return (
    <svg viewBox="0 0 1440 286" role="img" aria-label={aria} style={{ display: "block", width: "100%", height: "auto", maxHeight: 320, overflow: "visible" }}>
      <SceneDefs />
      <rect x="-1200" width="3840" height="286" style={{ fill: "var(--bg)" }} />
      <g style={{ fill: "var(--stars)" }}>
        {STARS.map(([x, y, r, o]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={r} opacity={o} />
        ))}
      </g>
      <circle cx="1150" cy="48" r="21" style={{ fill: "var(--moon)" }} opacity=".88" />
      <path d="M-1200 150 L0 168 L120 134 L230 156 L380 114 L520 150 L640 124 L760 154 L900 118 L1040 148 L1170 124 L1300 152 L1440 132 L2640 150 L2640 286 L-1200 286 Z" style={{ fill: "var(--ridge1)" }} />
      <path d="M-1200 196 L0 204 C 180 180 330 194 520 186 S 900 166 1100 182 S 1330 174 1440 186 L2640 196 L2640 286 L-1200 286 Z" style={{ fill: "var(--ridge2)" }} />
      <path d="M-1200 232 L0 236 C 170 220 360 230 560 225 S 940 208 1180 222 S 1380 218 1440 226 L2640 232 L2640 286 L-1200 286 Z" style={{ fill: "var(--ridge3)" }} />
      {PINES.map(([x, y, s]) => (
        <Pine key={x} x={x} y={y} s={s} />
      ))}
      {arcs.map((a) => {
        const x1 = a.from.x;
        const x2 = a.to.x;
        const top = Math.min(a.from.y - 258 * a.from.scale, a.to.y - 258 * a.to.scale);
        return (
          <g key={a.label}>
            <path className="signal" d={`M${x1} ${a.from.y - 170 * a.from.scale} Q ${(x1 + x2) / 2} ${Math.max(6, top - 30)} ${x2} ${a.to.y - 170 * a.to.scale}`} fill="none" style={{ stroke: "var(--lamp)" }} strokeWidth="2" strokeDasharray="3 7" strokeLinecap="round" opacity=".85" />
            <text x={(x1 + x2) / 2} y={Math.max(18, top - 14)} textAnchor="middle" style={{ ...label, fill: "var(--amber-text)" }}>
              {a.label}
            </text>
          </g>
        );
      })}
      {towers.map((t) => (
        <g key={t.s.project.id} role="link" tabIndex={0} aria-label={`${t.s.project.id}: ${t.sub}`} style={{ cursor: "pointer" }} onClick={() => navigate(`/p/${t.s.project.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/p/${t.s.project.id}`)}>
          <Tower x={t.x} y={t.y} scale={t.scale} slots={t.s.maxInFlight} lit={t.s.running} ringing={t.ringing} planner={t.s.planning} dim={t.dim} />
          <text x={t.x} y={t.y + 22} textAnchor="middle" style={{ fill: t.dim ? "var(--label-dim)" : "var(--text)", fontFamily: "Shippori Mincho, serif", fontSize: t.dim ? 15 : 18, fontWeight: 600 }}>
            {t.s.project.id}
          </text>
          <text x={t.x} y={t.y + 39} textAnchor="middle" style={{ ...label, fill: t.ringing ? "var(--bell-text)" : t.dim ? "var(--label-dim)" : "var(--muted)" }}>
            {t.sub}
          </text>
        </g>
      ))}
      {quiet > 0 && (
        <text x="1420" y="276" textAnchor="end" style={{ ...label, fill: "var(--label-dim)" }}>
          +{quiet} quiet
        </text>
      )}
      {!towers.length && (
        <text x="720" y="140" textAnchor="middle" style={{ ...label, fontSize: 13, fill: "var(--muted)" }}>
          No towers yet. Talk to the watch to start a project.
        </text>
      )}
    </svg>
  );
}

export function WatchStrip({ projects, now }: { projects: ProjectSummary[]; now: number }) {
  const { towers } = layoutScene(projects, now);
  return (
    <div role="img" aria-label="Collapsed watch: projects and their lights" style={{ display: "flex", gap: 28, alignItems: "center", padding: "0 36px", height: 44, background: "var(--bg)", borderBottom: "1px solid var(--line)", overflow: "hidden" }}>
      {towers.map((t) => {
        const slots = Math.min(t.s.maxInFlight, 6);
        return (
          <button key={t.s.project.id} type="button" onClick={() => navigate(`/p/${t.s.project.id}`)} style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, padding: 0, cursor: "pointer", color: t.dim ? "var(--label-dim)" : "var(--text)" }}>
            {t.ringing && <span className="bellglow" style={{ width: 9, height: 9, borderRadius: "5px 5px 2px 2px", background: "var(--bell)" }} />}
            {t.s.planning && <span className="pulse" style={{ width: 6, height: 6, borderRadius: 3, background: "var(--lamp)" }} />}
            <span style={{ display: "flex", gap: 2 }}>
              {Array.from({ length: slots }, (_, i) => (
                <span key={i} className={i < t.s.running && !t.dim ? "shoji" : undefined} style={{ width: 6, height: 10, borderRadius: 1, background: i < t.s.running && !t.dim ? "var(--lamp)" : "var(--panel-off)", border: "1px solid var(--shoji-line)" }} />
              ))}
            </span>
            <span className="serif" style={{ fontSize: 14, fontWeight: 600 }}>
              {t.s.project.id}
            </span>
          </button>
        );
      })}
    </div>
  );
}
