import { beforeEach, describe, expect, it } from "vitest";
import { amendmentContext, applyOps, listAmendments, parseAmendments, proposeAmendment, settleAmendment } from "./amend.js";
import type { ProjectId, RepoId } from "./domain.js";
import { addGate, addProject, addRepo, addUnit, getUnit, openStore, type Db } from "./store.js";

describe("parseAmendments", () => {
  it("reads replace, add, remove, and verify lines for the threads they name", () => {
    const text = `## Decisions\n- T1: asked — q\n\n## Amendments\n- T1: replace: shout('app') === 'HELLO, APP!' => shout('app') === '🎉 HELLO, APP! 🎉'\n- T1: verify: node check.js\n- T2: add: it logs the call\n- T9: add: out of range\n- T2: replace: no arrow here\n\n## Notes\n- x\n`;
    expect(parseAmendments(text, 2)).toEqual(
      new Map([
        [
          1,
          [
            { kind: "replace", from: "shout('app') === 'HELLO, APP!'", to: "shout('app') === '🎉 HELLO, APP! 🎉'" },
            { kind: "verify", command: "node check.js" },
          ],
        ],
        [2, [{ kind: "add", text: "it logs the call" }]],
      ]),
    );
  });
});

describe("parseAmendments verify lines", () => {
  it("keeps only the command when the model wraps it in backticks or explains it after a dash", () => {
    const text = '## Amendments\n- T1: verify: `node -e "process.exit(0)"` — checks the output has emojis.\n- T2: verify: node check.js \u2014 prose\n';
    expect(parseAmendments(text, 2)).toEqual(
      new Map([
        [1, [{ kind: "verify", command: 'node -e "process.exit(0)"' }]],
        [2, [{ kind: "verify", command: "node check.js" }]],
      ]),
    );
  });
});

describe("backticks around a criterion", () => {
  it("matches a criterion the model wrapped in backticks, and stores it without them", () => {
    const text = "## Amendments\n- T1: replace: `shout('app') === 'HELLO, APP!'` => `shout('app') === 'HELLO, APP! \u{1F389}'`\n";
    const ops = parseAmendments(text, 1).get(1)!;
    expect(ops).toEqual([{ kind: "replace", from: "shout('app') === 'HELLO, APP!'", to: "shout('app') === 'HELLO, APP! \u{1F389}'" }]);
    expect(applyOps(["`shout('app') === 'HELLO, APP!'`"], "v", ops)).toEqual({ acceptance: ["shout('app') === 'HELLO, APP! \u{1F389}'"], verify: "v" });
  });
});

describe("applyOps", () => {
  it("replaces, adds, and removes criteria by their wording, ignoring case and spacing, and refuses one the unit does not have", () => {
    const next = applyOps(["A  works", "B works"], "run it", [
      { kind: "replace", from: "a works", to: "A works louder" },
      { kind: "remove", text: "B works" },
      { kind: "add", text: "C works" },
      { kind: "verify", command: "run it again" },
    ]);
    expect(next).toEqual({ acceptance: ["A works louder", "C works"], verify: "run it again" });
    expect(applyOps(["A works"], "v", [{ kind: "replace", from: "Z works", to: "Y" }])).toEqual({ problem: 'no acceptance criterion reads "Z works"' });
  });
});

describe("an amendment's life", () => {
  let db: Db;
  const project = "p" as ProjectId;
  const newUnit = () =>
    addUnit(db, {
      projectId: project,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      writeScope: ["a"],
      acceptance: ["greets plainly"],
      verify: "node check.js",
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
  beforeEach(() => {
    db = openStore(":memory:");
    addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
    addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["r" as RepoId] });
  });

  const propose = (unitId: number, changes: Parameters<typeof proposeAmendment>[1]["changes"]) => {
    const gateId = addGate(db, { projectId: project, unitId: unitId as never, kind: "review", question: "q", options: ["fix", "dismiss"] });
    return proposeAmendment(db, { unitId: unitId as never, gateId, threadId: "T", author: "mina", quote: "make it louder", changes });
  };

  it("changes the unit only when the developer answers fix, keeps what it was, and tells every later brief", () => {
    const u = newUnit();
    const made = propose(u.id, [
      { kind: "replace", from: "greets plainly", to: "greets loudly" },
      { kind: "verify", command: "node loud.js" },
    ]);
    expect(made).toMatchObject({ id: expect.any(Number) });
    expect(getUnit(db, u.id)).toMatchObject({ acceptance: ["greets plainly"], verify: "node check.js" });
    expect(amendmentContext(db, u.id)).toEqual([]);

    settleAmendment(db, u.id, "T", "fix");
    expect(getUnit(db, u.id)).toMatchObject({ acceptance: ["greets loudly"], verify: "node loud.js" });
    const [a] = listAmendments(db, u.id);
    expect(a).toMatchObject({ state: "approved", author: "mina", before: { acceptance: ["greets plainly"], verify: "node check.js" } });
    expect(amendmentContext(db, u.id)[0]).toContain(
      `mina's comment "make it louder": change "greets plainly" to "greets loudly"; the verify command becomes: node loud.js.`,
    );
    expect(settleAmendment(db, u.id, "T", "fix")).toBeNull();
  });

  it("leaves the unit alone on dismiss, and refuses a proposal that does not fit the unit", () => {
    const u = newUnit();
    propose(u.id, [{ kind: "add", text: "greets loudly" }]);
    settleAmendment(db, u.id, "T", "dismiss");
    expect(getUnit(db, u.id).acceptance).toEqual(["greets plainly"]);
    expect(listAmendments(db, u.id)[0]!.state).toBe("rejected");
    expect(propose(u.id, [{ kind: "replace", from: "no such criterion", to: "x" }])).toEqual({ problem: 'no acceptance criterion reads "no such criterion"' });
  });
});
