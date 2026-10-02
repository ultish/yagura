import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import { TERMINAL_STATES, type RepoId, type UnitState } from "./domain.js";
import { git, removeWorktree } from "./git.js";
import { layout } from "./paths.js";
import type { Db } from "./store.js";

// Every attempt checks out the repo (a verification three times: head, trunk, and the pack), and nothing reads those
// checkouts once the unit is finished: evidence is stored as artifacts, diffs come from the mirror, and a rework that
// finds its worktree gone starts fresh. On a real repo each one is a full checkout, so they go as soon as the unit is done.
export async function sweepWorktrees(db: Db, boot: Bootstrap): Promise<number> {
  const root = join(boot.home, "worktrees");
  if (!existsSync(root)) return 0;
  const stateOf = db.prepare("SELECT state FROM units WHERE project_id = ? AND seq = ?");
  let removed = 0;
  for (const repoId of readdirSync(root)) {
    const mirror = layout(boot).mirror(repoId as RepoId);
    for (const name of readdirSync(join(root, repoId))) {
      const m = /^(.+)-u(\d+)\.\d+(\..+)?$/.exec(name);
      if (!m) continue;
      const row = stateOf.get(m[1], Number(m[2])) as { state: UnitState } | undefined;
      if (row && !TERMINAL_STATES.has(row.state)) continue;
      const path = join(root, repoId, name);
      if (existsSync(mirror)) await removeWorktree(mirror, path).catch(() => undefined);
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
    if (removed && existsSync(mirror)) await git(["worktree", "prune"], { gitDir: mirror }).catch(() => undefined);
  }
  return removed;
}
