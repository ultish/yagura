import { userInfo } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { auditSection, approvalsOf, mergeMessage, pullRequestBody } from "./audit.js";
import { setSetting } from "./config.js";
import type { ProjectId, RepoId, Unit } from "./domain.js";
import { recordDisagreement } from "./disagreements.js";
import { putRecord } from "./records.js";
import {
  addGate,
  addProject,
  addRepo,
  addUnit,
  answerGate,
  createAttempt,
  getUnit,
  openStore,
  setApprovedSha,
  setProjectState,
  updateAttempt,
  type Db,
} from "./store.js";
import { addProposal, createThread } from "./threads.js";

let db: Db;
let unit: Unit;
const project = "demo" as ProjectId;

const run = (attemptId: number, command: string, exit: number) =>
  Number(
    db
      .prepare("INSERT INTO evidence_runs (attempt_id, at, sha, label, command, exit_code, duration_ms, created_at) VALUES (?, 'head', 'abc', 'x', ?, ?, 5, ?)")
      .run(attemptId, command, exit, new Date().toISOString()).lastInsertRowid,
  );

beforeEach(() => {
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
  addProject(db, { id: project, name: "Demo", goal: "g", predicate: "x", repos: ["r" as RepoId] });
  setProjectState(db, project, "active");
  unit = addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "r" as RepoId,
    goal: "Add a Consumers panel to the topic view.",
    acceptance: ["It lists groups"],
    refs: ["r#19"],
    timeboxSeconds: 60,
    maxAttempts: 2,
  });
  const worker = createAttempt(db, unit.id, "claude", "claude-sonnet-5-5");
  updateAttempt(db, worker.id, { state: "handed_off", role: "worker" });
  putRecord(db, worker.id, "handoff", "", {
    status: "done",
    reason: null,
    did: ["added the panel"],
    evidence: [],
    decisions: ["Reused describe_group per group"],
    notes: ["No live broker test"],
    followUps: [],
  });
  const judge = createAttempt(db, unit.id, "claude", "claude-sonnet-5-5");
  updateAttempt(db, judge.id, { role: "judge" });
  const r1 = run(judge.id, "cargo test --workspace", 0);
  putRecord(db, judge.id, "judge", "", { verdict: "approve", runs: [r1], findings: [], stalePages: [], question: null });
  setApprovedSha(db, unit.id, "701128a7fc0000000000000000000000000000ff");
  unit = getUnit(db, unit.id);
});

describe("who allowed the merge", () => {
  it("is nobody until the gate is answered, then the account the daemon runs as", () => {
    expect(approvalsOf(db, unit).approvedBy).toBeNull();
    const gate = addGate(db, { projectId: project, unitId: unit.id, kind: "land", question: "Merge U1?", options: ["land", "hold"], defaultOption: "hold" });
    answerGate(db, gate, "land");
    expect(approvalsOf(db, unit).approvedBy).toMatch(new RegExp(`^${userInfo().username} via merge gate #${gate} at \\d{4}-`));
  });

  it("is not a hold", () => {
    const gate = addGate(db, { projectId: project, unitId: unit.id, kind: "land", question: "Merge U1?", options: ["land", "hold"], defaultOption: "hold" });
    answerGate(db, gate, "hold");
    expect(approvalsOf(db, unit).approvedBy).toBeNull();
  });
});

describe("who asked for it", () => {
  const apply = (threadId: number) => {
    const p = addProposal(db, { threadId, messageId: null, body: {} });
    db.prepare("UPDATE proposals SET state = 'applied', result_json = ? WHERE id = ?").run(JSON.stringify({ units: { demo: ["U1"] } }), p.id);
    return p.id;
  };

  it("names the trusted user whose yes on an issue started it", () => {
    const thread = createThread(db, { title: "topic consumers" });
    const proposal = apply(thread.id);
    db.prepare("INSERT INTO events (ts, type, project_id, data_json) VALUES (?, 'issue.approved', NULL, ?)").run(
      new Date().toISOString(),
      JSON.stringify({ repo: "r", number: 19, proposal, by: "ultish" }),
    );
    expect(approvalsOf(db, unit).requestedBy).toBe("@ultish on issue #19");
  });

  it("names the conversation when the developer said Go in the dashboard", () => {
    apply(createThread(db, { title: "Copy button gives no feedback" }).id);
    expect(approvalsOf(db, unit).requestedBy).toMatch(/^Talk conversation \d+, "Copy button gives no feedback"$/);
  });

  it("is empty for a unit nobody proposed", () => {
    expect(approvalsOf(db, unit).requestedBy).toBeNull();
  });
});

describe("the merge commit", () => {
  const gate = () => answerGate(db, addGate(db, { projectId: project, unitId: unit.id, kind: "land", question: "Merge?", options: ["land", "hold"] }), "land");

  it("carries the approval and the link", () => {
    gate();
    const m = mergeMessage(db, unit, 22, "http://yagura:7300/");
    expect(m.subject).toBe("demo/U1: Add a Consumers panel to the topic view (#22)");
    expect(m.body).toContain("Workers: A1 (claude-sonnet-5-5)");
    expect(m.body).toContain("Closes #19");
    expect(m.body).toMatch(/Approved-by: .+ via merge gate #\d+ at /);
    expect(m.body).toContain("yagura: http://yagura:7300/p/demo/u/1");
  });

  it("leaves the link out when the project keeps it to the pull request", () => {
    gate();
    setSetting(db, "project", project, "yagura.link_in_commits", false);
    const m = mergeMessage(db, unit, 22, "http://yagura:7300");
    expect(m.body).not.toContain("http://");
    expect(m.body).toContain("Approved-by:");
  });
});

describe("the pull request description", () => {
  it("says how it was made, with the runs, the judgment calls, and the disagreements", () => {
    recordDisagreement(db, { unitId: unit.id, ref: "x", about: "Reused describe_group", reason: "that is O(groups) per load", action: "follow-up" });
    const body = pullRequestBody(db, { id: project } as never, unit, "http://yagura:7300");
    expect(body).toContain("## How it was made");
    expect(body).toContain("- Built by: A1 (claude-sonnet-5-5)");
    expect(body).toContain("- Judge: A2 (claude-sonnet-5-5) approved 701128a7fc");
    expect(body).toContain("`cargo test --workspace`: exit 0");
    expect(body).toContain("choice: Reused describe_group per group");
    expect(body).toContain("note: No live broker test");
    expect(body).toContain("that is O(groups) per load");
    expect(body).toContain("Built by yagura: demo/U1, http://yagura:7300/p/demo/u/1");
  });

  it("stays short when there is a lot to say", () => {
    const worker = createAttempt(db, unit.id, "claude", null);
    updateAttempt(db, worker.id, { state: "handed_off", role: "worker" });
    putRecord(db, worker.id, "handoff", "", {
      status: "done",
      reason: null,
      did: [],
      evidence: [],
      decisions: Array.from({ length: 40 }, (_, i) => `decision ${i}`),
      notes: [],
      followUps: [],
    });
    const lines = auditSection(db, unit);
    expect(lines.filter((l) => /^- (choice|note):/.test(l))).toHaveLength(20);
    expect(lines).toContain("- and 22 more");
  });
});
