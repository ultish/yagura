import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { acquireLease, activeLease, reapLeases, releaseLease, setProviderConfig } from "./leases.js";
import { missingSkills } from "./skills.js";
import { addEnvironment, addProject, addRepo, addUnit, createAttempt, openStore, updateAttempt, type Db } from "./store.js";

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

describe("required skills", () => {
  it("reports required skills a role did not load", () => {
    expect(missingSkills("worker", ["yagura:yagura-worker"])).toEqual([
      "pstack:poteto-mode",
      "pstack:principle-prove-it-works",
      "pstack:principle-test-behavior-not-implementation",
    ]);
    expect(missingSkills("worker", ["yagura-worker", "poteto-mode", "principle-prove-it-works", "principle-test-behavior-not-implementation"])).toEqual([]);
    expect(missingSkills("planner", [])).toEqual(["yagura:yagura-planner"]);
    expect(missingSkills("ci-fix", [])).toEqual([]);
  });
});

describe("editing an environment's provider settings", () => {
  it("saves a valid change, refuses an invalid one, and refuses any while a slot is in use", async () => {
    const kube = addEnvironment(db, { id: "kube", name: "kube", provider: "kube-namespace", capacity: 1, providerConfig: { context: "old" } });
    expect(setProviderConfig(db, kube.id, { context: "rancher-desktop", mode: "pool", pool: ["ns-a"] }).providerConfig).toEqual({
      context: "rancher-desktop",
      mode: "pool",
      pool: ["ns-a"],
    });
    expect(() => setProviderConfig(db, kube.id, { mode: "pool", pool: [] })).toThrow(/pool mode needs at least one namespace/);
    const a = attempt();
    await acquireLease(db, boot, env, a.id);
    expect(() => setProviderConfig(db, env, {})).toThrow(/has 1 slot\(s\) in use, queued, or kept/);
  });
});
