import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Sha } from "./domain.js";

const run = promisify(execFile);

// Output is trimmed of trailing whitespace unless `raw` is set; file contents must keep their final newline.
export async function git(args: string[], opts: { cwd?: string; gitDir?: string; raw?: boolean } = {}): Promise<string> {
  const full = opts.gitDir ? ["--git-dir", opts.gitDir, ...args] : args;
  const { stdout } = await run("git", full, {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return opts.raw ? stdout : stdout.trimEnd();
}

// Files tools generate as they run. Agents commit whatever is untracked in a repo without its own .gitignore, and
// every worktree of a mirror reads the mirror's info/exclude.
const GENERATED = ["__pycache__/", "*.py[cod]", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "node_modules/", ".gradle/", ".DS_Store"];

// Concurrent fetches into one mirror race for its ref locks and all but one fail ("cannot lock ref"), so each mirror
// is brought up to date one call at a time in this process; a lock held by another process gets one retry.
const mirrorQueue = new Map<string, Promise<void>>();

export function ensureMirror(url: string, gitDir: string): Promise<void> {
  const next = (mirrorQueue.get(gitDir) ?? Promise.resolve()).catch(() => {}).then(() => updateMirror(url, gitDir));
  mirrorQueue.set(gitDir, next);
  return next;
}

async function updateMirror(url: string, gitDir: string): Promise<void> {
  if (!existsSync(gitDir)) {
    await git(["clone", "--bare", "--quiet", url, gitDir]);
    await git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { gitDir });
  }
  const exclude = join(gitDir, "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const missing = GENERATED.filter((p) => !current.split("\n").includes(p));
  if (missing.length) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }
  if ((await git(["remote", "get-url", "origin"], { gitDir })) !== url) await git(["remote", "set-url", "origin", url], { gitDir });
  const fetch = () => git(["fetch", "--quiet", "--prune", "origin"], { gitDir });
  await fetch().catch(async (e: unknown) => {
    if (!/cannot lock ref|Unable to create .*\.lock/.test(String((e as { stderr?: string }).stderr ?? e))) throw e;
    await new Promise((r) => setTimeout(r, 500));
    await fetch();
  });
}

export async function readFileAt(gitDir: string, ref: string, path: string): Promise<string | null> {
  try {
    return await git(["show", `${ref}:${path}`], { gitDir });
  } catch {
    return null;
  }
}

export async function resolveRef(gitDir: string, ref: string): Promise<Sha> {
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`], { gitDir })) as Sha;
}

export async function addWorktree(gitDir: string, path: string, branch: string, base: Sha): Promise<void> {
  await git(["worktree", "add", "--quiet", "-b", branch, path, base], { gitDir });
}

export async function addDetachedWorktree(gitDir: string, path: string, sha: Sha): Promise<void> {
  await git(["worktree", "add", "--quiet", "--detach", path, sha], { gitDir });
}

export async function isPristine(worktree: string, sha: Sha): Promise<boolean> {
  const [status, head] = await Promise.all([git(["status", "--porcelain"], { cwd: worktree }), git(["rev-parse", "HEAD"], { cwd: worktree })]);
  return status === "" && head === sha;
}

export async function restorePristine(worktree: string, sha: Sha): Promise<void> {
  await git(["checkout", "--quiet", "--detach", "--force", sha], { cwd: worktree });
  await git(["reset", "--quiet", "--hard", sha], { cwd: worktree });
  await git(["clean", "--quiet", "-fd"], { cwd: worktree });
}

export async function patchId(worktree: string, base: Sha, head: Sha): Promise<string | null> {
  const diff = await git(["diff", "--binary", base, head], { cwd: worktree });
  if (!diff) return null;
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = execFile("git", ["patch-id", "--stable"], { cwd: worktree }, (err, stdout) => (err ? reject(err) : resolve({ stdout })));
    child.stdin?.end(`${diff}\n`);
  });
  return stdout.split(" ")[0] || null;
}

export async function diffText(worktree: string, base: Sha, head: Sha): Promise<string> {
  return git(["diff", "--stat", "--patch", base, head], { cwd: worktree });
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

export async function discardLeftovers(worktree: string): Promise<{ paths: string[]; patch: string }> {
  if (!(await git(["status", "--porcelain"], { cwd: worktree }))) return { paths: [], patch: "" };
  await git(["add", "-A"], { cwd: worktree });
  const patch = await git(["diff", "--cached", "--binary"], { cwd: worktree });
  const paths = (await git(["diff", "--cached", "--name-only", "-z"], { cwd: worktree })).split("\0").filter(Boolean);
  await git(["reset", "--quiet", "--hard", "HEAD"], { cwd: worktree });
  return { paths, patch: `${patch}\n` };
}

export async function changedPaths(worktree: string, base: Sha): Promise<string[]> {
  const out = await git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD"], { cwd: worktree });
  return out.split("\0").filter(Boolean);
}

export async function mergesCleanly(gitDir: string, trunk: Sha, head: Sha): Promise<boolean> {
  try {
    await git(["merge-tree", "--write-tree", "--quiet", trunk, head], { gitDir });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 1) return false;
    throw e;
  }
}

export async function gitWithEnv(args: string[], cwd: string, env: Record<string, string>, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trimEnd()),
    );
    child.stdin?.end(stdin);
  });
}

export async function diffRange(gitDir: string, base: Sha, head: Sha): Promise<string> {
  return git(["diff", "--stat", "--patch", "--no-color", base, head], { gitDir });
}

export async function addedLines(worktree: string, base: Sha): Promise<{ path: string; line: string }[]> {
  const out = await git(["diff", "--unified=0", "--no-color", "--no-renames", base, "HEAD"], { cwd: worktree });
  const lines: { path: string; line: string }[] = [];
  let path = "";
  for (const l of out.split("\n")) {
    if (l.startsWith("+++ ")) path = l.startsWith("+++ b/") ? l.slice(6) : "";
    else if (l.startsWith("+") && path) lines.push({ path, line: l.slice(1) });
  }
  return lines;
}
