import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import { setSetting, type Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { Engine } from "./engine.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import {
  applyAskAnswer,
  listManagerDecisions,
  managerForcesFresh,
  managerNeed,
  parseDecision,
  queueManager,
  runManagerUnit,
  wakeManager,
  wakeOnNote,
} from "./manager.js";
import { runInvestigateUnit } from "./investigate.js";
import { layout } from "./paths.js";
import { applyDelta, PlanDelta } from "./plan.js";
import { runWorkUnit } from "./runner.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  answerGate,
  getUnit,
  getUnitBySeq,
  listAttempts,
  listGates,
  listUnits,
  openStore,
  setMergePolicy,
  setProjectEnvironment,
  transitionUnit,
  type Db,
} from "./store.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs"), ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
  parse: parseClaudeLine,
};
const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;
const project = "p" as ProjectId;
let db: Db;
let ctx: RunContext;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-manager-"));
  const seed = join(root, "seed");
  mkdirSync(join(seed, ".agents/verify"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "seed\n");
  writeFileSync(
    join(seed, ".agents/verify/verify.json"),
    JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f README.md", tier: "unit-verified" }] }),
  );
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  const origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["testbed" as RepoId] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  setMergePolicy(db, project, "auto");
  process.env.FAKE_MODE = "engine";
});

afterEach(() => {
  for (const k of ["FAKE_MANAGER", "FAKE_VERIFY_NEEDS_FIX", "FAKE_RESUME", "FAKE_FORGET"]) delete process.env[k];
});

const unitDelta = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo: "testbed",
  goal: `write ${key}`,
  write: [`app/${key}/**`],
  accept: [`${key} exists`],
  verify: "true",
  ...extra,
});

// A unit whose worker has run once and whose verification then rejected it for a code fault.
async function rejectedUnit(key = "a", extra: Record<string, unknown> = {}) {
  applyDelta(db, project, PlanDelta.parse({ add: [unitDelta(key, extra)] }), null);
  const unit = listUnits(db, project).find((u) => u.goal === `write ${key}`)!;
  await runWorkUnit(ctx, unit.id);
  db.prepare("UPDATE attempts SET rejection = 'code-fault' WHERE unit_id = ?").run(unit.id);
  transitionUnit(db, unit.id, "rejected", { reason: "verification failed: the scenario fails on head" });
  return getUnit(db, unit.id);
}

const wake = async (unitId: number) => {
  const target = getUnit(db, unitId as never);
  const need = managerNeed(db, target);
  expect(need?.kind).toBe("wake");
  const m = queueManager(db, target, (need as { wake: string }).wake);
  await runManagerUnit(ctx, m.id);
  return m;
};

describe("parseDecision", () => {
  it("reads the action, reason, note, and question from the Decision section", () => {
    expect(
      parseDecision("## Status\nsuccess\n\n## Decision\naction: `fresh`\nreason: the old session\n  went the wrong way\nnote: mind the empty case\n"),
    ).toEqual({
      ok: true,
      action: "fresh",
      reason: "the old session went the wrong way",
      note: "mind the empty case",
      question: null,
      to: null,
    });
    expect(parseDecision("## Decision\naction: ask\nreason: unclear\nquestion: Which one?\n")).toMatchObject({
      ok: true,
      action: "ask",
      question: "Which one?",
    });
  });

  it("reads the last Decision section when the analysis above it has a Decision heading of its own", () => {
    const text =
      "## Analysis\nThe verifier is right.\n\n## Decision\n\nOnly the developer can decide this.\n\n---\n\n## Status\nsuccess\n\n## Decision\naction: ask\nreason: scope conflict\nquestion: Keep the emojis?\n";
    expect(parseDecision(text)).toMatchObject({ ok: true, action: "ask", reason: "scope conflict", question: "Keep the emojis?" });
    expect(parseDecision("## Decision\nonly prose here\n\n## Decision\nstill prose\n")).toMatchObject({
      ok: false,
      problem: expect.stringContaining('no usable "action:" line'),
    });
  });

  it("refuses an answer it cannot act on", () => {
    expect(parseDecision("I am not sure.")).toEqual({ ok: false, problem: "the answer has no ## Decision section" });
    expect(parseDecision("## Decision\naction: delete\nreason: x\n")).toMatchObject({ ok: false });
    expect(parseDecision("## Decision\naction: stop\n")).toEqual({ ok: false, problem: "the decision has no reason" });
  });
});

describe("a manager deciding about a rejected unit", () => {
  it("starts a fresh builder with its note when it chooses fresh, and the runner does not resume the old session", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "fresh";
    await wake(u.id);
    const after = getUnit(db, u.id);
    expect(after.state).toBe("ready");
    expect(after.notes).toEqual(["The unit lead says: write it with care"]);
    expect(listManagerDecisions(db, u.id)).toMatchObject([{ action: "fresh", reason: "the fake manager chose fresh", note: "write it with care", tries: 1 }]);
    expect(managerForcesFresh(db, after)).toBe(true);
    await runWorkUnit(ctx, u.id);
    expect(listAttempts(db, u.id).map((a) => a.resumesAttemptId)).toEqual([null, null]);
  }, 60_000);

  it("takes its decision from yagura decide, not its report, and reminds it once in the same session when it forgot", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "fresh";
    process.env.FAKE_FORGET = "manager";
    await wake(u.id);
    expect(listManagerDecisions(db, u.id)).toMatchObject([{ action: "fresh", note: "write it with care" }]);
    const kinds = (db.prepare("SELECT type FROM events WHERE type IN ('records.reminded', 'parse.fallback') ORDER BY id").all() as { type: string }[]).map(
      (r) => r.type,
    );
    expect(kinds).toEqual(["records.reminded"]);
  }, 60_000);

  it("resumes the builder's own session when it chooses resume and the rules allow it", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "resume";
    await wake(u.id);
    expect(getUnit(db, u.id).state).toBe("ready");
    expect(managerForcesFresh(db, getUnit(db, u.id))).toBe(false);
    await runWorkUnit(ctx, u.id);
    const [first, second] = listAttempts(db, u.id);
    expect(second!.resumesAttemptId).toBe(first!.id);
  }, 60_000);

  it("leaves resume to the fixed rules when the session cannot be resumed", async () => {
    const u = await rejectedUnit();
    db.prepare("UPDATE attempts SET session_id = NULL WHERE unit_id = ?").run(u.id);
    process.env.FAKE_MANAGER = "resume";
    await wake(u.id);
    expect(getUnit(db, u.id).state).toBe("rejected");
    expect(listManagerDecisions(db, u.id)).toMatchObject([{ action: "fallback", reason: expect.stringContaining("resume was not possible") }]);
    expect(managerNeed(db, getUnit(db, u.id))).toBeNull();
  }, 60_000);

  it("blocks the unit when it stops, and when it sends it to the planner, saying so", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "stop";
    await wake(u.id);
    expect(getUnit(db, u.id).state).toBe("blocked");
    const v = await rejectedUnit("b");
    process.env.FAKE_MANAGER = "planner";
    await wake(v.id);
    expect(getUnit(db, v.id).state).toBe("blocked");
    const reasons = db
      .prepare(
        "SELECT json_extract(data_json, '$.reason') AS r FROM events WHERE type = 'unit.state' AND json_extract(data_json, '$.to') = 'blocked' ORDER BY id",
      )
      .all() as {
      r: string;
    }[];
    expect(reasons.map((x) => x.r)).toEqual([
      "the unit lead stopped it: the fake manager chose stop",
      "the unit lead sent it to the project lead: the fake manager chose planner",
    ]);
  }, 60_000);

  it("asks the developer, waits for the answer, and acts on it", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "ask";
    await wake(u.id);
    const [gate] = listGates(db, project, "open");
    expect(gate).toMatchObject({ kind: "manager", question: "U1: Should it try again?", options: ["retry", "stop"], defaultOption: "stop" });
    expect(managerNeed(db, getUnit(db, u.id))).toEqual({ kind: "waiting" });
    answerGate(db, gate!.id, "retry");
    const need = managerNeed(db, getUnit(db, u.id));
    expect(need).toEqual({ kind: "answered", answer: "retry" });
    applyAskAnswer(db, getUnit(db, u.id), "retry");
    expect(getUnit(db, u.id)).toMatchObject({ state: "ready", notes: ["The developer said to try again."] });
  }, 60_000);

  it("splits a unit nothing depends on into the units it adds, and refuses to split one that others depend on", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "split";
    await wake(u.id);
    expect(getUnit(db, u.id).state).toBe("abandoned");
    const added = listUnits(db, project).filter((x) => x.type === "work" && x.id !== u.id);
    expect(added.map((x) => [x.goal, x.state])).toEqual([
      ["half a", "ready"],
      ["half b", "ready"],
    ]);

    const v = await rejectedUnit("b");
    applyDelta(db, project, PlanDelta.parse({ add: [unitDelta("c", { deps: [{ on: `U${v.seq}`, kind: "needs-landed" }] })] }), null);
    await wake(v.id);
    expect(getUnit(db, v.id).state).toBe("rejected");
    expect(listManagerDecisions(db, v.id)).toMatchObject([{ action: "fallback", reason: expect.stringContaining("cannot be split") }]);
  }, 90_000);

  it("falls back to the fixed rules when the manager gives no usable decision, without asking again for the same state", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "garbage";
    await wake(u.id);
    expect(listManagerDecisions(db, u.id)).toMatchObject([{ action: "fallback", reason: "the answer has no ## Decision section" }]);
    expect(managerNeed(db, getUnit(db, u.id))).toBeNull();
  }, 60_000);

  it("lists the other live units in the repo and says which overlap its scope", async () => {
    const u = await rejectedUnit("a");
    applyDelta(db, project, PlanDelta.parse({ add: [unitDelta("b", { write: ["app/a/**"] }), unitDelta("c", { write: ["app/c/**"] })] }), null);
    process.env.FAKE_MANAGER = "fresh";
    const m = await wake(u.id);
    const brief = readFileSync(layout(ctx.boot).brief(project, m.seq, 1), "utf8");
    expect(brief).toContain("## OTHER UNITS IN THIS REPO NOW\n");
    expect(brief).toMatch(/- U\d+ \(\w+\): write b; writes app\/a\/\*\* \(overlaps this unit\)/);
    expect(brief).toMatch(/- U\d+ \(\w+\): write c; writes app\/c\/\*\*\n/);
  }, 60_000);

  it("resumes its own session on a later decision and is told only what changed; a lost session starts again", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "fresh";
    const first = await wake(u.id);
    await runWorkUnit(ctx, u.id);
    db.prepare("UPDATE attempts SET rejection = 'code-fault' WHERE unit_id = ?").run(u.id);
    transitionUnit(db, u.id, "rejected", { reason: "verification failed again" });
    const second = await wake(u.id);
    const a1 = listAttempts(db, first.id)[0]!;
    const a2 = listAttempts(db, second.id)[0]!;
    expect(a2.resumesAttemptId).toBe(a1.id);
    const brief1 = readFileSync(layout(ctx.boot).brief(project, first.seq, 1), "utf8");
    const brief2 = readFileSync(layout(ctx.boot).brief(project, second.seq, 1), "utf8");
    expect(brief1).toContain("## THE RECORD");
    expect(brief2).toContain("## WHAT HAPPENED SINCE YOUR LAST DECISION");
    expect(brief2).toContain("## YOUR EARLIER DECISIONS ON THIS UNIT\n- fresh: the fake manager chose fresh (note: write it with care)");
    expect(brief2).not.toContain("A1 worker");
    expect(brief2).toContain("A3 worker");

    await runWorkUnit(ctx, u.id);
    db.prepare("UPDATE attempts SET rejection = 'code-fault' WHERE unit_id = ?").run(u.id);
    transitionUnit(db, u.id, "rejected", { reason: "and again" });
    process.env.FAKE_RESUME = "missing";
    const third = await wake(u.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'manager.session_lost'").get()).toEqual({ n: 1 });
    expect(listManagerDecisions(db, u.id).map((d) => d.action)).toEqual(["fresh", "fresh", "fresh"]);
    expect(readFileSync(layout(ctx.boot).brief(project, third.seq, 1), "utf8")).toContain("## THE RECORD");
  }, 120_000);

  it("stops asking after its decisions are spent, and blocks the unit for the developer", async () => {
    setSetting(db, "global", "", "manager.max_decisions_per_unit", 1);
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "fresh";
    await wake(u.id);
    await runWorkUnit(ctx, u.id);
    db.prepare("UPDATE attempts SET rejection = 'code-fault' WHERE unit_id = ?").run(u.id);
    transitionUnit(db, u.id, "rejected", { reason: "again" });
    expect(managerNeed(db, getUnit(db, u.id))).toEqual({ kind: "cap", cap: 1 });
  }, 90_000);

  it("is not asked when it is switched off for the project", async () => {
    setSetting(db, "project", project, "manager.enabled", false);
    const u = await rejectedUnit();
    expect(managerNeed(db, u)).toBeNull();
  }, 60_000);
});

describe("the developer waking the unit lead", () => {
  const stuck = async () => {
    const u = await rejectedUnit();
    transitionUnit(db, u.id, "blocked", { reason: "its review raised findings; it needs you" });
    return getUnit(db, u.id);
  };

  it("lets the unit lead look at a blocked unit with the developer's note, and acts on its choice", async () => {
    const u = await stuck();
    const woken = wakeManager(db, u, "I want emojis; the acceptance criteria are stale");
    expect(woken).toMatchObject({ ok: true });
    const unit = (woken as { unit: ReturnType<typeof getUnit> }).unit;
    expect(unit.context[1]).toBe("asked");
    expect(wakeManager(db, u, "again")).toEqual({ ok: false, reason: "U1's unit lead is already deciding" });
    process.env.FAKE_MANAGER = "fresh";
    await runManagerUnit(ctx, unit.id);
    const brief = readFileSync(layout(ctx.boot).brief(project, unit.seq, 1), "utf8");
    expect(brief).toContain("The developer asked you to look at U1 now: I want emojis; the acceptance criteria are stale. Answer what they wrote first.");
    expect(listManagerDecisions(db, u.id).map((d) => d.action)).toEqual(["fresh"]);
    expect(getUnit(db, u.id).state).toBe("ready");
  }, 60_000);

  it("keeps a blocked unit blocked when the unit lead stops it, and writes why on the unit", async () => {
    const u = await stuck();
    const unit = (wakeManager(db, u, "") as { unit: ReturnType<typeof getUnit> }).unit;
    process.env.FAKE_MANAGER = "stop";
    await runManagerUnit(ctx, unit.id);
    expect(getUnit(db, u.id).state).toBe("blocked");
    expect(getUnit(db, u.id).notes.at(-1)).toMatch(/^the unit lead stopped it: /);
  }, 60_000);

  it("is refused for a unit that is not stuck, a unit with no unit lead, and a unit whose lead is already deciding", async () => {
    const u = await stuck();
    transitionUnit(db, u.id, "ready", {});
    expect(wakeManager(db, getUnit(db, u.id), "x")).toEqual({ ok: false, reason: "U1 is ready; the unit lead looks at blocked, failed, or rejected units" });
    transitionUnit(db, u.id, "blocked", {});
    setSetting(db, "project", project, "manager.enabled", false);
    expect(wakeManager(db, getUnit(db, u.id), "x")).toEqual({ ok: false, reason: "the unit lead is switched off for this project (manager.enabled)" });
  }, 60_000);

  it("is woken again with the findings when it asked for an investigation of a blocked unit", async () => {
    const u = await stuck();
    const unit = (wakeManager(db, u, "why does it keep failing?") as { unit: ReturnType<typeof getUnit> }).unit;
    process.env.FAKE_MANAGER = "investigate";
    await runManagerUnit(ctx, unit.id);
    const inv = listUnits(db, project).find((x) => x.type === "investigate")!;
    expect(managerNeed(db, getUnit(db, u.id))).toEqual({ kind: "waiting" });
    await runInvestigateUnit(ctx, inv.id);
    expect(managerNeed(db, getUnit(db, u.id))).toMatchObject({ kind: "wake", wake: expect.stringContaining("has finished") });
  }, 90_000);
});

describe("a manager that asks for an investigation", () => {
  it("waits for the investigator, then is woken once with its findings and decides again", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "investigate";
    await wake(u.id);
    const inv = listUnits(db, project).find((x) => x.type === "investigate")!;
    expect(inv).toMatchObject({ state: "ready", targetUnitId: u.id, goal: "Investigate for U1: Why does the scenario fail on head?" });
    expect(getUnit(db, u.id).state).toBe("rejected");
    expect(managerNeed(db, getUnit(db, u.id))).toEqual({ kind: "waiting" });

    const attempt = await runInvestigateUnit(ctx, inv.id);
    expect(getUnit(db, inv.id).state).toBe("done");
    expect(readFileSync(layout(ctx.boot).handoff(project, inv.seq, attempt!.n), "utf8")).toContain("depends on the clock");
    const need = managerNeed(db, getUnit(db, u.id));
    expect(need).toMatchObject({
      kind: "wake",
      wake: expect.stringMatching(/^The investigation U\d+ you asked for has finished: Why does the scenario fail on head\?$/),
    });

    process.env.FAKE_MANAGER = "fresh";
    const m2 = queueManager(db, getUnit(db, u.id), (need as { wake: string }).wake);
    await runManagerUnit(ctx, m2.id);
    const brief = readFileSync(layout(ctx.boot).brief(project, m2.seq, 1), "utf8");
    expect(brief).toContain("investigator");
    expect(brief).toContain("the failing test depends on the clock");
    expect(listManagerDecisions(db, u.id).map((d) => d.action)).toEqual(["investigate", "fresh"]);
    expect(getUnit(db, u.id).state).toBe("ready");
  }, 90_000);

  it("is woken with the failure when the investigator reports nothing, and the investigator changed nothing", async () => {
    const u = await rejectedUnit();
    process.env.FAKE_MANAGER = "investigate";
    await wake(u.id);
    const inv = listUnits(db, project).find((x) => x.type === "investigate")!;
    process.env.FAKE_INVESTIGATE = "garbage";
    await runInvestigateUnit(ctx, inv.id);
    delete process.env.FAKE_INVESTIGATE;
    expect(getUnit(db, inv.id).state).toBe("failed");
    expect(managerNeed(db, getUnit(db, u.id))).toMatchObject({ kind: "wake", wake: expect.stringContaining("failed") });
  }, 90_000);
});

describe("a manager told of a worker's note", () => {
  // Two units in one repo: U1 has handed off with a note, U2 is still to be built.
  async function handedOffWithNote(note = "I moved the shared helper") {
    process.env.FAKE_WORKER_NOTE = note;
    applyDelta(db, project, PlanDelta.parse({ add: [unitDelta("a"), unitDelta("b")] }), null);
    const [a, b] = listUnits(db, project).filter((u) => u.type === "work");
    await runWorkUnit(ctx, a!.id);
    delete process.env.FAKE_WORKER_NOTE;
    return { a: getUnit(db, a!.id), b: getUnit(db, b!.id) };
  }

  it("relays the note to the live sibling it names, and not again for the same handoff", async () => {
    const { a, b } = await handedOffWithNote();
    process.env.FAKE_MANAGER = "relay";
    const m = wakeOnNote(db, ctx.boot, a)!;
    expect(m.context[1]).toBe("note");
    expect(wakeOnNote(db, ctx.boot, a)).toBeNull();
    await runManagerUnit(ctx, m.id);
    expect(getUnit(db, b.id).notes).toEqual([`The unit lead says, from U${a.seq}: the shared helper moved`]);
    expect(listManagerDecisions(db, a.id)).toMatchObject([{ action: "relay", note: "the shared helper moved" }]);
    expect(getUnit(db, a.id).state).toBe("verifying");
    expect(wakeOnNote(db, ctx.boot, getUnit(db, a.id))).toBeNull();
    expect(managerNeed(db, getUnit(db, a.id))).toBeNull();
  }, 60_000);

  it("records ignore, and a relay it cannot do, as ignore with the reason, touching no unit", async () => {
    const { a, b } = await handedOffWithNote();
    process.env.FAKE_MANAGER = "ignore";
    await runManagerUnit(ctx, wakeOnNote(db, ctx.boot, a)!.id);
    expect(listManagerDecisions(db, a.id)).toMatchObject([{ action: "ignore" }]);
    expect(getUnit(db, b.id).notes).toEqual([]);
    process.env.FAKE_MANAGER = "fresh";
    db.prepare("DELETE FROM events WHERE type = 'manager.note_woken'").run();
    await runManagerUnit(ctx, wakeOnNote(db, ctx.boot, a)!.id);
    expect(listManagerDecisions(db, a.id).at(-1)).toMatchObject({
      action: "ignore",
      reason: expect.stringMatching(/^fresh was not possible: fresh is not on the menu/),
    });
  }, 60_000);

  it("is not woken when the note says nothing", async () => {
    const { a } = await handedOffWithNote("none");
    expect(wakeOnNote(db, ctx.boot, a)).toBeNull();
  }, 60_000);

  it("is not woken by ordinary notes, only by what the worker says other units must know", async () => {
    const { a } = await handedOffWithNote("none");
    const file = layout(ctx.boot).handoff(project, a.seq, 1);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n## Notes, concerns, deviations\n- all acceptance criteria met; used the laziness protocol\n`);
    expect(wakeOnNote(db, ctx.boot, a)).toBeNull();
    writeFileSync(file, readFileSync(file, "utf8").replace("## For other units\n- none", "## For other units\n- renamed helper.py to util.py"));
    expect(wakeOnNote(db, ctx.boot, a)?.context[0]).toContain("says other units must know: renamed helper.py to util.py");
  }, 60_000);

  it("is not woken when nobody else is live in the repo", async () => {
    const { a, b } = await handedOffWithNote("a real note");
    transitionUnit(db, b.id, "abandoned", {});
    expect(wakeOnNote(db, ctx.boot, a)).toBeNull();
  }, 60_000);

  it("does not let a note decision stand in for a decision about a later rejection", async () => {
    const { a } = await handedOffWithNote();
    process.env.FAKE_MANAGER = "ignore";
    await runManagerUnit(ctx, wakeOnNote(db, ctx.boot, a)!.id);
    transitionUnit(db, a.id, "rejected", { reason: "verification failed" });
    expect(managerNeed(db, getUnit(db, a.id))?.kind).toBe("wake");
  }, 60_000);
});

describe("the engine with a manager", () => {
  const run = async () => {
    const log: string[] = [];
    await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();
    return log;
  };

  it("sends a rejected unit to its manager, applies the decision, and lands the work", async () => {
    process.env.FAKE_VERIFY_NEEDS_FIX = "1";
    process.env.FAKE_MANAGER = "resume";
    const log = await run();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
    expect(listUnits(db, project).filter((u) => u.type === "manager").length).toBe(3);
    expect(work.flatMap((u) => listManagerDecisions(db, u.id)).map((d) => d.action)).toEqual(["resume", "resume", "resume"]);
    expect(log.some((l) => l.includes("goes to its unit lead"))).toBe(true);
    for (const u of work) expect(listAttempts(db, u.id).filter((a) => a.resumesAttemptId).length).toBe(1);
  }, 120_000);

  it("runs the investigations its manager asks for, and blocks the unit once its decisions are spent", async () => {
    process.env.FAKE_VERIFY_NEEDS_FIX = "1";
    process.env.FAKE_MANAGER = "investigate";
    setSetting(db, "project", project, "manager.max_decisions_per_unit", 2);
    const log = await run();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.some((u) => u.state === "blocked")).toBe(true);
    const investigations = listUnits(db, project).filter((u) => u.type === "investigate");
    expect(investigations.length).toBeGreaterThanOrEqual(2);
    expect(investigations.every((u) => u.state === "done")).toBe(true);
    expect(log.some((l) => l.includes("its unit lead has used"))).toBe(true);
  }, 180_000);

  it("leaves a rejection to the fixed rules when the manager is off", async () => {
    setSetting(db, "global", "", "manager.enabled", false);
    process.env.FAKE_VERIFY_NEEDS_FIX = "1";
    await run();
    expect(listUnits(db, project).filter((u) => u.type === "manager").length).toBe(0);
    expect(
      listUnits(db, project)
        .filter((u) => u.type === "work")
        .map((u) => u.state),
    ).toEqual(["landed", "landed", "landed"]);
  }, 120_000);

  it("falls back to the fixed rules when the manager never gives a usable answer", async () => {
    process.env.FAKE_VERIFY_NEEDS_FIX = "1";
    process.env.FAKE_MANAGER = "garbage";
    await run();
    expect(
      listUnits(db, project)
        .filter((u) => u.type === "work")
        .map((u) => u.state),
    ).toEqual(["landed", "landed", "landed"]);
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.flatMap((u) => listManagerDecisions(db, u.id)).every((d) => d.action === "fallback")).toBe(true);
  }, 120_000);
});

void getUnitBySeq;
