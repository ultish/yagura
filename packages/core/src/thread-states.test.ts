import { beforeEach, describe, expect, it } from "vitest";
import { listAmendments, proposeAmendment } from "./amend.js";
import { listDisagreements } from "./disagreements.js";
import type { ProjectId, RepoId, Unit } from "./domain.js";
import { addGate, addProject, addRepo, addUnit, answerGate, getUnit, listUnits, openStore, transitionUnit, type Db } from "./store.js";
import { IllegalThreadTransition, listThreadRows, queueTriage, transitionThread } from "./triage.js";

let db: Db;
const project = "p" as ProjectId;
const thread = { id: "RT_1", kind: "review-thread" as const, author: "ultish", path: "index.js", line: 2, comments: ["add some emojis!"] };

// A unit waiting on the developer's answer to one thread, as an arbiter's ask leaves it.
function asked(changes: string[], extra: { planNote?: string } = {}): Unit {
  const u = addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "r" as RepoId,
    goal: "shout",
    writeScope: ["index.js"],
    acceptance: ["shout('app') === 'HELLO, APP!'"],
    verify: "node check.js",
    timeboxSeconds: 60,
    maxAttempts: 2,
  });
  for (const s of ["ready", "running", "handed_off", "verifying", "verified", "blocked"] as const) transitionUnit(db, u.id, s);
  const gate = addGate(db, { projectId: project, unitId: u.id, kind: "review", question: "q", options: ["fix", "dismiss"] });
  db.prepare(
    `INSERT INTO mr_threads (unit_id, thread_id, kind, author, path, line, comments_json, decision, reason, gate_id, state, changes_json, plan_note, created_at)
     VALUES (?, ?, 'review-thread', 'ultish', 'index.js', 2, ?, 'asked', 'emojis contradict criterion 1', ?, 'waiting', ?, ?, 't')`,
  ).run(u.id, thread.id, JSON.stringify(thread.comments), gate, JSON.stringify(changes), extra.planNote ?? null);
  if (changes.includes("acceptance"))
    proposeAmendment(db, {
      unitId: u.id,
      gateId: gate,
      threadId: thread.id,
      author: "ultish",
      quote: "add some emojis!",
      changes: [{ kind: "replace", from: "shout('app') === 'HELLO, APP!'", to: "shout('app') === 'HELLO, APP! 🎉'" }],
    });
  answerGate(db, gate, "fix");
  return getUnit(db, u.id);
}

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "/r", defaultBranch: "main" });
  addProject(db, { id: project, name: "p", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["r" as RepoId] });
});

describe("the developer's answer to a ruled thread (§28)", () => {
  it("applies an approved change to the criteria and verifies the unit again, with no arbiter and no worker", () => {
    const u = asked(["acceptance"]);
    expect(queueTriage(db, u, "pull request #1", [{ thread, directive: "fix" }])).toBeNull();
    expect(getUnit(db, u.id)).toMatchObject({ state: "verifying", acceptance: ["shout('app') === 'HELLO, APP! 🎉'"] });
    expect(listUnits(db, project).filter((x) => x.type === "verify")).toHaveLength(1);
    expect(listUnits(db, project).filter((x) => x.type === "review-triage")).toEqual([]);
    expect(listAmendments(db, u.id).map((a) => a.state)).toEqual(["approved"]);
    expect(listThreadRows(db, u.id)[0]).toMatchObject({ state: "verifying", decision: "fixed" });
  });

  it("hands a plan change to the project lead as a follow-up and replies, leaving the unit verified", () => {
    const u = asked(["plan"], { planNote: "a separate unit for emoji themes" });
    expect(queueTriage(db, u, "pull request #1", [{ thread, directive: "fix" }])).toBeNull();
    expect(getUnit(db, u.id).state).toBe("verified");
    expect(listDisagreements(db, { unitId: u.id })).toMatchObject([{ action: "follow-up", reason: "a separate unit for emoji themes" }]);
    expect(listThreadRows(db, u.id)[0]).toMatchObject({
      state: "replying",
      decision: "fixed",
      reason: "Planned as a follow-up: a separate unit for emoji themes",
    });
  });

  it("replies and settles a dismissed answer, rejecting the change it carried", () => {
    const u = asked(["acceptance"]);
    db.prepare("UPDATE gates SET answer = 'dismiss' WHERE unit_id = ?").run(u.id);
    expect(queueTriage(db, u, "pull request #1", [{ thread, directive: "dismiss" }])).toBeNull();
    expect(getUnit(db, u.id)).toMatchObject({ state: "verified", acceptance: ["shout('app') === 'HELLO, APP!'"] });
    expect(listAmendments(db, u.id).map((a) => a.state)).toEqual(["rejected"]);
    expect(listThreadRows(db, u.id)[0]).toMatchObject({ state: "replying", decision: "dismissed" });
  });

  it("refuses a move the table does not allow, and lets a new comment reopen a thread from anywhere", () => {
    const u = asked(["acceptance"]);
    expect(() => transitionThread(db, u, thread.id, "fixing")).toThrow(IllegalThreadTransition);
    transitionThread(db, u, thread.id, "open", { reason: "a new comment" });
    expect(listThreadRows(db, u.id)[0]!.state).toBe("open");
  });
});
