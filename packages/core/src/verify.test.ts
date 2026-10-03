import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import { REBASE_HARNESS, spendsAttempt, type EnvironmentId, type ProjectId, type RepoId, type Unit } from "./domain.js";
import { setSetting } from "./config.js";
import { listEvidenceRuns } from "./evidence.js";
import { reapKept } from "./leases.js";
import { commitAll, ensureMirror, git } from "./git.js";
import { notePackStale } from "./repos.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import { listPackEdits } from "./packedits.js";
import { addVerifyUnit, runWorkUnit } from "./runner.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  addUnit,
  createAttempt,
  getRepo,
  getUnit,
  getUnitBySeq,
  listAttempts,
  listUnits,
  openStore,
  setProjectEnvironment,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { readiness } from "./schedule.js";
import { runVerifyUnit } from "./verify.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs"), ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
  parse: parseClaudeLine,
};
const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;
const cli = [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")];

let db: Db;
let ctx: RunContext;
let origin: string;
const project = "p" as ProjectId;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-verify-"));
  origin = join(root, "origin");
  mkdirSync(join(origin, "app"), { recursive: true });
  mkdirSync(join(origin, ".agents/verify"), { recursive: true });
  writeFileSync(join(origin, "app/orders.py"), "x = 1\n");
  writeFileSync(
    join(origin, ".agents/verify/verify.json"),
    JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f app/orders.py", tier: "unit-verified" }] }),
  );
  await git(["init", "--quiet", "-b", "main"], { cwd: origin });
  await commitAll(origin, "init", { name: "t", email: "t@t" });
  const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  ctx = { db, boot, adapters: { claude: fake }, cli };
  addRepo(db, { id: "testbed", url: origin, defaultBranch: "main" });
  addProject(db, { id: project, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["testbed" as RepoId] });
  addEnvironment(db, { id: "local", name: "local", provider: "local-process", capacity: 1 });
  setProjectEnvironment(db, project, "local" as EnvironmentId);
  // These tests are about the fixed rules; the manager has its own (manager.test.ts).
  setSetting(db, "global", "", "manager.enabled", false);
});

async function workThenVerify(verifierMode: string): Promise<{ target: Unit; verify: Unit; result: Awaited<ReturnType<typeof runVerifyUnit>> }> {
  const work = addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "testbed" as RepoId,
    goal: "Implement apply_discount",
    writeScope: ["app/**"],
    acceptance: ["orders.py is edited"],
    verify: "python3 -m unittest",
    playbook: "feature",
    timeboxSeconds: 60,
    maxAttempts: 2,
  });
  transitionUnit(db, work.id, "ready");
  process.env.FAKE_MODE = "success";
  await runWorkUnit(ctx, work.id);
  const verify = getUnitBySeq(db, project, 2);
  process.env.FAKE_MODE = verifierMode;
  const result = await runVerifyUnit(ctx, verify.id);
  return { target: getUnit(db, work.id), verify: getUnit(db, verify.id), result };
}

describe("runVerifyUnit", () => {
  it("verifies a change on evidence yagura captured on trunk and head", async () => {
    const { target, verify, result } = await workThenVerify("verify-pass");
    expect(result.decision).toMatchObject({ outcome: "verified", tier: "unit-verified" });
    expect(target.state).toBe("verified");
    expect(verify.state).toBe("done");
    const runs = listEvidenceRuns(db, result.attempt.id);
    expect(runs.map((r) => `${r.label}@${r.at}:${r.exitCode}`)).toEqual(["check:unit@base:0", "check:unit@head:0", "scenario@base:1", "scenario@head:0"]);
    const verdict = db.prepare("SELECT tier, head_sha, patch_id, trunk_outcome FROM verdicts WHERE id = ?").get(result.verdictId) as Record<string, string>;
    expect(verdict).toMatchObject({ tier: "unit-verified", head_sha: listAttempts(db, target.id)[0]!.headSha });
    expect(verdict.patch_id).toMatch(/^[0-9a-f]{40}$/);
    expect(db.prepare("SELECT state FROM leases").all()).toEqual([{ state: "released" }]);
    expect(result.attempt.missingSkills).toEqual([]);
  });

  it("proves an existing pack when a verification passes all of it on trunk, and marks it stale when it changes after", async () => {
    await workThenVerify("verify-pass");
    const trunk = (await git(["rev-parse", "HEAD"], { cwd: origin })).trim();
    expect(getRepo(db, "testbed" as RepoId)).toMatchObject({ packStatus: "proven", packProvenSha: trunk });
    writeFileSync(
      join(origin, ".agents/verify/verify.json"),
      JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "test -f app/orders.py && true", tier: "unit-verified" }] }),
    );
    await commitAll(origin, "change the pack", { name: "t", email: "t@t" });
    const mirror = layout(ctx.boot).mirror("testbed" as RepoId);
    await ensureMirror(origin, mirror);
    expect(await notePackStale(db, getRepo(db, "testbed" as RepoId), mirror)).toBe("stale");
    expect(getRepo(db, "testbed" as RepoId).packStatus).toBe("stale");
  });

  it("discards a verdict whose scenario also passes on trunk, without blaming the work", async () => {
    const { target, result } = await workThenVerify("verify-weak");
    expect(result.decision).toMatchObject({ outcome: "invalid", reason: expect.stringMatching(/proves nothing/) });
    expect(result.verdictId).toBeNull();
    expect(target.state).toBe("verifying");
    expect(getUnitBySeq(db, project, 3)).toMatchObject({ type: "verify", state: "ready", targetUnitId: target.id });
  });

  it("blocks the work after repeated verifications fail to reach a verdict", async () => {
    const { target } = await workThenVerify("verify-weak");
    process.env.FAKE_MODE = "verify-weak";
    await runVerifyUnit(ctx, getUnitBySeq(db, project, 3).id);
    expect(getUnit(db, target.id).state).toBe("blocked");
    expect(listUnits(db, project).filter((u) => u.type === "verify" && u.state === "ready")).toEqual([]);
  });

  it("closes the work as done, not blocked, when trunk moved under it and already does what the verifier checks", async () => {
    const { target } = await workThenVerify("verify-weak");
    writeFileSync(join(origin, "README.md"), "another unit landed this\n");
    await commitAll(origin, "another unit's change", { name: "t", email: "t@t" });
    const moved = (await git(["rev-parse", "HEAD"], { cwd: origin })).trim();
    const work = listAttempts(db, target.id)[0]!;
    const rebased = createAttempt(db, target.id, REBASE_HARNESS, null);
    updateAttempt(db, rebased.id, { state: "handed_off", baseSha: moved as never, headSha: work.headSha, branch: work.branch });
    process.env.FAKE_MODE = "verify-weak";
    await runVerifyUnit(ctx, getUnitBySeq(db, project, 3).id);
    const after = getUnit(db, target.id);
    expect(after.state).toBe("done");
    expect(after.notes.at(-1)).toMatch(/^Closed without landing: already on [0-9a-f]{10}: trunk moved under it/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'unit.already_on_trunk'").get()).toEqual({ n: 1 });
  });

  it("discards a verdict that cites runs yagura never recorded", async () => {
    const { target, result } = await workThenVerify("verify-lie");
    expect(result.decision).toMatchObject({ outcome: "invalid", reason: expect.stringMatching(/run:999/) });
    expect(target.state).toBe("verifying");
    const outcome = db.prepare("SELECT data_json FROM events WHERE type = 'verify.outcome'").get() as { data_json: string };
    expect(JSON.parse(outcome.data_json)).toMatchObject({ outcome: "invalid", check: "disagreed" });
  });

  it("sends the work back with the verifier's reason when the change fails acceptance", async () => {
    const { target, result } = await workThenVerify("verify-fail");
    expect(result.decision).toMatchObject({ outcome: "code-fault", tier: "verifier-failed" });
    expect(target.state).toBe("ready");
    expect(target.notes[0]).toMatch(/Verifier U2 rejected the previous attempt/);
  });

  it("restores and flags a checkout the verifier edited, voiding its verdict", async () => {
    const { target, result } = await workThenVerify("verify-tamper");
    const runs = listEvidenceRuns(db, result.attempt.id);
    expect(runs.filter((r) => r.tampered).map((r) => `${r.label}@${r.at}`)).toEqual(["scenario@head"]);
    expect(result.decision).toMatchObject({ outcome: "invalid", reason: expect.stringMatching(/modified/) });
    expect(target.state).toBe("verifying");
  });
});

describe("pack lifecycle scripts", () => {
  async function setTrunkPack(pack: Record<string, unknown>) {
    writeFileSync(join(origin, ".agents/verify/verify.json"), JSON.stringify({ provider: "local-process", ...pack }));
    await commitAll(origin, "pack", { name: "t", email: "t@t" });
  }
  const labels = (attemptId: number) => listEvidenceRuns(db, attemptId as never).map((r) => `${r.label}@${r.at}:${r.exitCode}`);

  it("runs doctor once, deploys the side each run needs, and tears down at the end", async () => {
    await setTrunkPack({
      doctor: "test -d .",
      deploy: 'echo "$YAGURA_AT" > "$YAGURA_LEASE_DIR/deployed"',
      teardown: 'rm "$YAGURA_LEASE_DIR/deployed"',
      checks: [{ name: "unit", command: 'grep -qx "$YAGURA_AT" "$YAGURA_LEASE_DIR/deployed"', tier: "unit-verified" }],
    });
    const { target, result } = await workThenVerify("verify-pass");
    expect(result.decision).toMatchObject({ outcome: "verified", tier: "unit-verified" });
    expect(target.state).toBe("verified");
    expect(labels(result.attempt.id)).toEqual([
      "pack:doctor@base:0",
      "pack:deploy@base:0",
      "check:unit@base:0",
      "pack:teardown@base:0",
      "pack:deploy@head:0",
      "check:unit@head:0",
      "pack:teardown@head:0",
      "pack:deploy@base:0",
      "scenario@base:1",
      "pack:teardown@base:0",
      "pack:deploy@head:0",
      "scenario@head:0",
      "pack:teardown@head:0",
    ]);
  });

  it("still runs the verifier when the doctor fails, and blames the environment when the verifier leaves the pack as it is", async () => {
    await setTrunkPack({ doctor: "echo cluster unreachable >&2; exit 3", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] });
    const { target, result } = await workThenVerify("verify-pass");
    expect(result.decision).toMatchObject({ outcome: "env-blocked", reason: expect.stringMatching(/^the pack's doctor failed \(run:\d+\)/) });
    expect(labels(result.attempt.id).slice(0, 3)).toEqual(["pack:doctor@base:3", "check:unit@base:0", "check:unit@head:0"]);
    expect(result.attempt.skills).toContain("yagura:yagura-verifier");
    expect(readFileSync(layout(ctx.boot).brief(project, 2, 1), "utf8")).toContain("- doctor on trunk: run:1 exit 3");
    expect(target.state).toBe("verifying");
    expect(db.prepare("SELECT kind, state FROM gates").all()).toEqual([{ kind: "environment", state: "open" }]);
    expect(listUnits(db, project).filter((u) => u.type === "verify" && u.state === "ready")).toEqual([]);
    const waiting = addVerifyUnit(db, getUnit(db, target.id));
    expect(readiness(db, project).waiting).toEqual([{ unit: waiting, reason: "verification on local is paused until gate 1 is answered" }]);
  });

  it("uses the verifier's pack fix at once on both sides, and keeps it as an edit to land after the unit", async () => {
    await setTrunkPack({ doctor: "exit 3", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] });
    const { target, result } = await workThenVerify("verify-fix-pack");
    expect(result.decision).toMatchObject({ outcome: "verified", tier: "unit-verified" });
    expect(labels(result.attempt.id)).toEqual([
      "pack:doctor@base:3",
      "check:unit@base:0",
      "check:unit@head:0",
      "scenario@base:1",
      "scenario@head:0",
      "pack:doctor@base:0",
      "check:unit@base:0",
      "check:unit@head:0",
      "check:orders-edited@base:1",
      "check:orders-edited@head:0",
    ]);
    const edits = listPackEdits(db, target.id);
    expect(edits).toMatchObject([
      { state: "pending", summary: "- doctor: the old one probed a service this repo does not use\n- added orders-edited, which runs what this change built" },
    ]);
    const mirror = layout(ctx.boot).mirror("testbed" as RepoId);
    expect(await git(["diff", "--name-only", edits[0]!.baseSha, edits[0]!.sha], { gitDir: mirror })).toBe(".agents/verify/verify.json");
    expect(db.prepare("SELECT data_json FROM events WHERE type = 'pack.edit_outside'").get()).toEqual({ data_json: JSON.stringify({ paths: ["stray.txt"] }) });

    transitionUnit(db, target.id, "verifying");
    process.env.FAKE_MODE = "verify-pass";
    const again = await runVerifyUnit(ctx, addVerifyUnit(db, getUnit(db, target.id)).id);
    expect(labels(again.attempt.id).slice(0, 5)).toEqual([
      "pack:doctor@base:0",
      "check:unit@base:0",
      "check:unit@head:0",
      "check:orders-edited@base:1",
      "check:orders-edited@head:0",
    ]);
  });

  it("shows later verifiers of the repo what the developer disagreed with", async () => {
    const { target } = await workThenVerify("verify-pass");
    const { recordDisagreement } = await import("./disagreements.js");
    recordDisagreement(db, { unitId: target.id, ref: "x", about: "skipping non-ASCII input", reason: "always test accented letters", action: "note" });
    transitionUnit(db, target.id, "verifying");
    const again = addVerifyUnit(db, getUnit(db, target.id));
    await runVerifyUnit(ctx, again.id);
    expect(readFileSync(layout(ctx.boot).brief(project, again.seq, 1), "utf8")).toContain(
      "## WHERE THE DEVELOPER DISAGREED WITH EARLIER WORK ON THIS REPO\nWeigh these when you decide what to test.\n- On p/U1, about skipping non-ASCII input: always test accented letters",
    );
  });

  it("drops a pack edit that yagura cannot read and does not accept the verdict", async () => {
    const { target, result } = await workThenVerify("verify-bad-pack");
    expect(result.decision).toMatchObject({
      outcome: "invalid",
      reason: expect.stringMatching(/^the verifier's pack edit cannot be used \(verify.json is not valid JSON/),
    });
    expect(listPackEdits(db, target.id)).toEqual([]);
    expect(target.state).toBe("verifying");
  });

  it("blocks a unit whose verifier reached no verdict in its allowed tries when no manager is on", async () => {
    setSetting(db, "project", project, "verify.max_retries", 1);
    const { target } = await workThenVerify("verify-weak");
    expect(target.state).toBe("blocked");
  });

  it("leaves such a unit rejected for its manager when one is on", async () => {
    setSetting(db, "project", project, "verify.max_retries", 1);
    setSetting(db, "global", "", "manager.enabled", true);
    const { target } = await workThenVerify("verify-weak");
    expect(target.state).toBe("rejected");
    const why = db.prepare("SELECT data_json FROM events WHERE unit_id = ? AND type = 'unit.state' ORDER BY id DESC LIMIT 1").get(target.id) as {
      data_json: string;
    };
    expect(JSON.parse(why.data_json).reason).toMatch(/^verification did not reach a verdict 1 times: /);
  });

  it("sends the work back when its head does not deploy while trunk does", async () => {
    await setTrunkPack({ deploy: 'grep -q "x = 1" app/orders.py', checks: [{ name: "unit", command: "true", tier: "unit-verified" }] });
    const { target, result } = await workThenVerify("verify-pass");
    expect(result.decision).toMatchObject({ outcome: "code-fault", reason: expect.stringMatching(/^head does not deploy \(run:\d+\) while trunk does/) });
    expect(labels(result.attempt.id).slice(0, 4)).toEqual(["pack:deploy@base:0", "check:unit@base:0", "pack:deploy@head:1", "check:unit@head:0"]);
    expect(target.state).toBe("ready");
  });

  it("keeps a failed local verification's slot directory after its teardown when the keep policy says so, and deletes it when its time is up", async () => {
    await setTrunkPack({
      deploy: 'grep -q "x = 1" app/orders.py && touch "$YAGURA_LEASE_DIR/up-$YAGURA_AT"',
      teardown: 'rm -f "$YAGURA_LEASE_DIR"/up-*',
      checks: [{ name: "unit", command: "true", tier: "unit-verified" }],
    });
    setSetting(db, "project", project, "lease.keep", "failed");
    const { result } = await workThenVerify("verify-pass");
    expect(result.decision.outcome).toBe("code-fault");
    expect(labels(result.attempt.id).at(-1)).toBe("pack:teardown@head:0");
    const lease = db.prepare("SELECT id, state, vars_json, kept_until, kept_reason FROM leases").get() as Record<string, string>;
    expect(lease).toMatchObject({ state: "released", kept_reason: "kept because verification did not pass (code-fault)" });
    expect(Date.parse(lease.kept_until!) - Date.now()).toBeGreaterThan(1.9 * 3_600_000);
    const dir = JSON.parse(lease.vars_json!).YAGURA_LEASE_DIR as string;
    expect(readdirSync(dir)).toEqual([]);
    expect(await reapKept(db, ctx.boot)).toBe(0);
    expect(await reapKept(db, ctx.boot, Date.now() + 3 * 3_600_000)).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(db.prepare("SELECT kept_until FROM leases").get()).toEqual({ kept_until: null });
  });
});

describe("resume on rejection", () => {
  const attemptsOf = (u: Unit) => listAttempts(db, u.id);
  const rework = async (u: Unit, mode = "success") => {
    process.env.FAKE_MODE = mode;
    await runWorkUnit(ctx, u.id);
    return attemptsOf(u).at(-1)!;
  };
  const freshReasons = () =>
    (db.prepare("SELECT data_json FROM events WHERE type = 'attempt.fresh' ORDER BY id").all() as { data_json: string }[]).map(
      (e) => (JSON.parse(e.data_json) as { reason: string }).reason,
    );

  it("resumes the rejected worker's session in its own worktree with the verifier's findings, then verifies again", async () => {
    const { target } = await workThenVerify("verify-fail");
    expect(target.state).toBe("ready");
    const first = attemptsOf(target)[0]!;
    expect(first).toMatchObject({ rejection: "code-fault", sessionId: "s1" });
    const second = await rework(target);
    expect(second).toMatchObject({
      resumesAttemptId: first.id,
      sessionId: "s1",
      worktreePath: first.worktreePath,
      branch: first.branch,
      baseSha: first.baseSha,
      state: "handed_off",
      missingSkills: [],
    });
    const prompt = readFileSync(layout(ctx.boot).brief(project, target.seq, 2), "utf8");
    expect(prompt).toContain("This is attempt 2 of p/U1, resuming your own session from attempt 1.");
    expect(prompt).toMatch(
      /- run:\d+ scenario on your head: exit 1 \(trunk: exit 1\)\n  command: sh (\S+scenario\.sh)\n  \1:\n  ```\n  grep -q 'never there' app\/orders\.py\n  ```\n  \(no output\)/,
    );
    expect(prompt).toContain("## VERIFIER'S REPORT\n## Status\nsuccess\n\n## Verification\nverifier-failed");
    expect(prompt).not.toContain("## GOAL");
    expect(readFileSync(join(first.worktreePath!, "app/orders.py"), "utf8")).toContain("# fixed after findings: true");
    expect(getUnit(db, target.id).state).toBe("verifying");
    process.env.FAKE_MODE = "verify-pass";
    const again = await runVerifyUnit(ctx, getUnitBySeq(db, project, 3).id);
    expect(again.decision.outcome).toBe("verified");
  });

  it("starts fresh after one resumed round, when the session was near its context limit, and when resuming is off", async () => {
    const { target } = await workThenVerify("verify-fail");
    db.prepare("UPDATE units SET max_attempts = 5 WHERE id = ?").run(target.id);
    await rework(target);
    process.env.FAKE_MODE = "verify-fail";
    await runVerifyUnit(ctx, getUnitBySeq(db, project, 3).id);
    const third = await rework(target);
    expect(third.resumesAttemptId).toBeNull();
    expect(third.worktreePath).not.toBe(attemptsOf(target)[0]!.worktreePath);
    expect(readFileSync(layout(ctx.boot).brief(project, target.seq, 3), "utf8")).toContain("## GOAL");

    process.env.FAKE_MODE = "verify-fail";
    await runVerifyUnit(ctx, getUnitBySeq(db, project, 4).id);
    updateAttempt(db, third.id, { contextPeak: 150_000 });
    expect((await rework(target)).resumesAttemptId).toBeNull();

    process.env.FAKE_MODE = "verify-fail";
    await runVerifyUnit(ctx, getUnitBySeq(db, project, 5).id);
    setSetting(db, "project", project, "work.resume_on_rejection", false);
    expect((await rework(target)).resumesAttemptId).toBeNull();
    expect(freshReasons()).toEqual([
      "attempt 2 was already a resumed round",
      "attempt 3 peaked at 75% of its context window",
      "attempt 4 is not resumed: resume on rejection is off",
    ]);
  }, 30_000);

  it("falls back to a fresh attempt at no extra try when the session cannot be resumed", async () => {
    const { target } = await workThenVerify("verify-fail");
    process.env.FAKE_RESUME = "missing";
    try {
      await rework(target);
    } finally {
      delete process.env.FAKE_RESUME;
    }
    const [first, resume, fresh] = attemptsOf(target);
    expect(resume).toMatchObject({ resumesAttemptId: first!.id, sessionId: null, state: "failed", failureMode: "harness-error" });
    expect(fresh).toMatchObject({ resumesAttemptId: null, state: "handed_off" });
    expect(attemptsOf(target).filter(spendsAttempt)).toHaveLength(2);
    const failed = db.prepare("SELECT data_json FROM events WHERE type = 'attempt.resume_failed'").get() as { data_json: string };
    expect(JSON.parse(failed.data_json).reason).toBe("resuming attempt 1's session failed to start: No conversation found with session ID: s1");
    expect(getUnit(db, target.id).state).toBe("verifying");
  });
});
