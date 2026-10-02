export interface FindHit {
  kind: string;
  ref: string;
  href: string;
  title: string;
  meta: string;
  text: string;
}

export interface FindResult {
  query: string;
  total: number;
  counts: Record<string, number>;
  hits: FindHit[];
}

export const KIND_ORDER = ["unit", "project", "decision", "question", "review", "message", "handoff", "repo"] as const;
export const KIND_LABEL: Record<string, string> = {
  unit: "Units",
  project: "Projects",
  decision: "Decisions",
  question: "Questions",
  review: "Review threads",
  message: "Conversations",
  handoff: "Handoffs",
  repo: "Repos",
};

export interface HitGroup {
  kind: string;
  label: string;
  count: number;
  hits: FindHit[];
}

export function groupHits(r: FindResult): HitGroup[] {
  return KIND_ORDER.filter((k) => r.counts[k]).map((k) => ({ kind: k, label: KIND_LABEL[k]!, count: r.counts[k]!, hits: r.hits.filter((h) => h.kind === k) }));
}

// Splits text into plain and matched pieces, every word of the query, case-insensitive.
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const words = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return [{ text, match: false }];
  const whole = new RegExp(`^(?:${words.join("|")})$`, "i");
  return text
    .split(new RegExp(`(${words.join("|")})`, "i"))
    .filter((p) => p !== "")
    .map((p) => ({ text: p, match: whole.test(p) }));
}
