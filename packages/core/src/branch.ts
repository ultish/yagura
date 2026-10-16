import { execFile } from "node:child_process";
import type { Sha } from "./domain.js";
import { git, resolveRef } from "./git.js";
import { PUSH_BRANCH_VAR } from "./relay.js";

export const unitBranch = (prefix: string, projectId: string, seq: number) => `${prefix}/${projectId}/u${seq}`;

// The unit's branch lives in yagura's mirror; it is made from the base the first time a worker starts, and kept after.
export async function createUnitBranch(mirror: string, branch: string, base: string): Promise<Sha> {
  const existing = await resolveRef(mirror, `refs/heads/${branch}`).catch(() => null);
  if (existing) return existing;
  const from = await resolveRef(mirror, `refs/remotes/origin/${base}`);
  await git(["update-ref", `refs/heads/${branch}`, from, ""], { gitDir: mirror });
  return from;
}

// A worker's checkout is its own clone of the mirror (sharing its objects), so its commits and pushes reach the mirror
// only through `git push`, where the relay checks them; a worktree would share the mirror's refs and push to the forge.
export async function checkoutUnit(mirror: string, path: string, branch: string): Promise<void> {
  await git(["clone", "--quiet", "--shared", "--branch", branch, mirror, path]);
}

// Brings a checkout with no uncommitted work up to its branch in the mirror (after yagura merged the base into it).
export async function syncCheckout(path: string, branch: string): Promise<void> {
  await git(["fetch", "--quiet", "origin", branch], { cwd: path });
  await git(["merge", "--quiet", "--ff-only", `origin/${branch}`], { cwd: path });
}

// yagura's own push of the checkout at a hand-off, through the relay like the worker's: null when taken, else the relay's reason.
export function pushCheckout(path: string, branch: string): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(
      "git",
      ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`],
      { cwd: path, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", [PUSH_BRANCH_VAR]: branch } },
      (err, _out, stderr) =>
        resolve(
          !err
            ? null
            : (/yagura: (.*)/.exec(stderr)?.[1]?.trimEnd() ??
                (/non-fast-forward|fetch first/.test(stderr)
                  ? `${branch} only moves forward; merge instead of rebasing, and never force-push`
                  : stderr.trim())),
        ),
    ),
  );
}

// The branch as the mirror holds it, sent on to the forge; the relay does this on each push, and this repeats it in case that failed.
export async function publishBranch(mirror: string, branch: string): Promise<void> {
  await git(["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { gitDir: mirror });
}

const commitTree = (mirror: string, tree: string, parents: Sha[], message: string, author: { name: string; email: string }) =>
  new Promise<Sha>((resolve, reject) =>
    execFile(
      "git",
      ["--git-dir", mirror, "commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        },
      },
      (err, out) => (err ? reject(err) : resolve(out.trim() as Sha)),
    ),
  );

// A clean merge of the base becomes a merge commit on the unit's branch, only if the branch has not moved since the check.
export async function commitBaseMerge(
  mirror: string,
  branch: string,
  merge: Extract<BaseMerge, { kind: "clean" }>,
  message: string,
  author: { name: string; email: string },
): Promise<Sha> {
  const sha = await commitTree(mirror, merge.tree, [merge.head, merge.base], message, author);
  await git(["update-ref", `refs/heads/${branch}`, sha, merge.head], { gitDir: mirror });
  await publishBranch(mirror, branch);
  return sha;
}

// For a repo without a forge, yagura merges itself: a merge commit of the approved head onto the base, pushed to the base.
// A base that moved since the last fetch makes the push fail, and the merge is tried again on a later check.
export async function mergeWithoutForge(mirror: string, head: Sha, base: string, message: string, author: { name: string; email: string }): Promise<Sha> {
  const baseSha = await resolveRef(mirror, `refs/remotes/origin/${base}`);
  const tree = await git(["merge-tree", "--write-tree", "--no-messages", baseSha, head], { gitDir: mirror });
  const sha = await commitTree(mirror, tree, [baseSha, head], message, author);
  await git(["push", "--quiet", "origin", `${sha}:refs/heads/${base}`], { gitDir: mirror });
  return sha;
}

export type BaseMerge =
  { kind: "current" } | { kind: "clean"; head: Sha; base: Sha; tree: string } | { kind: "conflict"; head: Sha; base: Sha; files: string[] };

// How the unit's head merges with its base's head, computed without touching any checkout. Both are commits the caller already
// holds (the head yagura recorded, the base it fetched or just merged), so nothing can move underneath. A git process costs
// more than the merge itself, so the two run side by side. A merge that leaves the head's tree unchanged is "current",
// whether or not the base is an ancestor: there is nothing to bring in.
export async function mergeWithBase(mirror: string, head: Sha, base: Sha): Promise<BaseMerge> {
  const [headTree, merged] = await Promise.all([
    git(["rev-parse", `${head}^{tree}`], { gitDir: mirror }),
    git(["merge-tree", "--write-tree", "--name-only", "--no-messages", head, base], { gitDir: mirror }).then(
      (tree) => ({ tree, files: [] as string[] }),
      (e: { code?: number; stdout?: string }) => {
        if (e.code !== 1 || !e.stdout) throw e;
        const [tree, ...files] = e.stdout.trimEnd().split("\n");
        return { tree: tree!, files };
      },
    ),
  ]);
  if (merged.files.length) return { kind: "conflict", head, base, files: merged.files };
  return merged.tree === headTree ? { kind: "current" } : { kind: "clean", head, base, tree: merged.tree };
}
