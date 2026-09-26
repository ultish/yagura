TIMBER = "#8a7160"
TIMBER_DIM = "#4d4452"
AMBER = "#f0a94a"
BELL = "#e5553a"
BRONZE = "#a88a5c"

def tower(x, y, scale=1.0, lit=0, slots=3, ringing=False, planner=False, dim=False, name="", sub=""):
    t = TIMBER_DIM if dim else TIMBER
    panel_off = "#1a1722"
    out = [f'<g transform="translate({x} {y}) scale({scale})">']
    if lit and not dim:
        out.append(f'<circle class="breathe" cx="0" cy="-196" r="{70 + 12 * lit}" fill="url(#lamp)"/>')
    if planner and not dim:
        out.append('<circle class="pulse" cx="0" cy="-252" r="34" fill="url(#lamp)"/>')
    out.append(f'<path d="M-40 0 L-24 -168 M40 0 L24 -168" stroke="{t}" stroke-width="4" stroke-linecap="round" fill="none"/>')
    for yy in (-30, -72, -114, -150):
        w = 40 - (-yy) * 16 / 168
        out.append(f'<path d="M{-w:.1f} {yy} L{w:.1f} {yy}" stroke="{t}" stroke-width="3.2" stroke-linecap="round"/>')
    for (y1, y2) in ((-30, -72), (-72, -114), (-114, -150)):
        w1 = 40 - (-y1) * 16 / 168
        w2 = 40 - (-y2) * 16 / 168
        out.append(f'<path d="M{-w1:.1f} {y1} L{w2:.1f} {y2} M{w1:.1f} {y1} L{-w2:.1f} {y2}" stroke="{t}" stroke-width="1.6" opacity=".75"/>')
    out.append(f'<path d="M-9 0 L-7 -168 M9 0 L7 -168" stroke="{t}" stroke-width="1.8"/>')
    for yy in range(-12, -168, -13):
        out.append(f'<path d="M-8.5 {yy} L8.5 {yy}" stroke="{t}" stroke-width="1.2"/>')
    out.append(f'<rect x="-34" y="-174" width="68" height="6" fill="{t}"/>')
    out.append(f'<path d="M-30 -174 L-30 -188 M30 -174 L30 -188 M-30 -184 L30 -184" stroke="{t}" stroke-width="2"/>')
    out.append(f'<path d="M-26 -186 L-26 -224 M26 -186 L26 -224" stroke="{t}" stroke-width="3"/>')
    pw, gap, x0 = 13, 3, -((slots * 13 + (slots - 1) * 3) / 2)
    for i in range(slots):
        px = x0 + i * (pw + gap)
        on = i < lit and not dim
        fill = AMBER if on else panel_off
        stroke = "#c58a3a" if on else ("#3b3542" if not dim else "#2c2833")
        anim = f' class="shoji" style="animation-delay: {-(i * 1.3 + x % 7 * .4):.1f}s"' if on else ''
        out.append(f'<rect{anim} x="{px:.1f}" y="-218" width="{pw}" height="26" fill="{fill}" stroke="{stroke}" stroke-width="1"/>')
        out.append(f'<path d="M{px + pw/2:.1f} -218 L{px + pw/2:.1f} -192 M{px:.1f} -209 L{px + pw:.1f} -209 M{px:.1f} -200 L{px + pw:.1f} -200" stroke="{"#b77a2e" if on else stroke}" stroke-width=".8"/>')
    roof = "#2b2533" if not dim else "#1e1c26"
    out.append(f'<path d="M-52 -222 Q-36 -224 -26 -236 L-10 -252 L10 -252 L26 -236 Q36 -224 52 -222 Q30 -229 0 -229 Q-30 -229 -52 -222 Z" fill="{roof}" stroke="{t}" stroke-width="2" stroke-linejoin="round"/>')
    out.append(f'<path d="M-10 -252 L10 -252" stroke="{AMBER if planner and not dim else t}" stroke-width="{3.5 if planner and not dim else 2.5}" stroke-linecap="round"/>')
    if planner and not dim:
        out.append(f'<circle class="pulse" cx="0" cy="-258" r="3.5" fill="{AMBER}"/>')
    bell_c = BRONZE if not dim else "#5a5048"
    if ringing and not dim:
        out.append(f'<circle class="bellglow" cx="0" cy="-238" r="26" fill="url(#bell)"/>')
        out.append(f'<path class="ring" d="M-15 -246 Q-20 -238 -15 -230 M15 -246 Q20 -238 15 -230 M-21 -250 Q-28 -238 -21 -226 M21 -250 Q28 -238 21 -226" stroke="{BELL}" stroke-width="1.6" fill="none" stroke-linecap="round"/>')
    swing = ' class="swing"' if ringing and not dim else ''
    out.append(f'<g{swing}><path d="M0 -243 L0 -229" stroke="{t}" stroke-width="1.2"/>')
    out.append(f'<path d="M-6 -241 Q-6 -246 0 -246 Q6 -246 6 -241 L7 -232 L-7 -232 Z" fill="{BELL if ringing and not dim else bell_c}"/></g>')
    out.append('</g>')
    if name:
        color = "#8f93a6" if dim else "#ece6da"
        muted = "#8f93a6" if dim else "#a3a7b8"
        out.append(f'<g transform="translate({x} {y})"><text x="0" y="22" text-anchor="middle" fill="{color}" style="font-family: \'Shippori Mincho\', serif; font-size: {15 if dim else 18}px; font-weight: 600">{name}</text>')
        out.append(f'<text x="0" y="39" text-anchor="middle" fill="{muted}" style="font-family: \'JetBrains Mono\', monospace; font-size: 11.5px">{sub}</text></g>')
    return "\n".join(out)

def pine(x, y, s=1.0, fill="#141828"):
    return (f'<g transform="translate({x} {y}) scale({s})" fill="{fill}">'
            '<path d="M-2 0 L-1 -46 L1 -46 L2 0 Z"/>'
            '<path d="M-26 -30 Q-10 -40 0 -36 Q12 -42 28 -32 Q10 -30 0 -32 Q-12 -28 -26 -30 Z"/>'
            '<path d="M-20 -44 Q-6 -54 2 -50 Q12 -56 24 -46 Q8 -44 0 -46 Q-10 -42 -20 -44 Z"/>'
            '<path d="M-12 -57 Q0 -66 14 -58 Q2 -56 -12 -57 Z"/></g>')

def castle(x, y, name, sha, landed, glow=True):
    wall = "#c9c2b2"
    roof = "#2b2533"
    stone = "#3a3a4a"
    return f'''<g transform="translate({x} {y})">
  <path d="M-110 330 Q-96 250 -84 200 L84 200 Q96 250 110 330 Z" fill="{stone}" stroke="#56566a" stroke-width="1.5"/>
  <path d="M-102 300 L102 300 M-97 270 L97 270 M-92 240 L92 240 M-60 200 L-66 330 M-20 200 L-22 330 M20 200 L22 330 M60 200 L66 330" stroke="#4c4c60" stroke-width="1"/>
  <rect x="-70" y="120" width="140" height="80" fill="{wall}"/>
  <rect x="-58" y="138" width="16" height="12" fill="#2a2630"/><rect x="-24" y="138" width="16" height="12" fill="{"#f0a94a" if glow else "#2a2630"}"/><rect x="8" y="138" width="16" height="12" fill="#2a2630"/><rect x="42" y="138" width="16" height="12" fill="#2a2630"/>
  <path d="M-100 124 Q-78 118 -70 106 L-58 96 L58 96 L70 106 Q78 118 100 124 Q60 114 0 114 Q-60 114 -100 124 Z" fill="{roof}" stroke="#8a7160" stroke-width="2"/>
  <rect x="-44" y="54" width="88" height="44" fill="{wall}"/>
  <rect x="-30" y="66" width="14" height="11" fill="#2a2630"/><rect x="-7" y="66" width="14" height="11" fill="#2a2630"/><rect x="16" y="66" width="14" height="11" fill="#2a2630"/>
  <path d="M-72 58 Q-54 52 -46 40 L-30 26 L30 26 L46 40 Q54 52 72 58 Q40 48 0 48 Q-40 48 -72 58 Z" fill="{roof}" stroke="#8a7160" stroke-width="2"/>
  <path d="M-30 26 L30 26 M-36 26 Q-40 18 -34 16 M36 26 Q40 18 34 16" stroke="#a88a5c" stroke-width="2" fill="none"/>
  <text x="0" y="-8" text-anchor="middle" fill="#ece6da" style="font-family: 'Shippori Mincho', serif; font-size: 26px; font-weight: 600">{name}</text>
  <text x="0" y="360" text-anchor="middle" fill="#f0a94a" style="font-family: 'JetBrains Mono', monospace; font-size: 12.5px">{sha}</text>
  <text x="0" y="380" text-anchor="middle" fill="#a3a7b8" style="font-family: 'JetBrains Mono', monospace; font-size: 12px">{landed}</text>
</g>'''
