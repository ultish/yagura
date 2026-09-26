import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";

export const unitRef = (seq: number) => `u${seq}`;
export const attemptRef = (seq: number, n: number) => `u${seq}.${n}`;

export function layout(boot: Bootstrap) {
  const project = (p: ProjectId) => join(boot.home, "projects", p);
  return {
    db: join(boot.home, "yagura.db"),
    mirror: (r: RepoId) => join(boot.home, "cache", "repos", `${r}.git`),
    worktree: (r: RepoId, p: ProjectId, seq: number, n: number) => join(boot.home, "worktrees", r, `${p}-${attemptRef(seq, n)}`),
    standingOrders: (p: ProjectId) => join(project(p), "standing-orders.md"),
    brief: (p: ProjectId, seq: number, n: number) => join(project(p), "briefs", `${attemptRef(seq, n)}.md`),
    handoff: (p: ProjectId, seq: number, n: number) => join(project(p), "handoffs", `${attemptRef(seq, n)}.md`),
    log: (p: ProjectId, seq: number, n: number) => join(project(p), "logs", `${attemptRef(seq, n)}.jsonl`),
    leftovers: (p: ProjectId, seq: number, n: number) => join(project(p), "leftovers", `${attemptRef(seq, n)}.patch`),
  };
}
