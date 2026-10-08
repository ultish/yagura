import { isBuild, spendsAttempt, type Attempt, type FailureMode, type ProjectId, type Unit } from "./domain.js";
import { listUnits, type Db } from "./store.js";

export interface Readiness {
  ready: Unit[];
  waiting: { unit: Unit; reason: string }[];
  stuck: { unit: Unit; reason: string }[];
}

// A waiting unit is ready once every unit it comes after has merged; one that comes after a dropped unit can never start.
export function readiness(db: Db, projectId: ProjectId): Readiness {
  const units = listUnits(db, projectId);
  const byId = new Map(units.map((u) => [u.id, u]));
  const result: Readiness = { ready: [], waiting: [], stuck: [] };
  for (const u of units) {
    if (u.state !== "waiting" || !isBuild(u)) continue;
    const open = u.after.map((id) => byId.get(id)!).filter((on) => on.state !== "merged");
    const dropped = open.find((on) => on.state === "dropped");
    if (dropped) result.stuck.push({ unit: u, reason: `comes after U${dropped.seq}, which was dropped` });
    else if (open.length) result.waiting.push({ unit: u, reason: `waiting for U${open[0]!.seq} to merge (now ${open[0]!.state})` });
    else result.ready.push(u);
  }
  result.ready.sort((a, b) => a.seq - b.seq);
  return result;
}

const RETRYABLE: ReadonlySet<FailureMode> = new Set(["network", "tool-error", "harness-error", "unknown"]);
const NEEDS_SPLIT: ReadonlySet<FailureMode> = new Set(["timebox", "context-exhausted", "oom"]);

export function failurePolicy(unit: Unit, allAttempts: Attempt[]): { action: "retry" | "block"; reason: string } {
  const attempts = allAttempts.filter(spendsAttempt);
  const last = attempts.at(-1);
  const mode = last?.failureMode ?? "unknown";
  if (attempts.length >= unit.maxAttempts) return { action: "block", reason: `used ${attempts.length} of ${unit.maxAttempts} attempts (last: ${mode})` };
  if (NEEDS_SPLIT.has(mode)) return { action: "block", reason: `${mode}: the unit is probably too large; the planner should split or narrow it` };
  if (RETRYABLE.has(mode)) return { action: "retry", reason: `${mode}: retrying with a fresh attempt` };
  return { action: "block", reason: `${mode}` };
}

export function runningAttempts(db: Db, filter: { projectId?: ProjectId; harness?: string } = {}): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts a JOIN units u ON u.id = a.unit_id
         WHERE a.state = 'running' AND (? IS NULL OR u.project_id = ?) AND (? IS NULL OR a.harness = ?)`,
      )
      .get(filter.projectId ?? null, filter.projectId ?? null, filter.harness ?? null, filter.harness ?? null) as { n: number }
  ).n;
}
