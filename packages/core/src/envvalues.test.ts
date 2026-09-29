import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveSetting, setSetting, type Bootstrap } from "./config.js";
import type { AttemptId, EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { deleteValue, hardCodedValues, listValues, setEnvironmentNotes, setValue, suggestCheck, valueMap } from "./envvalues.js";
import { acquireLease, doctorEnvironment, releaseLease } from "./leases.js";
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
    setValue(db, dev, { name: "REDIS_URL", value: "redis://hostname:6379", check: "  " });
    setValue(db, dev, { name: "REGISTRY_PUSH", value: "localhost:5001", note: "push here" });
    setValue(db, dev, { name: "REGISTRY", value: "localhost:5001", replaces: "REGISTRY_PUSH" });
    expect(listValues(db, dev).map((v) => [v.name, v.value, v.note, v.check, v.source])).toEqual([
      ["REGISTRY", "localhost:5001", "", null, "you"],
      ["REDIS_URL", "redis://hostname:6379", "", null, "you"],
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

  it("suggests a check from the value's shape only, and none when it cannot tell", () => {
    expect(
      [
        ["REDIS_URL", "redis://hostname:6379"],
        ["API", "https://api.internal/health"],
        ["KAFKA", "hostname:30092"],
        ["DB", "postgres://u@db:5432/app"],
        ["PROFILE", "dev"],
      ].map(([n, v]) => suggestCheck(n!, v!)),
    ).toEqual(['redis-cli -u "$REDIS_URL" ping', 'curl -sf -o /dev/null "$API"', "nc -z -w 5 hostname 30092", 'pg_isready -d "$DB"', null]);
  });

  it("finds values written literally into added lines, except in allowed files and for short values", () => {
    const added = [
      { path: "skaffold.yaml", line: "  defaultRepo: localhost:5000" },
      { path: "charts/app/values.yaml", line: "image: hostname:5000/app" },
      { path: "README.md", line: "push to localhost:5000" },
      { path: "src/app.kt", line: 'val profile = "dev"' },
    ];
    const values = { REGISTRY_PUSH: "localhost:5000", REGISTRY_PULL: "hostname:5000", PROFILE: "dev" };
    expect(hardCodedValues(added, values, ["**/*.md"])).toEqual([
      { name: "REGISTRY_PUSH", value: "localhost:5000", path: "skaffold.yaml" },
      { name: "REGISTRY_PULL", value: "hostname:5000", path: "charts/app/values.yaml" },
    ]);
  });
});

describe("value checks in the doctor", () => {
  it("runs each value's check with every value set, keeps the result, and fails the doctor on a failing one", async () => {
    setValue(db, dev, { name: "GREETING", value: "hello there", check: 'test "$GREETING" = "hello there" && echo matched' });
    setValue(db, dev, { name: "MISSING_FILE", value: "/nonexistent/yagura", check: 'test -e "$MISSING_FILE"' });
    setValue(db, dev, { name: "PLAIN", value: "no check here" });
    const result = await doctorEnvironment(db, boot, dev);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => c.name.startsWith("value ")).map((c) => [c.name, c.ok, c.detail])).toEqual([
      ["value GREETING", true, "matched"],
      ["value MISSING_FILE", false, "exit 1"],
    ]);
    expect(listValues(db, dev).map((v) => [v.name, v.last?.ok ?? null])).toEqual([
      ["GREETING", true],
      ["MISSING_FILE", false],
      ["PLAIN", null],
    ]);
    expect(getEnvironment(db, dev).doctorStatus).toBe("failing");
  });

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
    setValue(db, dev, { name: "REGISTRY_PUSH", value: "localhost:5000", note: "push here", check: "true" });
    setValue(db, dev, { name: "REGISTRY_PULL", value: "devbox:5000", note: "the cluster pulls here" });
    setEnvironmentNotes(db, dev, "deps run in the cluster");
    setSetting(db, "environment", "dev", "lease.keep", "failed");
    const { path } = saveTemplate(db, boot, dev, { name: "spring-kube", description: "my dev box", ask: ["REGISTRY_PULL"] });
    expect(path).toBe(join(templatesDir(boot), "spring-kube.yaml"));
    expect(readFileSync(path, "utf8")).toContain("ask: true");

    await expect(applyTemplate({ db, boot }, "spring-kube", { id: "vm2" })).rejects.toThrow("template spring-kube needs a value for REGISTRY_PULL");
    const applied = await applyTemplate({ db, boot }, "spring-kube", { id: "vm2", answers: { REGISTRY_PULL: "vm2.internal:5000" } });
    expect(applied).toEqual({ ok: true, environmentId: "vm2" });
    const vm2 = "vm2" as EnvironmentId;
    expect(listValues(db, vm2).map((v) => [v.name, v.value, v.note, v.check, v.source])).toEqual([
      ["REGISTRY_PUSH", "localhost:5000", "push here", "true", "template spring-kube"],
      ["REGISTRY_PULL", "vm2.internal:5000", "the cluster pulls here", null, "template spring-kube"],
    ]);
    expect(getEnvironment(db, vm2)).toMatchObject({ notes: "deps run in the cluster", doctorStatus: "passing" });
    expect(resolveSetting(db, "lease.keep", { environmentId: vm2 })).toEqual({ value: "failed", source: "environment" });
    await expect(applyTemplate({ db, boot }, "spring-kube", { id: "vm2", answers: { REGISTRY_PULL: "x:1" } })).rejects.toThrow(
      "environment vm2 already exists",
    );
    await expect(applyTemplate({ db, boot }, "nope", { id: "vm3" })).rejects.toThrow(/no template named nope/);
  });
});
