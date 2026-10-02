import { existsSync, readFileSync } from "node:fs";
import { stopAttempt, type RunContext } from "./agent.js";
import { resolveSetting } from "./config.js";
import { TERMINAL_STATES, isBuild, type Project, type ProjectId, type Unit, type UnitId } from "./domain.js";
import { markMergeChecked, openMergeRequests, prNoun, prRef } from "./forge.js";
import { parseHandoff } from "./handoff.js";
import { landUnit, watchMergeRequest, type LandResult } from "./land.js";
import { layout } from "./paths.js";
import { projectSkillChecks } from "./skills.js";
import { reapKept, reapLeases } from "./leases.js";
import { lastDrainEventId, latestDelta, runPlanner } from "./planner.js";
import { runRebaseUnit } from "./rebase.js";
import { reverifyAgainstSources, sourceDeps, staleSource } from "./sources.js";
import { queueTriage, runTriageUnit } from "./triage.js";
import { queueReview, reviewStatus, runReviewUnit } from "./review.js";
import { checkRetroWatch, watchingFor } from "./retro.js";
import { addVerifyUnit, runWorkUnit } from "./runner.js";
import { failurePolicy, readiness, runningAttempts } from "./schedule.js";
import { defaultExpiredGates, gateResolved } from "./gates.js";
import { resumeVerifications } from "./envpause.js";
import { queuePackEdits } from "./packedits.js";
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
  projectCost,
  setProjectState,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { postReport, reportKey, type ReportKind } from "./report.js";
import { listThreads } from "./threads.js";
import { runVerifyUnit } from "./verify.js";
import { sweepWorktrees } from "./worktrees.js";

export interface EngineOptions {
  projectId?: ProjectId;
  tickMs?: number;
  sweepMs?: number;
  log?: (line: string) => void;
}

export const LANDING_CUTOFF = 0.7;
const COST_WARNING = 0.8;
const PLAN_TRIGGERS = ["landed", "blocked", "abandoned"];
const YAGURA_GATES = ["report", "land", "environment", "review"];

function suggestsFollowUps(db: Db, boot: RunContext["boot"], unitId: UnitId): boolean {
  const unit = getUnit(db, unitId);
  const last = listAttempts(db, unitId)
    .filter((a) => a.state === "handed_off")
    .at(-1);
  const path = last ? layout(boot).handoff(unit.projectId, unit.seq, last.n) : null;
  const handoff = path && existsSync(path) ? parseHandoff(readFileSync(path, "utf8")) : null;
  return (handoff?.followUps ?? "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^[-*]\s*/, "")
        .trim()
        .replace(/[.()]/g, "")
        .toLowerCase(),
    )
    .some((l) => l && !["none", "n/a", "nothing"].includes(l));
}

export class Engine {
  private readonly inflight = new Map<string, Promise<void>>();
  private lastSweep = 0;
  private readonly landingSaid = new Map<UnitId, string>();
  private readonly cutoffSaid = new Set<ProjectId>();
  private readonly costSaid = new Set<ProjectId>();
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
    // A unit that crashes before it starts would crash again on the next tick, so it waits for someone to look.
    else if (unit.state === "ready")
      transitionUnit(this.db, unitId, "blocked", { reason: `engine error before it started: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
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
      // A consumer lands after what it builds against, and only on a verdict proven against that source as it is now.
      if (sourceDeps(this.db, u).some((d) => d.state !== "landed" && d.state !== "done")) continue;
      const stale = staleSource(this.db, u);
      if (stale) {
        reverifyAgainstSources(this.db, u, stale, (x) => addVerifyUnit(this.db, x));
        this.log(`  U${u.seq} re-verifies: ${stale}`);
        continue;
      }
      // Nothing lands before its code review settles (§24): queue the review, or the next triage wave once the developer answered.
      const review = reviewStatus(this.db, u);
      if (review.state === "needed") {
        const r = queueReview(this.db, u, review.since);
        this.log(`  review of U${u.seq} queued`);
        continue;
      }
      if (review.state === "answered") {
        const t = queueTriage(this.db, u, `the review of U${u.seq}`, review.fresh);
        if (t) this.log(`  triage of the review of U${u.seq} queued`);
        continue;
      }
      if (review.state !== "settled") continue;
      // One lander per repo: a unit whose pull request is open stays landing until it merges.
      if (listUnits(this.db, project.id).some((x) => x.repoId === u.repoId && x.state === "landing")) continue;
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
            question: `U${u.seq} is verified. ${onForge ? `Merge its ${prNoun(getRepo(this.db, u.repoId!).forge)}` : "Land it"} on ${u.repoId}?`,
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
        () => landUnit(this.ctx, u.id).then((r) => this.logLanding(u, r)),
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
        `watch ${prRef(mr.forge, mr.number)} for U${u.seq}`,
        () => watchMergeRequest(this.ctx, u.id).then((r) => this.logLanding(u, r)),
        (e) => {
          markMergeChecked(this.db, u.id);
          this.log(`  ✗ ${prRef(mr.forge, mr.number)}: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    }
  }

  // A pull request is polled every few seconds; say what it is waiting for only when that changes.
  private logLanding(u: Unit, r: LandResult | null): void {
    if (!r) return;
    const line = `${r.outcome}: ${r.reason}`;
    if (this.landingSaid.get(u.id) === line) return;
    this.landingSaid.set(u.id, line);
    this.log(`  U${u.seq} ${line}`);
  }

  // The share of the project's wall-clock budget used since it became active, or null without a budget.
  budgetUsed(project: Project, at = Date.now()): number | null {
    const hours = resolveSetting(this.db, "project.budget_hours", { projectId: project.id }).value;
    if (!hours) return null;
    const activated = this.db
      .prepare("SELECT ts FROM events WHERE type = 'project.state' AND project_id = ? AND json_extract(data_json, '$.state') = 'active' ORDER BY id LIMIT 1")
      .get(project.id) as { ts: string } | undefined;
    return (at - Date.parse(activated?.ts ?? project.createdAt)) / (hours * 3_600_000);
  }

  // Past the landing cutoff only what helps verified work land may start: verification, rebases, review triage.
  private mayStart(project: Project, u: Unit): boolean {
    const used = this.budgetUsed(project);
    return used === null || used < LANDING_CUTOFF || !isBuild(u);
  }

  // A drain costs a planner session, so only what can change the plan starts one: a unit that stopped short, a
  // question answered, a rejected delta, andon cleared, a spec edit, or work landing with nothing left queued or
  // with follow-ups suggested. Land, environment, and review gates, and pack units, are yagura's own to finish.
  private planNeeded(project: Project): boolean {
    if (this.inflight.has(`plan:${project.id}`)) return false;
    const since = lastDrainEventId(this.db, project.id);
    if (since === 0) return true;
    const events = this.db
      .prepare(
        `SELECT e.type, e.unit_id, e.data_json, u.type AS unit_type FROM events e LEFT JOIN units u ON u.id = e.unit_id WHERE e.project_id = ? AND e.id > ? AND (
           (e.type = 'unit.state' AND json_extract(e.data_json, '$.to') IN (${PLAN_TRIGGERS.map(() => "?").join(", ")}) AND json_extract(e.data_json, '$.drain') IS NULL AND json_extract(e.data_json, '$.rebaseUnit') IS NULL AND json_extract(e.data_json, '$.reviewUnit') IS NULL)
           OR (e.type IN ('gate.answered', 'gate.defaulted') AND COALESCE(json_extract(e.data_json, '$.kind'), '') NOT IN (${YAGURA_GATES.map(() => "?").join(", ")}))
           OR (e.type = 'disagreement.recorded' AND json_extract(e.data_json, '$.action') = 'follow-up')
           OR e.type IN ('plan.rejected', 'project.andon_cleared', 'project.spec_changed', 'retro.reverted'))`,
      )
      .all(project.id, since, ...PLAN_TRIGGERS, ...YAGURA_GATES) as { type: string; unit_id: UnitId | null; data_json: string; unit_type: string | null }[];
    const open = () => listUnits(this.db, project.id).some((u) => isBuild(u) && !TERMINAL_STATES.has(u.state) && u.state !== "blocked");
    return events.some((e) => {
      if (e.type !== "unit.state" || (JSON.parse(e.data_json) as { to: string }).to !== "landed") return true;
      if (e.unit_type === "pack") return false;
      return !open() || suggestsFollowUps(this.db, this.ctx.boot, e.unit_id!);
    });
  }

  private spawn(project: Project): void {
    const r = readiness(this.db, project.id);
    for (const s of r.stuck) {
      transitionUnit(this.db, s.unit.id, "blocked", { reason: s.reason });
      this.log(`  U${s.unit.seq} blocked: ${s.reason}`);
    }
    for (const u of r.ready) {
      if (this.inflight.has(`unit:${u.id}`) || !this.mayStart(project, u)) continue;
      const sctx = { projectId: project.id, repoId: u.repoId, environmentId: u.type === "verify" ? project.environmentId : null };
      const harness = resolveSetting(
        this.db,
        u.type === "verify" ? "role.verifier.harness" : u.type === "review" ? "role.reviewer.harness" : "role.worker.harness",
        sctx,
      ).value;
      if (runningAttempts(this.db) + this.pendingStarts() >= resolveSetting(this.db, "max_parallel_agents").value) return;
      if (runningAttempts(this.db, { harness }) >= resolveSetting(this.db, "max_parallel_per_harness").value) return;
      if (
        runningAttempts(this.db, { projectId: project.id }) + this.pendingStarts(project.id) >=
        resolveSetting(this.db, "project.max_in_flight", { projectId: project.id }).value
      )
        return;
      const run =
        u.type === "verify"
          ? () => runVerifyUnit(this.ctx, u.id)
          : u.type === "rebase"
            ? () => runRebaseUnit(this.ctx, u.id)
            : u.type === "review-triage"
              ? () => runTriageUnit(this.ctx, u.id)
              : u.type === "review"
                ? () => runReviewUnit(this.ctx, u.id)
                : () => runWorkUnit(this.ctx, u.id);
      this.start(`unit:${u.id}`, isBuild(u) ? `${u.type} U${u.seq}: ${u.goal.slice(0, 80)}` : `${u.type}: ${u.goal.slice(0, 80)}`, run, (e) =>
        this.recoverCrashed(u.id, e),
      );
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
    if (!delta?.done || this.planNeeded(project) || units.some((u) => !TERMINAL_STATES.has(u.state) && u.state !== "blocked")) return false;
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
    if (Date.now() - this.lastSweep > (this.opts.sweepMs ?? SWEEP_MS)) {
      this.lastSweep = Date.now();
      const swept = await sweepWorktrees(this.db, this.ctx.boot);
      if (swept) this.log(`  removed ${swept} checkout(s) of finished units`);
    }
    const expired = await reapKept(this.db, this.ctx.boot);
    if (expired) this.log(`  deleted ${expired} kept slot(s) past their time`);
    for (const g of defaultExpiredGates(this.db)) this.log(`  gate ${g.id} (${g.kind}) timed out: ${g.answer}`);
    for (const project of this.scope().filter((p) => p.state === "framing")) this.activate(project);
    for (const project of this.scope()) this.retro(project);
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
      const budgetUsd = resolveSetting(this.db, "project.budget_usd", { projectId: project.id }).value;
      if (budgetUsd !== null) {
        const spent = projectCost(this.db, project.id);
        if (spent >= budgetUsd && !project.andonReason) {
          setAndon(
            this.db,
            project.id,
            `the cost budget of $${budgetUsd.toFixed(2)} is used up ($${spent.toFixed(2)} spent); running agents finish and nothing new starts. Raise project.budget_usd to continue`,
          );
          continue;
        }
        if (spent >= budgetUsd * COST_WARNING && !this.costSaid.has(project.id)) {
          this.costSaid.add(project.id);
          this.log(`  ${project.id}: $${spent.toFixed(2)} of the $${budgetUsd.toFixed(2)} cost budget spent`);
        }
      }
      const used = this.budgetUsed(project);
      if (used !== null && used >= 1 && !project.andonReason) {
        const hours = resolveSetting(this.db, "project.budget_hours", { projectId: project.id }).value;
        setAndon(this.db, project.id, `the wall-clock budget of ${hours}h is used up; what was verified has landed, and the rest waits for you`);
        continue;
      }
      if (used !== null && used >= LANDING_CUTOFF && !this.cutoffSaid.has(project.id)) {
        this.cutoffSaid.add(project.id);
        this.log(`  ${project.id}: ${Math.round(used * 100)}% of the wall-clock budget used; no new work starts, verified work keeps landing`);
      }
      for (const u of await ensurePackUnits(this.ctx, project)) this.log(`  U${u.seq}: ${u.goal}`);
      for (const u of await queuePackEdits(this.ctx, project)) this.log(`  U${u.seq}: ${u.goal}`);
      for (const u of resumeVerifications(this.db, project.id)) this.log(`  U${u.seq}: ${u.goal} (verification resumed)`);
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
      if (readiness(this.db, p.id).ready.some((u) => this.mayStart(p, u))) return false;
      if (listUnits(this.db, p.id).some((u) => u.state === "verified" && this.wouldMove(p, u))) return false;
      return !listUnits(this.db, p.id).some((u) => isBuild(u) && (u.state === "failed" || u.state === "rejected"));
    });
  }

  // Landed commits are watched for a while, whatever state their project is in: trunk CI on the forge, and reverts.
  private retro(project: Project): void {
    const poll = resolveSetting(this.db, "forge.poll_seconds").value * 1000;
    for (const w of watchingFor(this.db, project.id)) {
      const key = `retro:${w.unitId}`;
      if (this.inflight.has(key) || (w.checkedAt && Date.now() - Date.parse(w.checkedAt) < poll)) continue;
      this.start(
        key,
        `retro watch ${project.id} ${w.sha.slice(0, 10)}`,
        () => checkRetroWatch(this.ctx, w).then((said) => said && this.log(`  ${said}`)),
        () => undefined,
      );
    }
  }

  // A verified unit the engine would act on now: queue its review or triage, or land it.
  private wouldMove(p: Project, u: Unit): boolean {
    const review = reviewStatus(this.db, u).state;
    if (review === "needed" || review === "answered") return true;
    return review === "settled" && (p.mergePolicy === "auto" || landApproved(this.db, p.id, u));
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
    const aborted = new Promise((r) => signal.addEventListener("abort", r, { once: true }));
    while (!signal.aborted) {
      await this.tick().catch((e: unknown) => this.log(`✗ tick: ${e instanceof Error ? e.message : String(e)}`));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([...this.inflight.values(), new Promise((r) => (timer = setTimeout(r, tickMs))), aborted]);
      clearTimeout(timer);
      // A task that settles at once must not keep the loop on microtasks, or timers and signals never run.
      await new Promise((r) => setImmediate(r));
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

const SWEEP_MS = 60_000;

function landApproved(db: Db, projectId: ProjectId, u: Unit): boolean {
  const gate = listGates(db, projectId)
    .filter((g) => g.kind === "land" && g.unitId === u.id)
    .at(-1);
  return !!gate && gateResolved(gate, "land");
}
