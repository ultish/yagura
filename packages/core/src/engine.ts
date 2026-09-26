import { stopAttempt, type RunContext } from "./agent.js";
import { resolveSetting } from "./config.js";
import type { Project, ProjectId, Unit, UnitId } from "./domain.js";
import { landUnit } from "./land.js";
import { reapLeases } from "./leases.js";
import { lastDrainEventId, latestDelta, runPlanner } from "./planner.js";
import { runWorkUnit } from "./runner.js";
import { failurePolicy, readiness, runningAttempts } from "./schedule.js";
import {
  addGate,
  getProject,
  getUnit,
  listAttempts,
  listGates,
  listProjects,
  listUnits,
  now,
  recordEvent,
  setProjectState,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { runVerifyUnit } from "./verify.js";

export interface EngineOptions {
  projectId?: ProjectId;
  tickMs?: number;
  log?: (line: string) => void;
}

const TERMINAL = new Set(["landed", "done", "abandoned"]);
const PLAN_TRIGGERS = ["landed", "blocked", "abandoned"];

export class Engine {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly log: (line: string) => void;

  constructor(
    private readonly ctx: RunContext,
    private readonly opts: EngineOptions = {},
  ) {
    this.log = opts.log ?? (() => undefined);
  }

  get db(): Db {
    return this.ctx.db;
  }

  get busy(): number {
    return this.inflight.size;
  }

  private start(key: string, label: string, work: () => Promise<unknown>, onError: (e: unknown) => void): void {
    this.log(`▶ ${label}`);
    const p = work()
      .then(() => this.log(`■ ${label}`))
      .catch((e: unknown) => {
        this.log(`✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
        onError(e);
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
  }

  private recoverCrashed(unitId: UnitId, e: unknown): void {
    const unit = getUnit(this.db, unitId);
    recordEvent(this.db, "engine.error", { projectId: unit.projectId, unitId }, { error: e instanceof Error ? e.message : String(e) });
    for (const a of listAttempts(this.db, unitId)) if (a.state === "running" || a.state === "queued") updateAttempt(this.db, a.id, { state: "failed", endedAt: now(), failureMode: "harness-error" });
    if (unit.state === "running") transitionUnit(this.db, unitId, "failed", { reason: "engine error" });
    else if (unit.state === "ready" && unit.type === "verify") transitionUnit(this.db, unitId, "blocked", { reason: "engine error" });
  }

  private settleFailures(project: Project): void {
    for (const u of listUnits(this.db, project.id)) {
      if (this.inflight.has(`unit:${u.id}`)) continue;
      if (u.type === "verify" && u.state === "failed") transitionUnit(this.db, u.id, "abandoned", { reason: "verifier attempt failed; outcome applied to its target" });
      if (u.type !== "work" || (u.state !== "failed" && u.state !== "rejected")) continue;
      const policy = failurePolicy(u, listAttempts(this.db, u.id));
      transitionUnit(this.db, u.id, policy.action === "retry" ? "ready" : "blocked", { reason: policy.reason });
      this.log(`  U${u.seq} ${policy.action === "retry" ? "retries" : "blocked"}: ${policy.reason}`);
    }
  }

  private land(project: Project): void {
    for (const u of listUnits(this.db, project.id).filter((x) => x.state === "verified" && x.repoId)) {
      const key = `land:${u.repoId}`;
      if (this.inflight.has(key)) continue;
      if (project.mergePolicy === "human") {
        const gate = listGates(this.db, project.id).filter((g) => g.kind === "land" && g.unitId === u.id).at(-1);
        if (!gate || gate.state === "cancelled") {
          addGate(this.db, { projectId: project.id, unitId: u.id, kind: "land", question: `U${u.seq} is verified. Land it on ${u.repoId}?`, options: ["land", "hold"], defaultOption: "hold" });
          this.log(`  gate: land U${u.seq}?`);
          continue;
        }
        if (gate.state !== "answered" || gate.answer !== "land") continue;
      }
      this.start(key, `land U${u.seq}`, () => landUnit(this.ctx, u.id), () => undefined);
    }
  }

  private planNeeded(project: Project): boolean {
    if (this.inflight.has(`plan:${project.id}`)) return false;
    const since = lastDrainEventId(this.db, project.id);
    if (since === 0) return true;
    const triggers = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND id > ? AND (
           (type = 'unit.state' AND json_extract(data_json, '$.to') IN (${PLAN_TRIGGERS.map(() => "?").join(", ")}) AND json_extract(data_json, '$.drain') IS NULL)
           OR type IN ('plan.rejected', 'project.andon_cleared', 'gate.answered'))`,
      )
      .get(project.id, since, ...PLAN_TRIGGERS) as { n: number };
    return triggers.n > 0;
  }

  private spawn(project: Project): void {
    const r = readiness(this.db, project.id);
    for (const s of r.stuck) {
      transitionUnit(this.db, s.unit.id, "blocked", { reason: s.reason });
      this.log(`  U${s.unit.seq} blocked: ${s.reason}`);
    }
    const cap = (key: Parameters<typeof resolveSetting>[1]) => resolveSetting(this.db, key, { projectId: project.id }).value as number;
    for (const u of r.ready) {
      if (this.inflight.has(`unit:${u.id}`)) continue;
      const harness = resolveSetting(this.db, u.type === "verify" ? "role.verifier.harness" : "role.worker.harness", { projectId: project.id }).value;
      if (runningAttempts(this.db) + this.pendingStarts() >= cap("max_parallel_agents")) return;
      if (runningAttempts(this.db, { harness }) >= cap("max_parallel_per_harness")) return;
      if (runningAttempts(this.db, { projectId: project.id }) + this.pendingStarts(project.id) >= cap("project.max_in_flight")) return;
      const run = u.type === "verify" ? () => runVerifyUnit(this.ctx, u.id) : () => runWorkUnit(this.ctx, u.id);
      this.start(`unit:${u.id}`, `${u.type} U${u.seq}: ${u.goal.slice(0, 80)}`, run, (e) => this.recoverCrashed(u.id, e));
    }
  }

  private pendingStarts(projectId?: ProjectId): number {
    let n = 0;
    for (const key of this.inflight.keys()) {
      if (!key.startsWith("unit:")) continue;
      const u = getUnit(this.db, Number(key.slice(5)) as UnitId);
      if (projectId && u.projectId !== projectId) continue;
      if (!listAttempts(this.db, u.id).some((a) => a.state === "running")) n++;
    }
    return n;
  }

  private maybeClose(project: Project): boolean {
    const delta = latestDelta(this.db, project.id);
    const units = listUnits(this.db, project.id).filter((u) => u.type !== "plan");
    if (!delta?.done || this.planNeeded(project) || units.some((u) => !TERMINAL.has(u.state) && u.state !== "blocked")) return false;
    if ([...this.inflight.keys()].some((k) => k === `plan:${project.id}`)) return false;
    setProjectState(this.db, project.id, "closed");
    this.log(`✔ project ${project.id} closed: ${delta.summary}`);
    return true;
  }

  async tick(): Promise<void> {
    if (this.inflight.size === 0) await reapLeases(this.db, this.ctx.boot);
    const projects = this.opts.projectId ? [getProject(this.db, this.opts.projectId)] : listProjects(this.db);
    for (const project of projects.filter((p) => p.state === "active")) {
      this.settleFailures(project);
      if (this.maybeClose(project)) continue;
      if (project.andonReason) continue;
      this.land(project);
      if (this.planNeeded(project))
        this.start(`plan:${project.id}`, `plan ${project.id}`, () => runPlanner(this.ctx, project.id), () => undefined);
      this.spawn(project);
    }
  }

  isIdle(): boolean {
    if (this.inflight.size) return false;
    const projects = this.opts.projectId ? [getProject(this.db, this.opts.projectId)] : listProjects(this.db);
    return projects.every((p) => {
      if (p.state !== "active") return true;
      if (p.andonReason) return true;
      if (this.planNeeded(p)) return false;
      if (readiness(this.db, p.id).ready.length) return false;
      if (listUnits(this.db, p.id).some((u) => u.state === "verified" && (p.mergePolicy === "auto" || landApproved(this.db, p.id, u)))) return false;
      return !listUnits(this.db, p.id).some((u) => u.type === "work" && (u.state === "failed" || u.state === "rejected"));
    });
  }

  recoverOrphans(): number {
    const orphans = this.db
      .prepare("SELECT a.id, a.pid, a.unit_id FROM attempts a WHERE a.state IN ('running', 'queued')")
      .all() as { id: number; pid: number | null; unit_id: number }[];
    for (const o of orphans) {
      if (o.pid) {
        try {
          process.kill(-o.pid, "SIGTERM");
        } catch {}
      }
      this.recoverCrashed(o.unit_id as UnitId, new Error("yagura restarted while this attempt was running"));
    }
    return orphans.length;
  }

  async runForever(signal: AbortSignal): Promise<void> {
    const tickMs = this.opts.tickMs ?? 2000;
    const recovered = this.recoverOrphans();
    if (recovered) this.log(`recovered ${recovered} attempt(s) left running by a previous process`);
    while (!signal.aborted) {
      await this.tick().catch((e: unknown) => this.log(`✗ tick: ${e instanceof Error ? e.message : String(e)}`));
      await Promise.race([
        ...this.inflight.values(),
        new Promise((r) => setTimeout(r, tickMs)),
        new Promise((r) => signal.addEventListener("abort", r, { once: true })),
      ]);
    }
    for (const a of this.db.prepare("SELECT id FROM attempts WHERE state = 'running'").all() as { id: number }[])
      stopAttempt(this.db, a.id as never, "yagura daemon shut down");
    await Promise.allSettled(this.inflight.values());
  }

  async runUntilIdle(): Promise<void> {
    const tickMs = this.opts.tickMs ?? 2000;
    for (;;) {
      await this.tick();
      if (this.isIdle()) return;
      await Promise.race([...this.inflight.values(), new Promise((r) => setTimeout(r, tickMs))]);
    }
  }
}

function landApproved(db: Db, projectId: ProjectId, u: Unit): boolean {
  const gate = listGates(db, projectId).filter((g) => g.kind === "land" && g.unitId === u.id).at(-1);
  return gate?.state === "answered" && gate.answer === "land";
}

