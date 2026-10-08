import type { RunContext } from "./agent.js";
import { mergeMessage } from "./audit.js";
import { commitBaseMerge, mergeWithBase, mergeWithoutForge } from "./branch.js";
import { resolveSetting } from "./config.js";
import type { Repo, Sha, Unit, UnitId } from "./domain.js";
import { forgeFor, getMergeRequest, recordMergeStatus } from "./forge.js";
import { gateResolved } from "./gates.js";
import { ensureMirror, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import type { WorkerRound } from "./resume.js";
import {
  addGate,
  getProject,
  getRepo,
  getUnit,
  listGates,
  listProjects,
  listUnits,
  recordEvent,
  setApprovedSha,
  setMergedSha,
  transitionUnit,
  type Db,
} from "./store.js";

const baseOf = (repo: Repo, unit: Unit) => unit.base ?? repo.defaultBranch;
const author = (db: Db, unit: Unit) => {
  const at = { projectId: unit.projectId, repoId: unit.repoId ?? undefined };
  return { name: resolveSetting(db, "git.author_name", at).value, email: resolveSetting(db, "git.author_email", at).value };
};

// Keeps an open unit's branch merging with its base: a clean merge becomes a commit on the branch (and, on an approved branch, the
// approval moves to it: yagura vouches for a merge it made cleanly), a conflict sends the unit back to its worker.
export async function syncWithBase(ctx: RunContext, unitId: UnitId): Promise<"current" | "merged-base" | "conflict"> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  const repo = getRepo(db, unit.repoId!);
  const mirror = layout(boot).mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const base = baseOf(repo, unit);
  const head = await resolveRef(mirror, `refs/heads/${unit.branch!}`);
  const merge = await mergeWithBase(mirror, head, await resolveRef(mirror, `refs/remotes/origin/${base}`));
  if (merge.kind === "current") return "current";
  if (merge.kind === "conflict") {
    transitionUnit(db, unit.id, "building", { round: { kind: "conflict", base, baseSha: merge.base, files: merge.files } satisfies WorkerRound });
    return "conflict";
  }
  const merged = await commitBaseMerge(mirror, unit.branch!, merge, `Merge ${base} into ${unit.branch}`, author(db, unit));
  if (unit.approvedSha === head) setApprovedSha(db, unit.id, merged);
  db.prepare("UPDATE merge_requests SET head_sha = ?, base_sha = ? WHERE unit_id = ?").run(merged, merge.base, unit.id);
  recordEvent(db, "unit.base_merged", { projectId: unit.projectId, unitId: unit.id }, { base: merge.base, head: merged });
  return "merged-base";
}

// The open units that build on a base: after a merge into it, or when it moved outside yagura, each is checked against it.
export function unitsOnBase(db: Db, repoId: string, base: string): Unit[] {
  return listProjects(db)
    .flatMap((p) => listUnits(db, p.id))
    .filter((u) => u.repoId === repoId && u.branch && ["judging", "ready"].includes(u.state) && baseOf(getRepo(db, u.repoId), u) === base);
}

function finishMerged(db: Db, unit: Unit, sha: Sha): void {
  setMergedSha(db, unit.id, sha);
  db.prepare("UPDATE merge_requests SET state = 'merged' WHERE unit_id = ?").run(unit.id);
  transitionUnit(db, unit.id, "merged", { sha });
}

// What a ready unit waits for, checked at the forge poll rate: its head still the approved one, CI passed on it, the base merged
// in, and the developer's go when the project asks for it; then yagura merges it with a merge commit. Returns the merged base.
export async function checkReady(ctx: RunContext, unitId: UnitId): Promise<{ repoId: string; base: string } | null> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.state !== "ready") return null;
  const repo = getRepo(db, unit.repoId!);
  const project = getProject(db, unit.projectId);
  const forge = forgeFor(db, repo);
  const mr = getMergeRequest(db, unit.id);
  const mirror = layout(boot).mirror(repo.id);
  const refs = { projectId: project.id, unitId: unit.id };
  await ensureMirror(repo.url, mirror);

  let head = await resolveRef(mirror, `refs/heads/${unit.branch!}`);
  if (forge && mr) {
    const status = await forge.status(mr.number);
    recordMergeStatus(db, unit.id, status);
    if (status.state === "merged") {
      finishMerged(db, unit, status.mergedSha!);
      return { repoId: repo.id, base: baseOf(repo, unit) };
    }
    if (status.state === "closed") {
      transitionUnit(db, unit.id, "stuck", { reason: `its ${mr.url} was closed on the forge` });
      return null;
    }
    // A ready unit's pull request is out of draft; marking it again converges when an earlier mark was lost.
    if (status.draft) await forge.markReady(mr.number);
    head = status.headSha;
    if (head === unit.approvedSha && status.pending.length) return null;
    if (head === unit.approvedSha && status.failing.length) {
      const reran = db.prepare("SELECT 1 FROM events WHERE unit_id = ? AND type = 'ci.rerun' AND json_extract(data_json, '$.head') = ?").get(unit.id, head);
      if (reran) {
        transitionUnit(db, unit.id, "stuck", { reason: `CI failed twice on ${head.slice(0, 10)}: ${status.failing.join(", ")}` });
        return null;
      }
      for (const run of await forge.failedRuns(head)) await forge.rerunFailed(run.id);
      recordEvent(db, "ci.rerun", refs, { head, failing: status.failing });
      return null;
    }
  }
  if (head !== unit.approvedSha) {
    transitionUnit(db, unit.id, "judging", { reason: `the branch moved past the approved head ${unit.approvedSha?.slice(0, 10)} to ${head.slice(0, 10)}` });
    return null;
  }
  if ((await syncWithBase(ctx, unit.id)) !== "current") return null;

  if (project.mergePolicy === "human") {
    const gates = listGates(db, project.id).filter((g) => g.unitId === unit.id && g.kind === "land" && g.question.includes(head.slice(0, 10)));
    const gate = gates.at(-1);
    if (!gate) {
      addGate(db, {
        projectId: project.id,
        unitId: unit.id,
        kind: "land",
        question: `U${unit.seq} is approved and passes CI at ${head.slice(0, 10)}. Merge it into ${baseOf(repo, unit)}?${mr ? ` ${mr.url}` : ""}`,
        options: ["land", "hold"],
        defaultOption: "hold",
      });
      return null;
    }
    if (!gateResolved(gate, "land")) return null;
  }

  const message = mergeMessage(db, unit, mr?.number ?? null, resolveSetting(db, "yagura.url").value);
  if (forge && mr) {
    await forge.mergeCommit(mr.number, head, message);
    const status = await forge.status(mr.number);
    recordMergeStatus(db, unit.id, status);
    if (status.state !== "merged") return null;
    finishMerged(db, unit, status.mergedSha!);
  } else {
    finishMerged(db, unit, await mergeWithoutForge(mirror, head, baseOf(repo, unit), `${message.subject}\n\n${message.body}`, author(db, unit)));
  }
  await ensureMirror(repo.url, mirror);
  return { repoId: repo.id, base: baseOf(repo, unit) };
}
