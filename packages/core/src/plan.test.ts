import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectId, RepoId } from "./domain.js";
import { applyDelta, extractDelta, PlanRejected, scopesOverlap, type PlanDelta } from "./plan.js";
import { setSetting } from "./config.js";
import { addProject, addRepo, getUnitBySeq, listDeps, listGates, listUnits, openStore, transitionUnit, type Db } from "./store.js";

let db: Db;
const project = "p" as ProjectId;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "svc", url: "file:///svc", defaultBranch: "main" });
  addRepo(db, { id: "other", url: "file:///other", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["svc" as RepoId] });
});

const unit = (key: string, write: string[], extra: Record<string, unknown> = {}) => ({
  key,
  repo: "svc",
  goal: `do ${key}`,
  write,
  accept: [`${key} works`],
  verify: "make test",
  ...extra,
});

const delta = (d: Record<string, unknown>): PlanDelta => {
  const r = extractDelta("```json\n" + JSON.stringify(d) + "\n```");
  if (!r.ok) throw new Error(r.reason);
  return r.delta;
};

describe("unit defaults", () => {
  it("takes timebox and tries from the repo layer, and the project layer over it", () => {
    db.prepare("INSERT INTO project_repos (project_id, repo_id) VALUES (?, 'other')").run(project);
    setSetting(db, "repo", "svc", "max_attempts", 5);
    setSetting(db, "repo", "svc", "timebox.work_seconds", 600);
    setSetting(db, "project", project, "timebox.work_seconds", 300);
    applyDelta(db, project, delta({ add: [unit("a", ["a/**"]), unit("b", ["b/**"], { repo: "other" })] }), null);
    expect(listUnits(db, project).map((u) => [u.repoId, u.maxAttempts, u.timeboxSeconds])).toEqual([
      ["svc", 5, 300],
      ["other", 2, 300],
    ]);
  });
});

describe("extractDelta", () => {
  it("takes the last json block and fills defaults", () => {
    const r = extractDelta('draft:\n```json\n{"add": []}\n```\nfinal:\n```json\n{"done": true, "summary": "all landed"}\n```');
    expect(r).toEqual({ ok: true, delta: { add: [], amend: [], retry: [], cancel: [], gates: [], done: true, summary: "all landed" } });
  });

  it("explains what is wrong with a malformed delta", () => {
    expect(extractDelta("no plan here")).toMatchObject({ ok: false, reason: expect.stringMatching(/no ```json/) });
    expect(extractDelta("```json\n{add: []}\n```")).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid JSON/) });
    expect(extractDelta('```json\n{"add":[{"key":"a","repo":"svc","goal":"g","write":[],"accept":["x"],"verify":"v"}]}\n```')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/add\.0\.write/),
    });
    expect(extractDelta('```json\n{"surprise": 1}\n```')).toMatchObject({ ok: false, reason: expect.stringMatching(/surprise/) });
  });
});

describe("scopesOverlap", () => {
  it.each([
    [["app/**"], ["app/orders.py"], true],
    [["app/a/**"], ["app/b/**"], false],
    [["**"], ["docs/**"], true],
    [["tests/test_orders.py"], ["tests/test_orders.py"], true],
    [["app/**"], ["application/**"], false],
  ])("%j vs %j -> %s", (a, b, expected) => {
    expect(scopesOverlap(a, b)).toBe(expected);
  });
});

describe("applyDelta", () => {
  it("creates ready units, resolves deps by key and by U-number, and serializes overlapping scopes", () => {
    const first = applyDelta(db, project, delta({ add: [unit("store", ["app/store/**"])] }), null);
    expect(first.added.map((u) => [u.seq, u.state, u.playbook])).toEqual([[1, "ready", "feature"]]);
    applyDelta(
      db,
      project,
      delta({
        add: [
          unit("api", ["app/api/**"], { deps: [{ on: "U1" }] }),
          unit("store-fix", ["app/store/fix.py"]),
          unit("docs", ["docs/**"], { deps: [{ on: "api", kind: "needs-source" }] }),
        ],
      }),
      null,
    );
    expect(
      listDeps(db, project)
        .map((d) => `U${d.unitId}->U${d.dependsOn}:${d.kind}`)
        .sort(),
    ).toEqual(["U2->U1:needs-landed", "U3->U1:scope-overlap", "U4->U2:needs-source"]);
  });

  it("rejects the whole delta on any error, leaving nothing behind", () => {
    const bad = delta({ add: [unit("a", ["app/**"]), unit("b", ["lib/**"], { deps: [{ on: "nope" }] })] });
    expect(() => applyDelta(db, project, bad, null)).toThrow(PlanRejected);
    expect(listUnits(db, project)).toEqual([]);
    expect(() => applyDelta(db, project, delta({ add: [unit("a", ["x/**"], { repo: "other" })] }), null)).toThrow(/not part of this project/);
    expect(() => applyDelta(db, project, delta({ add: [unit("a", ["x/**"]), unit("a", ["y/**"])] }), null)).toThrow(/duplicate key/);
  });

  it("rejects dependency cycles", () => {
    const d = delta({ add: [unit("a", ["a/**"], { deps: [{ on: "b" }] }), unit("b", ["b/**"], { deps: [{ on: "a" }] })] });
    expect(() => applyDelta(db, project, d, null)).toThrow(/cycle/);
    expect(listUnits(db, project)).toEqual([]);
  });

  it("amends only units that have not started, and retries blocked ones with a note and a fresh attempt", () => {
    applyDelta(db, project, delta({ add: [unit("a", ["a/**"]), unit("b", ["b/**"])] }), null);
    applyDelta(db, project, delta({ amend: [{ unit: "U1", goal: "sharper goal" }] }), null);
    expect(getUnitBySeq(db, project, 1).goal).toBe("sharper goal");
    const u2 = getUnitBySeq(db, project, 2);
    transitionUnit(db, u2.id, "blocked");
    applyDelta(db, project, delta({ retry: [{ unit: "U2", note: "split the migration out first" }] }), null);
    expect(getUnitBySeq(db, project, 2)).toMatchObject({ state: "ready", notes: ["Planner: split the migration out first"] });
    expect(() => applyDelta(db, project, delta({ retry: [{ unit: "U1", note: "x" }] }), null)).toThrow(/only blocked, failed, or rejected/);
  });

  it("cancels idle units, warns about running ones, and opens planner gates", () => {
    applyDelta(db, project, delta({ add: [unit("a", ["a/**"]), unit("b", ["b/**"])] }), null);
    transitionUnit(db, getUnitBySeq(db, project, 2).id, "running");
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
    expect(getUnitBySeq(db, project, 1).state).toBe("abandoned");
    expect(r.warnings).toEqual(["U2 is running and was not cancelled; cancel it again after it hands off"]);
    expect(listGates(db, project, "open")).toMatchObject([{ kind: "planner", question: "Keep codes case-sensitive?", defaultOption: "yes" }]);
  });
});
