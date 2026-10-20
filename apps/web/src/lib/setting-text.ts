export function settingShown(value: unknown, lines = false): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.join(lines ? "\n" : " ");
  return String(value);
}

// A list is typed as names separated by spaces, commas, or both; a list whose entries hold spaces is typed one per line.
export function settingParsed(fallback: unknown, text: string, lines = false): unknown {
  const t = text.trim();
  if (typeof fallback === "number") return t === "" ? null : Number(t);
  if (typeof fallback === "boolean") return t === "true";
  if (Array.isArray(fallback)) return (lines ? t.split("\n").map((l) => l.trim()) : t.split(/[\s,]+/)).filter(Boolean);
  return t === "" && fallback === null ? null : t;
}
