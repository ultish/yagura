import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { repoChange, repoFile, repoHistory, repoTree } from "./browse.js";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { commitAll, git } from "./git.js";
import { layout } from "./paths.js";
import { addProject, addRepo, addUnit, openStore, setLandedSha, type Db } from "./store.js";

let db: Db;
let boot: Bootstrap;
let shas: { init: string; trailered: string; landed: string };
const repo = "sbx" as RepoId;
const author = { name: "t", email: "t@t" };

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-browse-"));
  const seed = join(root, "seed");
  mkdirSync(join(seed, "app"), { recursive: true });
  writeFileSync(join(seed, "app/main.py"), "a = 1\nb = 2\n");
  writeFileSync(join(seed, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "start", author);
  const init = await git(["rev-parse", "HEAD"], { cwd: seed });
  writeFileSync(join(seed, "app/main.py"), "a = 1\nb = 3\n");
  await commitAll(seed, "Change b\n\nYagura-Project: older\nYagura-Unit: U2\nYagura-Verdict: unit-verified by U4 (run:7)", author);
  const trailered = await git(["rev-parse", "HEAD"], { cwd: seed });
  writeFileSync(join(seed, "app/main.py"), "a = 1\nb = 3\nc = 4\n");
  writeFileSync(join(seed, "README.md"), "hi\n");
  await commitAll(seed, "Add c", author);
  const landed = await git(["rev-parse", "HEAD"], { cwd: seed });
  shas = { init, trailered, landed };
  const origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  boot = { home: join(root, "home"), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  addRepo(db, { id: repo, url: origin, defaultBranch: "main" });
  addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", minTier: "unit-verified", repos: [repo] });
  const unit = addUnit(db, {
    projectId: "p" as ProjectId,
    type: "work",
    repoId: repo,
    goal: "add c",
    writeScope: [],
    acceptance: [],
    verify: "v",
    timeboxSeconds: 60,
    maxAttempts: 1,
  });
  setLandedSha(db, unit.id, landed);
});

describe("browsing a repo's trunk", () => {
  it("lists the tree at trunk's head", async () => {
    expect(await repoTree(db, boot, repo)).toEqual({ head: shas.landed, branch: "main", files: ["README.md", "app/main.py", "logo.png"] });
  });

  it("ties each line to the unit that last wrote it, by yagura's record first and the commit's trailers second", async () => {
    await repoTree(db, boot, repo);
    const file = await repoFile(db, boot, repo, "app/main.py");
    expect(file.text).toBe("a = 1\nb = 3\nc = 4");
    expect(file.blame).toEqual([shas.init, shas.trailered, shas.landed]);
    expect(file.commits[shas.init]).toMatchObject({ subject: "start", projectId: null, seq: null });
    expect(file.commits[shas.trailered]).toMatchObject({ subject: "Change b", projectId: "older", seq: 2, verdict: "unit-verified by U4 (run:7)" });
    expect(file.commits[shas.landed]).toMatchObject({ subject: "Add c", projectId: "p", seq: 1 });
    expect(await repoFile(db, boot, repo, "logo.png")).toMatchObject({ binary: true, text: null, blame: [] });
  });

  it("lists trunk's history, or one file's, newest first", async () => {
    await repoTree(db, boot, repo);
    expect((await repoHistory(db, boot, repo)).map((c) => c.subject)).toEqual(["Add c", "Change b", "start"]);
    expect((await repoHistory(db, boot, repo, { path: "README.md" })).map((c) => c.subject)).toEqual(["Add c"]);
  });

  it("shows what a commit changed, the first one included", async () => {
    await repoTree(db, boot, repo);
    const change = await repoChange(db, boot, repo, shas.landed.slice(0, 10));
    expect(change.files).toEqual(["README.md", "app/main.py"]);
    expect(change.diff).toContain("+c = 4");
    expect(change.commit).toMatchObject({ projectId: "p", seq: 1 });
    expect((await repoChange(db, boot, repo, shas.init)).files).toEqual(["app/main.py", "logo.png"]);
    await expect(repoChange(db, boot, repo, "not-a-sha")).rejects.toThrow("not-a-sha is not a commit");
  });
});
