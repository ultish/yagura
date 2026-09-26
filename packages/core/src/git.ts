import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Sha } from "./domain.js";

const run = promisify(execFile);

export async function git(args: string[], opts: { cwd?: string; gitDir?: string } = {}): Promise<string> {
  const full = opts.gitDir ? ["--git-dir", opts.gitDir, ...args] : args;
  const { stdout } = await run("git", full, {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

export async function ensureMirror(url: string, gitDir: string): Promise<void> {
  if (!existsSync(gitDir)) {
    await git(["clone", "--bare", "--quiet", url, gitDir]);
    await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { gitDir });
  }
  await git(["fetch", "--quiet", "--prune", "origin"], { gitDir });
}

export async function resolveRef(gitDir: string, ref: string): Promise<Sha> {
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`], { gitDir })) as Sha;
}

export async function addWorktree(gitDir: string, path: string, branch: string, base: Sha): Promise<void> {
  await git(["worktree", "add", "--quiet", "-b", branch, path, base], { gitDir });
}

export async function removeWorktree(gitDir: string, path: string): Promise<void> {
  await git(["worktree", "remove", "--force", path], { gitDir });
}

export async function headSha(worktree: string): Promise<Sha> {
  return (await git(["rev-parse", "HEAD"], { cwd: worktree })) as Sha;
}

export async function commitAll(worktree: string, message: string, author: { name: string; email: string }): Promise<boolean> {
  if (!(await git(["status", "--porcelain"], { cwd: worktree }))) return false;
  await git(["add", "-A"], { cwd: worktree });
  await git(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "--no-verify", "-m", message], {
    cwd: worktree,
  });
  return true;
}

export async function changedPaths(worktree: string, base: Sha): Promise<string[]> {
  const out = await git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD"], { cwd: worktree });
  return out.split("\0").filter(Boolean);
}
