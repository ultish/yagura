import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId, Unit } from "./domain.js";
import { setSetting } from "./config.js";
import { listEvidenceRuns } from "./evidence.js";
import { reapKept } from "./leases.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import { runWorkUnit } from "./runner.js";
import {
  addEnvironment,
  addProject,
  addRepo,
  addUnit,
  getUnit,
  getUnitBySeq,
  listAttempts,
  listUnits,
  openStore,
  setProjectEnvironment,
  transitionUnit,
  type Db,
} from "./store.js";
import { runVerifyUnit } from "./verify.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs")], stdin: run.prompt }),
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

  it("discards a verdict that cites runs yagura never recorded", async () => {
    const { target, result } = await workThenVerify("verify-lie");
    expect(result.decision).toMatchObject({ outcome: "invalid", reason: expect.stringMatching(/run:999/) });
    expect(target.state).toBe("verifying");
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

  it("stops before the verifier when doctor fails, and blames the environment, not the change", async () => {
    await setTrunkPack({ doctor: "echo cluster unreachable >&2; exit 3", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] });
    const { target, result } = await workThenVerify("verify-pass");
    expect(result.decision).toMatchObject({ outcome: "env-blocked", reason: expect.stringMatching(/^the pack's doctor failed \(run:\d+\)/) });
    expect(labels(result.attempt.id)).toEqual(["pack:doctor@base:3"]);
    expect(result.attempt.skills).toEqual([]);
    expect(target.state).toBe("verifying");
    expect(
      listUnits(db, project)
        .filter((u) => u.type === "verify")
        .map((u) => u.state),
    ).toEqual(["failed", "ready"]);
  });

  it("sends the work back when its head does not deploy while trunk does", async () => {
    await setTrunkPack({ deploy: 'grep -q "x = 1" app/orders.py', checks: [{ name: "unit", command: "true", tier: "unit-verified" }] });
    const { target, result } = await workThenVerify("verify-pass");
    expect(result.decision).toMatchObject({ outcome: "code-fault", reason: expect.stringMatching(/^head does not deploy \(run:\d+\) while trunk does/) });
    expect(labels(result.attempt.id)).toEqual(["pack:deploy@base:0", "check:unit@base:0", "pack:deploy@head:1", "check:unit@head:0"]);
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
