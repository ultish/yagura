import { resolveSetting } from "./config.js";
import type { IsoTime, Sha, Unit, UnitId } from "./domain.js";
import { forgeFor } from "./forge.js";
import { ensureMirror, git } from "./git.js";
import { layout } from "./paths.js";
import type { Bootstrap } from "./config.js";
import { addUnit, addUnitNote, getProject, getRepo, getUnit, now, recordEvent, setProjectState, transitionUnit, type Db } from "./store.js";
import { addMessage, threadsForProject } from "./threads.js";

export const RETRO_STATES = ["watching", "passed", "failed", "reverted", "expired"] as const;
export type RetroState = (typeof RETRO_STATES)[number];

export interface RetroWatch {
  unitId: UnitId;
  sha: Sha;
  until: IsoTime;
  state: RetroState;
  reruns: number;
  detail: string | null;
  fixUnitId: UnitId | null;
  checkedAt: IsoTime | null;
}

type Row = Record<string, unknown>;
const toWatch = (r: Row): RetroWatch => ({
  unitId: r.unit_id as UnitId,
  sha: r.sha as Sha,
  until: r.until as IsoTime,
  state: r.state as RetroState,
  reruns: r.reruns as number,
  detail: (r.detail as string | null) ?? null,
  fixUnitId: (r.fix_unit_id as UnitId | null) ?? null,
  checkedAt: (r.checked_at as IsoTime | null) ?? null,
});

// After a unit lands, its trunk commit is watched for a while: the forge's CI on it, and anyone reverting it.
export function startRetroWatch(db: Db, unit: Unit, sha: Sha): void {
  const minutes = resolveSetting(db, "retro.watch_minutes", { projectId: unit.projectId, repoId: unit.repoId }).value;
  if (!minutes) return;
  db.prepare(
    `INSERT INTO retro_watches (unit_id, sha, until, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (unit_id) DO UPDATE SET sha = excluded.sha, until = excluded.until, state = 'watching', reruns = 0, detail = NULL, checked_at = NULL`,
  ).run(unit.id, sha, new Date(Date.now() + minutes * 60_000).toISOString(), now());
}

export function getRetroWatch(db: Db, unitId: UnitId): RetroWatch | null {
  const r = db.prepare("SELECT * FROM retro_watches WHERE unit_id = ?").get(unitId) as Row | undefined;
  return r ? toWatch(r) : null;
}

export function watchingFor(db: Db, projectId: string): RetroWatch[] {
  return (
    db.prepare("SELECT w.* FROM retro_watches w JOIN units u ON u.id = w.unit_id WHERE u.project_id = ? AND w.state = 'watching'").all(projectId) as Row[]
  ).map(toWatch);
}

function settle(db: Db, unit: Unit, state: RetroState, detail: string, fixUnitId: UnitId | null = null): void {
  db.prepare("UPDATE retro_watches SET state = ?, detail = ?, fix_unit_id = ?, checked_at = ? WHERE unit_id = ?").run(state, detail, fixUnitId, now(), unit.id);
  recordEvent(db, `retro.${state}`, { projectId: unit.projectId, unitId: unit.id }, { detail, fixUnit: fixUnitId });
}

function tell(db: Db, unit: Unit, body: string): void {
  for (const t of threadsForProject(db, unit.projectId)) addMessage(db, { threadId: t, role: "system", body });
}

// A commit on trunk after the landed one whose message says it reverts it.
async function revertOf(mirror: string, branch: string, sha: Sha): Promise<{ sha: string; subject: string } | null> {
  const log = await git(["log", "--format=%H%x1f%s%x1f%b%x1e", `${sha}..origin/${branch}`], { gitDir: mirror }).catch(() => "");
  for (const entry of log.split("\x1e")) {
    const [commit, subject, body] = entry.trim().split("\x1f");
    if (commit && new RegExp(`This reverts commit ${sha.slice(0, 12)}`).test(`${body ?? ""}`)) return { sha: commit, subject: subject ?? "" };
  }
  return null;
}

// One look at a watched commit. Returns what changed, for the daemon log.
export async function checkRetroWatch(ctx: { db: Db; boot: Bootstrap }, w: RetroWatch): Promise<string | null> {
  const { db, boot } = ctx;
  const unit = getUnit(db, w.unitId);
  const repo = getRepo(db, unit.repoId!);
  const mirror = layout(boot).mirror(repo.id);
  db.prepare("UPDATE retro_watches SET checked_at = ? WHERE unit_id = ?").run(now(), unit.id);
  await ensureMirror(repo.url, mirror);
  const reverted = await revertOf(mirror, repo.defaultBranch, w.sha);
  if (reverted) {
    const detail = `${reverted.sha.slice(0, 10)} reverted it on ${repo.defaultBranch}: ${reverted.subject}`;
    settle(db, unit, "reverted", detail);
    addUnitNote(db, unit.id, `Reverted on trunk after landing: ${detail}`);
    tell(
      db,
      unit,
      `**${unit.projectId}/U${unit.seq} was reverted on ${repo.defaultBranch}** (${detail}). The project lead will see it the next time it plans.`,
    );
    return `U${unit.seq} was reverted: ${detail}`;
  }
  const forge = forgeFor(db, repo);
  const expired = Date.parse(w.until) <= Date.now();
  if (!forge) {
    if (expired) settle(db, unit, "expired", "no forge CI to watch; no revert seen");
    return null;
  }
  const checks = await forge.commitChecks(w.sha);
  if (checks === "success") {
    settle(db, unit, "passed", `trunk CI passed on ${w.sha.slice(0, 10)}`);
    return `U${unit.seq}: trunk CI passed`;
  }
  if (checks === "none" || checks === "pending") {
    if (expired) settle(db, unit, "expired", checks === "none" ? "no CI ran on the landed commit" : "trunk CI was still running when the watch ended");
    return null;
  }
  const failing = await forge.failedRuns(w.sha);
  if (w.reruns === 0 && failing.length) {
    for (const r of failing) await forge.rerunFailed(r.id);
    db.prepare("UPDATE retro_watches SET reruns = reruns + 1 WHERE unit_id = ?").run(unit.id);
    recordEvent(db, "retro.rerun", { projectId: unit.projectId, unitId: unit.id }, { runs: failing.map((r) => r.id) });
    return `U${unit.seq}: trunk CI failed on ${w.sha.slice(0, 10)}; re-running ${failing.map((r) => r.name).join(", ")} once`;
  }
  const fix = queueTrunkFix(db, unit, w.sha, failing);
  settle(db, unit, "failed", `trunk CI failed on ${w.sha.slice(0, 10)}: ${failing.map((r) => r.name).join(", ") || "a failing check"}`, fix.id);
  return `U${unit.seq}: trunk CI failed again; queued U${fix.seq}: ${fix.goal}`;
}

// A broken trunk becomes ordinary work, judged and merged like any unit: a fix, or a revert when the project allows it.
function queueTrunkFix(db: Db, broke: Unit, sha: Sha, failing: { name: string; log: string }[]): Unit {
  const project = getProject(db, broke.projectId);
  const revert = resolveSetting(db, "project.auto_revert", { projectId: project.id }).value;
  const jobs = failing.map((r) => r.name).join(", ") || "the trunk CI";
  const unit = addUnit(db, {
    projectId: project.id,
    type: "work",
    repoId: broke.repoId,
    base: broke.base,
    goal: revert
      ? `Revert U${broke.seq} (${sha.slice(0, 10)}) on trunk: ${jobs} fails after it landed`
      : `Fix trunk: ${jobs} fails on ${sha.slice(0, 10)} after U${broke.seq} landed (${broke.goal})`,
    acceptance: revert
      ? [`trunk no longer contains U${broke.seq}'s change: \`git revert --no-edit ${sha}\` and nothing else`, `${jobs} passes`]
      : [`${jobs} passes on trunk`, ...broke.acceptance],
    context: failing.map((r) => `Failing job ${r.name} on ${sha.slice(0, 10)}, last lines:\n${r.log}`),
    playbook: revert ? undefined : "bug-fix",
    timeboxSeconds: resolveSetting(db, "timebox.work_seconds", { projectId: project.id, repoId: broke.repoId! }).value,
    maxAttempts: 2,
  });
  recordEvent(db, "retro.fix_queued", { projectId: project.id, unitId: unit.id }, { retro: broke.seq, revert });
  if (project.state === "closed") setProjectState(db, project.id, "active");
  addUnitNote(db, broke.id, `Trunk CI failed after it landed (${jobs}); ${revert ? "reverting" : "fixing"} in U${unit.seq}.`);
  tell(
    db,
    broke,
    `**Trunk broke after ${project.id}/U${broke.seq} landed**: ${jobs} fails on ${sha.slice(0, 10)}. yagura queued U${unit.seq} to ${revert ? "revert it" : "fix it"}.`,
  );
  return getUnit(db, unit.id);
}

// The watch above sees a revert only while it lasts. This scan reads every commit trunk gained since the last scan, so a
// revert of any landed unit is noticed however long after it landed. The first scan of a repo only sets where to start.
export async function scanReverts(ctx: { db: Db; boot: Bootstrap }, repoId: string): Promise<string[]> {
  const { db, boot } = ctx;
  const repo = getRepo(db, repoId as never);
  const mirror = layout(boot).mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const trunk = (await git(["rev-parse", `origin/${repo.defaultBranch}`], { gitDir: mirror })).trim();
  const from = (db.prepare("SELECT revert_scan_sha FROM repos WHERE id = ?").get(repo.id) as { revert_scan_sha: string | null }).revert_scan_sha;
  const said: string[] = [];
  if (from && from !== trunk) {
    const log = await git(["log", "--format=%H%x1f%s%x1f%b%x1e", `${from}..${trunk}`], { gitDir: mirror }).catch(() => "");
    for (const entry of log.split("\x1e")) {
      const [commit, subject, body] = entry.trim().split("\x1f");
      if (!commit) continue;
      for (const [, reverted] of (body ?? "").matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
        const unit = db.prepare("SELECT id FROM units WHERE repo_id = ? AND merged_sha LIKE ? AND state = 'merged'").get(repo.id, `${reverted}%`) as
          { id: UnitId } | undefined;
        if (!unit || getRetroWatch(db, unit.id)?.state === "reverted") continue;
        const u = getUnit(db, unit.id);
        const detail = `${commit.slice(0, 10)} reverted it on ${repo.defaultBranch}: ${subject ?? ""}`;
        db.prepare(
          `INSERT INTO retro_watches (unit_id, sha, until, created_at, state) VALUES (?, ?, ?, ?, 'watching')
           ON CONFLICT (unit_id) DO NOTHING`,
        ).run(u.id, u.mergedSha, now(), now());
        settle(db, u, "reverted", detail);
        addUnitNote(db, u.id, `Reverted on trunk after landing: ${detail}`);
        tell(db, u, `**${u.projectId}/U${u.seq} was reverted on ${repo.defaultBranch}** (${detail}). The project lead will see it the next time it plans.`);
        said.push(`${u.projectId}/U${u.seq} was reverted: ${detail}`);
      }
    }
  }
  if (from !== trunk) db.prepare("UPDATE repos SET revert_scan_sha = ? WHERE id = ?").run(trunk, repo.id);
  return said;
}
