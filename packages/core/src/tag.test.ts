import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId, Sha, Unit } from "./domain.js";
import { commitAll, git, headSha } from "./git.js";
import { pushUnitTag } from "./tag.js";
import { addProject, addRepo, addUnit, checkTagName, getUnit, openStore, setProjectState, setUnitTag, type Db } from "./store.js";

const author = { name: "dev", email: "dev@example.com" };
let db: Db;
let ctx: RunContext;
let forge: string;
let work: string;
let unit: Unit;

const merged = (u: Unit, sha: string) => db.prepare("UPDATE units SET state = 'merged', merged_sha = ? WHERE id = ?").run(sha, u.id);
const tagsOnForge = (pattern = "v*") => git(["tag", "--list", pattern, "-n9"], { gitDir: forge });

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-tag-"));
  forge = join(root, "forge.git");
  work = join(root, "work");
  mkdirSync(work);
  await git(["init", "--quiet", "--bare", "-b", "main", forge]);
  await git(["init", "--quiet", "-b", "main"], { cwd: work });
  writeFileSync(join(work, "Cargo.toml"), 'version = "0.23.0"\n');
  await commitAll(work, "bump to 0.23.0", author);
  await git(["remote", "add", "origin", forge], { cwd: work });
  await git(["push", "--quiet", "origin", "main"], { cwd: work });

  const boot = { home: join(root, "home"), skillsDir: "", bind: "", port: 0, tokenFile: "" } as Bootstrap;
  db = openStore(":memory:");
  ctx = { db, boot, adapters: {}, cli: [] } as unknown as RunContext;
  addRepo(db, { id: "r", url: forge, defaultBranch: "main" });
  addProject(db, { id: "rel", name: "Release", goal: "g", predicate: "x", repos: ["r" as RepoId] });
  setProjectState(db, "rel" as ProjectId, "active");
  unit = addUnit(db, {
    projectId: "rel" as ProjectId,
    type: "work",
    repoId: "r" as RepoId,
    goal: "Release 0.23.0.",
    acceptance: ["a"],
    tag: "v0.23.0",
    timeboxSeconds: 60,
    maxAttempts: 2,
  });
});

describe("a unit's release tag", () => {
  it("is put on the merge commit as an annotated tag and pushed to the forge alone", async () => {
    merged(unit, await headSha(work));
    expect(await pushUnitTag(ctx, unit.id)).toBe("pushed");
    expect(await git(["rev-parse", "refs/tags/v0.23.0^{}"], { gitDir: forge })).toBe(await headSha(work));
    expect(await git(["cat-file", "-t", "refs/tags/v0.23.0"], { gitDir: forge })).toBe("tag");
    expect(await tagsOnForge()).toContain("rel/U1: Release 0.23.0");
    expect(getUnit(db, unit.id).tagPushedAt).not.toBeNull();
    expect(await git(["for-each-ref", "--format=%(refname)", "refs/heads"], { gitDir: forge })).toBe("refs/heads/main");
    expect(await pushUnitTag(ctx, unit.id)).toBe("none");
  });

  it("waits until the forge's branch has the commit, then tags it", async () => {
    merged(unit, "0".repeat(40));
    expect(await pushUnitTag(ctx, unit.id)).toBe("waiting");
    expect(await tagsOnForge()).toBe("");
    expect(getUnit(db, unit.id).tagPushedAt).toBeNull();
  });

  it("does nothing for a unit that has not merged", async () => {
    expect(await pushUnitTag(ctx, unit.id)).toBe("none");
    expect(await tagsOnForge()).toBe("");
  });

  it("accepts a tag the forge already has on this commit, without making another", async () => {
    const sha = await headSha(work);
    await git(["tag", "-a", "v0.23.0", "-m", "by hand"], { cwd: work });
    await git(["push", "--quiet", "origin", "v0.23.0"], { cwd: work });
    merged(unit, sha);
    expect(await pushUnitTag(ctx, unit.id)).toBe("pushed");
    expect(await tagsOnForge()).toContain("by hand");
  });

  it("never moves a tag the forge has on another commit, and says so once", async () => {
    const first = await headSha(work);
    writeFileSync(join(work, "Cargo.toml"), 'version = "0.23.1"\n');
    await commitAll(work, "bump again", author);
    await git(["push", "--quiet", "origin", "main"], { cwd: work });
    await git(["tag", "-a", "v0.23.0", first, "-m", "earlier"], { cwd: work });
    await git(["push", "--quiet", "origin", "v0.23.0"], { cwd: work });
    merged(unit, await headSha(work));
    expect(await pushUnitTag(ctx, unit.id)).toBe("conflict");
    expect(await pushUnitTag(ctx, unit.id)).toBe("conflict");
    expect(await git(["rev-parse", "refs/tags/v0.23.0^{}"], { gitDir: forge })).toBe(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'unit.tag_conflict'").get()).toEqual({ n: 1 });
  });
});

describe("tag names", () => {
  it("accept a version and refuse anything git or a shell could misread", () => {
    for (const ok of ["v0.23.0", "release/2026-10", "1.2.3-rc.1"]) expect(checkTagName(ok)).toBe(ok);
    for (const bad of ["", "-f", "a b", "v1..2", "a/", "x.lock", "$(id)", "a;b", "../x", "a//b"]) expect(() => checkTagName(bad), bad).toThrow(/tag name/);
  });

  it("can be asked for on a merged unit that has none, but not changed once the forge has it", async () => {
    const plain = addUnit(db, {
      projectId: "rel" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      acceptance: ["a"],
      timeboxSeconds: 60,
      maxAttempts: 2,
    });
    merged(plain, await headSha(work));
    expect(setUnitTag(db, plain.id, "v9.9.9").tag).toBe("v9.9.9");
    expect(await pushUnitTag(ctx, plain.id)).toBe("pushed");
    expect(() => setUnitTag(db, plain.id, "v9.9.10")).toThrow(/already has v9.9.9 on the forge/);
    expect(() => setUnitTag(db, unit.id, "bad tag")).toThrow(/tag name/);
  });
});
