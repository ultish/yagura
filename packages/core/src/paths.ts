import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";

export const unitRef = (seq: number) => `u${seq}`;
export const attemptRef = (seq: number, n: number) => `u${seq}.${n}`;

export const logTimesPath = (logPath: string) => logPath.replace(/\.jsonl$/, "") + ".times";

// Where a repo lives under the home, kept on the repo's row so the watchman and the dashboard can say it.
export const repoPath = (r: string) => join("repos", r);

export function layout(boot: Bootstrap) {
  const project = (p: ProjectId) => join(boot.home, "projects", p);
  return {
    db: join(boot.home, "yagura.db"),
    project,
    // Everything about one repo lives in repos/<repo>: origin.git is the bare clone that has the remote and only yagura writes; worktrees/ holds the checkouts agents work in.
    repoDir: (r: RepoId) => join(boot.home, repoPath(r)),
    mirror: (r: RepoId) => join(boot.home, repoPath(r), "origin.git"),
    // The remote of a repo yagura created itself, which has no other home.
    upstream: (r: RepoId) => join(boot.home, repoPath(r), "upstream.git"),
    worktrees: (r: RepoId) => join(boot.home, repoPath(r), "worktrees"),
    worktree: (r: RepoId, p: ProjectId, seq: number, n: number) => join(boot.home, repoPath(r), "worktrees", `${p}-${attemptRef(seq, n)}`),
    // The unit's own checkout, which every worker round uses; the judge gets a fresh one beside it each round.
    checkout: (r: RepoId, p: ProjectId, seq: number) => join(boot.home, repoPath(r), "worktrees", `${p}-${unitRef(seq)}`),
    standingOrders: (p: ProjectId) => join(project(p), "standing-orders.md"),
    spec: (p: ProjectId) => join(project(p), "spec.md"),
    thread: (t: number) => join(boot.home, "threads", String(t)),
    turnLog: (t: number, messageId: number) => join(boot.home, "threads", String(t), "turns", `${messageId}.jsonl`),
    turnBrief: (t: number, messageId: number) => join(boot.home, "threads", String(t), "turns", `${messageId}.brief.md`),
    managerDir: (p: ProjectId, seq: number) => join(project(p), "managers", unitRef(seq)),
    brief: (p: ProjectId, seq: number, n: number) => join(project(p), "briefs", `${attemptRef(seq, n)}.md`),
    handoff: (p: ProjectId, seq: number, n: number) => join(project(p), "handoffs", `${attemptRef(seq, n)}.md`),
    log: (p: ProjectId, seq: number, n: number) => join(project(p), "logs", `${attemptRef(seq, n)}.jsonl`),
    daemonLog: join(boot.home, "logs", "daemon.log"),
    doctorLog: (id: number) => join(boot.home, "doctor", `d${id}.jsonl`),
    doctorBrief: (id: number) => join(boot.home, "doctor", `d${id}.brief.md`),
    leftovers: (p: ProjectId, seq: number, n: number) => join(project(p), "leftovers", `${attemptRef(seq, n)}.patch`),
  };
}
