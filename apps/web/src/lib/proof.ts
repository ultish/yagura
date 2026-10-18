import type { ProofRow } from "@yagura/core";

export type ProofTone = "muted" | "pine" | "bell";

// One page of the Proof row: how it stands, in the words the page shows, and the judge's run ids behind it.
export function proofLine(row: ProofRow): { tone: ProofTone; text: string; runs: string } {
  const judge = row.runs.filter((r) => r.role === "judge");
  const worker = row.runs.length - judge.length;
  const lines = `${row.lines} line${row.lines === 1 ? "" : "s"}`;
  const ran = [judge.length ? judge.map((r) => `run:${r.id}${r.at === "base" ? " (base)" : ""}`).join(" ") : "", worker ? `${worker} by the worker` : ""]
    .filter(Boolean)
    .join(" · ");
  const runs = [lines, ran].filter(Boolean).join(" · ");
  switch (row.status) {
    case "pending":
      return { tone: "muted", text: "not judged yet", runs };
    case "missing":
      return { tone: "bell", text: "the judge ran nothing for it", runs };
    case "failed":
      return { tone: "bell", text: row.isNew && !row.failsOnBase ? "did not fail on the base" : "the judge's runs do not show it holds", runs };
    case "held":
      return { tone: "pine", text: row.isNew ? "fails on base · passes on head" : "judge ran it · held", runs };
  }
}
