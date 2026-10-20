interface Groupable {
  key: string;
  title: string;
  help: string;
  example?: string;
  group: string;
  advanced?: true;
}

export function filterSettings<T extends Groupable>(settings: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return settings;
  return settings.filter((s) => {
    const hay = `${s.title} ${s.help} ${s.key} ${s.example ?? ""} ${s.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// Groups keep the order the settings arrive in, which the server sorts by group.
export function groupSettings<T extends Groupable>(settings: T[]): { title: string; main: T[]; advanced: T[] }[] {
  const out: { title: string; main: T[]; advanced: T[] }[] = [];
  for (const s of settings) {
    let g = out.find((x) => x.title === s.group);
    if (!g) out.push((g = { title: s.group, main: [], advanced: [] }));
    (s.advanced ? g.advanced : g.main).push(s);
  }
  return out;
}
