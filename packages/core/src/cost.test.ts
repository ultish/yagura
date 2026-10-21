import { describe, expect, it } from "vitest";
import { costSummary } from "./cost.js";
import { openStore, type Db } from "./store.js";

const iso = (d: Date) => d.toISOString();

function fixture(db: Db, at: Date) {
  const day = (n: number) => iso(new Date(at.getFullYear(), at.getMonth(), at.getDate() - n, 12));
  let n = 0;
  const insert = (table: string, cost: number, startedAt: string) => {
    n += 1;
    if (table === "attempts")
      db.prepare("INSERT INTO attempts (unit_id, n, harness, cost_usd, started_at) VALUES (1, ?, 'claude', ?, ?)").run(n, cost, startedAt);
    else if (table === "watchman_turns")
      db.prepare("INSERT INTO watchman_turns (thread_id, message_id, log_path, cost_usd, started_at) VALUES (1, 1, 'x', ?, ?)").run(cost, startedAt);
    else
      db.prepare(
        "INSERT INTO doctor_runs (environment_id, repo_id, trigger, harness, log_path, cost_usd, started_at) VALUES ('e', 'r', 'setup', 'claude', 'x', ?, ?)",
      ).run(cost, startedAt);
  };
  return { day, insert };
}

describe("costSummary", () => {
  it("is zero on an empty home", () => {
    expect(costSummary(openStore(":memory:"))).toEqual({ total: 0, today: 0, week: 0, agents: 0, watchman: 0, doctor: 0 });
  });

  it("adds up agents, the watchman and the doctor, by day", () => {
    const db = openStore(":memory:");
    db.pragma("foreign_keys = OFF");
    const at = new Date(2026, 9, 21, 15);
    const { day, insert } = fixture(db, at);
    insert("attempts", 1.5, day(0));
    insert("attempts", 2, day(3));
    insert("attempts", 4, day(20));
    insert("watchman_turns", 0.25, day(0));
    insert("doctor_runs", 0.1, day(10));
    const c = costSummary(db, at);
    expect(c.agents).toBeCloseTo(7.5);
    expect(c.watchman).toBeCloseTo(0.25);
    expect(c.doctor).toBeCloseTo(0.1);
    expect(c.total).toBeCloseTo(7.85);
    expect(c.today).toBeCloseTo(1.75);
    expect(c.week).toBeCloseTo(3.75);
  });
});
