import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Bootstrap } from "./config.js";
import { resolveSetting } from "./config.js";
import { PACK_EDIT_HARNESS, type AttemptId, type Project, type Repo, type Sha, type Unit, type UnitId } from "./domain.js";
import { addWorktree, ensureMirror, git, gitWithEnv, removeWorktree, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { addVerifyUnit } from "./runner.js";
import { addUnit, createAttempt, getAttempt, getRepo, getUnit, now, recordEvent, transitionUnit, updateAttempt, type Db } from "./store.js";

export interface PackEdit {
  id: number;
  attemptId: AttemptId;
  targetUnitId: UnitId;
  baseSha: Sha;
  sha: Sha;
  branch: string;
  summary: string;
  state: "pending" | "queued" | "dropped";
  packUnitId: UnitId | null;
  reason: string | null;
}

const toEdit = (r: Record<string, unknown>): PackEdit => ({
  id: r.id as number,
  attemptId: r.attempt_id as AttemptId,
  targetUnitId: r.target_unit_id as UnitId,
  baseSha: r.base_sha as Sha,
  sha: r.sha as Sha,
  branch: r.branch as string,
  summary: r.summary as string,
  state: r.state as PackEdit["state"],
  packUnitId: (r.pack_unit_id as UnitId | null) ?? null,
  reason: (r.reason as string | null) ?? null,
});

export function listPackEdits(db: Db, targetUnitId: UnitId): PackEdit[] {
  return (db.prepare("SELECT * FROM pack_edits WHERE target_unit_id = ? ORDER BY id").all(targetUnitId) as Record<string, unknown>[]).map(toEdit);
}

export const packWorkspace = (headWorktree: string) => `${headWorktree}.pack`;

// Where a verification reads and runs its pack from: the verifier's own editable copy, except for a pack unit's proof.
export function packWorkspaceOf(db: Db, attemptId: AttemptId): string | null {
  const attempt = getAttempt(db, attemptId);
  const unit = getUnit(db, attempt.unitId);
  if (unit.type !== "verify" || !unit.targetUnitId || getUnit(db, unit.targetUnitId).type === "pack" || !attempt.worktreePath) return null;
  const ws = packWorkspace(attempt.worktreePath);
  return existsSync(ws) ? ws : null;
}

// A later verifier of the same unit starts from the edits earlier verifiers made, so a fixed pack stays fixed.
export async function openPackWorkspace(
  db: Db,
  a: { mirror: string; repo: Repo; projectId: string; target: Unit; verifySeq: number; head: string },
): Promise<{ path: string; start: Sha }> {
  const pending = listPackEdits(db, a.target.id).filter((e) => e.state === "pending");
  const start = pending.at(-1)?.sha ?? (await resolveRef(a.mirror, `origin/${a.repo.defaultBranch}`));
  const path = packWorkspace(a.head);
  const branch = `${resolveSetting(db, "git.branch_prefix", { projectId: a.projectId as never, repoId: a.repo.id }).value}/${a.projectId}/u${a.target.seq}-pack-v${a.verifySeq}`;
  await git(["branch", "-D", branch], { gitDir: a.mirror }).catch(() => undefined);
  await addWorktree(a.mirror, path, branch, start);
  return { path, start };
}

export function overlayPack(workspace: string, checkout: string, packPath: string): void {
  const target = join(checkout, packPath);
  rmSync(target, { recursive: true, force: true });
  const source = join(workspace, packPath);
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, filter: (p) => !p.endsWith("/.git") });
}

// Keeps only what the verifier changed inside the pack; anything else it touched in the workspace is discarded.
export async function stagePackChanges(workspace: string, packPath: string): Promise<{ changed: string[]; discarded: string[] }> {
  const touched = (await git(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: workspace }))
    .split("\0")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3));
  const inPack = (p: string) => p === packPath || p.startsWith(`${packPath}/`);
  await git(["add", "-A", "--", packPath], { cwd: workspace });
  return { changed: touched.filter(inPack), discarded: touched.filter((p) => !inPack(p)) };
}

export async function discardWorkspace(workspace: string): Promise<void> {
  await git(["reset", "--quiet", "--hard", "HEAD"], { cwd: workspace });
  await git(["clean", "--quiet", "-fd"], { cwd: workspace });
}

export async function commitPackEdit(
  db: Db,
  a: { workspace: string; start: Sha; attemptId: AttemptId; target: Unit; summary: string; author: { name: string; email: string } },
): Promise<PackEdit> {
  const identity = { GIT_AUTHOR_NAME: a.author.name, GIT_AUTHOR_EMAIL: a.author.email, GIT_COMMITTER_NAME: a.author.name, GIT_COMMITTER_EMAIL: a.author.email };
  await gitWithEnv(
    ["commit", "--quiet", "--no-verify", "-F", "-"],
    a.workspace,
    identity,
    `Update the verify pack (verifier of U${a.target.seq})\n\n${a.summary}\n`,
  );
  await discardWorkspace(a.workspace);
  const sha = (await git(["rev-parse", "HEAD"], { cwd: a.workspace })) as Sha;
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: a.workspace });
  const id = Number(
    db
      .prepare("INSERT INTO pack_edits (attempt_id, target_unit_id, base_sha, sha, branch, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(a.attemptId, a.target.id, a.start, sha, branch, a.summary, now()).lastInsertRowid,
  );
  recordEvent(db, "pack.edited", { projectId: a.target.projectId, unitId: a.target.id, attemptId: a.attemptId }, { edit: id, sha, summary: a.summary });
  return toEdit(db.prepare("SELECT * FROM pack_edits WHERE id = ?").get(id) as Record<string, unknown>);
}

function settleEdits(db: Db, edits: PackEdit[], state: "queued" | "dropped", reason: string, packUnitId: UnitId | null): void {
  for (const e of edits) db.prepare("UPDATE pack_edits SET state = ?, reason = ?, pack_unit_id = ? WHERE id = ?").run(state, reason, packUnitId, e.id);
}

// Once the unit a verifier edited the pack for has landed, its edits go onto the new trunk as one pack unit that yagura
// proves and lands like any change. They wait for the landing because a new check may exercise what that unit added.
const listUnitsOfRepo = (db: Db, projectId: string, repoId: string) =>
  db.prepare("SELECT id, state FROM units WHERE project_id = ? AND repo_id = ? AND type = 'pack'").all(projectId, repoId) as { id: UnitId; state: string }[];

export async function queuePackEdits(ctx: { db: Db; boot: Bootstrap }, project: Project): Promise<Unit[]> {
  const { db, boot } = ctx;
  const added: Unit[] = [];
  const targets = db
    .prepare("SELECT DISTINCT e.target_unit_id AS id FROM pack_edits e JOIN units u ON u.id = e.target_unit_id WHERE e.state = 'pending' AND u.project_id = ?")
    .all(project.id) as { id: UnitId }[];
  for (const { id } of targets) {
    const target = getUnit(db, id);
    const edits = listPackEdits(db, id).filter((e) => e.state === "pending");
    const refs = { projectId: project.id, unitId: target.id };
    if (target.state === "abandoned") {
      settleEdits(db, edits, "dropped", `U${target.seq} was abandoned`, null);
      recordEvent(db, "pack.edit_dropped", refs, { reason: "target abandoned" });
      continue;
    }
    if (target.state !== "landed") continue;
    const repo = getRepo(db, target.repoId!);
    // One at a time per repo: parallel verifiers often make the same fix, and the next is applied to a trunk that has it.
    const inFlight = editPackUnitIds(db, project.id);
    if (listUnitsOfRepo(db, project.id, repo.id).some((u) => inFlight.has(u.id) && !["landed", "done", "abandoned"].includes(u.state))) continue;
    const mirror = layout(boot).mirror(repo.id);
    await ensureMirror(repo.url, mirror);
    const trunk = await resolveRef(mirror, `origin/${repo.defaultBranch}`);
    const unit = addUnit(db, {
      projectId: project.id,
      type: "pack",
      repoId: repo.id,
      goal: `Update the verify pack for ${repo.id} with the changes U${target.seq}'s verifier made`,
      writeScope: [`${repo.verifyPackPath}/**`],
      acceptance: [
        `${repo.verifyPackPath}/verify.json parses and names this project's provider`,
        "every check passes on the repo as it is, and the strongest check proves at least the project's minimum tier",
        "doctor, deploy, and teardown (when present) exit 0",
      ],
      verify: "yagura proves the pack on the branch head: doctor, deploy, every check, teardown",
      context: edits.map((e) => `Verifier edit ${e.sha.slice(0, 10)}: ${e.summary}`),
      playbook: "pack",
      timeboxSeconds: resolveSetting(db, "timebox.work_seconds", { projectId: project.id, repoId: repo.id }).value,
      maxAttempts: resolveSetting(db, "max_attempts", { projectId: project.id, repoId: repo.id }).value,
    });
    const wt = layout(boot).worktree(repo.id, project.id, unit.seq, 1);
    const branch = `${resolveSetting(db, "git.branch_prefix", { projectId: project.id, repoId: repo.id }).value}/${project.id}/u${unit.seq}-1`;
    mkdirSync(dirname(wt), { recursive: true });
    await addWorktree(mirror, wt, branch, trunk);
    let head: Sha | null = null;
    let why = "the verifier's pack edits no longer apply to trunk";
    try {
      const patch = await git(["diff", "--binary", edits[0]!.baseSha, edits.at(-1)!.sha, "--", repo.verifyPackPath], { gitDir: mirror });
      if (patch) {
        await gitWithEnv(["apply", "--3way", "--index", "-"], wt, {}, `${patch}\n`);
        why = `${repo.defaultBranch} already has these pack changes`;
        if (!(await git(["diff", "--cached", "--name-only"], { cwd: wt }))) throw new Error(why);
        const author = {
          name: resolveSetting(db, "git.author_name", { projectId: project.id, repoId: repo.id }).value,
          email: resolveSetting(db, "git.author_email", { projectId: project.id, repoId: repo.id }).value,
        };
        const identity = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
        await gitWithEnv(
          ["commit", "--quiet", "--no-verify", "-F", "-"],
          wt,
          identity,
          `Update the verify pack from U${target.seq}'s verifier\n\n${edits.map((e) => e.summary).join("\n")}\n`,
        );
        head = (await git(["rev-parse", "HEAD"], { cwd: wt })) as Sha;
      }
    } catch {
      head = null;
    }
    if (!head) {
      transitionUnit(db, unit.id, "abandoned", { reason: why });
      settleEdits(db, edits, "dropped", `${why} (at ${trunk.slice(0, 10)})`, unit.id);
      recordEvent(db, "pack.edit_dropped", refs, { reason: why, trunk });
      await removeWorktree(mirror, wt).catch(() => undefined);
      continue;
    }
    db.transaction(() => {
      const attempt = createAttempt(db, unit.id, PACK_EDIT_HARNESS, null);
      updateAttempt(db, attempt.id, {
        state: "handed_off",
        baseSha: trunk,
        headSha: head,
        branch,
        worktreePath: wt,
        handoffStatus: "success",
        startedAt: now(),
        endedAt: now(),
      });
      transitionUnit(db, unit.id, "ready", { reason: `pack edits from U${target.seq}'s verifier` });
      transitionUnit(db, unit.id, "running", { attempt: attempt.n });
      transitionUnit(db, unit.id, "handed_off", { head, from: edits.map((e) => e.id) });
      transitionUnit(db, unit.id, "verifying", { reason: "yagura proves the edited pack" });
      addVerifyUnit(db, getUnit(db, unit.id));
      settleEdits(db, edits, "queued", `queued as U${unit.seq}`, unit.id);
    })();
    recordEvent(db, "pack.edit_queued", refs, { packUnit: unit.seq, edits: edits.map((e) => e.id) });
    added.push(getUnit(db, unit.id));
  }
  return added;
}

// Pack units made from a verifier's edits refine a working pack, so verifications do not wait for them.
export function editPackUnitIds(db: Db, projectId: string): Set<UnitId> {
  return new Set(
    (
      db.prepare("SELECT DISTINCT e.pack_unit_id AS id FROM pack_edits e JOIN units u ON u.id = e.pack_unit_id WHERE u.project_id = ?").all(projectId) as {
        id: UnitId;
      }[]
    ).map((r) => r.id),
  );
}
