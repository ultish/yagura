import { now, recordEvent, type Db } from "./store.js";

// A refusal that does not say when the window resets (an API key's rate limit, a gateway's) is tried again after this long.
export const LIMIT_FALLBACK_MS = 15 * 60_000;

export interface UsageHold {
  harness: string;
  until: string;
  reason: string;
  since: string;
}

export function limitUntil(resetsAt: string | null, at = Date.now()): string {
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  return new Date(reset > at ? reset : at + LIMIT_FALLBACK_MS).toISOString();
}

export function activeHold(db: Db, harness?: string): UsageHold | null {
  const row = db
    .prepare("SELECT harness, until, reason, since FROM usage_holds WHERE (? IS NULL OR harness = ?) AND until > ? ORDER BY until DESC LIMIT 1")
    .get(harness ?? null, harness ?? null, now()) as UsageHold | undefined;
  return row ?? null;
}

// The account is shared by every session on this harness, so one refusal holds them all until the window resets.
export function holdHarness(db: Db, harness: string, until: string, reason: string): void {
  const held = activeHold(db, harness);
  if (held && held.until >= until) return;
  db.prepare(
    "INSERT INTO usage_holds (harness, until, reason, since) VALUES (?, ?, ?, ?) ON CONFLICT (harness) DO UPDATE SET until = excluded.until, reason = excluded.reason, since = CASE WHEN usage_holds.until > excluded.since THEN usage_holds.since ELSE excluded.since END",
  ).run(harness, until, reason, now());
  recordEvent(db, held ? "harness.limit_extended" : "harness.limited", {}, { harness, until, reason });
}

export function clearHold(db: Db, harness: string): boolean {
  const cleared = db.prepare("UPDATE usage_holds SET until = ? WHERE harness = ? AND until > ?").run(now(), harness, now()).changes > 0;
  if (cleared) recordEvent(db, "harness.limit_cleared", {}, { harness });
  return cleared;
}
