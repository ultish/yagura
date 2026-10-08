import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BUNDLED_SKILLS_DIR, type Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { layout } from "./paths.js";
import { defaultGuidance, effectiveGuidance, getPromptText, importStandingFiles, promptPlugin, setPromptText, standingFor } from "./prompts.js";
import { createThread } from "./threads.js";
import { addProject, addRepo, addUnit, createAttempt, openStore, type Db } from "./store.js";

let db: Db;
let boot: Bootstrap;
const project = "p" as ProjectId;

beforeEach(() => {
  boot = { home: mkdtempSync(join(tmpdir(), "yagura-prompts-")), packsDir: "", skillsDir: BUNDLED_SKILLS_DIR, bind: "", port: 0, tokenFile: "" };
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "file:///nowhere", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "p", repos: ["r" as RepoId] });
});

describe("role prompts", () => {
  it("uses the project's guidance over the global one over yagura's default, and resets back", () => {
    expect(effectiveGuidance(db, boot, "planner", project)).toMatchObject({ source: "default", text: defaultGuidance(boot, "planner") });
    expect(defaultGuidance(boot, "planner")).toContain("# yagura planner");
    setPromptText(db, "global", "", "planner", "guidance", "Plan big units.");
    expect(effectiveGuidance(db, boot, "planner", project)).toMatchObject({ source: "global", text: "Plan big units.\n" });
    setPromptText(db, "project", project, "planner", "guidance", "Plan one unit per feature, with its tests.");
    expect(effectiveGuidance(db, boot, "planner", project)).toMatchObject({ source: "project", text: "Plan one unit per feature, with its tests.\n" });
    expect(effectiveGuidance(db, boot, "planner", "other")).toMatchObject({ source: "global" });
    setPromptText(db, "project", project, "planner", "guidance", null);
    setPromptText(db, "global", "", "planner", "guidance", "  ");
    expect(effectiveGuidance(db, boot, "planner", project).source).toBe("default");
  });

  it("refuses guidance for every role at once and project guidance for the watchman", () => {
    expect(() => setPromptText(db, "project", project, "all", "guidance", "x")).toThrow(/per role/);
    expect(() => setPromptText(db, "project", project, "watchman", "guidance", "x")).toThrow(/global only/);
  });

  it("gives each role the project's notes for every role, then its own", () => {
    setPromptText(db, "project", project, "all", "notes", "Never touch vendor/.");
    setPromptText(db, "project", project, "worker", "notes", "Run the linter before you hand off.");
    expect(standingFor(db, project, "worker")).toBe("Never touch vendor/.\n\nRun the linter before you hand off.\n");
    expect(standingFor(db, project, "judge")).toBe("Never touch vendor/.\n");
  });

  it("moves hand-edited standing-orders files into the store and removes them", () => {
    mkdirSync(join(boot.home, "projects", project), { recursive: true });
    writeFileSync(layout(boot).standingOrders(project), "Use British spelling.\n");
    const thread = createThread(db, { title: "t" });
    mkdirSync(layout(boot).thread(thread.id), { recursive: true });
    writeFileSync(join(layout(boot).thread(thread.id), "standing-orders.md"), "Always propose merge: human.\n");
    expect(importStandingFiles(db, boot).length).toBe(2);
    expect(standingFor(db, project, "worker")).toBe("Use British spelling.\n");
    expect(getPromptText(db, "global", "", "watchman", "notes")).toBe(`From thread ${thread.id}:\nAlways propose merge: human.\n`);
    expect(existsSync(layout(boot).standingOrders(project))).toBe(false);
    expect(importStandingFiles(db, boot)).toEqual([]);
  });

  it("hands sessions yagura's own skills until something is overridden, then a copy carrying the override, and records the version a run got", () => {
    const unit = addUnit(db, {
      projectId: project,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      acceptance: ["x"],
      timeboxSeconds: 60,
      maxAttempts: 2,
    });
    const attempt = createAttempt(db, unit.id, "claude", null);
    expect(promptPlugin(db, boot, project, { attemptId: attempt.id, role: "worker" })).toBe(BUNDLED_SKILLS_DIR);
    setPromptText(db, "project", project, "worker", "guidance", "# worker for p\n\nWrite the test first.");
    const dir = promptPlugin(db, boot, project, { attemptId: attempt.id, role: "worker" });
    expect(dir).not.toBe(BUNDLED_SKILLS_DIR);
    const skill = readFileSync(join(dir, "skills", "yagura-worker", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: yagura-worker\n/);
    expect(skill).toContain("Write the test first.");
    expect(readFileSync(join(dir, "skills", "yagura-planner", "SKILL.md"), "utf8")).toContain("# yagura planner");
    expect(promptPlugin(db, boot, project)).toBe(dir);
    const recorded = db.prepare("SELECT v.text FROM attempts a JOIN prompt_versions v ON v.sha = a.guidance_sha WHERE a.id = ?").get(attempt.id) as {
      text: string;
    };
    expect(recorded.text).toContain("Write the test first.");
  });
});
