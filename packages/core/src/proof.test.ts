import { beforeEach, describe, expect, it } from "vitest";
import type { AttemptId, ProjectId, RepoId } from "./domain.js";
import { approvalProblem, proofRows } from "./proof.js";
import { recordProblem } from "./records.js";
import { addProject, addRepo, addUnit, createAttempt, getUnit, openStore, updateAttempt, type Db } from "./store.js";
import { normalizeAcceptance } from "./verify-guide.js";

let db: Db;
const project = "p" as ProjectId;

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", repos: ["r" as RepoId] });
});

const unit = () => {
  const { acceptance, proof } = normalizeAcceptance([
    { outcome: "order 42 is shipped", proof: "orders-api" },
    { outcome: "order 43 is pending", proof: "orders-api" },
    { outcome: "status is plain text", proof: "new order-status" },
    "unit tests pass",
  ]);
  return getUnit(
    db,
    addUnit(db, { projectId: project, type: "work", repoId: "r" as RepoId, goal: "g", acceptance, proof, timeboxSeconds: 60, maxAttempts: 2 }).id,
  );
};

const run = (attemptId: AttemptId, page: string | null, at: "base" | "head", exit: number | null) =>
  Number(
    db
      .prepare(
        "INSERT INTO evidence_runs (attempt_id, at, sha, label, page, command, exit_code, duration_ms, created_at) VALUES (?, ?, 'abc', 'l', ?, 'c', ?, 1, 't')",
      )
      .run(attemptId, at, page, exit).lastInsertRowid,
  );

const attempt = (unitId: number, role: "worker" | "judge") => {
  const a = createAttempt(db, unitId as never, "claude", null);
  db.prepare("UPDATE attempts SET role = ? WHERE id = ?").run(role, a.id);
  updateAttempt(db, a.id, { state: "running" });
  return a;
};

describe("proofRows", () => {
  it("groups the unit's lines by page and says nothing has been judged yet", () => {
    const u = unit();
    expect(proofRows(db, u).map((r) => [r.page, r.isNew, r.lines, r.status])).toEqual([
      ["orders-api", false, 2, "pending"],
      ["order-status", true, 1, "pending"],
    ]);
  });

  it("marks a page the judge never ran as missing, and a page that holds as held", () => {
    const u = unit();
    const worker = attempt(u.id, "worker");
    run(worker.id, "orders-api", "head", 0);
    const judge = attempt(u.id, "judge");
    run(judge.id, "orders-api", "head", 0);
    const rows = proofRows(db, u);
    expect(rows.find((r) => r.page === "orders-api")).toMatchObject({ status: "held", runs: [{ role: "worker" }, { role: "judge", at: "head", exit: 0 }] });
    expect(rows.find((r) => r.page === "order-status")).toMatchObject({ status: "missing", runs: [] });
  });

  it("holds a new page only when it fails on the base and passes on the head", () => {
    const u = unit();
    const judge = attempt(u.id, "judge");
    run(judge.id, "orders-api", "head", 0);
    run(judge.id, "order-status", "head", 0);
    expect(proofRows(db, u).find((r) => r.page === "order-status")).toMatchObject({ status: "failed", failsOnBase: false });
    run(judge.id, "order-status", "base", 1);
    expect(proofRows(db, u).find((r) => r.page === "order-status")).toMatchObject({ status: "held", failsOnBase: true });
  });
});

describe("approving", () => {
  it("is refused until the judge has driven every named page, and a new page on the base", () => {
    const u = unit();
    const judge = attempt(u.id, "judge");
    const cited = run(judge.id, null, "head", 0);
    const verdict = { verdict: "approve" as const, runs: [cited], findings: [], question: null };
    expect(recordProblem(db, judge.id, "judge", verdict)).toMatch(/page orders-api has no run of yours.*--page orders-api/);
    run(judge.id, "orders-api", "head", 0);
    run(judge.id, "order-status", "head", 0);
    expect(approvalProblem(db, u, judge.id)).toMatch(/page order-status is new, so it must fail on the base/);
    run(judge.id, "order-status", "base", 1);
    expect(approvalProblem(db, u, judge.id)).toBeNull();
    expect(recordProblem(db, judge.id, "judge", verdict)).toBeNull();
  });

  it("does not ask a unit that names no page for anything, and never blocks changes", () => {
    const { acceptance, proof } = normalizeAcceptance(["it builds"]);
    const u = getUnit(
      db,
      addUnit(db, { projectId: project, type: "work", repoId: "r" as RepoId, goal: "g", acceptance, proof, timeboxSeconds: 60, maxAttempts: 2 }).id,
    );
    const judge = attempt(u.id, "judge");
    expect(approvalProblem(db, u, judge.id)).toBeNull();
    const named = unit();
    const judge2 = attempt(named.id, "judge");
    expect(recordProblem(db, judge2.id, "judge", { verdict: "changes", runs: [], findings: ["a.md:1 stale"], question: null })).toBeNull();
  });
});
