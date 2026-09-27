import type { CSSProperties } from "react";

export interface TowerProps {
  x: number;
  y: number;
  scale?: number;
  slots: number;
  lit: number;
  ringing?: boolean;
  planner?: boolean;
  dim?: boolean;
}

const v = (name: string): CSSProperties => ({ stroke: `var(--${name})` });
const f = (name: string): CSSProperties => ({ fill: `var(--${name})` });

export function SceneDefs() {
  return (
    <defs>
      <radialGradient id="yg-lamp">
        <stop offset="0" style={{ stopColor: "var(--lamp)", stopOpacity: 0.42 }} />
        <stop offset="1" style={{ stopColor: "var(--lamp)", stopOpacity: 0 }} />
      </radialGradient>
      <radialGradient id="yg-bell">
        <stop offset="0" style={{ stopColor: "var(--bell)", stopOpacity: 0.62 }} />
        <stop offset="1" style={{ stopColor: "var(--bell)", stopOpacity: 0 }} />
      </radialGradient>
    </defs>
  );
}

export function Tower({ x, y, scale = 1, slots, lit, ringing = false, planner = false, dim = false }: TowerProps) {
  const t = dim ? "timber-dim" : "timber";
  const drawn = Math.min(Math.max(slots, 1), 6);
  const rows = drawn > 3 ? 2 : 1;
  const cols = Math.min(drawn, 3);
  const litDrawn = dim ? 0 : Math.min(lit, drawn);
  const ph = rows === 1 ? 26 : 12;
  const pw = 13;
  const x0 = -(cols * pw + (cols - 1) * 3) / 2;
  const panels = Array.from({ length: drawn }, (_, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    return { px: x0 + col * (pw + 3), py: -218 + row * (ph + 2), on: i < litDrawn };
  });
  const widthAt = (yy: number) => 40 - (-yy * 16) / 168;
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      {litDrawn > 0 && <circle className="breathe" cx="0" cy="-196" r={70 + 12 * litDrawn} fill="url(#yg-lamp)" />}
      {planner && !dim && <circle className="pulse" cx="0" cy="-252" r="34" fill="url(#yg-lamp)" />}
      <path d="M-40 0 L-24 -168 M40 0 L24 -168" style={v(t)} strokeWidth="4" strokeLinecap="round" fill="none" />
      {[-30, -72, -114, -150].map((yy) => (
        <path key={yy} d={`M${-widthAt(yy)} ${yy} L${widthAt(yy)} ${yy}`} style={v(t)} strokeWidth="3.2" strokeLinecap="round" />
      ))}
      {[
        [-30, -72],
        [-72, -114],
        [-114, -150],
      ].map(([a, b]) => (
        <path
          key={a}
          d={`M${-widthAt(a!)} ${a} L${widthAt(b!)} ${b} M${widthAt(a!)} ${a} L${-widthAt(b!)} ${b}`}
          style={v(t)}
          strokeWidth="1.6"
          opacity=".75"
        />
      ))}
      <path d="M-9 0 L-7 -168 M9 0 L7 -168" style={v(t)} strokeWidth="1.8" />
      {Array.from({ length: 12 }, (_, i) => -12 - i * 13).map((yy) => (
        <path key={yy} d={`M-8.5 ${yy} L8.5 ${yy}`} style={v(t)} strokeWidth="1.2" />
      ))}
      <rect x="-34" y="-174" width="68" height="6" style={f(t)} />
      <path d="M-30 -174 L-30 -188 M30 -174 L30 -188 M-30 -184 L30 -184" style={v(t)} strokeWidth="2" />
      <path d="M-26 -186 L-26 -224 M26 -186 L26 -224" style={v(t)} strokeWidth="3" />
      {panels.map((p, i) => (
        <g key={i}>
          <rect
            className={p.on ? "shoji" : undefined}
            style={{
              fill: p.on ? "var(--lamp)" : "var(--panel-off)",
              stroke: p.on ? "#c58a3a" : dim ? "var(--shoji-line-dim)" : "var(--shoji-line)",
              animationDelay: `${-(i * 1.3 + (x % 7) * 0.4)}s`,
            }}
            x={p.px}
            y={p.py}
            width={pw}
            height={ph}
            strokeWidth="1"
          />
          <path
            d={`M${p.px + pw / 2} ${p.py} L${p.px + pw / 2} ${p.py + ph}`}
            style={{ stroke: p.on ? "#b77a2e" : dim ? "var(--shoji-line-dim)" : "var(--shoji-line)" }}
            strokeWidth=".8"
          />
        </g>
      ))}
      <path d="M-48 -224 L-10 -252 L10 -252 L48 -224 Z" style={{ fill: `var(--${dim ? "roof-dim" : "roof"})`, stroke: `var(--${t})` }} strokeWidth="2" />
      <path d="M-50 -224 L50 -224" style={v(t)} strokeWidth="3.2" />
      <path
        d="M-10 -252 L10 -252"
        style={{ stroke: planner && !dim ? "var(--lamp)" : `var(--${t})` }}
        strokeWidth={planner && !dim ? 3.5 : 2.5}
        strokeLinecap="round"
      />
      {planner && !dim && <circle className="pulse" cx="0" cy="-258" r="3.5" style={f("lamp")} />}
      {ringing && !dim && (
        <>
          <circle className="bellglow" cx="0" cy="-238" r="26" fill="url(#yg-bell)" />
          <path
            className="ring"
            d="M-15 -246 Q-20 -238 -15 -230 M15 -246 Q20 -238 15 -230 M-21 -250 Q-28 -238 -21 -226 M21 -250 Q28 -238 21 -226"
            style={v("bell")}
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}
      <g className={ringing && !dim ? "swing" : undefined}>
        <path d="M0 -243 L0 -229" style={v(t)} strokeWidth="1.2" />
        <path d="M-6 -241 Q-6 -246 0 -246 Q6 -246 6 -241 L7 -232 L-7 -232 Z" style={f(ringing && !dim ? "bell" : dim ? "bronze-dim" : "bronze")} />
      </g>
      {slots > 6 && (
        <text x="34" y="-200" style={{ fill: "var(--amber-text)", fontFamily: "JetBrains Mono, monospace", fontSize: 11 }}>
          {lit}/{slots}
        </text>
      )}
    </g>
  );
}

export function Pine({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} style={f("pine-fill")}>
      <path d="M-2 0 L-1 -46 L1 -46 L2 0 Z" />
      <path d="M-26 -30 Q-10 -40 0 -36 Q12 -42 28 -32 Q10 -30 0 -32 Q-12 -28 -26 -30 Z" />
      <path d="M-20 -44 Q-6 -54 2 -50 Q12 -56 24 -46 Q8 -44 0 -46 Q-10 -42 -20 -44 Z" />
      <path d="M-12 -57 Q0 -66 14 -58 Q2 -56 -12 -57 Z" />
    </g>
  );
}

export function Castle({ x, y, name, line1, line2, glow }: { x: number; y: number; name: string; line1: string; line2: string; glow: boolean }) {
  const roof = { fill: "var(--roof)", stroke: "var(--timber)" };
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M-110 330 Q-96 250 -84 200 L84 200 Q96 250 110 330 Z" style={{ fill: "var(--stone)", stroke: "var(--stone-line)" }} strokeWidth="1.5" />
      <path
        d="M-102 300 L102 300 M-97 270 L97 270 M-92 240 L92 240 M-60 200 L-66 330 M-20 200 L-22 330 M20 200 L22 330 M60 200 L66 330"
        style={v("stone-line")}
        strokeWidth="1"
      />
      <rect x="-70" y="120" width="140" height="80" style={f("wall")} />
      {[-58, -24, 8, 42].map((wx, i) => (
        <rect key={wx} x={wx} y="138" width="16" height="12" style={{ fill: glow && i === 1 ? "var(--lamp)" : "#2a2630" }} />
      ))}
      <path d="M-100 124 Q-78 118 -70 106 L-58 96 L58 96 L70 106 Q78 118 100 124 Q60 114 0 114 Q-60 114 -100 124 Z" style={roof} strokeWidth="2" />
      <rect x="-44" y="54" width="88" height="44" style={f("wall")} />
      {[-30, -7, 16].map((wx) => (
        <rect key={wx} x={wx} y="66" width="14" height="11" fill="#2a2630" />
      ))}
      <path d="M-72 58 Q-54 52 -46 40 L-30 26 L30 26 L46 40 Q54 52 72 58 Q40 48 0 48 Q-40 48 -72 58 Z" style={roof} strokeWidth="2" />
      <path d="M-30 26 L30 26 M-36 26 Q-40 18 -34 16 M36 26 Q40 18 34 16" style={v("bronze")} strokeWidth="2" fill="none" />
      <text x="0" y="-8" textAnchor="middle" style={{ fill: "var(--text)", fontFamily: "Shippori Mincho, serif", fontSize: 26, fontWeight: 600 }}>
        {name}
      </text>
      <text x="0" y="360" textAnchor="middle" style={{ fill: "var(--amber)", fontFamily: "JetBrains Mono, monospace", fontSize: 12.5 }}>
        {line1}
      </text>
      <text x="0" y="380" textAnchor="middle" style={{ fill: "var(--muted)", fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>
        {line2}
      </text>
    </g>
  );
}
