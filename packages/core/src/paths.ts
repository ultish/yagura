import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";

export const unitRef = (seq: number) => `u${seq}`;
export const attemptRef = (seq: number, n: number) => `u${seq}.${n}`;

export const logTimesPath = (logPath: string) => logPath.replace(/\.jsonl$/, "") + ".times";

export function layout(boot: Bootstrap) {
  const project = (p: ProjectId) => join(boot.home, "projects", p);
  return {
    db: join(boot.home, "yagura.db"),
    project,
    mirror: (r: RepoId) => join(boot.home, "cache", "repos", `${r}.git`),
    worktree: (r: RepoId, p: ProjectId, seq: number, n: number) => join(boot.home, "worktrees", r, `${p}-${attemptRef(seq, n)}`),
    // The unit's own checkout, which every worker round uses; the judge gets a fresh one beside it each round.
    checkout: (r: RepoId, p: ProjectId, seq: number) => join(boot.home, "worktrees", r, `${p}-${unitRef(seq)}`),
    standingOrders: (p: ProjectId) => join(project(p), "standing-orders.md"),
    spec: (p: ProjectId) => join(project(p), "spec.md"),
    thread: (t: number) => join(boot.home, "threads", String(t)),
    turnLog: (t: number, messageId: number) => join(boot.home, "threads", String(t), "turns", `${messageId}.jsonl`),
    turnBrief: (t: number, messageId: number) => join(boot.home, "threads", String(t), "turns", `${messageId}.brief.md`),
    managerDir: (p: ProjectId, seq: number) => join(project(p), "managers", unitRef(seq)),
    newRepo: (r: string) => join(boot.home, "repos", `${r}.git`),
    brief: (p: ProjectId, seq: number, n: number) => join(project(p), "briefs", `${attemptRef(seq, n)}.md`),
    handoff: (p: ProjectId, seq: number, n: number) => join(project(p), "handoffs", `${attemptRef(seq, n)}.md`),
    log: (p: ProjectId, seq: number, n: number) => join(project(p), "logs", `${attemptRef(seq, n)}.jsonl`),
    publishLog: (p: ProjectId, seq: number, kind: string, sha: string) => join(project(p), "logs", `${unitRef(seq)}.publish-${kind}-${sha.slice(0, 10)}.log`),
    daemonLog: join(boot.home, "logs", "daemon.log"),
    leftovers: (p: ProjectId, seq: number, n: number) => join(project(p), "leftovers", `${attemptRef(seq, n)}.patch`),
  };
}
