import type { Db } from "./store.js";

export interface CostSummary {
  total: number;
  today: number;
  week: number;
  // Where the total went: planner, worker, judge and lead sessions; the watchman's conversation turns; the doctor's runs.
  agents: number;
  watchman: number;
  doctor: number;
}

// Every session yagura has paid for, in the three places that record a cost. A project's own cost counts only its agents; this counts all of it.
const TABLES = [
  ["agents", "attempts"],
  ["watchman", "watchman_turns"],
  ["doctor", "doctor_runs"],
] as const;

export function costSummary(db: Db, at = new Date()): CostSummary {
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const weekStart = new Date(midnight.getTime() - 6 * 86_400_000);
  const sum = (table: string, since?: Date) =>
    (
      db
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM ${table} ${since ? "WHERE started_at >= ?" : ""}`)
        .get(...(since ? [since.toISOString()] : [])) as {
        usd: number;
      }
    ).usd;
  const by = Object.fromEntries(TABLES.map(([k, t]) => [k, sum(t)])) as Record<(typeof TABLES)[number][0], number>;
  const over = (since: Date) => TABLES.reduce((n, [, t]) => n + sum(t, since), 0);
  const cents = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    total: cents(by.agents + by.watchman + by.doctor),
    today: cents(over(midnight)),
    week: cents(over(weekStart)),
    agents: cents(by.agents),
    watchman: cents(by.watchman),
    doctor: cents(by.doctor),
  };
}
