import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { RepoId } from "./domain.js";
import { commitAll, git, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { registerRepo, resolveSource, suggestRepoId } from "./repos.js";
import { getRepo, openStore, type Db } from "./store.js";

const author = { name: "yagura", email: "yagura@localhost" };
const pack = { provider: "local-process", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] };

let root: string;
let db: Db;
let boot: Bootstrap;

async function workingCopy(name: string, opts: { branch?: string; pack?: unknown } = {}): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  if (opts.pack !== undefined) {
    mkdirSync(join(dir, ".agents/verify"), { recursive: true });
    writeFileSync(join(dir, ".agents/verify/verify.json"), typeof opts.pack === "string" ? opts.pack : JSON.stringify(opts.pack));
  }
  await git(["init", "--quiet", "-b", opts.branch ?? "main"], { cwd: dir });
  await commitAll(dir, "init", author);
  return dir;
}

async function bare(name: string, opts: { branch?: string; pack?: unknown } = {}): Promise<string> {
  const path = join(root, `${name}.git`);
  await git(["clone", "--quiet", "--bare", await workingCopy(`${name}-seed`, opts), path]);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yagura-repos-"));
  boot = { home: join(root, "home"), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
});

describe("registering an existing repo", () => {
  it("mirrors a bare repo, reads its default branch from HEAD, and finds the trunk verify pack", async () => {
    const url = await bare("billing", { branch: "trunk", pack });
    const { repo, inspection } = await registerRepo({ db, boot }, { source: url });
    expect(repo).toMatchObject({ id: "billing", url, defaultBranch: "trunk", packStatus: "unproven" });
    expect(inspection.notes).toEqual([]);
    expect(await resolveRef(layout(boot).mirror("billing" as RepoId), "origin/trunk")).toBe(inspection.trunk);
  });

  it("registers a repo without a pack, and says verification will not work yet", async () => {
    const { repo, inspection } = await registerRepo({ db, boot }, { source: await bare("scratch"), id: "notes" });
    expect(repo).toMatchObject({ id: "notes", defaultBranch: "main", packStatus: "missing" });
    expect(inspection.notes).toEqual(["no verify pack at .agents/verify/verify.json; verification stays env-blocked until a pack lands on main"]);
  });

  it("refuses a working copy and points at its origin, without mirroring", async () => {
    const dir = await workingCopy("scratch");
    await expect(registerRepo({ db, boot }, { source: dir })).rejects.toThrow(`${dir} is a working copy; give the repo's git URL instead`);
    await git(["remote", "add", "origin", "git@gitlab.internal:team/scratch.git"], { cwd: dir });
    await expect(registerRepo({ db, boot }, { source: dir })).rejects.toThrow(
      `${dir} is a working copy; give the repo's git URL instead (its origin is git@gitlab.internal:team/scratch.git)`,
    );
    expect(existsSync(layout(boot).mirror("scratch" as RepoId))).toBe(false);
  });

  it("reports an unparseable pack as missing with the reason", async () => {
    const { repo, inspection } = await registerRepo({ db, boot }, { source: await bare("broken", { pack: "{nope" }) });
    expect(repo.packStatus).toBe("missing");
    expect(inspection.notes[0]).toMatch(/^verify.json is not valid JSON/);
  });

  it("refuses a path that is not a repo, an empty repo, a taken id, and a url registered twice, without mirroring", async () => {
    const empty = join(root, "empty.git");
    await git(["init", "--quiet", "--bare", empty]);
    await expect(registerRepo({ db, boot }, { source: join(root, "nowhere") })).rejects.toThrow(/cannot read .*nowhere as a git repo/);
    await expect(registerRepo({ db, boot }, { source: empty })).rejects.toThrow(/has no commits/);
    expect(existsSync(layout(boot).mirror("empty" as RepoId))).toBe(false);

    const url = await bare("billing", { pack });
    await registerRepo({ db, boot }, { source: url });
    await expect(registerRepo({ db, boot }, { source: await bare("other", { pack }), id: "billing" })).rejects.toThrow("repo billing already exists");
    await expect(registerRepo({ db, boot }, { source: url, id: "billing-2" })).rejects.toThrow(`${url} is already registered as repo billing`);
    await expect(registerRepo({ db, boot }, { source: url, id: "Bad Id" })).rejects.toThrow(/lowercase words/);
    expect(getRepo(db, "billing" as RepoId).url).toBe(url);
  });
});

describe("repo sources", () => {
  it("resolves local paths and leaves git URLs alone", () => {
    expect(resolveSource("~/code/app")).toBe(join(homedir(), "code/app"));
    expect(resolveSource("git@gitlab.internal:team/app.git")).toBe("git@gitlab.internal:team/app.git");
    expect(resolveSource("https://gitlab.internal/team/app.git")).toBe("https://gitlab.internal/team/app.git");
  });

  it("suggests an id from the last path segment", () => {
    expect(suggestRepoId("/Users/x/Developer/kuru-testbed")).toBe("kuru-testbed");
    expect(suggestRepoId("/srv/git/Billing_API.git/")).toBe("billing-api");
    expect(suggestRepoId("git@gitlab.internal:team/app.git")).toBe("app");
    expect(suggestRepoId("git@host:x.git")).toBe("repo");
    expect(suggestRepoId("")).toBe("repo");
  });
});
