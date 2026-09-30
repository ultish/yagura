import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addWorktree, changedPaths, commitAll, ensureMirror, git, headSha, resolveRef } from "./git.js";
import { checkScope } from "./scope.js";

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
});

describe("scope", () => {
  it("flags paths outside the write scope and forbidden paths", () => {
    expect(checkScope(["app/orders.py", ".agents/verify/drive", "README.md"], ["app/**", ".agents/**"], [".agents/verify/**"])).toEqual([
      { path: ".agents/verify/drive", reason: "forbidden" },
      { path: "README.md", reason: "outside-write-scope" },
    ]);
  });

  it("passes a diff fully inside scope", () => {
    expect(checkScope(["app/orders.py", "tests/test_orders.py"], ["app/**", "tests/**"], [])).toEqual([]);
  });
});
