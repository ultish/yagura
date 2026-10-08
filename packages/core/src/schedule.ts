import { TERMINAL_STATES, isBuild, spendsAttempt, type Attempt, type FailureMode, type ProjectId, type Unit } from "./domain.js";
import { listDeps, listUnits, type Db } from "./store.js";

const SATISFIES_DEP = new Set(["landed", "done"]);
// A needs-source consumer builds against the upstream's verified head, so it can start before that lands.
const SATISFIES_SOURCE = new Set(["verified", "landing", "landed", "done"]);

export interface Readiness {
  ready: Unit[];
  waiting: { unit: Unit; reason: string }[];
  stuck: { unit: Unit; reason: string }[];
}

export function readiness(db: Db, projectId: ProjectId): Readiness {
  const units = listUnits(db, projectId);
  const byId = new Map(units.map((u) => [u.id, u]));
  const deps = listDeps(db, projectId);
  const result: Readiness = { ready: [], waiting: [], stuck: [] };
  for (const u of units) {
    if (u.state !== "ready" || (!isBuild(u) && u.type !== "manager")) continue;
    let reason: string | null = null;
    for (const d of deps.filter((x) => x.unitId === u.id)) {
      const on = byId.get(d.dependsOn)!;
      const met = d.kind === "scope-overlap" ? TERMINAL_STATES.has(on.state) : (d.kind === "needs-source" ? SATISFIES_SOURCE : SATISFIES_DEP).has(on.state);
      if (met) continue;
      if (d.kind !== "scope-overlap" && on.state === "abandoned") {
        result.stuck.push({ unit: u, reason: `depends on U${on.seq}, which was abandoned` });
        reason = null;
        break;
      }
      reason =
        d.kind === "scope-overlap"
          ? `waiting for U${on.seq} to finish: it writes some of the same files, so they run one after the other (now ${on.state})`
          : `waiting for U${on.seq} (${d.kind}, now ${on.state})`;
      break;
    }
    if (result.stuck.some((s) => s.unit.id === u.id)) continue;
    if (reason) result.waiting.push({ unit: u, reason });
    else result.ready.push(u);
  }
  result.ready.sort((a, b) => a.seq - b.seq);
  return result;
}

const RETRYABLE: ReadonlySet<FailureMode> = new Set(["network", "tool-error", "harness-error", "unknown", "scope"]);
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
