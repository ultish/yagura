import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runAgentSession, stopRequested, write, type RunContext } from "./agent.js";
import { renderPlanBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import type { ProjectId } from "./domain.js";
import { addDetachedWorktree, ensureMirror, removeWorktree, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { applyDelta, extractDelta, PlanRejected, WORK_PLAYBOOKS, type PlanDelta } from "./plan.js";
import { generateStatus } from "./status.js";
import { addUnit, createAttempt, getProject, now, projectRepos, recordEvent, setAndon, transitionUnit, updateAttempt, type Db } from "./store.js";

export interface PlanResult {
  drainId: number;
  outcome: "applied" | "rejected" | "failed";
  delta: PlanDelta | null;
  reason: string;
}

const MAX_CONSECUTIVE_REJECTIONS = 3;
const STOPPED = "planner stopped by operator";

export function lastDrainEventId(db: Db, projectId: ProjectId): number {
  return (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE project_id = ? AND type = 'plan.drain_started'").get(projectId) as { id: number }).id;
}

export function latestDelta(db: Db, projectId: ProjectId): PlanDelta | null {
  const row = db.prepare("SELECT delta_json FROM drains WHERE project_id = ? AND applied = 1 ORDER BY id DESC LIMIT 1").get(projectId) as { delta_json: string } | undefined;
  return row ? (JSON.parse(row.delta_json) as PlanDelta) : null;
}

function consecutiveRejections(db: Db, projectId: ProjectId): number {
  const rows = db
    .prepare("SELECT applied, rejection FROM drains WHERE project_id = ? AND finished_at IS NOT NULL AND COALESCE(rejection, '') <> ? ORDER BY id DESC LIMIT ?")
    .all(projectId, STOPPED, MAX_CONSECUTIVE_REJECTIONS) as { applied: number }[];
  let n = 0;
  for (const r of rows) {
    if (r.applied) break;
    n++;
  }
  return n;
}

export async function runPlanner(ctx: RunContext, projectId: ProjectId): Promise<PlanResult> {
  const { db, boot } = ctx;
  const project = getProject(db, projectId);
  const sctx = { projectId };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.planner.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);
  const since = lastDrainEventId(db, projectId);

  const drainId = Number(db.prepare("INSERT INTO drains (project_id, started_at) VALUES (?, ?)").run(projectId, now()).lastInsertRowid);
  recordEvent(db, "plan.drain_started", { projectId }, { drain: drainId });
  const unit = addUnit(db, {
    projectId,
    type: "plan",
    repoId: null,
    goal: `Plan drain ${drainId}`,
    writeScope: [],
    acceptance: ["a valid plan delta"],
    verify: null,
    timeboxSeconds: setting("timebox.plan_seconds"),
    maxAttempts: 1,
  });
  transitionUnit(db, unit.id, "ready", { drain: drainId });
  const attempt = createAttempt(db, unit.id, harnessId, setting("role.planner.model"));
  db.prepare("UPDATE drains SET planner_attempt_id = ? WHERE id = ?").run(attempt.id, drainId);

  const checkouts: { id: string; path: string; trunkSha: string; mirror: string }[] = [];
  for (const repo of projectRepos(db, projectId)) {
    const mirror = paths.mirror(repo.id);
    await ensureMirror(repo.url, mirror);
    const trunkSha = await resolveRef(mirror, `origin/${repo.defaultBranch}`);
    const path = join(dirname(paths.worktree(repo.id, projectId, unit.seq, attempt.n)), `${projectId}-plan${drainId}`);
    mkdirSync(dirname(path), { recursive: true });
    await addDetachedWorktree(mirror, path, trunkSha);
    checkouts.push({ id: repo.id, path, trunkSha, mirror });
  }

  const finish = (outcome: PlanResult["outcome"], reason: string, delta: PlanDelta | null): PlanResult => {
    db.prepare("UPDATE drains SET delta_json = ?, applied = ?, rejection = ?, finished_at = ? WHERE id = ?").run(
      delta ? JSON.stringify(delta) : null,
      outcome === "applied" ? 1 : 0,
      outcome === "applied" ? null : reason,
      now(),
      drainId,
    );
    if (outcome !== "applied" && reason !== STOPPED) recordEvent(db, "plan.rejected", { projectId, unitId: unit.id }, { drain: drainId, reason });
    recordEvent(db, "plan.drain_finished", { projectId, unitId: unit.id }, { drain: drainId, outcome, reason });
    if (outcome !== "applied" && consecutiveRejections(db, projectId) >= MAX_CONSECUTIVE_REJECTIONS)
      setAndon(db, projectId, `planner failed to produce a valid plan ${MAX_CONSECUTIVE_REJECTIONS} times in a row; last: ${reason}`);
    return { drainId, outcome, delta, reason };
  };

  try {
    const status = generateStatus(db, boot, projectId, since);
    write(join(boot.home, "projects", projectId, "status.md"), status);
    const standingPath = paths.standingOrders(projectId);
    const briefText = renderPlanBrief({
      project: { id: project.id, goal: project.goal, predicate: project.predicate, minTier: project.minTier },
      repos: checkouts.map(({ id, path, trunkSha }) => ({ id, path, trunkSha })),
      status,
      playbooks: WORK_PLAYBOOKS,
      standing: existsSync(standingPath) ? readFileSync(standingPath, "utf8") : "",
      timeboxMinutes: setting("timebox.work_seconds") / 60,
    });
    write(paths.brief(projectId, unit.seq, attempt.n), briefText);
    transitionUnit(db, unit.id, "running", { attempt: attempt.n });
    updateAttempt(db, attempt.id, { state: "running", startedAt: now() });

    const session = await runAgentSession(ctx, {
      attempt,
      unit,
      projectId,
      role: "planner",
      adapter,
      run: {
        prompt: briefText,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.planner.model"),
        permissionMode: setting("harness.claude.permission_mode"),
        pluginDirs: [boot.skillsDir],
        addDirs: checkouts.slice(1).map((c) => c.path),
        extraArgs: setting("harness.claude.extra_args"),
      },
      cwd: checkouts[0]?.path ?? join(boot.home, "projects", projectId),
      env: {},
      timeboxSeconds: unit.timeboxSeconds,
      logPath: paths.log(projectId, unit.seq, attempt.n),
    });
    if (stopRequested(db, attempt.id).stopped) {
      updateAttempt(db, attempt.id, { state: "stopped", endedAt: now(), exitCode: session.exitCode });
      transitionUnit(db, unit.id, "failed", { drain: drainId, reason: "stopped by operator" });
      transitionUnit(db, unit.id, "abandoned", { drain: drainId });
      return finish("failed", STOPPED, null);
    }
    const text = session.final && !session.final.isError && !session.timedOut ? session.final.text : null;
    if (text) write(paths.handoff(projectId, unit.seq, attempt.n), text);
    updateAttempt(db, attempt.id, { state: text ? "handed_off" : "failed", endedAt: now(), exitCode: session.exitCode, failureMode: text ? null : session.timedOut ? "timebox" : "unknown" });
    if (!text) {
      transitionUnit(db, unit.id, "failed", { drain: drainId });
      return finish("failed", "planner ended without a final message", null);
    }
    transitionUnit(db, unit.id, "handed_off", { drain: drainId });
    transitionUnit(db, unit.id, "done", { drain: drainId });

    const extracted = extractDelta(text);
    if (!extracted.ok) return finish("rejected", extracted.reason, null);
    try {
      const applied = applyDelta(db, projectId, extracted.delta, drainId);
      return finish("applied", applied.warnings.join("; ") || extracted.delta.summary, extracted.delta);
    } catch (e) {
      if (e instanceof PlanRejected) return finish("rejected", e.message, extracted.delta);
      throw e;
    }
  } finally {
    for (const c of checkouts) await removeWorktree(c.mirror, c.path).catch(() => undefined);
  }
}
