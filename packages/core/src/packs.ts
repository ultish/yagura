import { resolveSetting, type Bootstrap } from "./config.js";
import type { Project, Unit } from "./domain.js";
import { ensureMirror, readFileAt } from "./git.js";
import { parsePack } from "./pack.js";
import { layout } from "./paths.js";
import { syncPackStatus } from "./repos.js";
import { addUnit, getRepo, getUnit, listUnits, projectRepos, recordEvent, transitionUnit, type Db } from "./store.js";

// A repo whose trunk has no usable pack gets one pack unit before anything on it can be verified. An abandoned one is
// the developer's call and is not replaced; a landed one is replaced only if trunk's pack later breaks.
export async function ensurePackUnits(ctx: { db: Db; boot: Bootstrap }, project: Project): Promise<Unit[]> {
  const { db, boot } = ctx;
  const added: Unit[] = [];
  for (const repo of projectRepos(db, project.id)) {
    if (repo.packStatus !== "missing") continue;
    const packUnits = listUnits(db, project.id).filter((u) => u.type === "pack" && u.repoId === repo.id);
    if (packUnits.some((u) => u.state !== "landed")) continue;
    const mirror = layout(boot).mirror(repo.id);
    await ensureMirror(repo.url, mirror);
    const pack = parsePack(await readFileAt(mirror, `origin/${repo.defaultBranch}`, `${repo.verifyPackPath}/verify.json`), repo.verifyPackPath);
    if (syncPackStatus(db, repo.id, pack) !== "missing" || pack.ok) continue;
    const sctx = { projectId: project.id, repoId: repo.id };
    const unit = addUnit(db, {
      projectId: project.id,
      type: "pack",
      repoId: repo.id,
      goal: `Write a verify pack for ${repo.id}`,
      writeScope: [`${getRepo(db, repo.id).verifyPackPath}/**`],
      acceptance: [
        `${repo.verifyPackPath}/verify.json parses and names this project's provider`,
        "every check passes on the repo as it is, and the strongest check proves at least the project's minimum tier",
        "doctor, deploy, and teardown (when present) exit 0",
      ],
      verify: "yagura proves the pack on the branch head: doctor, deploy, every check, teardown",
      context: [`Trunk has no usable verify pack (${pack.reason})`],
      playbook: "pack",
      timeboxSeconds: resolveSetting(db, "timebox.work_seconds", sctx).value,
      maxAttempts: resolveSetting(db, "max_attempts", sctx).value,
    });
    transitionUnit(db, unit.id, "ready", { reason: "repo has no usable verify pack" });
    recordEvent(db, "pack.unit_added", { projectId: project.id, unitId: unit.id }, { repo: repo.id, reason: pack.reason });
    added.push(getUnit(db, unit.id));
  }
  return added;
}

export function markPackProven(db: Db, unit: Unit, landedSha: string): void {
  if (unit.type !== "pack" || !unit.repoId) return;
  db.prepare("UPDATE repos SET pack_status = 'proven', pack_proven_sha = ? WHERE id = ?").run(landedSha, unit.repoId);
  recordEvent(db, "repo.pack_status", { projectId: unit.projectId, unitId: unit.id }, { repo: unit.repoId, to: "proven", sha: landedSha });
}
