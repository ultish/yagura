import { stopAttempt, type RunContext } from "./agent.js";
import { resolveSetting } from "./config.js";
import { isBuild, type Project, type ProjectId, type Unit, type UnitId } from "./domain.js";
import { markMergeChecked, openMergeRequests } from "./forge.js";
import { landUnit, watchMergeRequest } from "./land.js";
import { projectSkillChecks } from "./skills.js";
import { reapKept, reapLeases } from "./leases.js";
import { lastDrainEventId, latestDelta, runPlanner } from "./planner.js";
import { runWorkUnit } from "./runner.js";
import { failurePolicy, readiness, runningAttempts } from "./schedule.js";
import { defaultExpiredGates, gateResolved } from "./gates.js";
import { ensurePackUnits } from "./packs.js";
import {
  addGate,
  getProject,
  getRepo,
  getUnit,
  listAttempts,
  listGates,
  listProjects,
  listUnits,
  now,
  recordEvent,
  setAndon,
  setProjectState,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { postReport, reportKey, type ReportKind } from "./report.js";
import { listThreads } from "./threads.js";
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
    for (const a of listAttempts(this.db, unitId))
      if (a.state === "running" || a.state === "queued") updateAttempt(this.db, a.id, { state: "failed", endedAt: now(), failureMode: "harness-error" });
    if (unit.state === "running") transitionUnit(this.db, unitId, "failed", { reason: "engine error" });
    else if (unit.state === "ready" && unit.type === "verify") transitionUnit(this.db, unitId, "blocked", { reason: "engine error" });
  }

  private settleFailures(project: Project): void {
    for (const u of listUnits(this.db, project.id)) {
      if (this.inflight.has(`unit:${u.id}`)) continue;
      if (u.type === "verify" && u.state === "failed")
        transitionUnit(this.db, u.id, "abandoned", { reason: "verifier attempt failed; outcome applied to its target" });
      if (!isBuild(u) || (u.state !== "failed" && u.state !== "rejected")) continue;
      const policy = failurePolicy(u, listAttempts(this.db, u.id));
      transitionUnit(this.db, u.id, policy.action === "retry" ? "ready" : "blocked", { reason: policy.reason });
      this.log(`  U${u.seq} ${policy.action === "retry" ? "retries" : "blocked"}: ${policy.reason}`);
    }
  }

  private land(project: Project): void {
    for (const u of listUnits(this.db, project.id).filter((x) => x.state === "verified" && x.repoId)) {
      const key = `land:${u.repoId}`;
      if (this.inflight.has(key)) continue;
      const onForge = getRepo(this.db, u.repoId!).forge !== "none";
      if (project.mergePolicy === "human") {
        const gate = listGates(this.db, project.id)
          .filter((g) => g.kind === "land" && g.unitId === u.id)
          .at(-1);
        if (!gate || gate.state === "cancelled") {
          addGate(this.db, {
            projectId: project.id,
            unitId: u.id,
            kind: "land",
            question: `U${u.seq} is verified. ${onForge ? "Merge its pull request" : "Land it"} on ${u.repoId}?`,
            options: ["land", "hold"],
            defaultOption: "hold",
          });
          this.log(`  gate: land U${u.seq}?`);
        }
        // On a forge the pull request opens now so it can be reviewed there; the gate decides the merge.
        if (!onForge && !landApproved(this.db, project.id, u)) continue;
      }
      this.start(
        key,
        `land U${u.seq}`,
        () => landUnit(this.ctx, u.id),
        () => undefined,
      );
    }
    const poll = resolveSetting(this.db, "forge.poll_seconds").value * 1000;
    for (const mr of openMergeRequests(this.db)) {
      const u = getUnit(this.db, mr.unitId);
      if (u.projectId !== project.id) continue;
      const key = `land:${u.repoId}`;
      if (this.inflight.has(key) || (mr.checkedAt && Date.now() - Date.parse(mr.checkedAt) < poll)) continue;
      this.start(
        key,
        `watch pull request #${mr.number} for U${u.seq}`,
        () => watchMergeRequest(this.ctx, u.id),
        (e) => {
          markMergeChecked(this.db, u.id);
          this.log(`  ✗ pull request #${mr.number}: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
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
           OR (type IN ('gate.answered', 'gate.defaulted') AND COALESCE(json_extract(data_json, '$.kind'), '') <> 'report')
           OR type IN ('plan.rejected', 'project.andon_cleared', 'project.spec_changed'))`,
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
    for (const u of r.ready) {
      if (this.inflight.has(`unit:${u.id}`)) continue;
      const sctx = { projectId: project.id, repoId: u.repoId, environmentId: u.type === "verify" ? project.environmentId : null };
      const harness = resolveSetting(this.db, u.type === "verify" ? "role.verifier.harness" : "role.worker.harness", sctx).value;
      if (runningAttempts(this.db) + this.pendingStarts() >= resolveSetting(this.db, "max_parallel_agents").value) return;
      if (runningAttempts(this.db, { harness }) >= resolveSetting(this.db, "max_parallel_per_harness").value) return;
      if (
        runningAttempts(this.db, { projectId: project.id }) + this.pendingStarts(project.id) >=
        resolveSetting(this.db, "project.max_in_flight", { projectId: project.id }).value
      )
        return;
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

  private activationDue(project: Project): "activate" | "gate" | null {
    if (project.state !== "framing" || !project.after.every((a) => getProject(this.db, a).state === "closed")) return null;
    if (!project.phaseGate) return "activate";
    const gate = listGates(this.db, project.id)
      .filter((g) => g.kind === "phase")
      .at(-1);
    if (!gate || gate.state === "cancelled") return "gate";
    return gateResolved(gate, "start") ? "activate" : null;
  }

  private activate(project: Project): void {
    const due = this.activationDue(project);
    if (due === "gate") {
      addGate(this.db, {
        projectId: project.id,
        kind: "phase",
        question: `${project.after.join(", ")} closed. Start ${project.id}: ${project.goal}?`,
        options: ["start", "hold"],
        defaultOption: "hold",
      });
      this.log(`  gate: start ${project.id}?`);
    }
    if (due !== "activate") return;
    setProjectState(this.db, project.id, "active");
    this.log(`▲ project ${project.id} activated (after ${project.after.join(", ")})`);
  }

  private stalled(project: Project): number[] | null {
    if (project.state !== "active" || project.andonReason) return null;
    if ([...this.inflight.keys()].some((k) => k === `plan:${project.id}`)) return null;
    const units = listUnits(this.db, project.id);
    if (units.some((u) => this.inflight.has(`unit:${u.id}`) || ["ready", "running", "handed_off", "verifying", "verified", "landing"].includes(u.state)))
      return null;
    const blocked = units.filter((u) => isBuild(u) && u.state === "blocked").map((u) => u.seq);
    return blocked.length && !this.planNeeded(project) ? blocked : null;
  }

  private dueReports(projects: Project[]): { threadId: number; projectId: ProjectId; kind: ReportKind }[] {
    const due: { threadId: number; projectId: ProjectId; kind: ReportKind }[] = [];
    for (const thread of listThreads(this.db).filter((t) => t.state === "open")) {
      for (const project of projects.filter((p) => thread.projects.includes(p.id))) {
        const p = getProject(this.db, project.id);
        const blocked = this.stalled(p);
        const kind: ReportKind | null =
          p.state === "closed" ? { kind: "closed" } : p.andonReason ? { kind: "andon", reason: p.andonReason } : blocked ? { kind: "stalled", blocked } : null;
        if (kind && thread.reported[p.id] !== reportKey(kind)) due.push({ threadId: thread.id, projectId: p.id, kind });
      }
    }
    return due;
  }

  private report(projects: Project[]): void {
    for (const r of this.dueReports(projects)) {
      const key = `report:${r.threadId}:${r.projectId}`;
      if (!this.inflight.has(key))
        this.start(
          key,
          `report ${r.projectId} → thread ${r.threadId}`,
          () => postReport(this.ctx, r.threadId, r.projectId, r.kind),
          () => undefined,
        );
    }
  }

  private scope(): Project[] {
    return this.opts.projectId ? [getProject(this.db, this.opts.projectId)] : listProjects(this.db);
  }

  async tick(): Promise<void> {
    if (this.inflight.size === 0) await reapLeases(this.db, this.ctx.boot);
    const expired = await reapKept(this.db, this.ctx.boot);
    if (expired) this.log(`  deleted ${expired} kept slot(s) past their time`);
    for (const g of defaultExpiredGates(this.db)) this.log(`  gate ${g.id} (${g.kind}) timed out: ${g.answer}`);
    for (const project of this.scope().filter((p) => p.state === "framing")) this.activate(project);
    for (const project of this.scope().filter((p) => p.state === "active")) {
      const missing = projectSkillChecks(this.db, this.ctx.boot, project.id).filter((c) => !c.installed);
      if (missing.length) {
        if (!project.andonReason)
          setAndon(
            this.db,
            project.id,
            `skills not installed where agents run: ${missing.map((c) => `${c.skill} (${c.purposes.join(", ")})`).join("; ")}. Install them or change the project's skills settings, then clear the andon`,
          );
        continue;
      }
      for (const u of await ensurePackUnits(this.ctx, project)) this.log(`  U${u.seq}: ${u.goal}`);
      this.settleFailures(project);
      if (this.maybeClose(project)) continue;
      if (project.andonReason) continue;
      this.land(project);
      if (this.planNeeded(project))
        this.start(
          `plan:${project.id}`,
          `plan ${project.id}`,
          () => runPlanner(this.ctx, project.id),
          () => undefined,
        );
      this.spawn(project);
    }
    this.report(this.scope());
  }

  isIdle(): boolean {
    if (this.inflight.size) return false;
    const projects = this.scope();
    if (projects.some((p) => this.activationDue(p)) || this.dueReports(projects).length) return false;
    return projects.every((p) => {
      if (p.state !== "active") return true;
      if (p.andonReason) return true;
      if (this.planNeeded(p)) return false;
      if (readiness(this.db, p.id).ready.length) return false;
      if (listUnits(this.db, p.id).some((u) => u.state === "verified" && (p.mergePolicy === "auto" || landApproved(this.db, p.id, u)))) return false;
      return !listUnits(this.db, p.id).some((u) => isBuild(u) && (u.state === "failed" || u.state === "rejected"));
    });
  }

  recoverOrphans(): number {
    const orphans = this.db.prepare("SELECT a.id, a.pid, a.unit_id FROM attempts a WHERE a.state IN ('running', 'queued')").all() as {
      id: number;
      pid: number | null;
      unit_id: number;
    }[];
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
  const gate = listGates(db, projectId)
    .filter((g) => g.kind === "land" && g.unitId === u.id)
    .at(-1);
  return !!gate && gateResolved(gate, "land");
}
