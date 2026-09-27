import { beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { defaultExpiredGates, gateDeadline, recentlyResolvedGates } from "./gates.js";
import { addGate, addProject, addRepo, answerGate, listGates, openStore, type Db } from "./store.js";

let db: Db;
const project = "p" as ProjectId;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "svc", url: "file:///svc", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["svc" as RepoId] });
});

function gate(kind: string, options: string[], defaultOption: string | null, ageHours: number): number {
  const id = addGate(db, { projectId: project, kind, question: `${kind}?`, options, defaultOption });
  db.prepare("UPDATE gates SET created_at = ? WHERE id = ?").run(hoursAgo(ageHours), id);
  return id;
}

const states = () => listGates(db, project).map((g) => [g.kind, g.state, g.answer]);

describe("gate timeouts", () => {
  it("takes the default after the timeout, but never for a hold default or a gate without one", () => {
    gate("planner", ["sqlite", "postgres"], "sqlite", 25);
    gate("planner", ["a", "b"], "a", 2);
    gate("land", ["land", "hold"], "hold", 100);
    gate("question", ["x", "y"], null, 100);
    expect(defaultExpiredGates(db).map((g) => g.answer)).toEqual(["sqlite"]);
    expect(states()).toEqual([
      ["planner", "defaulted", "sqlite"],
      ["planner", "open", null],
      ["land", "open", null],
      ["question", "open", null],
    ]);
    expect(db.prepare("SELECT data_json FROM events WHERE type = 'gate.defaulted'").all()).toEqual([
      { data_json: JSON.stringify({ gate: 1, kind: "planner", answer: "sqlite" }) },
    ]);
    expect(defaultExpiredGates(db)).toEqual([]);
  });

  it("uses the project's timeout, and none when it is empty", () => {
    const id = gate("planner", ["a", "b"], "a", 2);
    const open = () => listGates(db, project, "open").find((g) => g.id === id)!;
    expect(Date.parse(gateDeadline(db, open())!) - Date.parse(open().createdAt)).toBe(24 * 3_600_000);
    setSetting(db, "project", project, "gates.timeout_hours", null);
    expect(gateDeadline(db, open())).toBeNull();
    setSetting(db, "project", project, "gates.timeout_hours", 1);
    expect(defaultExpiredGates(db).map((g) => g.id)).toEqual([id]);
    expect(gateDeadline(db, listGates(db, project)[0]!)).toBeNull();
  });

  it("lists resolved gates newest first, answered and defaulted alike", () => {
    const first = gate("planner", ["a", "b"], "a", 30);
    const second = gate("land", ["land", "hold"], "hold", 1);
    defaultExpiredGates(db);
    answerGate(db, second, "land");
    expect(recentlyResolvedGates(db).map((g) => [g.id, g.state])).toEqual([
      [second, "answered"],
      [first, "defaulted"],
    ]);
  });
});
