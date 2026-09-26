import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { canTransition, IllegalTransition } from "./domain.js";
import type {
  Attempt,
  AttemptId,
  IsoTime,
  MeasurementSpec,
  Project,
  ProjectId,
  Repo,
  RepoId,
  Unit,
  UnitId,
  UnitState,
  UnitType,
  PassTier,
  Forge,
} from "./domain.js";

export type Db = Database.Database;

export const now = () => new Date().toISOString() as IsoTime;

export function openStore(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const initialized = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!initialized) db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  return db;
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

export function addRepo(db: Db, r: { id: string; url: string; defaultBranch: string; forge?: Forge }): Repo {
  db.prepare("INSERT INTO repos (id, url, default_branch, forge, created_at) VALUES (?, ?, ?, ?, ?)").run(
    r.id,
    r.url,
    r.defaultBranch,
    r.forge ?? "none",
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
    verifyPackPath: r.verify_pack_path as string,
    packStatus: r.pack_status as Repo["packStatus"],
    packProvenSha: (r.pack_proven_sha as Repo["packProvenSha"]) ?? null,
    createdAt: r.created_at as IsoTime,
  };
}

export function addProject(
  db: Db,
  p: { id: string; name: string; goal: string; predicate: string; minTier: PassTier; repos: RepoId[] },
): Project {
  db.transaction(() => {
    db.prepare("INSERT INTO projects (id, name, goal, predicate, min_tier, state, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)").run(
      p.id,
      p.name,
      p.goal,
      p.predicate,
      p.minTier,
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
    minTier: r.min_tier as PassTier,
    environmentId: (r.environment_id as Project["environmentId"]) ?? null,
    state: r.state as Project["state"],
    mergePolicy: r.merge_policy as Project["mergePolicy"],
    andonReason: (r.andon_reason as string | null) ?? null,
    createdAt: r.created_at as IsoTime,
    closedAt: (r.closed_at as IsoTime | null) ?? null,
  };
}

export interface NewUnit {
  projectId: ProjectId;
  type: UnitType;
  repoId: RepoId | null;
  targetUnitId?: UnitId | null;
  goal: string;
  writeScope: string[];
  forbidScope?: string[];
  acceptance: string[];
  verify: string | null;
  context?: string[];
  measurements?: MeasurementSpec[];
  playbook?: string | null;
  timeboxSeconds: number;
  maxAttempts: number;
}

export function addUnit(db: Db, u: NewUnit): Unit {
  const id = db.transaction(() => {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM units WHERE project_id = ?").get(u.projectId) as { next: number }).next;
    const t = now();
    const result = db
      .prepare(
        `INSERT INTO units (project_id, seq, type, repo_id, target_unit_id, goal, write_scope_json, forbid_scope_json,
          acceptance_json, verify, context_json, measurements_json, playbook, timebox_seconds, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.projectId,
        seq,
        u.type,
        u.repoId,
        u.targetUnitId ?? null,
        u.goal,
        JSON.stringify(u.writeScope),
        JSON.stringify(u.forbidScope ?? []),
        JSON.stringify(u.acceptance),
        u.verify,
        JSON.stringify(u.context ?? []),
        JSON.stringify(u.measurements ?? []),
        u.playbook ?? null,
        u.timeboxSeconds,
        u.maxAttempts,
        t,
        t,
      );
    const unitId = Number(result.lastInsertRowid) as UnitId;
    recordEvent(db, "unit.created", { projectId: u.projectId, unitId }, { seq, type: u.type });
    return unitId;
  })();
  return getUnit(db, id);
}

function toUnit(r: Record<string, unknown>): Unit {
  return {
    id: r.id as UnitId,
    projectId: r.project_id as ProjectId,
    seq: r.seq as number,
    type: r.type as UnitType,
    state: r.state as UnitState,
    repoId: (r.repo_id as RepoId | null) ?? null,
    targetUnitId: (r.target_unit_id as UnitId | null) ?? null,
    goal: r.goal as string,
    writeScope: JSON.parse(r.write_scope_json as string),
    forbidScope: JSON.parse(r.forbid_scope_json as string),
    acceptance: JSON.parse(r.acceptance_json as string),
    verify: (r.verify as string | null) ?? null,
    context: JSON.parse(r.context_json as string),
    measurements: JSON.parse(r.measurements_json as string),
    playbook: (r.playbook as string | null) ?? null,
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
  return toUnit(r);
}

export function getUnitBySeq(db: Db, projectId: ProjectId, seq: number): Unit {
  const r = db.prepare("SELECT * FROM units WHERE project_id = ? AND seq = ?").get(projectId, seq) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`unit ${projectId}/U${seq} not found`);
  return toUnit(r);
}

export function listUnits(db: Db, projectId: ProjectId): Unit[] {
  return (db.prepare("SELECT * FROM units WHERE project_id = ? ORDER BY seq").all(projectId) as Record<string, unknown>[]).map(toUnit);
}

function toAttempt(r: Record<string, unknown>): Attempt {
  return {
    id: r.id as AttemptId,
    unitId: r.unit_id as UnitId,
    n: r.n as number,
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
    selfTier: (r.self_tier as Attempt["selfTier"]) ?? null,
    failureMode: (r.failure_mode as Attempt["failureMode"]) ?? null,
    exitCode: (r.exit_code as number | null) ?? null,
    stopNote: (r.stop_note as string | null) ?? null,
    tokensIn: r.tokens_in as number,
    tokensOut: r.tokens_out as number,
    contextPeak: r.context_peak as number,
    startedAt: (r.started_at as IsoTime | null) ?? null,
    endedAt: (r.ended_at as IsoTime | null) ?? null,
  };
}

export function createAttempt(db: Db, unitId: UnitId, harness: string, model: string | null): Attempt {
  const id = db.transaction(() => {
    const n = (db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS next FROM attempts WHERE unit_id = ?").get(unitId) as { next: number }).next;
    return Number(db.prepare("INSERT INTO attempts (unit_id, n, harness, model) VALUES (?, ?, ?, ?)").run(unitId, n, harness, model).lastInsertRowid);
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
  selfTier: "self_tier",
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
} as const satisfies Partial<Record<keyof Attempt, string>>;

export function updateAttempt(db: Db, id: AttemptId, patch: Partial<Pick<Attempt, keyof typeof ATTEMPT_COLUMNS>>): void {
  const entries = Object.entries(patch) as [keyof typeof ATTEMPT_COLUMNS, unknown][];
  if (!entries.length) return;
  const sets = entries.map(([k]) => `${ATTEMPT_COLUMNS[k]} = ?`).join(", ");
  const values = entries.map(([k, v]) => (k === "pluginVersions" ? JSON.stringify(v) : v));
  db.prepare(`UPDATE attempts SET ${sets} WHERE id = ?`).run(...values, id);
}
