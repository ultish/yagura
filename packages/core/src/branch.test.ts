import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkoutUnit, commitBaseMerge, createUnitBranch, mergeWithBase, mergeWithoutForge, pushCheckout, syncCheckout, unitBranch } from "./branch.js";
import { installRelay } from "./relay.js";
import { commitAll, ensureMirror, git, resolveRef } from "./git.js";

const author = { name: "dev", email: "dev@localhost" };
let seed: string;
let forge: string;
let mirror: string;
let root: string;
const branch = unitBranch("yagura", "demo", 1);

// A commit on the unit's branch in the mirror, as a worker's accepted push leaves it.
async function onUnit(file: string, text: string) {
  const wt = mkdtempSync(join(root, "wt-"));
  await git(["worktree", "add", "--quiet", wt, branch], { gitDir: mirror });
  writeFileSync(join(wt, file), text);
  await commitAll(wt, `edit ${file}`, author);
  await git(["worktree", "remove", "--force", wt], { gitDir: mirror });
}

// A commit on main at the forge, made outside yagura, then fetched.
async function onMain(file: string, text: string) {
  writeFileSync(join(seed, file), text);
  await commitAll(seed, `main edits ${file}`, author);
  await git(["push", "--quiet", forge, "main"], { cwd: seed });
  await ensureMirror(forge, mirror);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "yagura-branch-"));
  seed = join(root, "seed");
  await git(["init", "--quiet", "-b", "main", seed]);
  writeFileSync(join(seed, "greet.py"), "def greet():\n    return 'hi'\n");
  writeFileSync(join(seed, "notes.md"), "notes\n");
  await commitAll(seed, "init", author);
  forge = join(root, "forge.git");
  await git(["clone", "--quiet", "--bare", seed, forge]);
  mirror = join(root, "mirror.git");
  await ensureMirror(forge, mirror);
});

describe("unit branches", () => {
  it("names the branch after the project and unit, makes it from the base once, and keeps it after", async () => {
    expect(branch).toBe("yagura/demo/u1");
    const main = await resolveRef(mirror, "refs/remotes/origin/main");
    expect(await createUnitBranch(mirror, branch, "main")).toBe(main);
    await onUnit("greet.py", "def greet():\n    return 'hello'\n");
    const head = await resolveRef(mirror, `refs/heads/${branch}`);
    expect(head).not.toBe(main);
    expect(await createUnitBranch(mirror, branch, "main")).toBe(head);
  });

  it("checks the branch out as a clone whose origin is the mirror", async () => {
    await createUnitBranch(mirror, branch, "main");
    const checkout = join(root, "u1");
    await checkoutUnit(mirror, checkout, branch);
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: checkout })).toBe(branch);
    expect(await git(["remote", "get-url", "origin"], { cwd: checkout })).toBe(mirror);
  });
});

describe("mergeWithBase", () => {
  beforeEach(async () => {
    await createUnitBranch(mirror, branch, "main");
    await onUnit("greet.py", "def greet():\n    return 'hello'\n");
  });

  it("says the branch is current when the base has not moved", async () => {
    expect(await mergeWithBase(mirror, await resolveRef(mirror, `refs/heads/${branch}`), await resolveRef(mirror, "refs/remotes/origin/main"))).toEqual({
      kind: "current",
    });
  });

  it("gives the merged tree when the base moved without touching the unit's files", async () => {
    await onMain("notes.md", "notes, edited on main\n");
    const merge = await mergeWithBase(mirror, await resolveRef(mirror, `refs/heads/${branch}`), await resolveRef(mirror, "refs/remotes/origin/main"));
    expect(merge).toMatchObject({
      kind: "clean",
      head: await resolveRef(mirror, `refs/heads/${branch}`),
      base: await resolveRef(mirror, "refs/remotes/origin/main"),
    });
    const tree = (merge as { tree: string }).tree;
    expect(await git(["show", `${tree}:notes.md`], { gitDir: mirror })).toBe("notes, edited on main");
    expect(await git(["show", `${tree}:greet.py`], { gitDir: mirror })).toBe("def greet():\n    return 'hello'");
  });

  it("names the conflicting files when the base changed the same lines", async () => {
    await onMain("greet.py", "def greet():\n    return 'hey'\n");
    await onMain("notes.md", "notes, edited on main\n");
    expect(await mergeWithBase(mirror, await resolveRef(mirror, `refs/heads/${branch}`), await resolveRef(mirror, "refs/remotes/origin/main"))).toEqual({
      kind: "conflict",
      head: await resolveRef(mirror, `refs/heads/${branch}`),
      base: await resolveRef(mirror, "refs/remotes/origin/main"),
      files: ["greet.py"],
    });
  });
});

describe("moving a unit's branch", () => {
  const dev = { name: "yagura", email: "yagura@localhost" };

  it("merges a moved base into the branch as a two-parent commit, publishes it, and brings a checkout up to it", async () => {
    await createUnitBranch(mirror, branch, "main");
    installRelay(mirror);
    const checkout = join(root, "u1");
    await checkoutUnit(mirror, checkout, branch);
    writeFileSync(join(checkout, "greet.py"), "def greet():\n    return 'hello'\n");
    await commitAll(checkout, "say hello", author);
    expect(await pushCheckout(checkout, branch)).toBeNull();
    await onMain("notes.md", "notes, edited on main\n");
    const head = await resolveRef(mirror, `refs/heads/${branch}`);
    const merge = await mergeWithBase(mirror, head, await resolveRef(mirror, "refs/remotes/origin/main"));
    if (merge.kind !== "clean") throw new Error(merge.kind);
    const merged = await commitBaseMerge(mirror, branch, merge, "Merge main into yagura/demo/u1", dev);
    expect(await git(["log", "-1", "--format=%P%n%s%n%an", merged], { gitDir: mirror })).toBe(`${head} ${merge.base}\nMerge main into yagura/demo/u1\nyagura`);
    expect(await resolveRef(forge, `refs/heads/${branch}`)).toBe(merged);
    await syncCheckout(checkout, branch);
    expect(await git(["rev-parse", "HEAD"], { cwd: checkout })).toBe(merged);
  });

  it("refuses yagura's own push of a rewritten checkout, with the relay's reason", async () => {
    await createUnitBranch(mirror, branch, "main");
    installRelay(mirror);
    const checkout = join(root, "u1");
    await checkoutUnit(mirror, checkout, branch);
    writeFileSync(join(checkout, "greet.py"), "x\n");
    await commitAll(checkout, "one", author);
    await pushCheckout(checkout, branch);
    await git(["commit", "--quiet", "--amend", "-m", "one, rewritten"], { cwd: checkout });
    expect(await pushCheckout(checkout, branch)).toBe(`${branch} only moves forward; merge instead of rebasing, and never force-push`);
  });

  it("merges an approved head onto the base itself when the repo has no forge", async () => {
    await createUnitBranch(mirror, branch, "main");
    await onUnit("greet.py", "def greet():\n    return 'hello'\n");
    await onMain("notes.md", "notes, edited on main\n");
    const head = await resolveRef(mirror, `refs/heads/${branch}`);
    const before = await resolveRef(forge, "refs/heads/main");
    const merged = await mergeWithoutForge(mirror, head, "main", "U1: Say hello", dev);
    expect(await resolveRef(forge, "refs/heads/main")).toBe(merged);
    expect(await git(["log", "-1", "--format=%P%n%B", merged], { gitDir: forge })).toBe(`${before} ${head}\nU1: Say hello`);
    expect(await git(["show", "main:greet.py"], { gitDir: forge })).toBe("def greet():\n    return 'hello'");
  });
});
