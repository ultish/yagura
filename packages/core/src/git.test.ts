import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkoutUnit } from "./branch.js";
import { addWorktree, changedPaths, commitAll, ensureMirror, git, headSha, resolveRef } from "./git.js";

const author = { name: "yagura", email: "yagura@localhost" };
let origin: string;
let mirror: string;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "yagura-git-"));
  origin = join(root, "origin");
  mkdirSync(join(origin, "app"), { recursive: true });
  writeFileSync(join(origin, "app/orders.py"), "x = 1\n");
  await git(["init", "--quiet", "-b", "main"], { cwd: origin });
  await commitAll(origin, "init", author);
  mirror = join(root, "mirror.git");
  await ensureMirror(origin, mirror);
});

describe("git", () => {
  it("mirrors origin and resolves its default branch", async () => {
    expect(await resolveRef(mirror, "origin/main")).toBe(await headSha(origin));
  });

  it("gives a unit its own worktree and branch, and reports what it changed", async () => {
    const base = await resolveRef(mirror, "origin/main");
    const wt = join(root, "wt-u1");
    await addWorktree(mirror, wt, "yg/p/u1-1", base);
    writeFileSync(join(wt, "app/orders.py"), "x = 2\n");
    mkdirSync(join(wt, ".agents/verify"), { recursive: true });
    writeFileSync(join(wt, ".agents/verify/drive"), "#!/bin/sh\n");
    expect(await commitAll(wt, "work", author)).toBe(true);
    expect(await commitAll(wt, "nothing", author)).toBe(false);
    expect((await changedPaths(wt, base)).sort()).toEqual([".agents/verify/drive", "app/orders.py"]);
  });

  it("keeps files tools generate out of an agent's commits, once per mirror", async () => {
    const wt = join(root, "wt-generated");
    await addWorktree(mirror, wt, "yg/p/u9-1", await resolveRef(mirror, "origin/main"));
    mkdirSync(join(wt, "app/__pycache__"), { recursive: true });
    writeFileSync(join(wt, "app/__pycache__/orders.cpython-312.pyc"), "bytecode");
    writeFileSync(join(wt, "app/new.py"), "y = 1\n");
    await commitAll(wt, "work", author);
    expect(await git(["show", "--name-only", "--format=", "HEAD"], { cwd: wt })).toBe("app/new.py");
    await ensureMirror(origin, mirror);
    expect(readFileSync(join(mirror, "info/exclude"), "utf8").match(/__pycache__/g)).toHaveLength(1);
  });

  it("keeps unit branches across later fetches", async () => {
    writeFileSync(join(origin, "app/orders.py"), "x = 3\n");
    await commitAll(origin, "upstream moves", author);
    await ensureMirror(origin, mirror);
    expect(await resolveRef(mirror, "yg/p/u1-1")).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveRef(mirror, "origin/main")).toBe(await headSha(origin));
  });

  it("brings a mirror up to date for many callers at once (a planner and workers starting together)", async () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(origin, "app/orders.py"), `x = ${10 + i}\n`);
      await commitAll(origin, `upstream moves ${i}`, author);
      await Promise.all(Array.from({ length: 8 }, () => ensureMirror(origin, mirror)));
      expect(await resolveRef(mirror, "origin/main")).toBe(await headSha(origin));
    }
  });
});

describe("a mirror's default branch", () => {
  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "yagura-adv-"));
    const origin = join(dir, "origin");
    mkdirSync(origin, { recursive: true });
    writeFileSync(join(origin, "a.txt"), "1\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: origin });
    await commitAll(origin, "one", author);
    const mirror = join(dir, "mirror.git");
    await ensureMirror(origin, mirror);
    await git(["branch", "yg/p/u1", "refs/remotes/origin/main"], { gitDir: mirror });
    return { dir, origin, mirror };
  }
  const land = async (origin: string, text: string) => {
    writeFileSync(join(origin, "a.txt"), `${text}\n`);
    await commitAll(origin, text, author);
    return headSha(origin);
  };

  it("follows the forge, so a worker's clone sees the latest commits and tags as its origin", async () => {
    const { dir, origin, mirror } = await fixture();
    const clone = join(dir, "wt");
    await checkoutUnit(mirror, clone, "yg/p/u1");
    const next = await land(origin, "two");
    await git(["tag", "-a", "v1.0.0", "-m", "release"], { cwd: origin });
    await ensureMirror(origin, mirror);

    expect(await resolveRef(mirror, "refs/heads/main")).toBe(next);
    await git(["fetch", "--quiet", "--tags", "origin"], { cwd: clone });
    expect(await git(["rev-parse", "origin/main"], { cwd: clone })).toBe(next);
    expect(await git(["tag", "--list", "v1.0.0"], { cwd: clone })).toBe("v1.0.0");
  });

  it("never winds back a branch the mirror is ahead on (a repo that lands by pushing merges into the mirror first)", async () => {
    const { origin, mirror } = await fixture();
    const base = await resolveRef(mirror, "refs/heads/main");
    const tree = await git(["rev-parse", `${base}^{tree}`], { gitDir: mirror });
    const ahead = await git(["commit-tree", tree, "-p", base, "-m", "merged here, not pushed yet"], { gitDir: mirror });
    await git(["update-ref", "refs/heads/main", ahead], { gitDir: mirror });
    await land(origin, "two");
    await ensureMirror(origin, mirror);
    expect(await resolveRef(mirror, "refs/heads/main")).toBe(ahead);
  });
});
