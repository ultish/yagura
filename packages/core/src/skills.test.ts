import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setSetting, type Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { Engine } from "./engine.js";
import { installedSkills, isInstalled, projectSkillChecks } from "./skills.js";
import { addProject, addRepo, getProject, openStore, type Db } from "./store.js";

const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
};

let db: Db;
let boot: Bootstrap;
let claude: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "yagura-skills-"));
  claude = join(root, "claude");
  skill(join(claude, "skills"), "setup-gradle");
  skill(join(root, "elsewhere"), "linked");
  symlinkSync(join(root, "elsewhere", "linked"), join(claude, "skills", "linked"));
  const pstack = join(root, "cache", "pstack", "0.5.0");
  skill(join(pstack, "skills"), "poteto-mode");
  mkdirSync(join(claude, "plugins"), { recursive: true });
  writeFileSync(
    join(claude, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "pstack@pstack-claude": [{ installPath: pstack }] } }),
  );
  boot = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "yagura"), bind: "", port: 0, tokenFile: "" };
  skill(join(boot.skillsDir, "skills"), "yagura-worker");
  db = openStore(":memory:");
  addRepo(db, { id: "a", url: "/a", defaultBranch: "main" });
  addRepo(db, { id: "b", url: "/b", defaultBranch: "main" });
  addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", repos: ["a", "b"] as RepoId[] });
});

describe("installed skills", () => {
  it("finds user skills, installed plugin skills, and yagura's overlays", () => {
    const found = installedSkills(boot, claude);
    expect([...found].sort()).toEqual(["linked", "pstack:poteto-mode", "setup-gradle", "yagura:yagura-worker"]);
    expect(isInstalled(found, "poteto-mode")).toBe(true);
    expect(isInstalled(found, "pstack:poteto-mode")).toBe(true);
    expect(isInstalled(found, "other:poteto-mode")).toBe(false);
    expect(isInstalled(found, "setup-maven")).toBe(false);
  });

  it("checks every skill a project names, per purpose and per repo layer", () => {
    expect(projectSkillChecks(db, boot, "p" as ProjectId, claude)).toEqual([]);
    setSetting(db, "project", "p" as ProjectId, "skills.scaffold", ["setup-gradle"]);
    setSetting(db, "repo", "b" as RepoId, "skills.work", ["setup-gradle", "setup-helm"]);
    expect(projectSkillChecks(db, boot, "p" as ProjectId, claude)).toEqual([
      { skill: "setup-gradle", purposes: ["scaffold", "work"], repos: ["a", "b"], installed: true },
      { skill: "setup-helm", purposes: ["work"], repos: ["b"], installed: false },
    ]);
  });

  it("stops a project whose skills are not installed before any agent starts", async () => {
    process.env.CLAUDE_CONFIG_DIR = claude;
    try {
      setSetting(db, "project", "p" as ProjectId, "skills.work", ["setup-helm"]);
      db.prepare("UPDATE projects SET state = 'active' WHERE id = 'p'").run();
      const engine = new Engine({ db, boot, adapters: {}, cli: [] }, { projectId: "p" as ProjectId, tickMs: 10 });
      await engine.tick();
      expect(getProject(db, "p" as ProjectId).andonReason).toBe(
        "skills not installed where agents run: setup-helm (work). Install them or change the project's skills settings, then clear the andon",
      );
      expect(db.prepare("SELECT COUNT(*) AS n FROM units").get()).toEqual({ n: 0 });
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});
