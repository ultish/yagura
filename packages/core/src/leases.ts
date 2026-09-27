import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import type { AttemptId, Environment, EnvironmentId, IsoTime, LeaseId, Provider } from "./domain.js";
import { getEnvironment, now, recordEvent, type Db } from "./store.js";

export interface Lease {
  id: LeaseId;
  environmentId: EnvironmentId;
  attemptId: AttemptId;
  slot: string;
  vars: Record<string, string>;
}

export interface ProviderImpl {
  createSlot(env: Environment, lease: { id: LeaseId; slot: string }, boot: Bootstrap): Promise<Record<string, string>>;
  destroySlot(env: Environment, lease: { id: LeaseId; slot: string; vars: Record<string, string> }, boot: Bootstrap): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

const leaseDir = (boot: Bootstrap, id: LeaseId) => join(boot.home, "leases", String(id));

export const LEASE_VARS: Partial<Record<Provider, string[]>> = {
  "local-process": ["YAGURA_SLOT", "YAGURA_LEASE_DIR (a private directory)", "YAGURA_PORT (a free port)"],
};

export const PROVIDERS_IMPL: Partial<Record<Provider, ProviderImpl>> = {
  "local-process": {
    async createSlot(_env, lease, boot) {
      const dir = leaseDir(boot, lease.id);
      mkdirSync(dir, { recursive: true });
      return { YAGURA_SLOT: lease.slot, YAGURA_LEASE_DIR: dir, YAGURA_PORT: String(await freePort()) };
    },
    async destroySlot(_env, lease, boot) {
      rmSync(leaseDir(boot, lease.id), { recursive: true, force: true });
    },
  },
};

function providerFor(env: Environment): ProviderImpl {
  const impl = PROVIDERS_IMPL[env.provider];
  if (!impl) throw new Error(`provider ${env.provider} is not implemented yet`);
  return impl;
}

function tryGrant(db: Db, env: Environment, attemptId: AttemptId, queuedId: LeaseId | null): { id: LeaseId; slot: string } | null {
  return db.transaction(() => {
    const active = new Set(
      (db.prepare("SELECT slot FROM leases WHERE environment_id = ? AND state = 'active'").all(env.id) as { slot: string }[]).map((r) => r.slot),
    );
    if (active.size >= env.capacity) return null;
    const ahead = queuedId
      ? (db.prepare("SELECT COUNT(*) AS n FROM leases WHERE environment_id = ? AND state = 'queued' AND id < ?").get(env.id, queuedId) as { n: number }).n
      : 0;
    if (ahead >= env.capacity - active.size) return null;
    let i = 1;
    while (active.has(`slot-${i}`)) i++;
    const slot = `slot-${i}`;
    const t = now();
    const id = queuedId
      ? (db.prepare("UPDATE leases SET state = 'active', slot = ?, granted_at = ? WHERE id = ?").run(slot, t, queuedId), queuedId)
      : (Number(
          db
            .prepare("INSERT INTO leases (environment_id, attempt_id, slot, state, requested_at, granted_at) VALUES (?, ?, ?, 'active', ?, ?)")
            .run(env.id, attemptId, slot, t, t).lastInsertRowid,
        ) as LeaseId);
    return { id, slot };
  })();
}

export async function acquireLease(
  db: Db,
  boot: Bootstrap,
  environmentId: EnvironmentId,
  attemptId: AttemptId,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<Lease> {
  const env = getEnvironment(db, environmentId);
  const deadline = Date.now() + (opts.waitMs ?? 30 * 60_000);
  let granted = tryGrant(db, env, attemptId, null);
  let queuedId: LeaseId | null = null;
  if (!granted) {
    queuedId = Number(
      db.prepare("INSERT INTO leases (environment_id, attempt_id, state, requested_at) VALUES (?, ?, 'queued', ?)").run(env.id, attemptId, now())
        .lastInsertRowid,
    ) as LeaseId;
    recordEvent(db, "lease.queued", { attemptId }, { environment: env.id, lease: queuedId });
  }
  while (!granted) {
    if (Date.now() > deadline) {
      db.prepare("UPDATE leases SET state = 'released', released_at = ? WHERE id = ?").run(now(), queuedId);
      throw new Error(`timed out waiting for a lease on ${env.id}`);
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
    granted = tryGrant(db, env, attemptId, queuedId);
  }
  const vars = await providerFor(env).createSlot(env, granted, boot);
  db.prepare("UPDATE leases SET vars_json = ? WHERE id = ?").run(JSON.stringify(vars), granted.id);
  recordEvent(db, "lease.granted", { attemptId }, { environment: env.id, lease: granted.id, slot: granted.slot });
  return { id: granted.id, environmentId: env.id, attemptId, slot: granted.slot, vars };
}

export async function releaseLease(db: Db, boot: Bootstrap, leaseId: LeaseId, state: "released" | "reaped" = "released"): Promise<void> {
  const row = db.prepare("SELECT * FROM leases WHERE id = ?").get(leaseId) as
    { environment_id: EnvironmentId; slot: string; vars_json: string; state: string; attempt_id: AttemptId } | undefined;
  if (!row || row.state !== "active") return;
  const env = getEnvironment(db, row.environment_id);
  await providerFor(env).destroySlot(env, { id: leaseId, slot: row.slot, vars: JSON.parse(row.vars_json) }, boot);
  db.prepare("UPDATE leases SET state = ?, released_at = ? WHERE id = ?").run(state, now() as IsoTime, leaseId);
  recordEvent(db, `lease.${state}`, { attemptId: row.attempt_id }, { lease: leaseId, slot: row.slot });
}

export function activeLease(db: Db, attemptId: AttemptId): Lease | null {
  const row = db.prepare("SELECT * FROM leases WHERE attempt_id = ? AND state = 'active'").get(attemptId) as
    { id: LeaseId; environment_id: EnvironmentId; slot: string; vars_json: string } | undefined;
  return row ? { id: row.id, environmentId: row.environment_id, attemptId, slot: row.slot, vars: JSON.parse(row.vars_json) } : null;
}

export async function reapLeases(db: Db, boot: Bootstrap): Promise<number> {
  const stale = db
    .prepare(
      `SELECT l.id FROM leases l JOIN attempts a ON a.id = l.attempt_id
       WHERE l.state IN ('active', 'queued') AND a.state NOT IN ('queued', 'running')`,
    )
    .all() as { id: LeaseId }[];
  for (const { id } of stale) {
    const state = (db.prepare("SELECT state FROM leases WHERE id = ?").get(id) as { state: string }).state;
    if (state === "queued") db.prepare("UPDATE leases SET state = 'reaped', released_at = ? WHERE id = ?").run(now(), id);
    else await releaseLease(db, boot, id, "reaped");
  }
  return stale.length;
}
