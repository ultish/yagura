import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { canTransition, IllegalTransition, type Role } from "./domain.js";
import { MIGRATIONS } from "./migrations.js";
import type {
  Attempt,
  AttemptId,
  Environment,
  EnvironmentId,
  Provider,
  IsoTime,
  Project,
  ProjectId,
  Repo,
  RepoId,
  Unit,
  UnitId,
  UnitState,
  UnitType,
  Forge,
} from "./domain.js";

export type Db = Database.Database;

export const now = () => new Date().toISOString() as IsoTime;

export const BUSY_TIMEOUT_MS = 30_000;
const BUSY_RETRIES = 4;
const BUSY_RETRY_MS = 100;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function openStore(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Several processes write to this file (the daemon, the CLI, the evidence CLI an agent calls). SQLite makes a blocked writer
  // wait this long before it gives up with SQLITE_BUSY ("database is locked").
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // A deferred transaction that reads and then writes fails at once, without waiting, when another process commits in between,
  // so every transaction takes the write lock first. If that still comes back busy after the wait above, it is retried with a
  // growing pause before the error is allowed through; a transaction's function must therefore only touch the database
  // (or do idempotent work), since a busy commit runs it again.
  const deferred = db.transaction.bind(db);
  db.transaction = ((fn: (...args: never[]) => unknown) => {
    const t = deferred(fn);
    const run = (...args: never[]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return t.immediate(...args);
        } catch (e) {
          if ((e as { code?: string }).code !== "SQLITE_BUSY" || db.inTransaction || attempt >= BUSY_RETRIES) throw e;
          sleep(BUSY_RETRY_MS * 2 ** attempt);
        }
      }
    };
    return Object.assign(run, { deferred: t.deferred, immediate: t.immediate, exclusive: t.exclusive });
  }) as typeof db.transaction;
  const initialized = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!initialized) db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return (db.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
}

function migrate(db: Db): void {
  for (const m of MIGRATIONS) {
    if (m.version <= schemaVersion(db)) continue;
    if (m.rebuild) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        if (m.sql) db.exec(m.sql);
        if (m.rebuild) {
          m.rebuild(db);
          const broken = db.pragma("foreign_key_check") as unknown[];
          if (broken.length) throw new Error(`migration ${m.version} broke ${broken.length} foreign key(s)`);
        }
        db.prepare("UPDATE schema_version SET version = ?").run(m.version);
      })();
    } finally {
      if (m.rebuild) db.pragma("foreign_keys = ON");
    }
  }
}

export function recordEvent(
  db: Db,
  type: string,
  refs: { projectId?: ProjectId | null; unitId?: UnitId | null; attemptId?: AttemptId | null },
  data: Record<string, unknown> = {},
): void {
  db.prepare("INSERT INTO events (ts, type, project_id, unit_id, attempt_id, data_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    now(),
    type,
    refs.projectId ?? null,
    refs.unitId ?? null,
    refs.attemptId ?? null,
    JSON.stringify(data),
  );
}

export function transitionUnit(db: Db, unitId: UnitId, to: UnitState, data: Record<string, unknown> = {}): void {
  db.transaction(() => {
    const row = db.prepare("SELECT state, project_id FROM units WHERE id = ?").get(unitId) as { state: UnitState; project_id: ProjectId } | undefined;
    if (!row) throw new Error(`unit ${unitId} not found`);
    if (!canTransition(row.state, to)) throw new IllegalTransition(unitId, row.state, to);
    db.prepare("UPDATE units SET state = ?, updated_at = ? WHERE id = ?").run(to, now(), unitId);
    recordEvent(db, "unit.state", { projectId: row.project_id, unitId }, { from: row.state, to, ...data });
  })();
}

export function addRepo(db: Db, r: { id: string; url: string; defaultBranch: string; forge?: Forge; pushConfirmed?: boolean }): Repo {
  db.prepare("INSERT INTO repos (id, url, default_branch, forge, push_confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    r.id,
    r.url,
    r.defaultBranch,
    r.forge ?? "none",
    r.pushConfirmed ? 1 : 0,
    now(),
  );
  return getRepo(db, r.id as RepoId);
}

export function getRepo(db: Db, id: RepoId): Repo {
  const r = db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`repo ${id} not found`);
  return {
    id: r.id as RepoId,
    url: r.url as string,
    defaultBranch: r.default_branch as string,
    forge: r.forge as Forge,
    pushConfirmed: r.push_confirmed === 1,
    publish: r.publish_json ? (JSON.parse(r.publish_json as string) as Repo["publish"]) : null,
    createdAt: r.created_at as IsoTime,
  };
}

export function addProject(
  db: Db,
  p: {
    id: string;
    name: string;
    goal: string;
    predicate: string;
    repos: RepoId[];
    refs?: string[];
    after?: ProjectId[];
    phaseGate?: boolean;
    mergePolicy?: Project["mergePolicy"];
    land?: Project["land"];
    environmentId?: EnvironmentId | null;
  },
): Project {
  db.transaction(() => {
    for (const dep of p.after ?? []) getProject(db, dep);
    if (p.environmentId) getEnvironment(db, p.environmentId);
    db.prepare(
      `INSERT INTO projects (id, name, goal, predicate, state, refs_json, after_json, phase_gate, merge_policy, land, environment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      p.name,
      p.goal,
      p.predicate,
      p.after?.length ? "framing" : "active",
      JSON.stringify(p.refs ?? []),
      JSON.stringify(p.after ?? []),
      p.phaseGate ? 1 : 0,
      p.mergePolicy ?? "human",
      p.land ?? null,
      p.environmentId ?? null,
      now(),
    );
    for (const repo of p.repos) db.prepare("INSERT INTO project_repos (project_id, repo_id) VALUES (?, ?)").run(p.id, repo);
    recordEvent(db, "project.created", { projectId: p.id as ProjectId });
  })();
  return getProject(db, p.id as ProjectId);
}

export function getProject(db: Db, id: ProjectId): Project {
  const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`project ${id} not found`);
  return {
    id: r.id as ProjectId,
    name: r.name as string,
    goal: r.goal as string,
    predicate: r.predicate as string,
    environmentId: (r.environment_id as Project["environmentId"]) ?? null,
    state: r.state as Project["state"],
    mergePolicy: r.merge_policy as Project["mergePolicy"],
    land: (r.land as Project["land"] | null) ?? null,
    andonReason: (r.andon_reason as string | null) ?? null,
    refs: JSON.parse((r.refs_json as string | undefined) ?? "[]"),
    after: JSON.parse((r.after_json as string | undefined) ?? "[]"),
    phaseGate: r.phase_gate === 1,
    createdAt: r.created_at as IsoTime,
    closedAt: (r.closed_at as IsoTime | null) ?? null,
  };
}

export interface NewUnit {
  projectId: ProjectId;
  type: UnitType;
  repoId: RepoId | null;
  base?: string | null;
  goal: string;
  acceptance: string[];
  context?: string[];
  after?: UnitId[];
  refs?: string[];
  playbook?: string | null;
  scaffold?: boolean;
  timeboxSeconds: number;
  maxAttempts: number;
}

export function addUnit(db: Db, u: NewUnit): Unit {
  const id = db.transaction(() => {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM units WHERE project_id = ?").get(u.projectId) as { next: number }).next;
    const t = now();
    const result = db
      .prepare(
        `INSERT INTO units (project_id, seq, type, repo_id, base, goal, acceptance_json, context_json, playbook, scaffold, timebox_seconds, max_attempts, refs_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.projectId,
        seq,
        u.type,
        u.repoId,
        u.base ?? null,
        u.goal,
        JSON.stringify(u.acceptance),
        JSON.stringify(u.context ?? []),
        u.playbook ?? null,
        u.scaffold ? 1 : 0,
        u.timeboxSeconds,
        u.maxAttempts,
        JSON.stringify(u.refs ?? []),
        t,
        t,
      );
    const unitId = Number(result.lastInsertRowid) as UnitId;
    for (const dep of new Set(u.after ?? [])) addDep(db, { unitId, dependsOn: dep });
    recordEvent(db, "unit.created", { projectId: u.projectId, unitId }, { seq, type: u.type });
    return unitId;
  })();
  return getUnit(db, id);
}

function toUnit(r: Record<string, unknown>, after: UnitId[]): Unit {
  return {
    id: r.id as UnitId,
    projectId: r.project_id as ProjectId,
    seq: r.seq as number,
    type: r.type as UnitType,
    state: r.state as UnitState,
    repoId: (r.repo_id as RepoId | null) ?? null,
    base: (r.base as string | null) ?? null,
    goal: r.goal as string,
    acceptance: JSON.parse(r.acceptance_json as string),
    context: JSON.parse(r.context_json as string),
    after,
    refs: JSON.parse(r.refs_json as string),
    notes: JSON.parse(r.notes_json as string),
    branch: (r.branch as string | null) ?? null,
    approvedSha: (r.approved_sha as Unit["approvedSha"]) ?? null,
    mergedSha: (r.merged_sha as Unit["mergedSha"]) ?? null,
    playbook: (r.playbook as string | null) ?? null,
    scaffold: r.scaffold === 1,
    timeboxSeconds: r.timebox_seconds as number,
    maxAttempts: r.max_attempts as number,
    createdByDrainId: (r.created_by_drain_id as Unit["createdByDrainId"]) ?? null,
    createdAt: r.created_at as IsoTime,
    updatedAt: r.updated_at as IsoTime,
  };
}

export function getUnit(db: Db, id: UnitId): Unit {
  const r = db.prepare("SELECT * FROM units WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`unit ${id} not found`);
  const after = (db.prepare("SELECT depends_on FROM unit_deps WHERE unit_id = ? ORDER BY depends_on").all(id) as { depends_on: UnitId }[]).map(
    (d) => d.depends_on,
  );
  return toUnit(r, after);
}

export function getUnitBySeq(db: Db, projectId: ProjectId, seq: number): Unit {
  const r = db.prepare("SELECT id FROM units WHERE project_id = ? AND seq = ?").get(projectId, seq) as { id: UnitId } | undefined;
  if (!r) throw new Error(`unit ${projectId}/U${seq} not found`);
  return getUnit(db, r.id);
}

export function listUnits(db: Db, projectId: ProjectId): Unit[] {
  const after = new Map<UnitId, UnitId[]>();
  for (const d of db
    .prepare("SELECT d.unit_id, d.depends_on FROM unit_deps d JOIN units u ON u.id = d.unit_id WHERE u.project_id = ? ORDER BY d.depends_on")
    .all(projectId) as { unit_id: UnitId; depends_on: UnitId }[])
    after.set(d.unit_id, [...(after.get(d.unit_id) ?? []), d.depends_on]);
  return (db.prepare("SELECT * FROM units WHERE project_id = ? ORDER BY seq").all(projectId) as Record<string, unknown>[]).map((r) =>
    toUnit(r, after.get(r.id as UnitId) ?? []),
  );
}

function toAttempt(r: Record<string, unknown>): Attempt {
  return {
    id: r.id as AttemptId,
    unitId: r.unit_id as UnitId,
    n: r.n as number,
    agentNo: r.agent_no as number,
    guidanceSha: (r.guidance_sha as string | null) ?? null,
    role: (r.role as Role | null) ?? null,
    state: r.state as Attempt["state"],
    harness: r.harness as string,
    model: (r.model as string | null) ?? null,
    pluginVersions: JSON.parse(r.plugin_versions_json as string),
    pid: (r.pid as number | null) ?? null,
    worktreePath: (r.worktree_path as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    baseSha: (r.base_sha as Attempt["baseSha"]) ?? null,
    headSha: (r.head_sha as Attempt["headSha"]) ?? null,
    handoffStatus: (r.handoff_status as Attempt["handoffStatus"]) ?? null,
    failureMode: (r.failure_mode as Attempt["failureMode"]) ?? null,
    exitCode: (r.exit_code as number | null) ?? null,
    stopNote: (r.stop_note as string | null) ?? null,
    tokensIn: r.tokens_in as number,
    tokensOut: r.tokens_out as number,
    contextPeak: r.context_peak as number,
    costUsd: (r.cost_usd as number | undefined) ?? 0,
    sessionId: (r.session_id as string | null) ?? null,
    resumesAttemptId: (r.resumes_attempt_id as AttemptId | null) ?? null,
    limitedUntil: (r.limited_until as string | null | undefined) ?? null,
    skills: JSON.parse((r.skills_json as string | undefined) ?? "[]"),
    missingSkills: JSON.parse((r.missing_skills_json as string | undefined) ?? "[]"),
    startedAt: (r.started_at as IsoTime | null) ?? null,
    endedAt: (r.ended_at as IsoTime | null) ?? null,
  };
}

// A plan row is an agent job, not a slice of work: it is named by its agent, "A13", once one has started.
export function jobLabel(db: Db, unit: Pick<Unit, "id" | "type">): string {
  const a = db.prepare("SELECT agent_no FROM attempts WHERE unit_id = ? ORDER BY id DESC LIMIT 1").get(unit.id) as { agent_no: number } | undefined;
  return a ? `A${a.agent_no}` : `its ${unit.type} (not started)`;
}

// The first agent run on a unit, "A4".
export function firstAgentRef(db: Db, unit: Pick<Unit, "id" | "seq">): string {
  const a = db.prepare("SELECT agent_no FROM attempts WHERE unit_id = ? ORDER BY id LIMIT 1").get(unit.id) as { agent_no: number } | undefined;
  return a ? `A${a.agent_no}` : `U${unit.seq}`;
}

// The agent run that did a job, "A4", or its unit, "U7", before any run has started; for a header that must always name something.
export function agentRef(db: Db, unit: Pick<Unit, "id" | "seq" | "type">): string {
  const label = jobLabel(db, unit);
  return /^A\d+$/.test(label) ? label : `U${unit.seq}`;
}

export function createAttempt(db: Db, unitId: UnitId, harness: string, model: string | null): Attempt {
  const id = db.transaction(() => {
    const n = (db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS next FROM attempts WHERE unit_id = ?").get(unitId) as { next: number }).next;
    const agentNo = (
      db
        .prepare(
          "SELECT COUNT(*) + 1 AS next FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = (SELECT project_id FROM units WHERE id = ?)",
        )
        .get(unitId) as { next: number }
    ).next;
    return Number(
      db.prepare("INSERT INTO attempts (unit_id, n, agent_no, harness, model) VALUES (?, ?, ?, ?, ?)").run(unitId, n, agentNo, harness, model).lastInsertRowid,
    );
  })();
  return getAttempt(db, id as AttemptId);
}

export function getAttempt(db: Db, id: AttemptId): Attempt {
  const r = db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`attempt ${id} not found`);
  return toAttempt(r);
}

export function listAttempts(db: Db, unitId: UnitId): Attempt[] {
  return (db.prepare("SELECT * FROM attempts WHERE unit_id = ? ORDER BY n").all(unitId) as Record<string, unknown>[]).map(toAttempt);
}

const ATTEMPT_COLUMNS = {
  state: "state",
  pid: "pid",
  worktreePath: "worktree_path",
  branch: "branch",
  baseSha: "base_sha",
  headSha: "head_sha",
  handoffStatus: "handoff_status",
  failureMode: "failure_mode",
  exitCode: "exit_code",
  stopNote: "stop_note",
  tokensIn: "tokens_in",
  tokensOut: "tokens_out",
  contextPeak: "context_peak",
  startedAt: "started_at",
  endedAt: "ended_at",
  pluginVersions: "plugin_versions_json",
  model: "model",
  skills: "skills_json",
  missingSkills: "missing_skills_json",
  sessionId: "session_id",
  resumesAttemptId: "resumes_attempt_id",
  role: "role",
  limitedUntil: "limited_until",
} as const satisfies Partial<Record<keyof Attempt, string>>;

export function updateAttempt(db: Db, id: AttemptId, patch: Partial<Pick<Attempt, keyof typeof ATTEMPT_COLUMNS>>): void {
  const entries = Object.entries(patch) as [keyof typeof ATTEMPT_COLUMNS, unknown][];
  if (!entries.length) return;
  const sets = entries.map(([k]) => `${ATTEMPT_COLUMNS[k]} = ?`).join(", ");
  const values = entries.map(([k, v]) => (k === "pluginVersions" || k === "skills" || k === "missingSkills" ? JSON.stringify(v) : v));
  db.prepare(`UPDATE attempts SET ${sets} WHERE id = ?`).run(...values, id);
}

export function addEnvironment(
  db: Db,
  e: { id: string; name: string; provider: Provider; capacity: number; providerConfig?: Record<string, unknown> },
): Environment {
  db.prepare("INSERT INTO environments (id, name, provider, provider_config_json, capacity, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    e.id,
    e.name,
    e.provider,
    JSON.stringify(e.providerConfig ?? {}),
    e.capacity,
    now(),
  );
  return getEnvironment(db, e.id as EnvironmentId);
}

// History stays in events; what goes is the environment itself, its values, settings, and finished leases.
export function deleteEnvironment(db: Db, id: EnvironmentId): void {
  getEnvironment(db, id);
  const using = (db.prepare("SELECT id FROM projects WHERE environment_id = ? AND state <> 'closed' ORDER BY id").all(id) as { id: string }[]).map((p) => p.id);
  if (using.length) throw new Error(`environment ${id} is used by ${using.join(", ")}; move those projects to another environment first`);
  const busy = db
    .prepare("SELECT COUNT(*) AS n FROM leases WHERE environment_id = ? AND (state IN ('queued', 'active') OR kept_until IS NOT NULL)")
    .get(id) as { n: number };
  if (busy.n) throw new Error(`environment ${id} has slots in use or kept; wait for them or delete the kept ones first`);
  db.transaction(() => {
    db.prepare("UPDATE projects SET environment_id = NULL WHERE environment_id = ?").run(id);
    db.prepare("DELETE FROM leases WHERE environment_id = ?").run(id);
    db.prepare("DELETE FROM environment_values WHERE environment_id = ?").run(id);
    db.prepare("DELETE FROM settings WHERE scope = 'environment' AND scope_id = ?").run(id);
    db.prepare("DELETE FROM environments WHERE id = ?").run(id);
    recordEvent(db, "environment.deleted", {}, { environment: id });
  })();
}

export function getEnvironment(db: Db, id: EnvironmentId): Environment {
  const r = db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`environment ${id} not found`);
  return {
    id: r.id as EnvironmentId,
    name: r.name as string,
    provider: r.provider as Provider,
    providerConfig: JSON.parse(r.provider_config_json as string),
    capacity: r.capacity as number,
    notes: r.notes as string,
    createdAt: r.created_at as IsoTime,
  };
}

export function updateEnvironment(db: Db, id: EnvironmentId, patch: { name?: string; capacity?: number }): Environment {
  const before = getEnvironment(db, id);
  if (patch.capacity !== undefined && (!Number.isInteger(patch.capacity) || patch.capacity < 0)) throw new Error("capacity must be a whole number, 0 or more");
  if (patch.name !== undefined && !patch.name.trim()) throw new Error("name must not be empty");
  const next = { name: patch.name?.trim() ?? before.name, capacity: patch.capacity ?? before.capacity };
  db.prepare("UPDATE environments SET name = ?, capacity = ? WHERE id = ?").run(next.name, next.capacity, id);
  recordEvent(db, "environment.updated", {}, { environment: id, from: { name: before.name, capacity: before.capacity }, to: next });
  return getEnvironment(db, id);
}

export function setProjectEnvironment(db: Db, projectId: ProjectId, environmentId: EnvironmentId | null): void {
  if (environmentId) getEnvironment(db, environmentId);
  db.prepare("UPDATE projects SET environment_id = ? WHERE id = ?").run(environmentId, projectId);
  recordEvent(db, "project.environment", { projectId }, { environment: environmentId });
}

export function setRepoUrl(db: Db, repoId: RepoId, url: string): void {
  db.prepare("UPDATE repos SET url = ? WHERE id = ?").run(url, repoId);
}

export function setRepoForge(db: Db, repoId: RepoId, forge: Forge, pushConfirmed = false): void {
  db.prepare("UPDATE repos SET forge = ?, push_confirmed = ? WHERE id = ?").run(forge, forge === "none" && pushConfirmed ? 1 : 0, repoId);
  recordEvent(db, "repo.forge", {}, { repo: repoId, forge, pushConfirmed: forge === "none" && pushConfirmed });
}

export function addUnitNote(db: Db, unitId: UnitId, note: string): void {
  const row = db.prepare("SELECT notes_json, project_id FROM units WHERE id = ?").get(unitId) as { notes_json: string; project_id: ProjectId };
  const notes = [...(JSON.parse(row.notes_json) as string[]), note];
  db.prepare("UPDATE units SET notes_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(notes), now(), unitId);
  recordEvent(db, "unit.note", { projectId: row.project_id, unitId }, { note });
}

export function listProjects(db: Db): Project[] {
  return (db.prepare("SELECT id FROM projects ORDER BY created_at").all() as { id: ProjectId }[]).map((r) => getProject(db, r.id));
}

export function projectRepos(db: Db, projectId: ProjectId): Repo[] {
  return (db.prepare("SELECT repo_id FROM project_repos WHERE project_id = ? ORDER BY repo_id").all(projectId) as { repo_id: RepoId }[]).map((r) =>
    getRepo(db, r.repo_id),
  );
}

// What the project's agent sessions have cost; watchman turns belong to threads, which can span projects.
export function projectCost(db: Db, projectId: ProjectId): number {
  const r = db.prepare("SELECT COALESCE(SUM(a.cost_usd), 0) AS usd FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ?").get(projectId) as {
    usd: number;
  };
  return r.usd;
}

export function setAndon(db: Db, projectId: ProjectId, reason: string | null): void {
  db.prepare("UPDATE projects SET andon_reason = ? WHERE id = ?").run(reason, projectId);
  recordEvent(db, reason ? "project.andon" : "project.andon_cleared", { projectId }, { reason });
}

export function setMergePolicy(db: Db, projectId: ProjectId, policy: Project["mergePolicy"]): void {
  db.prepare("UPDATE projects SET merge_policy = ? WHERE id = ?").run(policy, projectId);
}

export function setProjectState(db: Db, projectId: ProjectId, state: Project["state"]): void {
  db.prepare("UPDATE projects SET state = ?, closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END WHERE id = ?").run(state, state, now(), projectId);
  recordEvent(db, "project.state", { projectId }, { state });
}

export interface UnitDepRow {
  unitId: UnitId;
  dependsOn: UnitId;
}

export function addDep(db: Db, dep: UnitDepRow): void {
  db.prepare("INSERT OR IGNORE INTO unit_deps (unit_id, depends_on) VALUES (?, ?)").run(dep.unitId, dep.dependsOn);
}

export function listDeps(db: Db, projectId: ProjectId): UnitDepRow[] {
  return (
    db.prepare("SELECT d.unit_id, d.depends_on FROM unit_deps d JOIN units u ON u.id = d.unit_id WHERE u.project_id = ?").all(projectId) as {
      unit_id: UnitId;
      depends_on: UnitId;
    }[]
  ).map((r) => ({ unitId: r.unit_id, dependsOn: r.depends_on }));
}

export interface Gate {
  id: number;
  projectId: ProjectId;
  unitId: UnitId | null;
  question: string;
  options: string[];
  defaultOption: string | null;
  state: "open" | "answered" | "defaulted" | "cancelled";
  answer: string | null;
  kind: string;
  createdAt: IsoTime;
  resolvedAt: IsoTime | null;
}

export function addGate(
  db: Db,
  g: { projectId: ProjectId; unitId?: UnitId | null; question: string; options: string[]; defaultOption?: string | null; kind: string },
): number {
  const id = Number(
    db
      .prepare("INSERT INTO gates (project_id, unit_id, kind, question, options_json, default_option, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(g.projectId, g.unitId ?? null, g.kind, g.question, JSON.stringify(g.options), g.defaultOption ?? null, now()).lastInsertRowid,
  );
  recordEvent(db, "gate.opened", { projectId: g.projectId, unitId: g.unitId ?? null }, { gate: id, kind: g.kind, question: g.question });
  return id;
}

function toGate(r: Record<string, unknown>): Gate {
  return {
    id: r.id as number,
    projectId: r.project_id as ProjectId,
    unitId: (r.unit_id as UnitId | null) ?? null,
    question: r.question as string,
    kind: r.kind as string,
    options: JSON.parse(r.options_json as string),
    defaultOption: (r.default_option as string | null) ?? null,
    state: r.state as Gate["state"],
    answer: (r.answer as string | null) ?? null,
    createdAt: r.created_at as IsoTime,
    resolvedAt: (r.resolved_at as IsoTime | null) ?? null,
  };
}

export function listGates(db: Db, projectId: ProjectId | null, state?: Gate["state"]): Gate[] {
  const rows = db
    .prepare(`SELECT * FROM gates WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR state = ?) ORDER BY id`)
    .all(projectId, projectId, state ?? null, state ?? null) as Record<string, unknown>[];
  return rows.map(toGate);
}

export function getGate(db: Db, id: number): Gate {
  const row = db.prepare("SELECT * FROM gates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`gate ${id} not found`);
  return toGate(row);
}

export function answerGate(db: Db, id: number, answer: string): Gate {
  const row = db.prepare("SELECT * FROM gates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`gate ${id} not found`);
  const gate = toGate(row);
  if (gate.state !== "open") throw new Error(`gate ${id} is ${gate.state}`);
  if (gate.options.length && !gate.options.includes(answer)) throw new Error(`answer must be one of: ${gate.options.join(", ")}`);
  db.prepare("UPDATE gates SET state = 'answered', answer = ?, resolved_at = ? WHERE id = ?").run(answer, now(), id);
  recordEvent(db, "gate.answered", { projectId: gate.projectId, unitId: gate.unitId }, { gate: id, kind: gate.kind, answer });
  return { ...gate, state: "answered", answer };
}

export function bumpMaxAttempts(db: Db, unitId: UnitId, to: number): void {
  db.prepare("UPDATE units SET max_attempts = MAX(max_attempts, ?), updated_at = ? WHERE id = ?").run(to, now(), unitId);
}

export function amendUnit(db: Db, unitId: UnitId, patch: { goal?: string; acceptance?: string[]; context?: string[] }): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.goal !== undefined) (sets.push("goal = ?"), values.push(patch.goal));
  if (patch.acceptance !== undefined) (sets.push("acceptance_json = ?"), values.push(JSON.stringify(patch.acceptance)));
  if (patch.context !== undefined) (sets.push("context_json = ?"), values.push(JSON.stringify(patch.context)));
  if (!sets.length) return;
  db.prepare(`UPDATE units SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, now(), unitId);
}

export function setProjectRefs(db: Db, projectId: ProjectId, refs: string[]): void {
  db.prepare("UPDATE projects SET refs_json = ? WHERE id = ?").run(JSON.stringify(refs), projectId);
  recordEvent(db, "project.refs", { projectId }, { refs });
}

export function setMergedSha(db: Db, unitId: UnitId, sha: string): void {
  db.prepare("UPDATE units SET merged_sha = ?, updated_at = ? WHERE id = ?").run(sha, now(), unitId);
}

export function setApprovedSha(db: Db, unitId: UnitId, sha: string | null): void {
  db.prepare("UPDATE units SET approved_sha = ?, updated_at = ? WHERE id = ?").run(sha, now(), unitId);
}

export function setUnitBranch(db: Db, unitId: UnitId, branch: string): void {
  db.prepare("UPDATE units SET branch = ?, updated_at = ? WHERE id = ?").run(branch, now(), unitId);
}
