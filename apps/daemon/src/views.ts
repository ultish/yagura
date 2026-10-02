import { existsSync, readFileSync } from "node:fs";
import {
  BUILD_TYPES_SQL,
  listValues,
  PRESETS,
  isBuild,
  diffRange,
  getAttempt,
  type AttemptId,
  gateDeadline,
  recentlyResolvedGates,
  getEnvironment,
  keepable,
  PROVIDERS_IMPL,
  runningAttempts as runningCount,
  type EnvironmentId,
  getRepo,
  layout,
  parsePack,
  readFileAt,
  resolveRef,
  type Bootstrap,
  type RepoId,
  getProject,
  getUnit,
  latestDelta,
  listAttempts,
  listEvidenceRuns,
  listGates,
  listProposals,
  listThreads,
  listUnits,
  liveVerdict,
  ProposalBody,
  readiness,
  resolveSetting,
  describeRoute,
  isRemote,
  projectCost,
  type Db,
  type ProjectId,
  type Unit,
  type UnitId,
  pausedBy,
} from "@yagura/core";

type Row = Record<string, unknown>;

const runningAttempts = (db: Db, projectId: ProjectId, type?: string) =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ? AND a.state = 'running' ${type ? "AND u.type = ?" : ""}`,
      )
      .get(...(type ? [projectId, type] : [projectId])) as { n: number }
  ).n;

export function projectSummary(db: Db, projectId: ProjectId) {
  const project = getProject(db, projectId);
  const units = listUnits(db, projectId);
  const counts: Record<string, number> = {};
  for (const u of units.filter(isBuild)) counts[u.state] = (counts[u.state] ?? 0) + 1;
  const lastLanded = units.filter((u) => u.landedSha).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    project,
    workCounts: counts,
    running: runningAttempts(db, projectId) - runningAttempts(db, projectId, "plan"),
    planning: runningAttempts(db, projectId, "plan") > 0,
    maxInFlight: resolveSetting(db, "project.max_in_flight", { projectId }).value,
    openGates: listGates(db, projectId, "open").length,
    blocked: counts.blocked ?? 0,
    lastLanded: lastLanded ? { seq: lastLanded.seq, sha: lastLanded.landedSha, at: lastLanded.updatedAt } : null,
    summary: latestDelta(db, projectId)?.summary ?? null,
    costUsd: projectCost(db, projectId),
    budgetUsd: resolveSetting(db, "project.budget_usd", { projectId }).value,
  };
}

function blockedReason(db: Db, unitId: UnitId): string | null {
  const row = db
    .prepare("SELECT data_json FROM events WHERE unit_id = ? AND type = 'unit.state' AND json_extract(data_json, '$.to') = 'blocked' ORDER BY id DESC LIMIT 1")
    .get(unitId) as { data_json: string } | undefined;
  const reason = row ? (JSON.parse(row.data_json) as { reason?: unknown }).reason : null;
  return reason == null ? null : typeof reason === "string" ? reason : JSON.stringify(reason);
}

export function unitView(db: Db, u: Unit) {
  const verdict = liveVerdict(db, u.id);
  return {
    ...u,
    attempts: listAttempts(db, u.id),
    verdict: verdict ? { id: verdict.id, tier: verdict.tier, headSha: verdict.head_sha } : null,
    blockedReason: u.state === "blocked" ? blockedReason(db, u.id) : null,
  };
}

export type BellItem =
  | {
      kind: "gate";
      id: string;
      projectId: string;
      unit: { seq: number; goal: string } | null;
      gate: { id: number; kind: string; question: string; options: string[]; defaultOption: string | null; deadline: string | null };
      at: string;
    }
  | {
      kind: "blocked";
      id: string;
      projectId: string;
      unit: { seq: number; goal: string };
      reason: string | null;
      attempts: number;
      maxAttempts: number;
      at: string;
    }
  | { kind: "proposal"; id: string; threadId: number; threadTitle: string; proposalId: number; summary: string; at: string };

export function bell(db: Db): BellItem[] {
  const items: BellItem[] = [];
  for (const g of listGates(db, null, "open")) {
    const unit = g.unitId ? getUnit(db, g.unitId) : null;
    items.push({
      kind: "gate",
      id: `gate:${g.id}`,
      projectId: g.projectId,
      unit: unit ? { seq: unit.seq, goal: unit.goal } : null,
      gate: { id: g.id, kind: g.kind, question: g.question, options: g.options, defaultOption: g.defaultOption, deadline: gateDeadline(db, g) },
      at: g.createdAt,
    });
  }
  for (const u of db.prepare(`SELECT id FROM units WHERE type IN ${BUILD_TYPES_SQL} AND state = 'blocked' ORDER BY updated_at`).all() as { id: number }[]) {
    const unit = getUnit(db, u.id as UnitId);
    items.push({
      kind: "blocked",
      id: `blocked:${unit.id}`,
      projectId: unit.projectId,
      unit: { seq: unit.seq, goal: unit.goal },
      reason: blockedReason(db, unit.id),
      attempts: listAttempts(db, unit.id).length,
      maxAttempts: unit.maxAttempts,
      at: unit.updatedAt,
    });
  }
  for (const t of listThreads(db).filter((x) => x.state === "open")) {
    for (const p of listProposals(db, t.id, "pending")) {
      const body = ProposalBody.safeParse(p.body);
      items.push({
        kind: "proposal",
        id: `proposal:${p.id}`,
        threadId: t.id,
        threadTitle: t.title,
        proposalId: p.id,
        summary: body.success ? body.data.summary : "proposal",
        at: p.createdAt,
      });
    }
  }
  return items;
}

export function attemptDetail(db: Db, paths: { brief: string; handoff: string; leftovers: string }, attemptId: number) {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const attempt = listAttempts(db, (db.prepare("SELECT unit_id FROM attempts WHERE id = ?").get(attemptId) as { unit_id: UnitId }).unit_id).find(
    (a) => a.id === attemptId,
  )!;
  const unit = getUnit(db, attempt.unitId);
  const project = getProject(db, unit.projectId);
  const verifications = (db.prepare("SELECT id FROM units WHERE target_unit_id = ? AND type = 'verify' ORDER BY seq").all(unit.id) as { id: number }[]).map(
    (v) => {
      const vu = getUnit(db, v.id as UnitId);
      const attempts = listAttempts(db, vu.id);
      return {
        unit: { id: vu.id, seq: vu.seq, state: vu.state },
        attempts: attempts.map((a) => ({ id: a.id, n: a.n, state: a.state, runs: listEvidenceRuns(db, a.id) })),
      };
    },
  );
  const target = unit.targetUnitId ? getUnit(db, unit.targetUnitId) : null;
  return {
    attempt,
    unit: unitView(db, unit),
    project: { id: project.id, minTier: project.minTier, state: project.state },
    target: target ? { id: target.id, seq: target.seq, goal: target.goal } : null,
    timeboxSeconds: unit.timeboxSeconds,
    brief: read(paths.brief),
    handoff: read(paths.handoff),
    leftovers: read(paths.leftovers),
    runs: listEvidenceRuns(db, attempt.id),
    verifications,
    waiting: readiness(db, unit.projectId).waiting.find((w) => w.unit.id === unit.id)?.reason ?? null,
    kept: keptSlots(db, { attemptId: attempt.id }),
  };
}

export async function repoView(db: Db, boot: Bootstrap, repoId: RepoId) {
  const repo = getRepo(db, repoId);
  const mirror = layout(boot).mirror(repoId);
  const trunk = existsSync(mirror) ? await resolveRef(mirror, `origin/${repo.defaultBranch}`).catch(() => null) : null;
  const pack = trunk ? parsePack(await readFileAt(mirror, trunk, `${repo.verifyPackPath}/verify.json`), repo.verifyPackPath) : null;
  const projects = db
    .prepare("SELECT p.id, p.state FROM project_repos pr JOIN projects p ON p.id = pr.project_id WHERE pr.repo_id = ? ORDER BY p.created_at")
    .all(repoId) as { id: string; state: string }[];
  const units = db
    .prepare(
      `SELECT project_id, seq, goal, state, landed_sha, updated_at FROM units WHERE repo_id = ? AND type IN ${BUILD_TYPES_SQL} AND state IN ('verified', 'landed') ORDER BY updated_at DESC`,
    )
    .all(repoId) as Row[];
  const ref = (u: Row) => ({ projectId: u.project_id as string, seq: u.seq as number, goal: u.goal as string, at: u.updated_at as string });
  const landed = units.filter((u) => u.state === "landed");
  return {
    repo,
    trunk,
    route: { text: `lands ${describeRoute(repo)}`, confirmed: !(repo.forge === "none" && isRemote(repo.url) && !repo.pushConfirmed) },
    pack: pack
      ? pack.ok
        ? { ok: true as const, checks: pack.pack.checks.map((c) => ({ name: c.name, tier: c.tier })) }
        : { ok: false as const, reason: pack.reason }
      : null,
    projects,
    landingQueue: units.filter((u) => u.state === "verified").map(ref),
    landedCount: landed.length,
    lastLanded: landed[0] ? { ...ref(landed[0]), sha: landed[0].landed_sha as string } : null,
  };
}

export function environmentView(db: Db, id: EnvironmentId) {
  const env = getEnvironment(db, id);
  const leases = db
    .prepare(
      `SELECT l.state, l.slot, l.attempt_id, l.requested_at, l.granted_at, u.project_id, u.seq, u.type, u.goal
       FROM leases l JOIN attempts a ON a.id = l.attempt_id JOIN units u ON u.id = a.unit_id
       WHERE l.environment_id = ? AND l.state IN ('active', 'queued') ORDER BY l.id`,
    )
    .all(id) as Row[];
  const holder = (l: Row) => ({
    attemptId: l.attempt_id as number,
    unit: { projectId: l.project_id as string, seq: l.seq as number, type: l.type as string, goal: l.goal as string },
  });
  return {
    environment: env,
    implemented: !!PROVIDERS_IMPL[env.provider],
    active: leases.filter((l) => l.state === "active").map((l) => ({ ...holder(l), slot: l.slot as string, since: l.granted_at as string })),
    queued: leases.filter((l) => l.state === "queued").map((l) => ({ ...holder(l), since: l.requested_at as string })),
    projects: db.prepare("SELECT id, state FROM projects WHERE environment_id = ? ORDER BY created_at").all(id) as { id: string; state: string }[],
    kept: keptSlots(db, { environmentId: id }),
    pausedBy: pausedBy(db, id),
  };
}

// Slots a verification left up on purpose (the keep policy), with what a developer needs to go and look.
export function keptSlots(db: Db, where: { environmentId?: EnvironmentId; attemptId?: number }) {
  return (
    db
      .prepare(
        `SELECT l.id, l.slot, l.vars_json, l.kept_until, l.kept_reason, l.attempt_id, u.project_id, u.seq, u.goal
         FROM leases l JOIN attempts a ON a.id = l.attempt_id JOIN units u ON u.id = a.unit_id
         WHERE l.kept_until IS NOT NULL AND (? IS NULL OR l.environment_id = ?) AND (? IS NULL OR l.attempt_id = ?) ORDER BY l.id`,
      )
      .all(where.environmentId ?? null, where.environmentId ?? null, where.attemptId ?? null, where.attemptId ?? null) as Row[]
  ).map((l) => {
    const vars = JSON.parse(l.vars_json as string) as Record<string, string>;
    return {
      leaseId: l.id as number,
      attemptId: l.attempt_id as number,
      unit: { projectId: l.project_id as string, seq: l.seq as number, goal: l.goal as string },
      until: l.kept_until as string,
      reason: (l.kept_reason as string) ?? "",
      namespace: vars.YAGURA_NAMESPACE ?? null,
      context: vars.KUBECONTEXT ?? null,
      leaseDir: vars.YAGURA_LEASE_DIR ?? null,
    };
  });
}

export function environmentDetail(db: Db, id: EnvironmentId) {
  const sctx = { environmentId: id };
  return {
    ...environmentView(db, id),
    values: listValues(db, id),
    keep: {
      policy: resolveSetting(db, "lease.keep", sctx),
      hours: resolveSetting(db, "lease.keep_hours", sctx),
      keeps: keepable(getEnvironment(db, id)),
    },
    presets: PRESETS,
  };
}

export function capCounts(db: Db) {
  const harnesses = db.prepare("SELECT harness, COUNT(*) AS n FROM attempts WHERE state = 'running' GROUP BY harness").all() as {
    harness: string;
    n: number;
  }[];
  const projects = (db.prepare("SELECT id FROM projects WHERE state != 'closed' ORDER BY created_at").all() as { id: ProjectId }[]).map(({ id }) => ({
    id,
    running: runningCount(db, { projectId: id }),
    limit: resolveSetting(db, "project.max_in_flight", { projectId: id }).value,
  }));
  return {
    max_parallel_agents: { running: runningCount(db), limit: resolveSetting(db, "max_parallel_agents").value },
    max_parallel_per_harness: {
      limit: resolveSetting(db, "max_parallel_per_harness").value,
      byHarness: Object.fromEntries(harnesses.map((h) => [h.harness, h.n])),
    },
    "project.max_in_flight": projects,
  };
}

export function resolvedGates(db: Db) {
  return recentlyResolvedGates(db).map((g) => {
    const unit = g.unitId ? getUnit(db, g.unitId) : null;
    return { ...g, unit: unit ? { seq: unit.seq, goal: unit.goal } : null };
  });
}

const MAX_DIFF = 2 * 1024 * 1024;

export async function attemptDiff(db: Db, boot: Bootstrap, attemptId: AttemptId) {
  const attempt = getAttempt(db, attemptId);
  const unit = getUnit(db, attempt.unitId);
  if (!unit.repoId || !attempt.baseSha || !attempt.headSha) return { base: attempt.baseSha, head: attempt.headSha, text: null, truncated: false };
  if (attempt.baseSha === attempt.headSha) return { base: attempt.baseSha, head: attempt.headSha, text: "", truncated: false };
  const text = await diffRange(layout(boot).mirror(unit.repoId), attempt.baseSha, attempt.headSha).catch(() => null);
  return { base: attempt.baseSha, head: attempt.headSha, text: text?.slice(0, MAX_DIFF) ?? null, truncated: (text?.length ?? 0) > MAX_DIFF };
}
