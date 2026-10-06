import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import { setSetting, type Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { Engine } from "./engine.js";
import { artifactName, listEvidenceRuns, readArtifact, runArtifacts } from "./evidence.js";
import { commitAll, diffRange, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  getProject,
  getRepo,
  getUnit,
  setAndon,
  listAttempts,
  listUnits,
  openStore,
  setMergePolicy,
  setProjectEnvironment,
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
let origin: string;
const project = "p" as ProjectId;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-engine-"));
  const seed = join(root, "seed");
  mkdirSync(join(seed, ".agents/verify"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "seed\n");
  writeFileSync(
    join(seed, ".agents/verify/verify.json"),
    JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f README.md", tier: "unit-verified" }] }),
  );
  await git(["init", "--quiet", "-b", "main"], { cwd: seed });
  await commitAll(seed, "init", { name: "t", email: "t@t" });
  origin = join(root, "origin.git");
  await git(["clone", "--quiet", "--bare", seed, origin]);
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "all files landed", minTier: "unit-verified", repos: ["testbed" as RepoId] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 2 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  setMergePolicy(db, project, "auto");
  process.env.FAKE_MODE = "engine";
});

describe("Engine", () => {
  it("stops starting work past 70% of the wall-clock budget, and raises an andon when it is spent", async () => {
    setSetting(db, "project", project, "project.budget_hours", 1);
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(ago(50), project);
    const log: string[] = [];
    const engine = new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) });
    await engine.runUntilIdle();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.map((u) => u.state)).toEqual(["ready", "ready", "ready"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.type = 'work'").get()).toEqual({ n: 0 });
    expect(log).toContain("  p: 83% of the wall-clock budget used; no new work starts, verified work keeps landing");
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(ago(70), project);
    await engine.tick();
    expect(getProject(db, project).andonReason).toBe("the wall-clock budget of 1h is used up; what was verified has landed, and the rest waits for you");
  });

  it("raises an andon once the project's agents have spent its cost budget, and starts nothing after", async () => {
    setSetting(db, "project", project, "project.budget_usd", 0.035);
    const log: string[] = [];
    const engine = new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) });
    await engine.runUntilIdle();
    const andon = getProject(db, project).andonReason;
    expect(andon).toMatch(
      /^the cost budget of \$0\.04 is used up \(\$0\.0\d spent\); running agents finish and nothing new starts\. Raise project\.budget_usd to continue$/,
    );
    expect(log).toContain("  p: $0.03 of the $0.04 cost budget spent");
    const sessions = (db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n;
    expect(getProject(db, project).state).not.toBe("closed");
    await engine.tick();
    expect((db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n).toBe(sessions);

    setSetting(db, "project", project, "project.budget_usd", 100);
    setAndon(db, project, null);
    await engine.runUntilIdle();
    expect(getProject(db, project).state).toBe("closed");
  }, 60_000);

  describe("code review (§24)", () => {
    const run = async () => {
      const log: string[] = [];
      await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();
      return log;
    };
    const units = (type: string) => listUnits(db, project).filter((u) => u.type === type);
    afterEach(() => {
      delete process.env.FAKE_REVIEW;
      delete process.env.FAKE_TRIAGE_AMEND;
      delete process.env.FAKE_TRIAGE_SECTIONS_FIRST;
    });

    it("turns a blocking finding into a triage fix, verifies and re-reviews the fix, then lands", async () => {
      process.env.FAKE_REVIEW = "blocking:please fix: the empty case is not handled";
      await run();
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
      expect(units("review").length).toBe(6);
      expect(units("review").map((u) => u.goal.replace(/: write \w$/, ""))).toContain("Review U2 again (round 2, the fixes only)");
      const threads = db.prepare("SELECT thread_id, author, decision FROM mr_threads ORDER BY rowid").all() as {
        thread_id: string;
        author: string;
        decision: string;
      }[];
      expect(threads.length).toBe(3);
      expect(threads.every((t) => /^review:U\d+:F1$/.test(t.thread_id) && t.author === "yagura reviewer" && t.decision === "fixed")).toBe(true);
      const files = (await git(["ls-tree", "-r", "--name-only", "main"], { cwd: origin })).split("\n").filter((f) => f.startsWith("app/"));
      for (const f of files) expect(await git(["show", `main:${f}`], { cwd: origin })).toContain("# review fix T1");
      expect(getProject(db, project).state).toBe("closed");
    }, 60_000);

    it("reads the arbiter's rulings from its records, never its report, and reminds it once in the same session when it forgot them", async () => {
      const events = (type: string) => db.prepare("SELECT data_json FROM events WHERE type = ?").all(type) as { data_json: string }[];
      const arbiterAttempts = () =>
        (db.prepare("SELECT a.id FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.type = 'review-triage' AND a.n = 1").all() as { id: number }[]).map(
          (r) => r.id,
        );
      process.env.FAKE_REVIEW = "blocking:please fix: the empty case is not handled";
      process.env.FAKE_FORGET = "review-triage";
      try {
        await run();
      } finally {
        delete process.env.FAKE_FORGET;
      }
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
      const reminded = events("records.reminded").map((e) => JSON.parse(e.data_json) as { role: string; missing: string[] });
      expect(reminded.filter((r) => r.role === "review-triage").length).toBe(arbiterAttempts().length);
      expect(reminded.find((r) => r.role === "review-triage")!.missing).toEqual([expect.stringMatching(/^no ruling for T1: run `yagura rule T1/)]);
      const fallbacks = db.prepare("SELECT attempt_id FROM events WHERE type = 'parse.fallback'").all() as { attempt_id: number }[];
      expect(fallbacks.filter((f) => arbiterAttempts().includes(f.attempt_id))).toEqual([]);
      const { unitStory } = await import("./story.js");
      const reviewed = units("work").find((u) => units("review-triage").some((t) => t.targetUnitId === u.id))!;
      const lines = unitStory(db, ctx.boot, reviewed).entries.flatMap((e) => e.lines);
      expect(lines).toContainEqual(
        expect.objectContaining({
          text: expect.stringMatching(/^Ended without recording: no ruling for T1/),
          checks: [{ ok: false, text: "yagura asked for it once, in the same session" }],
        }),
      );
    }, 60_000);

    it("asks a triage agent that wrote outside the unit's scope to explain it in its own session, then lands", async () => {
      process.env.FAKE_REVIEW = "blocking:please fix: the empty case is not handled";
      process.env.FAKE_TRIAGE_OUTSIDE = "1";
      try {
        await run();
      } finally {
        delete process.env.FAKE_TRIAGE_OUTSIDE;
      }
      expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'triage.asked_for_reason'").get() as { n: number }).n).toBeGreaterThan(0);
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
    }, 60_000);

    it("keeps a nit as a note on the unit and lands without holding it", async () => {
      process.env.FAKE_REVIEW = "nit:a shorter name would read better";
      await run();
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
      expect(units("review-triage")).toEqual([]);
      expect(units("work")[0]!.notes.some((n) => /^Reviewer nit \(A\d+\) app\/a\/p-U\d+\.txt:1: a shorter name would read better$/.test(n))).toBe(true);
    }, 60_000);

    it("holds a change to what the unit must do until the developer approves it, then applies it for every later agent", async () => {
      const { listGates, answerGate } = await import("./store.js");
      const { listAmendments } = await import("./amend.js");
      process.env.FAKE_REVIEW = "blocking:please fix: add celebration emojis";
      process.env.FAKE_TRIAGE_AMEND = "1";
      process.env.FAKE_TRIAGE_SECTIONS_FIRST = "1";
      await run();
      const originals = new Map(units("work").map((u) => [u.id, u.acceptance]));
      const asks = () => listGates(db, project, "open").filter((g) => g.kind === "review");
      expect(asks().length).toBeGreaterThan(0);
      expect(asks()[0]!.question).toMatch(/Approving also changes U\d+'s acceptance: change "[^"]+" to "celebration emojis are part of the output"\./);
      const proposed = units("work").flatMap((u) => listAmendments(db, u.id));
      expect(proposed.length).toBeGreaterThan(0);
      expect(proposed.every((a) => a.state === "proposed")).toBe(true);
      for (const u of units("work")) expect(u.acceptance).toEqual(originals.get(u.id));

      for (let i = 0; i < 6 && asks().length; i++) {
        for (const g of asks()) answerGate(db, g.id, "fix");
        await run();
      }
      const amended = units("work").filter((u) => listAmendments(db, u.id).some((a) => a.state === "approved"));
      expect(amended.length).toBeGreaterThan(0);
      for (const u of amended) {
        expect(u.acceptance).toContain("celebration emojis are part of the output");
        expect(u.acceptance).not.toEqual(originals.get(u.id));
        const a = listAmendments(db, u.id).find((x) => x.state === "approved")!;
        expect(a.before?.acceptance).toEqual(originals.get(u.id));
      }
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
    }, 120_000);

    it("keeps each arbiter's rulings on its own story entry after a later wave takes the thread over", async () => {
      const { listGates, answerGate } = await import("./store.js");
      const { unitStory } = await import("./story.js");
      process.env.FAKE_REVIEW = "blocking:please fix: add celebration emojis";
      process.env.FAKE_TRIAGE_AMEND = "1";
      await run();
      const asks = () => listGates(db, project, "open").filter((g) => g.kind === "review");
      for (let i = 0; i < 6 && asks().length; i++) {
        for (const g of asks()) answerGate(db, g.id, "fix");
        await run();
      }
      const target = units("work").find((u) => units("review-triage").filter((t) => t.targetUnitId === u.id).length >= 2)!;
      const arbiters = unitStory(db, ctx.boot, target).entries.filter((e) => e.actor === "review-triage");
      expect(arbiters.length).toBeGreaterThanOrEqual(2);
      expect(arbiters[0]!.lines.map((l) => l.text)).toEqual([
        "T1 asked: should this change what the unit must do?",
        expect.stringMatching(/^T1 would change what U\d+ must do: change "[^"]+" to "celebration emojis are part of the output"$/),
      ]);
      // Answering Fix runs no second arbiter: the next wave is the worker, building from the first ruling's instruction.
      expect(arbiters[1]!.who).toBe("Worker");
      expect(arbiters[1]!.lines[0]!.text).toMatch(/^Fixed as you approved: make the greeting celebrate in /);
      const arbiterRuns = db
        .prepare("SELECT COUNT(*) AS n FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.target_unit_id = ? AND a.role = 'review-triage'")
        .get(target.id) as { n: number };
      expect(arbiterRuns.n).toBe(1);
      expect(target.acceptance).toContain("celebration emojis are part of the output");
      const moves = (
        db.prepare("SELECT data_json FROM events WHERE type = 'thread.state' AND unit_id = ? ORDER BY id").all(target.id) as { data_json: string }[]
      ).map((e) => JSON.parse(e.data_json).to as string);
      expect(moves).toEqual(["ruling", "waiting", "applying", "fixing", "verifying", "replying", "settled"]);
    }, 120_000);

    it("applies a trusted author's requirement change at once, with no gate, and the worker builds to the amended acceptance", async () => {
      const { listGates } = await import("./store.js");
      const { listAmendments } = await import("./amend.js");
      setSetting(db, "project", project, "review.trusted_authors", ["yagura reviewer"]);
      process.env.FAKE_REVIEW = "blocking:please fix: add celebration emojis";
      process.env.FAKE_TRIAGE_AMEND = "1";
      await run();
      expect(listGates(db, project, "open").filter((g) => g.kind === "review")).toEqual([]);
      const amended = units("work").filter((u) => listAmendments(db, u.id).some((a) => a.state === "approved"));
      expect(amended.length).toBeGreaterThan(0);
      for (const u of amended) {
        expect(u.acceptance).toContain("celebration emojis are part of the output");
        const a = listAmendments(db, u.id).find((x) => x.state === "approved")!;
        expect(a.gateId).toBeNull();
      }
      const fixBriefs = units("review-triage")
        .flatMap((t) => listAttempts(db, t.id).slice(1))
        .map((a) => readFileSync(layout(ctx.boot).brief(project, getUnit(db, a.unitId).seq, a.n), "utf8"));
      expect(fixBriefs.length).toBeGreaterThan(0);
      for (const b of fixBriefs) expect(b).toContain("## ACCEPTANCE\n- celebration emojis are part of the output");
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
    }, 120_000);

    it("leaves the unit as it was when the developer rejects the change", async () => {
      const { listGates, answerGate } = await import("./store.js");
      const { listAmendments } = await import("./amend.js");
      process.env.FAKE_REVIEW = "blocking:please fix: add celebration emojis";
      process.env.FAKE_TRIAGE_AMEND = "1";
      await run();
      const originals = new Map(units("work").map((u) => [u.id, u.acceptance]));
      const asks = () => listGates(db, project, "open").filter((g) => g.kind === "review");
      for (let i = 0; i < 6 && asks().length; i++) {
        for (const g of asks()) answerGate(db, g.id, "dismiss");
        await run();
      }
      const all = units("work").flatMap((u) => listAmendments(db, u.id));
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((a) => a.state === "rejected")).toBe(true);
      for (const u of units("work")) expect(u.acceptance).toEqual(originals.get(u.id));
    }, 120_000);

    it("asks the developer before a security finding is dismissed, then fixes it as answered", async () => {
      const { listGates, answerGate } = await import("./store.js");
      process.env.FAKE_REVIEW = "blocking:the secret token is written to the log";
      await run();
      const asks = () => listGates(db, project, "open").filter((g) => g.kind === "review");
      expect(asks().length).toBeGreaterThan(0);
      expect(asks()[0]!.question).toMatch(
        /^On the review of U\d+, yagura reviewer wrote: "\[blocking\] the secret token is written to the log"\. This touches security/,
      );
      expect(units("work").some((u) => u.state === "landed")).toBe(false);
      for (let i = 0; i < 5 && asks().length; i++) {
        for (const g of asks()) answerGate(db, g.id, "fix");
        await run();
      }
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
      expect((db.prepare("SELECT decision FROM mr_threads").all() as { decision: string }[]).map((r) => r.decision)).toEqual(["fixed", "fixed", "fixed"]);
    }, 60_000);

    it("lands without a reviewer in a project that switched review off", async () => {
      setSetting(db, "project", project, "review.enabled", false);
      process.env.FAKE_REVIEW = "blocking:please fix: never seen";
      await run();
      expect(units("work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
      expect(units("review")).toEqual([]);
    }, 60_000);

    it("rejects a reviewer that changes the worktree, and blocks the review after its second try", async () => {
      process.env.FAKE_REVIEW = "write";
      await run();
      const review = units("review")[0]!;
      expect(review.state).toBe("blocked");
      expect(listAttempts(db, review.id).length).toBe(2);
      const reason = db.prepare("SELECT data_json FROM events WHERE type = 'review.failed' AND unit_id = ? ORDER BY id DESC LIMIT 1").get(review.id) as {
        data_json: string;
      };
      expect(JSON.parse(reason.data_json).reason).toMatch(/^the reviewer changed the worktree \(app\/\w\/p-U\d+\.txt\); a review changes nothing$/);
      expect(units("work").every((u) => u.state !== "landed")).toBe(true);
    }, 60_000);
  });

  it("takes each verdict from what the verifier recorded, and reminds a verifier that forgot it in the same session", async () => {
    const verifierAttempts = () =>
      (db.prepare("SELECT a.id FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.type = 'verify'").all() as { id: number }[]).map((r) => r.id);
    process.env.FAKE_FORGET = "verifier";
    try {
      await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    } finally {
      delete process.env.FAKE_FORGET;
    }
    expect(getProject(db, project).state).toBe("closed");
    const reminded = (db.prepare("SELECT attempt_id FROM events WHERE type = 'records.reminded'").all() as { attempt_id: number }[]).map((r) => r.attempt_id);
    expect(verifierAttempts().length).toBeGreaterThan(0);
    expect(verifierAttempts().every((id) => reminded.includes(id))).toBe(true);
    const fallbacks = (db.prepare("SELECT attempt_id FROM events WHERE type = 'parse.fallback'").all() as { attempt_id: number }[]).map((r) => r.attempt_id);
    expect(fallbacks.filter((id) => verifierAttempts().includes(id))).toEqual([]);
  }, 60_000);

  it("plans, runs disjoint units in parallel, serializes overlapping ones, verifies, lands, and closes", async () => {
    const log: string[] = [];
    await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();

    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.map((u) => [u.goal, u.state])).toEqual([
      ["write a", "landed"],
      ["write b", "landed"],
      ["write c", "landed"],
    ]);
    expect(getProject(db, project).state).toBe("closed");

    const events = db.prepare("SELECT id, type, unit_id FROM events WHERE type IN ('attempt.started', 'attempt.ended', 'unit.landed') ORDER BY id").all() as {
      id: number;
      type: string;
      unit_id: number;
    }[];
    const at = (type: string, unitId: number) => events.find((e) => e.type === type && e.unit_id === unitId)!.id;
    const [a, b, c] = work.map((u) => u.id);
    expect(at("attempt.started", b!)).toBeLessThan(at("attempt.ended", a!));
    expect(at("attempt.started", c!)).toBeGreaterThan(at("unit.landed", a!));

    const files = await git(["ls-tree", "-r", "--name-only", "main"], { cwd: origin });
    expect(
      files
        .split("\n")
        .filter((f) => f.startsWith("app/"))
        .sort(),
    ).toEqual([`app/a/extra/p-U${work[2]!.seq}.txt`, `app/a/p-U${work[0]!.seq}.txt`, `app/b/p-U${work[1]!.seq}.txt`]);
    expect(log.some((l) => l.startsWith("✔ project p closed"))).toBe(true);
    const drains = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'plan.drain_started' AND project_id = ?").get(project) as { n: number }).n;
    expect(drains()).toBe(2);

    const verifyAttempt = listAttempts(db, listUnits(db, project).find((u) => u.type === "verify" && u.targetUnitId === a)!.id)[0]!;
    const headRun = listEvidenceRuns(db, verifyAttempt.id).find((r) => r.label === "s" && r.at === "head")!;
    const artifacts = runArtifacts(db, ctx.boot, headRun.id);
    expect(artifacts.map((x) => [x.kind, x.name, x.contentType])).toEqual([
      ["stdout", "stdout", "text/plain; charset=utf-8"],
      ["stderr", "stderr", "text/plain; charset=utf-8"],
      ["file", "notes/check.txt", "text/plain; charset=utf-8"],
      ["file", "pixel.png", "image/png"],
      ["file", "screen.svg", "image/svg+xml"],
    ]);
    const read = (i: number) => readArtifact(db, ctx.boot, artifacts[i]!.id);
    expect(read(0).toString()).toBe(`checking app/a/p-U${work[0]!.seq}.txt\n`);
    expect(read(2).toString()).toBe(`looked for app/a/p-U${work[0]!.seq}.txt at head\n`);
    expect(read(3).subarray(1, 4).toString()).toBe("PNG");
    expect(artifactName(db, artifacts[4]!.id)).toBe("screen.svg");

    const workAttempt = listAttempts(db, a!)[0]!;
    const diff = await diffRange(layout(ctx.boot).mirror("testbed" as RepoId), workAttempt.baseSha!, workAttempt.headSha!);
    expect(diff).toContain(`+++ b/app/a/p-U${work[0]!.seq}.txt\n@@ -0,0 +1 @@\n+work`);

    const checkouts = join(ctx.boot.home, "worktrees", "testbed");
    expect(readdirSync(checkouts).length).toBeGreaterThan(9);
    const sweep: string[] = [];
    await new Engine(ctx, { projectId: project, sweepMs: 0, log: (l) => sweep.push(l) }).tick();
    expect(readdirSync(checkouts)).toEqual([]);
    expect(await git(["worktree", "list", "--porcelain"], { gitDir: layout(ctx.boot).mirror("testbed" as RepoId) })).not.toContain("worktree " + checkouts);
    expect(sweep[0]).toMatch(/^ {2}removed \d+ checkout\(s\) of finished units$/);
    // Every role that has moved to records was read from them, never from its final message.
    const fallbacks = db.prepare("SELECT data_json FROM events WHERE type = 'parse.fallback'").all() as { data_json: string }[];
    expect(fallbacks.map((f) => JSON.parse(f.data_json).parser)).toEqual([]);
  }, 60_000);

  it("writes, proves, and lands a verify pack first on a repo without one, then verifies work with it", async () => {
    const seed = join(mkdtempSync(join(tmpdir(), "yagura-nopack-")), "seed");
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "README.md"), "no pack here\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@t" });
    const bare = `${seed}.git`;
    await git(["clone", "--quiet", "--bare", seed, bare]);
    addRepo(db, { id: "nopack", url: bare, defaultBranch: "main" });
    const q = "q" as ProjectId;
    addProject(db, { id: q, name: "Q", goal: "g", predicate: "all files landed", minTier: "unit-verified", repos: ["nopack" as RepoId] });
    setProjectEnvironment(db, q, "local" as EnvironmentId);
    setMergePolicy(db, q, "auto");

    await new Engine(ctx, { projectId: q, tickMs: 50 }).runUntilIdle();

    const units = listUnits(db, q);
    const pack = units.find((u) => u.type === "pack")!;
    expect(pack).toMatchObject({ seq: 1, state: "landed", repoId: "nopack", goal: "Write a verify pack for nopack" });
    expect(getRepo(db, "nopack" as RepoId)).toMatchObject({ packStatus: "proven", packProvenSha: pack.landedSha });
    const proof = units.find((u) => u.type === "verify" && u.targetUnitId === pack.id)!;
    const proofAttempt = listAttempts(db, proof.id)[0]!;
    expect(proofAttempt).toMatchObject({ harness: "yagura-proof", skills: [] });
    expect(listEvidenceRuns(db, proofAttempt.id).map((r) => `${r.label}@${r.at}:${r.exitCode}`)).toEqual([
      "pack:doctor@head:0",
      "pack:deploy@head:0",
      "check:unit@head:0",
      "pack:teardown@head:0",
    ]);
    expect(await git(["show", "main:.agents/verify/verify.json"], { cwd: bare })).toContain('"deploy"');

    const work = units.filter((u) => u.type === "work");
    expect(work.map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
    const firstWorkVerify = units.find((u) => u.type === "verify" && u.targetUnitId === work[0]!.id)!;
    const packLanded = db.prepare("SELECT MIN(id) AS id FROM events WHERE type = 'unit.landed' AND unit_id = ?").get(pack.id) as { id: number };
    const verifyStarted = db.prepare("SELECT MIN(id) AS id FROM events WHERE type = 'attempt.started' AND unit_id = ?").get(firstWorkVerify.id) as {
      id: number;
    };
    expect(verifyStarted.id).toBeGreaterThan(packLanded.id);
    expect(listEvidenceRuns(db, listAttempts(db, firstWorkVerify.id)[0]!.id).map((r) => r.label)).toContain("pack:deploy");
    expect(getProject(db, q).state).toBe("closed");
  }, 60_000);

  it("lets verifiers fix a broken pack, uses the fix at once, and lands it after the unit it was made for", async () => {
    const seed = join(mkdtempSync(join(tmpdir(), "yagura-brokenpack-")), "seed");
    mkdirSync(join(seed, ".agents/verify"), { recursive: true });
    writeFileSync(join(seed, "README.md"), "x\n");
    writeFileSync(
      join(seed, ".agents/verify/verify.json"),
      JSON.stringify({ provider: "local-process", doctor: "exit 3", checks: [{ name: "unit", command: "test -f README.md", tier: "unit-verified" }] }),
    );
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@t" });
    await git(["clone", "--quiet", "--bare", seed, `${seed}.git`]);
    addRepo(db, { id: "broken", url: `${seed}.git`, defaultBranch: "main" });
    const q = "q" as ProjectId;
    addProject(db, { id: q, name: "Q", goal: "g", predicate: "all files landed", minTier: "unit-verified", repos: ["broken" as RepoId] });
    setProjectEnvironment(db, q, "local" as EnvironmentId);
    setMergePolicy(db, q, "auto");

    await new Engine(ctx, { projectId: q, tickMs: 50 }).runUntilIdle();

    const units = listUnits(db, q);
    expect(units.filter((u) => u.type === "work").map((u) => u.state)).toEqual(["landed", "landed", "landed"]);
    const firstVerify = units.find((u) => u.type === "verify")!;
    const runs = listEvidenceRuns(db, listAttempts(db, firstVerify.id)[0]!.id).map((r) => `${r.label}@${r.at}:${r.exitCode}`);
    expect(runs[0]).toBe("pack:doctor@base:3");
    expect(runs.at(-3)).toBe("pack:doctor@base:0");
    const packUnits = units.filter((u) => u.type === "pack");
    expect(packUnits.some((u) => u.state === "landed")).toBe(true);
    expect(JSON.parse(await git(["show", "main:.agents/verify/verify.json"], { cwd: `${seed}.git` }))).toMatchObject({ doctor: "true" });
    const edits = db.prepare("SELECT state, summary FROM pack_edits").all() as { state: string; summary: string }[];
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.state !== "pending")).toBe(true);
    expect(edits[0]!.summary).toBe("- doctor: it probed a service this repo does not use");
    expect(getProject(db, q).state).toBe("closed");
  }, 60_000);

  it("sends a pack back to its agent when the proof fails", async () => {
    const seed = join(mkdtempSync(join(tmpdir(), "yagura-badpack-")), "seed");
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "README.md"), "x\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@t" });
    await git(["clone", "--quiet", "--bare", seed, `${seed}.git`]);
    addRepo(db, { id: "badpack", url: `${seed}.git`, defaultBranch: "main" });
    const q = "q" as ProjectId;
    addProject(db, { id: q, name: "Q", goal: "g", predicate: "p", minTier: "unit-verified", repos: ["badpack" as RepoId] });
    setProjectEnvironment(db, q, "local" as EnvironmentId);
    process.env.FAKE_PACK_CHECK = "test -f nothing-here";
    try {
      await new Engine(ctx, { projectId: q, tickMs: 50 }).runUntilIdle();
    } finally {
      delete process.env.FAKE_PACK_CHECK;
    }
    const pack = listUnits(db, q).find((u) => u.type === "pack")!;
    expect(pack.state).toBe("blocked");
    expect(pack.notes[0]).toMatch(/rejected the previous attempt: pack checks fail on the repo as it is: unit exit 1/);
    expect(listAttempts(db, pack.id).map((a) => a.state)).toEqual(["handed_off", "handed_off"]);
    expect(getRepo(db, "badpack" as RepoId).packStatus).toBe("missing");
    expect(listUnits(db, q).filter((u) => u.type === "pack")).toHaveLength(1);
  }, 60_000);

  it("stops at a land gate under merge: human and lands once it is answered", async () => {
    setMergePolicy(db, project, "human");
    const engine = new Engine(ctx, { projectId: project, tickMs: 50 });
    await engine.runUntilIdle();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.filter((u) => u.state === "verified").length).toBeGreaterThan(0);
    expect(work.some((u) => u.state === "landed")).toBe(false);
    const { listGates, answerGate } = await import("./store.js");
    for (const g of listGates(db, project, "open").filter((x) => x.kind === "land")) answerGate(db, g.id, "land");
    await engine.runUntilIdle();
    for (const g of listGates(db, project, "open").filter((x) => x.kind === "land")) answerGate(db, g.id, "land");
    await engine.runUntilIdle();
    expect(
      listUnits(db, project)
        .filter((u) => u.type === "work")
        .every((u) => u.state === "landed"),
    ).toBe(true);
  }, 60_000);

  it("pauses verification on an environment its first verifier cannot use, and resumes every waiting unit once answered", async () => {
    const { listGates, answerGate } = await import("./store.js");
    const engine = new Engine(ctx, { projectId: project, tickMs: 50 });
    process.env.FAKE_VERIFY_BLOCKED = "the registry at localhost:5000 refused the connection";
    try {
      await engine.runUntilIdle();
    } finally {
      delete process.env.FAKE_VERIFY_BLOCKED;
    }
    const gates = listGates(db, project, "open").filter((g) => g.kind === "environment");
    expect(gates.map((g) => g.question)).toEqual([
      "Verification on environment local is paused: the verifier could not verify: the registry at localhost:5000 refused the connection. It stays paused for every project on local until you answer that it works again.",
    ]);
    const opened = db.prepare("SELECT id FROM events WHERE type = 'environment.paused'").get() as { id: number };
    const startedAfter = db
      .prepare("SELECT COUNT(*) AS n FROM events e JOIN units u ON u.id = e.unit_id WHERE e.type = 'attempt.started' AND u.type = 'verify' AND e.id > ?")
      .get(opened.id);
    expect(startedAfter).toEqual({ n: 0 });
    expect(listUnits(db, project).filter((u) => u.type === "work" && u.state === "landed")).toEqual([]);
    expect(listUnits(db, project).filter((u) => u.state === "verifying").length).toBeGreaterThan(0);

    answerGate(db, gates[0]!.id, "fixed");
    await engine.runUntilIdle();
    expect(
      listUnits(db, project)
        .filter((u) => u.type === "work")
        .map((u) => u.state),
    ).toEqual(["landed", "landed", "landed"]);
    expect(getProject(db, project).state).toBe("closed");
  }, 60_000);

  it("plans again after a landing whose worker suggested follow-ups, even with work still queued", async () => {
    process.env.FAKE_FOLLOWUPS = "cache the parsed config";
    try {
      await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    } finally {
      delete process.env.FAKE_FOLLOWUPS;
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'plan.drain_started'").get() as { n: number }).n).toBe(4);
    expect(getProject(db, project).state).toBe("closed");
  }, 60_000);

  it("tells a unit's story, and turns a disagreement with a landed unit into a follow-up that reopens the closed project", async () => {
    const { unitStory } = await import("./story.js");
    const { recordDisagreement, listDisagreements } = await import("./disagreements.js");
    const engine = new Engine(ctx, { projectId: project, tickMs: 50 });
    await engine.runUntilIdle();
    expect(getProject(db, project).state).toBe("closed");
    const a = listUnits(db, project).find((u) => u.type === "work")!;

    const story = unitStory(db, ctx.boot, a);
    expect(story.entries.map((e) => e.actor)).toEqual(["planner", "worker", "verifier", "reviewer", "yagura"]);
    expect(story.entries[3]).toMatchObject({ who: "Reviewer", status: { text: "nothing to settle", tone: "pine" }, lines: [{ text: "No findings." }] });
    const [, worker, verifier, , landed] = story.entries;
    expect(worker!.lines[0]).toMatchObject({ kind: "claimed", checks: [{ ok: true, text: expect.stringMatching(/^verified by A\d+$/) }] });
    expect(verifier!.lines[0]!.checks[0]).toMatchObject({ ok: true, text: expect.stringMatching(/^scenario run:\d+ passes on head and fails on trunk/) });
    expect(landed!.lines[0]!.checks).toEqual([{ ok: true, text: "the merged patch is the one verified, so the verdict carries" }]);

    const d = recordDisagreement(db, {
      unitId: a.id,
      ref: worker!.lines[0]!.ref,
      about: worker!.lines[0]!.text,
      reason: "the file should be named after the unit",
      action: "follow-up",
    });
    expect(getProject(db, project).state).toBe("active");
    await engine.runUntilIdle();
    const [planned] = listDisagreements(db, { projectId: project });
    const fix = listUnits(db, project).find((u) => u.id === planned!.followUpUnitId)!;
    expect(planned).toMatchObject({ id: d.id, state: "planned" });
    expect(fix).toMatchObject({ goal: `write fix-d${d.id}`, state: "landed" });
    expect(fix.description).toBe(
      `On U${a.seq} you disagreed with "${worker!.lines[0]!.text}". You said: "the file should be named after the unit". This unit follows that up.`,
    );
    expect(getProject(db, project).state).toBe("closed");
    expect(unitStory(db, ctx.boot, a).entries.at(-1)).toMatchObject({ who: "You disagreed", status: { text: `following up with unit U${fix.seq}` } });
  }, 60_000);

  it("blocks a unit that crashes before it starts instead of starting it again every tick", async () => {
    setSetting(db, "project", project, "role.worker.harness", "missing-harness");
    const log: string[] = [];
    await new Engine(ctx, { projectId: project, tickMs: 50, log: (l) => log.push(l) }).runUntilIdle();
    const work = listUnits(db, project).filter((u) => u.type === "work");
    expect(work.filter((u) => u.state === "blocked").length).toBeGreaterThan(0);
    expect(log.filter((l) => l.startsWith("✗ work")).length).toBe(work.filter((u) => u.state === "blocked").length);
    expect(db.prepare("SELECT data_json FROM events WHERE type = 'unit.state' AND json_extract(data_json, '$.to') = 'blocked' LIMIT 1").get()).toEqual({
      data_json: JSON.stringify({ from: "ready", to: "blocked", reason: "engine error before it started: no adapter for harness missing-harness" }),
    });
  });

  it("does not start work while the project's andon is raised", async () => {
    const { setAndon } = await import("./store.js");
    setAndon(db, project, "investigating a bad deploy");
    await new Engine(ctx, { projectId: project, tickMs: 50 }).runUntilIdle();
    expect(listUnits(db, project)).toEqual([]);
  });
});
