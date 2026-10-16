import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectId, RepoId } from "./domain.js";
import { applyDelta, PlanDelta, PlanRejected } from "./plan.js";
import { setSetting } from "./config.js";
import { addProject, addRepo, getUnitBySeq, listDeps, listGates, listUnits, openStore, transitionUnit, type Db } from "./store.js";

let db: Db;
const project = "p" as ProjectId;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "svc", url: "file:///svc", defaultBranch: "main" });
  addRepo(db, { id: "other", url: "file:///other", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", repos: ["svc" as RepoId] });
});

const unit = (key: string, extra: Record<string, unknown> = {}) => ({ key, repo: "svc", goal: `do ${key}`, acceptance: [`${key} works`], ...extra });

const delta = (d: Record<string, unknown>): PlanDelta => PlanDelta.parse(d);

describe("unit defaults", () => {
  it("takes timebox and tries from the repo layer, and the project layer over it", () => {
    db.prepare("INSERT INTO project_repos (project_id, repo_id) VALUES (?, 'other')").run(project);
    setSetting(db, "repo", "svc", "max_attempts", 5);
    setSetting(db, "repo", "svc", "timebox.work_seconds", 600);
    setSetting(db, "project", project, "timebox.work_seconds", 300);
    applyDelta(db, project, delta({ add: [unit("a"), unit("b", { repo: "other" })] }), null);
    expect(listUnits(db, project).map((u) => [u.repoId, u.maxAttempts, u.timeboxSeconds])).toEqual([
      ["svc", 5, 300],
      ["other", 2, 300],
    ]);
  });
});

describe("PlanDelta", () => {
  it("fills defaults", () => {
    expect(PlanDelta.parse({ done: true, summary: "all merged" })).toEqual({
      add: [],
      amend: [],
      retry: [],
      cancel: [],
      gates: [],
      done: true,
      summary: "all merged",
    });
  });

  it("says what is wrong with a malformed delta", () => {
    const why = (d: unknown) => {
      const r = PlanDelta.safeParse(d);
      return r.success ? null : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    };
    expect(why({ add: [{ key: "a", repo: "svc", goal: "g", acceptance: [] }] })).toMatch(/add\.0\.acceptance/);
    expect(why({ surprise: 1 })).toMatch(/surprise/);
    expect(why({ add: [{ ...unit("a"), write: ["app/**"] }] })).toMatch(/write/);
    expect(why({ add: [{ ...unit("a"), verify: "make test" }] })).toMatch(/verify/);
    expect(why({ gates: [{ question: "q", options: ["a", "b"], default: "c" }] })).toMatch(/default must be one of its options/);
  });
});

describe("applyDelta", () => {
  it("creates waiting units with their goal, acceptance, context, base, and refs", () => {
    const r = applyDelta(
      db,
      project,
      delta({ add: [unit("a", { context: ["why: checkout needs a total"], base: "release-1", refs: ["svc#12"] }), unit("b")] }),
      null,
    );
    expect(r.added.map((u) => [u.seq, u.state, u.playbook, u.base])).toEqual([
      [1, "waiting", "feature", "release-1"],
      [2, "waiting", "feature", null],
    ]);
    expect(getUnitBySeq(db, project, 1)).toMatchObject({ goal: "do a", acceptance: ["a works"], context: ["why: checkout needs a total"], refs: ["svc#12"] });
  });

  it("resolves after by key and by U-number", () => {
    applyDelta(db, project, delta({ add: [unit("store")] }), null);
    applyDelta(db, project, delta({ add: [unit("api", { after: ["U1"] }), unit("docs", { after: ["api"] })] }), null);
    expect(getUnitBySeq(db, project, 2).after).toEqual([getUnitBySeq(db, project, 1).id]);
    expect(
      listDeps(db, project)
        .map((d) => `U${d.unitId}->U${d.dependsOn}`)
        .sort(),
    ).toEqual(["U2->U1", "U3->U2"]);
  });

  it("rejects the whole delta on any error, leaving nothing behind", () => {
    const bad = delta({ add: [unit("a"), unit("b", { after: ["nope"] })] });
    expect(() => applyDelta(db, project, bad, null)).toThrow(PlanRejected);
    expect(listUnits(db, project)).toEqual([]);
    expect(() => applyDelta(db, project, delta({ add: [unit("a", { repo: "other" })] }), null)).toThrow(/not part of this project/);
    expect(() => applyDelta(db, project, delta({ add: [unit("a"), unit("a")] }), null)).toThrow(/duplicate key/);
  });

  it("rejects dependency cycles", () => {
    const d = delta({ add: [unit("a", { after: ["b"] }), unit("b", { after: ["a"] })] });
    expect(() => applyDelta(db, project, d, null)).toThrow(/cycle/);
    expect(listUnits(db, project)).toEqual([]);
  });

  it("refuses to come after a dropped unit", () => {
    applyDelta(db, project, delta({ add: [unit("a")] }), null);
    transitionUnit(db, getUnitBySeq(db, project, 1).id, "dropped");
    expect(() => applyDelta(db, project, delta({ add: [unit("b", { after: ["U1"] })] }), null)).toThrow("b comes after U1, which was dropped");
  });

  it("amends only units that have not started, and retries stuck ones with a note and a fresh attempt", () => {
    applyDelta(db, project, delta({ add: [unit("a"), unit("b")] }), null);
    applyDelta(db, project, delta({ amend: [{ unit: "U1", goal: "sharper goal", acceptance: ["a sharper"] }] }), null);
    expect(getUnitBySeq(db, project, 1)).toMatchObject({ goal: "sharper goal", acceptance: ["a sharper"] });
    const u2 = getUnitBySeq(db, project, 2);
    transitionUnit(db, u2.id, "stuck");
    applyDelta(db, project, delta({ retry: [{ unit: "U2", note: "split the migration out first" }] }), null);
    expect(getUnitBySeq(db, project, 2)).toMatchObject({ state: "waiting", notes: ["Planner: split the migration out first"] });
    expect(() => applyDelta(db, project, delta({ retry: [{ unit: "U1", note: "x" }] }), null)).toThrow(/only stuck units can be retried/);
    transitionUnit(db, getUnitBySeq(db, project, 1).id, "building");
    expect(() => applyDelta(db, project, delta({ amend: [{ unit: "U1", goal: "x" }] }), null)).toThrow(/already started \(building\)/);
  });

  it("rewires a unit that has not started by amending its after, and refuses a cycle", () => {
    applyDelta(db, project, delta({ add: [unit("pack"), unit("core", { after: ["pack"] }), unit("cli", { after: ["core"] })] }), null);
    applyDelta(db, project, delta({ amend: [{ unit: "U2", after: [] }], add: [unit("docs")] }), null);
    applyDelta(db, project, delta({ amend: [{ unit: "U3", after: ["U4"] }] }), null);
    expect(
      listDeps(db, project)
        .map((d) => `U${d.unitId}->U${d.dependsOn}`)
        .sort(),
    ).toEqual(["U3->U4"]);
    expect(() => applyDelta(db, project, delta({ amend: [{ unit: "U4", after: ["U3"] }] }), null)).toThrow(/cycle/);
    expect(listDeps(db, project).filter((d) => d.unitId === 4)).toEqual([]);
  });

  it("drops idle units, warns about ones being built, and opens planner gates", () => {
    applyDelta(db, project, delta({ add: [unit("a"), unit("b")] }), null);
    transitionUnit(db, getUnitBySeq(db, project, 2).id, "building");
    const r = applyDelta(
      db,
      project,
      delta({
        cancel: [
          { unit: "U1", reason: "superseded" },
          { unit: "U2", reason: "superseded" },
        ],
        gates: [{ question: "Keep codes case-sensitive?", options: ["yes", "no"], default: "yes" }],
      }),
      null,
    );
    expect(getUnitBySeq(db, project, 1).state).toBe("dropped");
    expect(r.warnings).toEqual(["U2 is being built and was not cancelled; cancel it again once it is not"]);
    expect(listGates(db, project, "open")).toMatchObject([{ kind: "planner", question: "Keep codes case-sensitive?", defaultOption: "yes" }]);
  });
});
