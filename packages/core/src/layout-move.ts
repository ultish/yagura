import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import type { RepoId } from "./domain.js";
import { git } from "./git.js";
import { layout } from "./paths.js";
import type { Db } from "./store.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Before repos/<id>/ a repo's bare clone sat in cache/repos/<id>.git, the remote of a repo yagura created in repos/<id>.git, and its checkouts in worktrees/<id>/.
// Moving them is safe to repeat: each step is skipped once it is done. It refuses while an agent from this home is still running in a checkout.
export async function moveHomeLayout(db: Db, boot: Bootstrap): Promise<string[]> {
  const paths = layout(boot);
  const moved: string[] = [];
  const running = db.prepare("SELECT pid FROM attempts WHERE state = 'running' AND pid IS NOT NULL").all() as { pid: number }[];
  const repos = db.prepare("SELECT id, url FROM repos ORDER BY id").all() as { id: RepoId; url: string }[];
  const oldMirror = (id: string) => join(boot.home, "cache", "repos", `${id}.git`);
  const oldUpstream = (id: string) => join(boot.home, "repos", `${id}.git`);
  const oldWorktrees = (id: string) => join(boot.home, "worktrees", id);
  const pending = repos.some((r) => existsSync(oldMirror(r.id)) || existsSync(oldUpstream(r.id)) || existsSync(oldWorktrees(r.id)));
  if (!pending) return moved;
  const live = running.filter((a) => alive(a.pid));
  if (live.length)
    throw new Error(
      `yagura moved where repos live (repos/<repo>/origin.git and worktrees/), but ${live.length} agent(s) are still running in the old checkouts; stop them and start yagura again`,
    );

  for (const { id, url } of repos) {
    mkdirSync(paths.repoDir(id), { recursive: true });
    if (existsSync(oldUpstream(id)) && !existsSync(paths.upstream(id))) {
      renameSync(oldUpstream(id), paths.upstream(id));
      if (url === oldUpstream(id)) db.prepare("UPDATE repos SET url = ? WHERE id = ?").run(paths.upstream(id), id);
      moved.push(`${oldUpstream(id)} → ${paths.upstream(id)}`);
    }
    if (existsSync(oldMirror(id)) && !existsSync(paths.mirror(id))) {
      renameSync(oldMirror(id), paths.mirror(id));
      const upstreamNow = (db.prepare("SELECT url FROM repos WHERE id = ?").get(id) as { url: string }).url;
      if (upstreamNow === paths.upstream(id)) await git(["remote", "set-url", "origin", upstreamNow], { gitDir: paths.mirror(id) }).catch(() => undefined);
      moved.push(`${oldMirror(id)} → ${paths.mirror(id)}`);
    }
    if (existsSync(oldWorktrees(id))) {
      mkdirSync(paths.worktrees(id), { recursive: true });
      const names = readdirSync(oldWorktrees(id));
      for (const name of names) {
        const to = join(paths.worktrees(id), name);
        if (!existsSync(to)) renameSync(join(oldWorktrees(id), name), to);
      }
      if (names.length && existsSync(paths.mirror(id)))
        await git(["worktree", "repair", ...names.map((n) => join(paths.worktrees(id), n))], { gitDir: paths.mirror(id) }).catch(() => undefined);
      db.prepare("UPDATE attempts SET worktree_path = ? || substr(worktree_path, ?) WHERE worktree_path LIKE ? || '/%'").run(
        paths.worktrees(id),
        oldWorktrees(id).length + 1,
        oldWorktrees(id),
      );
      if (!readdirSync(oldWorktrees(id)).length) rmdirSync(oldWorktrees(id));
      moved.push(`${oldWorktrees(id)} → ${paths.worktrees(id)}`);
    }
  }
  for (const dir of [join(boot.home, "cache", "repos"), join(boot.home, "worktrees")]) if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
  return moved;
}
