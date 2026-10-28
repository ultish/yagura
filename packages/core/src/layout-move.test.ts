import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { layout } from "./paths.js";
import { addProject, addRepo, addUnit, createAttempt, getAttempt, getRepo, openStore, updateAttempt } from "./store.js";
import { moveHomeLayout } from "./layout-move.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("moveHomeLayout", () => {
  it("moves a repo's clone, remote, and checkouts to repos/<id>/ and keeps the checkouts working", async () => {
    const home = mkdtempSync(join(tmpdir(), "yagura-move-"));
    const boot = { home, skillsDir: "", bind: "", port: 0, tokenFile: "" } as Bootstrap;
    const db = openStore(":memory:");
    const upstream = join(home, "repos", "r.git");
    const seed = mkdtempSync(join(tmpdir(), "yagura-seed-"));
    sh(seed, "init", "--quiet", "-b", "main");
    writeFileSync(join(seed, "a.txt"), "a");
    sh(seed, "add", ".");
    sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
    mkdirSync(join(home, "repos"), { recursive: true });
    sh(seed, "clone", "--quiet", "--bare", seed, upstream);
    const oldMirror = join(home, "cache", "repos", "r.git");
    mkdirSync(join(home, "cache", "repos"), { recursive: true });
    sh(seed, "clone", "--quiet", "--bare", upstream, oldMirror);
    const oldCheckout = join(home, "worktrees", "r", "p-u1");
    mkdirSync(join(home, "worktrees", "r"), { recursive: true });
    execFileSync("git", ["--git-dir", oldMirror, "worktree", "add", "--quiet", "--detach", oldCheckout, "HEAD"]);
    addRepo(db, { id: "r", url: upstream, defaultBranch: "main" });
    addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", repos: ["r" as RepoId] });
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      acceptance: ["a"],
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    const attempt = createAttempt(db, unit.id, "claude", null);
    updateAttempt(db, attempt.id, { worktreePath: oldCheckout });

    const moved = await moveHomeLayout(db, boot);

    const paths = layout(boot);
    expect(moved).toHaveLength(3);
    expect(existsSync(paths.mirror("r" as RepoId))).toBe(true);
    expect(existsSync(oldMirror)).toBe(false);
    expect(existsSync(join(home, "cache"))).toBe(true);
    expect(getRepo(db, "r" as RepoId).url).toBe(paths.upstream("r" as RepoId));
    expect(sh(paths.mirror("r" as RepoId), "remote", "get-url", "origin")).toBe(paths.upstream("r" as RepoId));
    const checkout = paths.checkout("r" as RepoId, "p" as ProjectId, 1);
    expect(getAttempt(db, attempt.id).worktreePath).toBe(checkout);
    expect(readFileSync(join(checkout, "a.txt"), "utf8")).toBe("a");
    expect(sh(checkout, "status", "--porcelain")).toBe("");
    expect(sh(checkout, "rev-parse", "--git-common-dir")).toBe(realpathSync(paths.mirror("r" as RepoId)));
    expect(await moveHomeLayout(db, boot)).toEqual([]);
  });
});
