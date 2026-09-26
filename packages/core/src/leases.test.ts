import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { acquireLease, activeLease, reapLeases, releaseLease } from "./leases.js";
import { loadPack, missingSkills } from "./pack.js";
import { addEnvironment, addProject, addRepo, addUnit, createAttempt, openStore, updateAttempt, type Db } from "./store.js";
import { writeFileSync, mkdirSync } from "node:fs";

let db: Db;
let boot: Bootstrap;
const env = "local" as EnvironmentId;

beforeEach(() => {
  boot = { home: mkdtempSync(join(tmpdir(), "yagura-lease-")), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
  db = openStore(":memory:");
  addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
  addProject(db, { id: "p", name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["r" as RepoId] });
  addEnvironment(db, { id: env, name: "local", provider: "local-process", capacity: 2 });
});

function attempt() {
  const u = addUnit(db, {
    projectId: "p" as ProjectId,
    type: "work",
    repoId: "r" as RepoId,
    goal: "g",
    writeScope: ["**"],
    acceptance: ["a"],
    verify: "v",
    timeboxSeconds: 60,
    maxAttempts: 1,
  });
  const a = createAttempt(db, u.id, "claude", null);
  updateAttempt(db, a.id, { state: "running" });
  return a;
}

describe("leases", () => {
  it("grants distinct slots with a private dir and port, up to capacity", async () => {
    const [a, b] = [attempt(), attempt()];
    const la = await acquireLease(db, boot, env, a.id);
    const lb = await acquireLease(db, boot, env, b.id);
    expect([la.slot, lb.slot]).toEqual(["slot-1", "slot-2"]);
    expect(existsSync(la.vars.YAGURA_LEASE_DIR!)).toBe(true);
    expect(la.vars.YAGURA_PORT).not.toBe(lb.vars.YAGURA_PORT);
    expect(activeLease(db, a.id)?.id).toBe(la.id);
  });

  it("queues past capacity and grants the freed slot when one is released", async () => {
    const [a, b, c] = [attempt(), attempt(), attempt()];
    const la = await acquireLease(db, boot, env, a.id);
    await acquireLease(db, boot, env, b.id);
    const waiting = acquireLease(db, boot, env, c.id, { pollMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    expect(db.prepare("SELECT state FROM leases WHERE attempt_id = ?").get(c.id)).toEqual({ state: "queued" });
    await releaseLease(db, boot, la.id);
    expect(existsSync(la.vars.YAGURA_LEASE_DIR!)).toBe(false);
    expect((await waiting).slot).toBe("slot-1");
  });

  it("gives up waiting after the deadline", async () => {
    const [a, b, c] = [attempt(), attempt(), attempt()];
    await acquireLease(db, boot, env, a.id);
    await acquireLease(db, boot, env, b.id);
    await expect(acquireLease(db, boot, env, c.id, { waitMs: 50, pollMs: 10 })).rejects.toThrow(/timed out/);
  });

  it("reaps leases whose attempt is no longer running", async () => {
    const [a, b] = [attempt(), attempt()];
    const la = await acquireLease(db, boot, env, a.id);
    await acquireLease(db, boot, env, b.id);
    updateAttempt(db, a.id, { state: "failed" });
    expect(await reapLeases(db, boot)).toBe(1);
    expect(db.prepare("SELECT state FROM leases WHERE id = ?").get(la.id)).toEqual({ state: "reaped" });
    expect(activeLease(db, b.id)).not.toBeNull();
  });
});

describe("verify pack", () => {
  it("loads a valid pack and reports why an invalid one fails", () => {
    const wt = mkdtempSync(join(tmpdir(), "yagura-pack-"));
    expect(loadPack(wt, ".agents/verify")).toEqual({ ok: false, reason: "no verify pack at .agents/verify/verify.json" });
    mkdirSync(join(wt, ".agents/verify"), { recursive: true });
    writeFileSync(join(wt, ".agents/verify/verify.json"), JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "make test", tier: "unit-verified" }] }));
    expect(loadPack(wt, ".agents/verify")).toMatchObject({ ok: true, pack: { checks: [{ name: "unit", timeoutSeconds: 300 }], protected: [] } });
    writeFileSync(join(wt, ".agents/verify/verify.json"), JSON.stringify({ provider: "k8s", checks: [] }));
    const bad = loadPack(wt, ".agents/verify");
    expect(bad.ok === false && bad.reason).toMatch(/provider.*checks/s);
  });

  it("reports required skills a role did not load", () => {
    expect(missingSkills("worker", ["yagura:yagura-worker"])).toEqual(["pstack:poteto-mode"]);
    expect(missingSkills("worker", ["yagura-worker", "pstack:poteto-mode"])).toEqual([]);
    expect(missingSkills("planner", [])).toEqual([]);
  });
});
