import type { Attempt, FailureMode, ProjectId, Unit } from "./domain.js";
import { listDeps, listUnits, type Db } from "./store.js";

const TERMINAL = new Set(["landed", "done", "abandoned"]);
const SATISFIES_DEP = new Set(["landed", "done"]);

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
    if (u.state !== "ready" || (u.type !== "work" && u.type !== "verify")) continue;
    if (u.type === "verify") {
      result.ready.push(u);
      continue;
    }
    let reason: string | null = null;
    for (const d of deps.filter((x) => x.unitId === u.id)) {
      const on = byId.get(d.dependsOn)!;
      if (d.kind === "scope-overlap" ? TERMINAL.has(on.state) : SATISFIES_DEP.has(on.state)) continue;
      if (d.kind !== "scope-overlap" && on.state === "abandoned") {
        result.stuck.push({ unit: u, reason: `depends on U${on.seq}, which was abandoned` });
        reason = null;
        break;
      }
      reason = `waiting for U${on.seq} (${d.kind}, now ${on.state})`;
      break;
    }
    if (result.stuck.some((s) => s.unit.id === u.id)) continue;
    if (reason) result.waiting.push({ unit: u, reason });
    else result.ready.push(u);
  }
  result.ready.sort((a, b) => (a.type === "verify" ? 0 : 1) - (b.type === "verify" ? 0 : 1) || a.seq - b.seq);
  return result;
}

const RETRYABLE: ReadonlySet<FailureMode> = new Set(["network", "tool-error", "harness-error", "unknown", "scope"]);
const NEEDS_SPLIT: ReadonlySet<FailureMode> = new Set(["timebox", "context-exhausted", "oom"]);

export function failurePolicy(unit: Unit, allAttempts: Attempt[]): { action: "retry" | "block"; reason: string } {
  const attempts = allAttempts.filter((a) => a.state !== "stopped");
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
