import { stopAttempt, type RunContext } from "./agent.js";
import { resolveSetting } from "./config.js";
import { TERMINAL_STATES, isBuild, type Project, type ProjectId, type Unit, type UnitId } from "./domain.js";
import { layout } from "./paths.js";
import { projectSkillChecks } from "./skills.js";
import { reapKept, reapLeases } from "./leases.js";
import { lastDrainEventId, latestDelta, runPlanner } from "./planner.js";
import { checkRetroWatch, scanReverts, watchingFor } from "./retro.js";
import { currentRound, runWorkerRound } from "./runner.js";
import { runJudgeRound } from "./judge.js";
import { pendingWake, runLeadRound } from "./lead.js";
import { checkReady, syncWithBase, unitsOnBase } from "./merge.js";
import { ensureMirror, resolveRef } from "./git.js";
import { readiness, runningAttempts } from "./schedule.js";
import { defaultExpiredGates, gateResolved } from "./gates.js";
import {
  addGate,
  getProject,
  getRepo,
  getUnit,
  lastTransition,
  listAttempts,
  listGates,
  listProjects,
  listUnits,
  now,
  recordEvent,
  setAndon,
  projectCost,
  projectRepos,
  setProjectState,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { activeHold } from "./limits.js";
import { answerIssue, listIssues, pollIssues, watchedRepos } from "./issues.js";
import { postReport, reportKey, type ReportKind } from "./report.js";
import { listThreads } from "./threads.js";
import { listTurns, stopTurn } from "./turns.js";
import { doctorWake, runDoctorRound } from "./doctor.js";
import { sweepWorktrees } from "./worktrees.js";
import { savedHandoff } from "./finish.js";

export interface EngineOptions {
  projectId?: ProjectId;
  tickMs?: number;
  sweepMs?: number;
  revertScanMs?: number;
  log?: (line: string) => void;
}

export const LANDING_CUTOFF = 0.7;
const COST_WARNING = 0.8;
const PLAN_TRIGGERS = ["merged", "stuck", "dropped"];
const YAGURA_GATES = ["report", "land", "environment", "lead"];

function suggestsFollowUps(db: Db, unitId: UnitId): boolean {
  const last = listAttempts(db, unitId)
    .filter((a) => a.state === "handed_off")
    .at(-1);
  const handoff = last ? savedHandoff(db, last.id) : null;
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
  private lastRevertScan = 0;
  private readonly issuesPolledAt = new Map<string, number>();
  private readonly readyCheckedAt = new Map<UnitId, number>();
  private readonly basePolledAt = new Map<string, number>();
  private readonly baseSeen = new Map<string, string>();
  private readonly cutoffSaid = new Set<ProjectId>();
  private readonly costSaid = new Set<ProjectId>();
  private holdSaid: string | null = null;
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

  // A quiet start (routine polling: retro watches, revert scans) logs only what it finds and its errors.
  private start(key: string, label: string, work: () => Promise<unknown>, onError: (e: unknown) => void, quiet = false): void {
    if (!quiet) this.log(`▶ ${label}`);
    const p = work()
      .then(() => {
        if (!quiet) this.log(`■ ${label}`);
      })
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
    if (unit.state === "building" || unit.state === "judging")
      transitionUnit(this.db, unitId, "stuck", { reason: `engine error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, trigger: "engine" });
    // A unit that crashes before it starts would crash again on the next tick, so it waits for someone to look.
    else if (unit.state === "waiting")
      transitionUnit(this.db, unitId, "stuck", { reason: `engine error before it started: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
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

  // Past the landing cutoff only what is not a build may start.
  private mayStart(project: Project, u: Unit): boolean {
    const used = this.budgetUsed(project);
    return used === null || used < LANDING_CUTOFF || !isBuild(u);
  }

  // A drain costs a planner session, so only what can change the plan starts one: a unit that stopped short, a
  // question answered, a rejected delta, andon cleared, a spec edit, or work landing with nothing left queued or
  // with follow-ups suggested. Land, environment, and review gates are yagura's own to finish.
  private planNeeded(project: Project): boolean {
    if (this.inflight.has(`plan:${project.id}`)) return false;
    const since = lastDrainEventId(this.db, project.id);
    if (since === 0) return true;
    const events = this.db
      .prepare(
        `SELECT e.type, e.unit_id, e.data_json, u.type AS unit_type FROM events e LEFT JOIN units u ON u.id = e.unit_id WHERE e.project_id = ? AND e.id > ? AND (
           (e.type = 'unit.state' AND json_extract(e.data_json, '$.to') IN (${PLAN_TRIGGERS.map(() => "?").join(", ")}) AND json_extract(e.data_json, '$.drain') IS NULL)
           OR (e.type IN ('gate.answered', 'gate.defaulted') AND COALESCE(json_extract(e.data_json, '$.kind'), '') NOT IN (${YAGURA_GATES.map(() => "?").join(", ")}))
           OR (e.type = 'disagreement.recorded' AND json_extract(e.data_json, '$.action') = 'follow-up')
           OR e.type IN ('plan.rejected', 'project.andon_cleared', 'project.spec_changed', 'retro.reverted', 'lead.replan'))`,
      )
      .all(project.id, since, ...PLAN_TRIGGERS, ...YAGURA_GATES) as { type: string; unit_id: UnitId | null; data_json: string; unit_type: string | null }[];
    const open = () => listUnits(this.db, project.id).some((u) => isBuild(u) && !TERMINAL_STATES.has(u.state) && u.state !== "stuck");
    return events.some((e) => {
      const to = e.type === "unit.state" ? (JSON.parse(e.data_json) as { to: string }).to : null;
      if (to !== "merged") return true;
      if (e.unit_type === "plan") return false;
      return !open() || suggestsFollowUps(this.db, e.unit_id!);
    });
  }

  // An agent slot is free under every cap: across yagura, on the harness, and in the project.
  private slotFree(project: Project, harness: string): boolean {
    if (runningAttempts(this.db) + this.pendingStarts() >= resolveSetting(this.db, "max_parallel_agents").value) return false;
    if (runningAttempts(this.db, { harness }) >= resolveSetting(this.db, "max_parallel_per_harness").value) return false;
    return (
      runningAttempts(this.db, { projectId: project.id }) + this.pendingStarts(project.id) <
      resolveSetting(this.db, "project.max_in_flight", { projectId: project.id }).value
    );
  }

  private unitTask(unitId: UnitId, label: string, work: () => Promise<unknown>, quiet = false): void {
    this.start(`unit:${unitId}`, label, work, (e) => this.recoverCrashed(unitId, e), quiet);
  }

  // Each state has one step: a worker round for building, a judge round for judging, and a check of what a ready unit waits for.
  private spawn(project: Project): void {
    const r = readiness(this.db, project.id);
    for (const s of r.stuck) {
      transitionUnit(this.db, s.unit.id, "stuck", { reason: s.reason });
      this.log(`  U${s.unit.seq} stuck: ${s.reason}`);
    }
    const at = (u: Unit) => ({ projectId: project.id, repoId: u.repoId ?? undefined });
    const startable = new Set(r.ready.filter((u) => this.mayStart(project, u)).map((u) => u.id));
    for (const u of listUnits(this.db, project.id)) {
      if (!isBuild(u) || this.inflight.has(`unit:${u.id}`)) continue;
      const label = `U${u.seq}: ${u.goal.slice(0, 80)}`;
      const wake = u.state === "stuck" || u.state === "ready" ? pendingWake(this.db, u) : null;
      if (wake) {
        if (this.slotFree(project, resolveSetting(this.db, "role.lead.harness", at(u)).value))
          this.unitTask(u.id, `unit lead ${label} (${wake.trigger})`, () => runLeadRound(this.ctx, u.id, wake));
        continue;
      }
      if ((u.state === "waiting" && startable.has(u.id)) || u.state === "building") {
        if (!this.slotFree(project, resolveSetting(this.db, "role.worker.harness", at(u)).value)) continue;
        if (u.state === "waiting") transitionUnit(this.db, u.id, "building", { round: this.roundFromWaiting(u) });
        this.unitTask(u.id, `worker ${label}`, () => runWorkerRound(this.ctx, u.id));
      } else if (u.state === "judging") {
        if (!this.slotFree(project, resolveSetting(this.db, "role.judge.harness", at(u)).value)) continue;
        this.unitTask(u.id, `judge ${label}`, () => runJudgeRound(this.ctx, u.id));
      } else if (u.state === "ready" && this.readyDue(u)) {
        this.readyCheckedAt.set(u.id, Date.now());
        this.unitTask(
          u.id,
          `ready ${label}`,
          async () => {
            const merged = await checkReady(this.ctx, u.id);
            if (merged) {
              this.log(`✔ U${u.seq} merged`);
              this.syncBase(merged.repoId, merged.base);
            }
            // Without a forge there is no CI to wait for, so the next look need not wait for the poll.
            if (getRepo(this.db, u.repoId!).forge === "none") this.readyCheckedAt.delete(u.id);
          },
          true,
        );
      }
    }
  }

  // A repo gets a doctor when none has looked at it in this environment, when the developer asks, or when an action for it broke.
  // One doctor per repo and environment at a time, whichever project woke it.
  private doctors(project: Project): void {
    if (!project.environmentId) return;
    for (const repo of projectRepos(this.db, project.id)) {
      const key = `doctor:${project.environmentId}:${repo.id}`;
      if (this.inflight.has(key)) continue;
      const wake = doctorWake(this.db, project.id, repo.id);
      if (!wake || !this.slotFree(project, resolveSetting(this.db, "role.doctor.harness", { projectId: project.id }).value)) continue;
      this.start(
        key,
        `doctor ${repo.id} (${wake.trigger})`,
        () => runDoctorRound(this.ctx, project.id, repo.id, wake),
        (e) => this.log(`✗ doctor ${repo.id}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`),
      );
    }
  }

  // A unit leaving waiting starts its first round, or a fresh worker when an earlier one stopped or failed.
  private roundFromWaiting(u: Unit) {
    const round = currentRound(this.db, u.id);
    const why = lastTransition(this.db, u.id)?.data.reason;
    return round.kind === "fresh" && typeof why === "string" ? { kind: "fresh" as const, reason: why } : round;
  }

  private readyDue(u: Unit): boolean {
    const poll = resolveSetting(this.db, "forge.poll_seconds").value * 1000;
    return Date.now() - (this.readyCheckedAt.get(u.id) ?? 0) >= poll;
  }

  // Every open unit on a base that just moved is checked against it, unless an agent is on it.
  private syncBase(repoId: string, base: string): void {
    for (const u of unitsOnBase(this.db, repoId, base)) {
      if (this.inflight.has(`unit:${u.id}`)) continue;
      this.unitTask(
        u.id,
        `base check U${u.seq} on ${base}`,
        () => syncWithBase(this.ctx, u.id).then((r) => r !== "current" && this.log(`  U${u.seq}: ${r === "conflict" ? "conflicts with" : "merged"} ${base}`)),
        true,
      );
    }
  }

  // A base that moved outside yagura (someone merged by hand) is noticed at the forge poll rate.
  private baseMoves(): void {
    const poll = resolveSetting(this.db, "forge.poll_seconds").value * 1000;
    const bases = new Map<string, { repoId: string; base: string }>();
    for (const p of this.scope())
      for (const u of listUnits(this.db, p.id))
        if (u.repoId && u.branch && (u.state === "judging" || u.state === "ready")) {
          const base = u.base ?? getRepo(this.db, u.repoId).defaultBranch;
          bases.set(`${u.repoId}:${base}`, { repoId: u.repoId, base });
        }
    for (const [key, { repoId, base }] of bases) {
      if (this.inflight.has(`base:${key}`) || Date.now() - (this.basePolledAt.get(key) ?? 0) < poll) continue;
      this.basePolledAt.set(key, Date.now());
      this.start(
        `base:${key}`,
        `base ${key}`,
        async () => {
          const repo = getRepo(this.db, repoId as never);
          const mirror = layout(this.ctx.boot).mirror(repo.id);
          await ensureMirror(repo.url, mirror);
          const sha = await resolveRef(mirror, `refs/remotes/origin/${base}`);
          const seen = this.baseSeen.get(key);
          this.baseSeen.set(key, sha);
          if (seen && seen !== sha) this.syncBase(repoId, base);
        },
        () => undefined,
        true,
      );
    }
  }

  private pendingStarts(projectId?: ProjectId): number {
    let n = 0;
    for (const key of this.inflight.keys()) {
      if (!key.startsWith("unit:")) continue;
      const u = getUnit(this.db, Number(key.slice(5)) as UnitId);
      if (projectId && u.projectId !== projectId) continue;
      if ((u.state === "building" || u.state === "judging") && !listAttempts(this.db, u.id).some((a) => a.state === "running")) n++;
    }
    return n;
  }

  private maybeClose(project: Project): boolean {
    const delta = latestDelta(this.db, project.id);
    const units = listUnits(this.db, project.id).filter(isBuild);
    if (!delta?.done || this.planNeeded(project) || units.some((u) => !TERMINAL_STATES.has(u.state) && u.state !== "stuck")) return false;
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
    if (units.some((u) => this.inflight.has(`unit:${u.id}`) || ["waiting", "building", "judging", "ready"].includes(u.state))) return null;
    const blocked = units.filter((u) => isBuild(u) && u.state === "stuck").map((u) => u.seq);
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
    if (!this.opts.projectId) this.issues();
    if (Date.now() - this.lastRevertScan > (this.opts.revertScanMs ?? REVERT_SCAN_MS)) {
      this.lastRevertScan = Date.now();
      const repos = this.db.prepare("SELECT DISTINCT repo_id AS id FROM units WHERE merged_sha IS NOT NULL").all() as { id: string }[];
      for (const { id } of repos)
        if (!this.inflight.has(`reverts:${id}`))
          this.start(
            `reverts:${id}`,
            `revert scan ${id}`,
            () => scanReverts(this.ctx, id).then((said) => said.forEach((s) => this.log(`  ${s}`))),
            () => undefined,
            true,
          );
    }
    // While the account's usage limit holds, sessions already running wait it out and nothing new starts.
    const hold = activeHold(this.db);
    if (hold && hold.until !== this.holdSaid) {
      this.holdSaid = hold.until;
      this.log(`  usage limit on ${hold.harness}: no new agents until ${new Date(hold.until).toLocaleString()}`);
    }
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
      if (this.maybeClose(project)) continue;
      if (project.andonReason) continue;
      if (hold) continue;
      if (this.planNeeded(project))
        this.start(
          `plan:${project.id}`,
          `plan ${project.id}`,
          () => runPlanner(this.ctx, project.id),
          () => undefined,
        );
      this.spawn(project);
      this.doctors(project);
    }
    this.baseMoves();
    this.report(this.scope());
  }

  isIdle(): boolean {
    if (this.inflight.size) return false;
    const projects = this.scope();
    if (projects.some((p) => this.activationDue(p)) || this.dueReports(projects).length) return false;
    const held = activeHold(this.db) !== null;
    return projects.every((p) => {
      if (p.state !== "active") return true;
      if (p.andonReason || held) return true;
      if (this.planNeeded(p)) return false;
      if (p.environmentId && projectRepos(this.db, p.id).some((r) => doctorWake(this.db, p.id, r.id))) return false;
      if (readiness(this.db, p.id).ready.some((u) => this.mayStart(p, u))) return false;
      // A ready unit is settled only while it waits for the developer's go.
      const waitsForYou = (u: Unit) => listGates(this.db, p.id, "open").some((g) => g.unitId === u.id);
      return !listUnits(this.db, p.id).some(
        (u) => u.state === "building" || u.state === "judging" || (u.state === "ready" && !waitsForYou(u)) || (u.state === "stuck" && pendingWake(this.db, u)),
      );
    });
  }

  // Issues on watched repos (§30): one poll per repo at the forge poll rate, then each issue's waiting comments are answered.
  // A usage-limit hold only delays the watchman's turns, which wait inside their sessions like any agent.
  private issues(): void {
    const poll = resolveSetting(this.db, "forge.poll_seconds").value * 1000;
    for (const repo of watchedRepos(this.db)) {
      const key = `issues:${repo.id}`;
      if (this.inflight.has(key) || Date.now() - (this.issuesPolledAt.get(repo.id) ?? 0) < poll) continue;
      this.issuesPolledAt.set(repo.id, Date.now());
      this.start(
        key,
        `issues ${repo.id}`,
        async () => {
          await pollIssues(this.ctx, repo);
          for (const issue of listIssues(this.db, repo.id)) await answerIssue(this.ctx, repo, issue.number);
        },
        () => undefined,
        true,
      );
    }
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
        true,
      );
    }
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
    for (const t of listTurns(this.db).filter((x) => x.state === "running")) stopTurn(this.db, t.id, "the yagura daemon shut down; send your message again");
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
const REVERT_SCAN_MS = 5 * 60_000;
