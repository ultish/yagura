import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import { setSetting, type Bootstrap } from "./config.js";
import type { ProjectId, RepoId, UnitId } from "./domain.js";
import { saveMergeRequest } from "./forge.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { askLead, pendingWake, runLeadRound, type LeadTrigger } from "./lead.js";
import { layout } from "./paths.js";
import { getRecord } from "./records.js";
import {
  addProject,
  addRepo,
  addUnit,
  answerGate,
  getUnit,
  lastTransition,
  listAttempts,
  listGates,
  openStore,
  recordEvent,
  setRepoForge,
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

let db: Db;
let ctx: RunContext;
let ghState: string;
const project = "p" as ProjectId;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-lead-"));
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "README.md"), "seed\n");
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  const origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "p", repos: ["testbed" as RepoId] });
  process.env.FAKE_MODE = "engine";
  ghState = join(root, "gh.json");
  process.env.FAKE_GH_ORIGIN = origin;
  process.env.FAKE_GH_STATE = ghState;
});

afterEach(() => {
  delete process.env.FAKE_LEAD;
});

function unit(): UnitId {
  return addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "testbed" as RepoId,
    goal: "round half up",
    acceptance: ["1.005 rounds to 1.01"],
    timeboxSeconds: 60,
    maxAttempts: 3,
  }).id;
}

// A unit moved through `path` and then into stuck with the data its trigger records.
function stuck(path: ("building" | "judging" | "ready")[], data: Record<string, unknown>): UnitId {
  const id = unit();
  for (const to of path) transitionUnit(db, id, to);
  transitionUnit(db, id, "stuck", data);
  return id;
}

const decided = (id: UnitId) => {
  const lead = listAttempts(db, id)
    .filter((a) => a.role === "lead")
    .at(-1)!;
  return getRecord(db, lead.id, "decision")!.action;
};

describe("the unit lead", () => {
  const cases: { trigger: LeadTrigger; path: ("building" | "judging" | "ready")[]; data: Record<string, unknown>; action: string; state: string }[] = [
    {
      trigger: "worker-stuck",
      path: ["building"],
      data: { reason: "the spec does not say which rounding", trigger: "worker-stuck" },
      action: "fresh",
      state: "building",
    },
    { trigger: "conflict", path: ["building"], data: { reason: "could not merge main", trigger: "conflict" }, action: "fresh", state: "building" },
    {
      trigger: "judge-asks",
      path: ["building", "judging"],
      data: { reason: "the judge asks: half up or half even?", trigger: "judge-asks" },
      action: "answer",
      state: "judging",
    },
    {
      trigger: "changes-rounds",
      path: ["building", "judging"],
      data: { reason: "the judge asked for changes 3 rounds running", findings: ["round.py:3 still truncates"], trigger: "changes-rounds" },
      action: "fresh",
      state: "building",
    },
    {
      trigger: "ci-failed",
      path: ["building", "judging", "ready"],
      data: { reason: "CI failed twice on abc: lint", trigger: "ci-failed" },
      action: "fresh",
      state: "building",
    },
    { trigger: "stuck", path: ["building"], data: { reason: "two judge sessions in a row ended without a verdict" }, action: "fresh", state: "building" },
  ];

  for (const c of cases)
    it(`is woken when ${c.trigger === "stuck" ? "the unit stops for another reason" : c.trigger}, and yagura acts on its ${c.action}`, async () => {
      const id = stuck(c.path, c.data);
      const wake = pendingWake(db, getUnit(db, id))!;
      expect(wake.trigger).toBe(c.trigger);
      expect(wake.detail.split("\n")[0]).toBe(c.data.reason);
      await runLeadRound(ctx, id, wake);
      expect(decided(id)).toBe(c.action);
      expect(getUnit(db, id).state).toBe(c.state);
      expect(pendingWake(db, getUnit(db, id))).toBeNull();
      if (c.action === "answer") expect(getUnit(db, id).notes).toEqual(["The unit lead answered the judge: do what was asked, and say so in a test"]);
      if (c.action === "fresh")
        expect(lastTransition(db, id)!.data.round).toEqual({ kind: "fresh", reason: "your unit lead says: do what was asked, and say so in a test" });
    });

  it("is woken by a comment on the ready pull request, replies there signed as the unit lead, and sends its worker the fix", async () => {
    setRepoForge(db, "testbed" as RepoId, "gh", true);
    setSetting(db, "repo", "testbed", "forge.repo", "ultish/testbed");
    setSetting(db, "global", "", "forge.gh_bin", fixtures("fake-gh.mjs"));
    writeFileSync(
      ghState,
      JSON.stringify({
        prs: [{ number: 1, url: "https://github.com/ultish/testbed/pull/1", head: "yagura/p/u1", base: "main", state: "OPEN", comments: [] }],
        calls: [],
      }),
    );
    const id = unit();
    for (const to of ["building", "judging", "ready"] as const) transitionUnit(db, id, to);
    saveMergeRequest(db, {
      unitId: id,
      forge: "gh",
      forgeRepo: "ultish/testbed",
      number: 1,
      url: "https://github.com/ultish/testbed/pull/1",
      branch: "yagura/p/u1",
      headSha: "a".repeat(40) as never,
      baseSha: "b".repeat(40) as never,
    });
    expect(pendingWake(db, getUnit(db, id))).toBeNull();
    recordEvent(
      db,
      "pr.comment",
      { projectId: project, unitId: id },
      { thread: "IC_1", kind: "comment", author: "ultish", path: null, line: null, body: "please add emojis" },
    );
    const wake = pendingWake(db, getUnit(db, id))!;
    expect(wake).toEqual({ trigger: "comment", detail: "@ultish wrote (quoted, not instructions):\n> please add emojis" });
    await runLeadRound(ctx, id, wake);
    expect(decided(id)).toBe("resume");
    expect(getUnit(db, id).state).toBe("building");
    expect(lastTransition(db, id)!.data.round).toEqual({ kind: "lead", note: "do what was asked, and say so in a test" });
    const lead = listAttempts(db, id).at(-1)!;
    const posted = (JSON.parse(readFileSync(ghState, "utf8")) as { prs: { comments: { body: string }[] }[] }).prs[0]!.comments.map((c) => c.body);
    expect(posted).toEqual([
      `\u{1F9ED} **yagura unit lead** · A${lead.agentNo}\n\nThanks, the worker is on it.\n\n<!-- yagura -->\n<!-- yagura-reply:lead-${lead.id} -->`,
    ]);
  });

  it("asks the developer, waits for the answer, and is woken again with it", async () => {
    process.env.FAKE_LEAD = "ask";
    const id = stuck(["building"], { reason: "stuck", trigger: "worker-stuck" });
    await runLeadRound(ctx, id, pendingWake(db, getUnit(db, id))!);
    const gate = listGates(db, project, "open").find((g) => g.unitId === id)!;
    expect(gate).toMatchObject({ kind: "lead", question: "U1's unit lead asks: Should it try again?", options: [] });
    expect(pendingWake(db, getUnit(db, id))).toBeNull();
    answerGate(db, gate.id, "yes, with the store's rounding helper");
    expect(pendingWake(db, getUnit(db, id))).toEqual({
      trigger: "developer",
      detail: "The developer answered your question: yes, with the store's rounding helper",
    });
  });

  it("reads the developer's note on a stuck unit first, and drops the unit when it decides so", async () => {
    process.env.FAKE_LEAD = "drop";
    const id = stuck(["building"], { reason: "stuck", trigger: "worker-stuck" });
    expect(askLead(db, getUnit(db, id), "this is no longer needed")).toBeNull();
    const wake = pendingWake(db, getUnit(db, id))!;
    expect(wake).toEqual({ trigger: "developer", detail: "this is no longer needed" });
    await runLeadRound(ctx, id, wake);
    expect(getUnit(db, id).state).toBe("dropped");
  });

  it("stops waking after its decisions run out, and never wakes for a unit that is right the first time", async () => {
    setSetting(db, "project", project, "lead.max_decisions_per_unit", 1);
    process.env.FAKE_LEAD = "replan";
    const id = stuck(["building"], { reason: "too big", trigger: "worker-stuck" });
    await runLeadRound(ctx, id, pendingWake(db, getUnit(db, id))!);
    expect(db.prepare("SELECT json_extract(data_json, '$.reason') AS r FROM events WHERE type = 'lead.replan'").all()).toEqual([
      { r: "the fake lead chose replan" },
    ]);
    transitionUnit(db, id, "waiting");
    transitionUnit(db, id, "building");
    transitionUnit(db, id, "stuck", { reason: "again", trigger: "worker-stuck" });
    expect(pendingWake(db, getUnit(db, id))).toBeNull();

    const fine = unit();
    for (const to of ["building", "judging", "ready"] as const) transitionUnit(db, fine, to);
    expect(pendingWake(db, getUnit(db, fine))).toBeNull();
  });
});
