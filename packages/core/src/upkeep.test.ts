import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "./config.js";
import type { ProjectId, RepoId, UnitId } from "./domain.js";
import { JudgeRecord } from "./records.js";
import { requiredProjectSkills } from "./skills.js";
import { addProject, addRepo, addUnit, getUnit, openStore, setProjectState, type Db } from "./store.js";
import { requestUpkeep, scheduleUpkeep, UPKEEP_PLAYBOOK, upkeepDue } from "./upkeep.js";

let db: Db;
const repo = "r" as RepoId;
const project = "p" as ProjectId;
const boot = { home: mkdtempSync(join(tmpdir(), "yagura-upkeep-")), skillsDir: "", bind: "", port: 0, tokenFile: "" };
const guide = async () => true;
const noGuide = async () => false;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", repos: [repo] });
  setProjectState(db, project, "active");
  setSetting(db, "repo", "r", "verify.upkeep_every_merges", 3);
});

const unit = (playbook: string | null = null) =>
  addUnit(db, { projectId: project, type: "work", repoId: repo, goal: "g", acceptance: ["a"], playbook, timeboxSeconds: 60, maxAttempts: 2 });

const event = (type: string, ts: string, unitId: UnitId | null, data: Record<string, unknown>) =>
  db.prepare("INSERT INTO events (ts, type, project_id, unit_id, data_json) VALUES (?, ?, ?, ?, ?)").run(ts, type, project, unitId, JSON.stringify(data));
const merged = (ts: string) => event("unit.state", ts, unit().id, { to: "merged" });
const at = (id: UnitId, createdAt: string) => db.prepare("UPDATE units SET created_at = ? WHERE id = ?").run(createdAt, id);

describe("upkeepDue", () => {
  it("is not due until enough units have merged", () => {
    merged("2026-01-01T00:00:01Z");
    merged("2026-01-01T00:00:02Z");
    expect(upkeepDue(db, repo)).toBeNull();
    merged("2026-01-01T00:00:03Z");
    expect(upkeepDue(db, repo)?.reasons).toEqual(["3 units have merged into this repo since the guide was last checked."]);
  });

  it("never counts merges when the setting is 0", () => {
    setSetting(db, "repo", "r", "verify.upkeep_every_merges", 0);
    for (const s of ["01", "02", "03", "04"]) merged(`2026-01-01T00:00:${s}Z`);
    expect(upkeepDue(db, repo)).toBeNull();
  });

  it("is due at once when a judge reports a stale page, or the developer asks", () => {
    event("guide.stale", "2026-01-01T00:00:01Z", unit().id, { repo, report: "health-check: says {ok} but the app also returns a version" });
    expect(upkeepDue(db, repo)?.reasons[0]).toContain("health-check: says {ok}");
    requestUpkeep(db, repo, "after the refactor");
    expect(upkeepDue(db, repo)?.reasons.join("\n")).toContain("They said: after the refactor");
  });

  it("ignores a stale report from an upkeep unit's own judge", () => {
    const u = unit(UPKEEP_PLAYBOOK);
    event("guide.stale", "2026-01-01T00:00:01Z", u.id, { repo, report: "orders-api: still wrong" });
    expect(upkeepDue(db, repo)).toBeNull();
  });

  it("waits while an upkeep is in flight, then counts from it", () => {
    const first = unit(UPKEEP_PLAYBOOK);
    at(first.id, "2026-01-01T00:00:10Z");
    event("guide.stale", "2026-01-01T00:00:20Z", unit().id, { repo, report: "a: b" });
    expect(upkeepDue(db, repo)).toBeNull();
    db.prepare("UPDATE units SET state = 'merged' WHERE id = ?").run(first.id);
    expect(upkeepDue(db, repo)?.reasons).toHaveLength(1);
    event("guide.stale", "2026-01-01T00:00:05Z", unit().id, { repo, report: "older: before the upkeep" });
    expect(upkeepDue(db, repo)?.stale).toEqual(["a: b"]);
  });
});

describe("scheduleUpkeep", () => {
  it("creates one guide-upkeep unit in the newest active project, with the reasons as context", async () => {
    event("guide.stale", "2026-01-01T00:00:01Z", unit().id, { repo, report: "health-check: stale" });
    const [created, ...more] = await scheduleUpkeep(db, boot, guide);
    expect(more).toEqual([]);
    expect(getUnit(db, created!.id)).toMatchObject({ playbook: UPKEEP_PLAYBOOK, repoId: repo, projectId: project, state: "waiting", scaffold: false });
    expect(created!.goal).toContain("verification guide");
    expect(created!.acceptance).toContain("Only files under .claude/skills/verify-* changed");
    expect(created!.acceptance.join(" ")).toContain("SKILL.md");
    expect(created!.context.join("\n")).toContain("health-check: stale");
    expect(await scheduleUpkeep(db, boot, guide)).toEqual([]);
  });

  it("does nothing for a repo without a guide, or with no active project", async () => {
    requestUpkeep(db, repo, "");
    expect(await scheduleUpkeep(db, boot, noGuide)).toEqual([]);
    setProjectState(db, project, "closed");
    expect(await scheduleUpkeep(db, boot, guide)).toEqual([]);
    setProjectState(db, project, "active");
    expect(await scheduleUpkeep(db, boot, guide)).toHaveLength(1);
  });
});

describe("the judge's stale-page report and the upkeep worker", () => {
  it("reads --stale-page as part of the verdict", () => {
    expect(JudgeRecord.parse({ verdict: "approve", runs: [1], stalePages: ["health-check: stale"] }).stalePages).toEqual(["health-check: stale"]);
    expect(JudgeRecord.parse({ verdict: "approve", runs: [1] }).stalePages).toEqual([]);
  });

  it("makes an upkeep unit's worker load the maintain skill", () => {
    expect(requiredProjectSkills(db, unit(UPKEEP_PLAYBOOK))).toEqual(["pstack:maintain-verification-skill"]);
    expect(requiredProjectSkills(db, unit())).toEqual([]);
  });
});
