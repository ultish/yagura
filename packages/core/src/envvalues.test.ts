import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveSetting, setSetting, type Bootstrap } from "./config.js";
import type { AttemptId, EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { deleteValue, listValues, setEnvironmentNotes, setValue, valueMap } from "./envvalues.js";
import { acquireLease, releaseLease } from "./leases.js";
import { addEnvironment, addProject, addRepo, addUnit, createAttempt, getEnvironment, openStore, type Db } from "./store.js";
import { applyTemplate, saveTemplate, templatesDir } from "./templates.js";

let db: Db;
let boot: Bootstrap;
const dev = "dev" as EnvironmentId;

beforeEach(() => {
  boot = { home: mkdtempSync(join(tmpdir(), "yagura-values-")), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
  db = openStore(":memory:");
  addEnvironment(db, { id: "dev", name: "dev", provider: "local-process", capacity: 1 });
});

describe("environment values", () => {
  it("adds, edits in place, renames keeping the position, and deletes values", () => {
    setValue(db, dev, { name: "REGISTRY_PUSH", value: "localhost:5000", note: "push here" });
    setValue(db, dev, { name: "REDIS_URL", value: "redis://hostname:6379" });
    setValue(db, dev, { name: "REGISTRY_PUSH", value: "localhost:5001", note: "push here" });
    setValue(db, dev, { name: "REGISTRY", value: "localhost:5001", replaces: "REGISTRY_PUSH" });
    expect(listValues(db, dev).map((v) => [v.name, v.value, v.note, v.source])).toEqual([
      ["REGISTRY", "localhost:5001", "", "you"],
      ["REDIS_URL", "redis://hostname:6379", "", "you"],
    ]);
    expect(() => setValue(db, dev, { name: "REDIS_URL", value: "x", replaces: "REGISTRY" })).toThrow("REDIS_URL already exists in dev");
    expect(deleteValue(db, dev, "REGISTRY")).toBe(true);
    expect(valueMap(db, dev)).toEqual({ REDIS_URL: "redis://hostname:6379" });
  });

  it("refuses names yagura sets itself and names that are not UPPER_CASE", () => {
    expect(() => setValue(db, dev, { name: "YAGURA_NAMESPACE", value: "x" })).toThrow("YAGURA_NAMESPACE is set by yagura; choose another name");
    expect(() => setValue(db, dev, { name: "KUBECONTEXT", value: "x" })).toThrow("KUBECONTEXT is set by yagura");
    expect(() => setValue(db, dev, { name: "redis-url", value: "x" })).toThrow("redis-url: names are UPPER_CASE letters, digits, and _");
  });
});

describe("values in a slot", () => {
  it("hands every value to the slot as a variable, under yagura's own", async () => {
    setValue(db, dev, { name: "REGISTRY_PUSH", value: "localhost:5000" });
    addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
    addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["r" as RepoId] });
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      writeScope: [],
      acceptance: [],
      verify: "v",
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    const lease = await acquireLease(db, boot, dev, createAttempt(db, unit.id, "claude", null).id as AttemptId);
    expect(lease.vars).toMatchObject({ REGISTRY_PUSH: "localhost:5000", YAGURA_SLOT: "slot-1" });
    await releaseLease(db, boot, lease.id);
  });
});

describe("environment templates", () => {
  it("saves values, notes, and the keep policy, and applies them on another machine asking only for its own values", async () => {
    setValue(db, dev, { name: "REGISTRY_PUSH", value: "localhost:5000", note: "push here" });
    setValue(db, dev, { name: "REGISTRY_PULL", value: "devbox:5000", note: "the cluster pulls here" });
    setEnvironmentNotes(db, dev, "deps run in the cluster");
    setSetting(db, "environment", "dev", "lease.keep", "failed");
    const { path } = saveTemplate(db, boot, dev, { name: "spring-kube", description: "my dev box", ask: ["REGISTRY_PULL"] });
    expect(path).toBe(join(templatesDir(boot), "spring-kube.yaml"));
    expect(readFileSync(path, "utf8")).toContain("ask: true");

    await expect(applyTemplate({ db, boot }, "spring-kube", { id: "vm2" })).rejects.toThrow("template spring-kube needs a value for REGISTRY_PULL");
    const applied = await applyTemplate({ db, boot }, "spring-kube", { id: "vm2", answers: { REGISTRY_PULL: "vm2.internal:5000" } });
    expect(applied).toEqual({ environmentId: "vm2" });
    const vm2 = "vm2" as EnvironmentId;
    expect(listValues(db, vm2).map((v) => [v.name, v.value, v.note, v.source])).toEqual([
      ["REGISTRY_PUSH", "localhost:5000", "push here", "template spring-kube"],
      ["REGISTRY_PULL", "vm2.internal:5000", "the cluster pulls here", "template spring-kube"],
    ]);
    expect(getEnvironment(db, vm2)).toMatchObject({ notes: "deps run in the cluster" });
    expect(resolveSetting(db, "lease.keep", { environmentId: vm2 })).toEqual({ value: "failed", source: "environment" });
    await expect(applyTemplate({ db, boot }, "spring-kube", { id: "vm2", answers: { REGISTRY_PULL: "x:1" } })).rejects.toThrow(
      "environment vm2 already exists",
    );
    await expect(applyTemplate({ db, boot }, "nope", { id: "vm3" })).rejects.toThrow(/no template named nope/);
  });
});
