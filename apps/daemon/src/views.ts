import { existsSync, readFileSync } from "node:fs";
import {
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
  type Db,
  type ProjectId,
  type Unit,
  type UnitId,
} from "@yagura/core";

type Row = Record<string, unknown>;

const runningAttempts = (db: Db, projectId: ProjectId, type?: string) =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ? AND a.state = 'running' ${type ? "AND u.type = ?" : ""}`)
      .get(...(type ? [projectId, type] : [projectId])) as { n: number }
  ).n;

export function projectSummary(db: Db, projectId: ProjectId) {
  const project = getProject(db, projectId);
  const units = listUnits(db, projectId);
  const counts: Record<string, number> = {};
  for (const u of units.filter((x) => x.type === "work")) counts[u.state] = (counts[u.state] ?? 0) + 1;
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
  | { kind: "gate"; id: string; projectId: string; unit: { seq: number; goal: string } | null; gate: { id: number; kind: string; question: string; options: string[]; defaultOption: string | null }; at: string }
  | { kind: "blocked"; id: string; projectId: string; unit: { seq: number; goal: string }; reason: string | null; attempts: number; maxAttempts: number; at: string }
  | { kind: "proposal"; id: string; threadId: number; threadTitle: string; proposalId: number; summary: string; at: string };

export function bell(db: Db): BellItem[] {
  const items: BellItem[] = [];
  const gates = db.prepare("SELECT id, project_id, unit_id, kind, question, options_json, default_option, created_at FROM gates WHERE state = 'open' ORDER BY id").all() as Row[];
  for (const g of gates) {
    const unit = g.unit_id ? getUnit(db, g.unit_id as UnitId) : null;
    items.push({
      kind: "gate",
      id: `gate:${g.id}`,
      projectId: g.project_id as string,
      unit: unit ? { seq: unit.seq, goal: unit.goal } : null,
      gate: { id: g.id as number, kind: g.kind as string, question: g.question as string, options: JSON.parse(g.options_json as string), defaultOption: (g.default_option as string | null) ?? null },
      at: g.created_at as string,
    });
  }
  for (const u of db.prepare("SELECT id FROM units WHERE type = 'work' AND state = 'blocked' ORDER BY updated_at").all() as { id: number }[]) {
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
      items.push({ kind: "proposal", id: `proposal:${p.id}`, threadId: t.id, threadTitle: t.title, proposalId: p.id, summary: body.success ? body.data.summary : "proposal", at: p.createdAt });
    }
  }
  return items;
}

export function attemptDetail(db: Db, paths: { brief: string; handoff: string; leftovers: string }, attemptId: number) {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const attempt = listAttempts(db, (db.prepare("SELECT unit_id FROM attempts WHERE id = ?").get(attemptId) as { unit_id: UnitId }).unit_id).find((a) => a.id === attemptId)!;
  const unit = getUnit(db, attempt.unitId);
  const project = getProject(db, unit.projectId);
  const verifications = (db.prepare("SELECT id FROM units WHERE target_unit_id = ? AND type = 'verify' ORDER BY seq").all(unit.id) as { id: number }[]).map((v) => {
    const vu = getUnit(db, v.id as UnitId);
    const attempts = listAttempts(db, vu.id);
    return { unit: { id: vu.id, seq: vu.seq, state: vu.state }, attempts: attempts.map((a) => ({ id: a.id, n: a.n, state: a.state, runs: listEvidenceRuns(db, a.id) })) };
  });
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
    .prepare("SELECT project_id, seq, goal, state, landed_sha, updated_at FROM units WHERE repo_id = ? AND type = 'work' AND state IN ('verified', 'landed') ORDER BY updated_at DESC")
    .all(repoId) as Row[];
  const ref = (u: Row) => ({ projectId: u.project_id as string, seq: u.seq as number, goal: u.goal as string, at: u.updated_at as string });
  const landed = units.filter((u) => u.state === "landed");
  return {
    repo,
    trunk,
    pack: pack ? (pack.ok ? { ok: true as const, checks: pack.pack.checks.map((c) => ({ name: c.name, tier: c.tier })) } : { ok: false as const, reason: pack.reason }) : null,
    projects,
    landingQueue: units.filter((u) => u.state === "verified").map(ref),
    landedCount: landed.length,
    lastLanded: landed[0] ? { ...ref(landed[0]), sha: landed[0].landed_sha as string } : null,
  };
}
