import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import { createNamespaceSlot, destroyNamespaceSlot, KubeConfig, kubeConfig } from "./kube.js";
import { valueMap } from "./envvalues.js";
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
  validateConfig(config: Record<string, unknown>, capacity: number): string | null;
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
  "kube-namespace": [
    "YAGURA_SLOT",
    "YAGURA_LEASE_DIR (a private directory on this machine)",
    "YAGURA_NAMESPACE (the Kubernetes namespace this slot owns)",
    'KUBECONTEXT (pass it as kubectl --context "$KUBECONTEXT")',
    "YAGURA_LABEL (yagura=1; put it on everything deploy creates)",
    "YAGURA_BASE_URL (when the environment sets an ingress pattern)",
  ],
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
    validateConfig: (config) => (Object.keys(config).length ? `local-process takes no settings (got ${Object.keys(config).join(", ")})` : null),
  },
  "kube-namespace": {
    async createSlot(env, lease, boot) {
      const dir = leaseDir(boot, lease.id);
      mkdirSync(dir, { recursive: true });
      return { YAGURA_SLOT: lease.slot, YAGURA_LEASE_DIR: dir, ...(await createNamespaceSlot(env, lease)) };
    },
    async destroySlot(env, lease, boot) {
      await destroyNamespaceSlot(env, lease.vars);
      rmSync(leaseDir(boot, lease.id), { recursive: true, force: true });
    },
    validateConfig(config, capacity) {
      const parsed = KubeConfig.safeParse(config);
      if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
      if (parsed.data.mode === "pool" && capacity > parsed.data.pool.length)
        return `pool mode has ${parsed.data.pool.length} namespace(s), so capacity cannot be ${capacity}`;
      return null;
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
  const vars = { ...valueMap(db, env.id), ...(await providerFor(env).createSlot(env, granted, boot)) };
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

// A pool namespace is reused by the next lease of its slot, so keeping it would hand the next verification a dirty one.
// Deleting a local slot later cannot stop what deploy started there, so its teardown still runs and only the directory stays.
export function keepable(env: Environment): "deployed" | "directory" | null {
  if (env.provider === "local-process") return "directory";
  return kubeConfig(env).mode === "create" ? "deployed" : null;
}

export function keepLease(db: Db, leaseId: LeaseId, hours: number, reason: string): void {
  const row = db.prepare("SELECT state, attempt_id, slot FROM leases WHERE id = ?").get(leaseId) as
    { state: string; attempt_id: AttemptId; slot: string } | undefined;
  if (!row || row.state !== "active") return;
  const until = new Date(Date.now() + hours * 3_600_000).toISOString();
  db.prepare("UPDATE leases SET state = 'released', released_at = ?, kept_until = ?, kept_reason = ? WHERE id = ?").run(now(), until, reason, leaseId);
  recordEvent(db, "lease.kept", { attemptId: row.attempt_id }, { lease: leaseId, slot: row.slot, until, reason });
}

export async function deleteKept(db: Db, boot: Bootstrap, leaseId: LeaseId): Promise<boolean> {
  const row = db.prepare("SELECT environment_id, slot, vars_json, attempt_id, kept_until FROM leases WHERE id = ?").get(leaseId) as
    { environment_id: EnvironmentId; slot: string; vars_json: string; attempt_id: AttemptId; kept_until: string | null } | undefined;
  if (!row?.kept_until) return false;
  const env = getEnvironment(db, row.environment_id);
  await providerFor(env).destroySlot(env, { id: leaseId, slot: row.slot, vars: JSON.parse(row.vars_json) }, boot);
  db.prepare("UPDATE leases SET kept_until = NULL WHERE id = ?").run(leaseId);
  recordEvent(db, "lease.kept_deleted", { attemptId: row.attempt_id }, { lease: leaseId, slot: row.slot });
  return true;
}

export async function reapKept(db: Db, boot: Bootstrap, at = Date.now()): Promise<number> {
  const due = (db.prepare("SELECT id, kept_until FROM leases WHERE kept_until IS NOT NULL").all() as { id: LeaseId; kept_until: string }[]).filter(
    (r) => Date.parse(r.kept_until) <= at,
  );
  for (const r of due) await deleteKept(db, boot, r.id).catch(() => false);
  return due.length;
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
