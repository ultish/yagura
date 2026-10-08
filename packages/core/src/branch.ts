import type { Sha } from "./domain.js";
import { git, resolveRef } from "./git.js";

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
