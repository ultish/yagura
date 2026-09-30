import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { AttemptId, EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { acquireLease, PROVIDERS_IMPL, releaseLease } from "./leases.js";
import { addEnvironment, addProject, addRepo, addUnit, createAttempt, getEnvironment, openStore, setProjectEnvironment, type Db } from "./store.js";

const fakeKubectl = fileURLToPath(new URL("./harness/fixtures/fake-kubectl.mjs", import.meta.url));

let db: Db;
let boot: Bootstrap;
let kube: string;
let attempt: AttemptId;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "yagura-kube-"));
  kube = join(root, "kube");
  mkdirSync(join(kube, "ns"), { recursive: true });
  process.env.FAKE_KUBE_DIR = kube;
  delete process.env.FAKE_KUBE_DOWN;
  boot = { home: join(root, "home"), packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
  db = openStore(":memory:");
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
  attempt = createAttempt(db, unit.id, "claude", null).id;
});

const kubeEnv = (id: string, config: Record<string, unknown>, capacity = 1) =>
  addEnvironment(db, { id, name: id, provider: "kube-namespace", capacity, providerConfig: { kubectl: fakeKubectl, ...config } });
const calls = () => readFileSync(join(kube, "log"), "utf8").trim().split("\n");
const namespaces = () => (existsSync(join(kube, "ns")) ? readdirSync(join(kube, "ns")) : []);

describe("kube-namespace provider", () => {
  it("gives each lease its own labelled namespace, pinned to the context, and deletes it on release", async () => {
    kubeEnv("dev", {});
    const lease = await acquireLease(db, boot, "dev" as EnvironmentId, attempt);
    expect(lease.vars).toMatchObject({ YAGURA_NAMESPACE: `yg-dev-${lease.id}`, KUBECONTEXT: "fake-ctx", YAGURA_LABEL: "yagura=1", YAGURA_SLOT: "slot-1" });
    expect(JSON.parse(readFileSync(join(kube, "ns", `yg-dev-${lease.id}`, "labels.json"), "utf8"))).toEqual({
      yagura: "1",
      "yagura/env": "dev",
      "yagura/lease": String(lease.id),
    });
    await releaseLease(db, boot, lease.id);
    expect(namespaces()).toEqual([]);
    expect(calls().filter((c) => c.includes("delete"))).toEqual([`--context fake-ctx delete namespace yg-dev-${lease.id} --wait=false`]);
  });

  it("refuses to delete a namespace that is not yagura's", async () => {
    const env = kubeEnv("dev", {});
    mkdirSync(join(kube, "ns", "theirs"));
    writeFileSync(join(kube, "ns", "theirs", "labels.json"), JSON.stringify({ team: "a" }));
    await expect(
      PROVIDERS_IMPL["kube-namespace"]!.destroySlot(
        env,
        { id: 1 as never, slot: "slot-1", vars: { YAGURA_NAMESPACE: "theirs", KUBECONTEXT: "fake-ctx" } },
        boot,
      ),
    ).rejects.toThrow("namespace theirs is not labelled yagura=1; yagura leaves it alone");
    expect(namespaces()).toEqual(["theirs"]);
  });

  it("in pool mode, leases a listed namespace and deletes only yagura-labelled resources in it", async () => {
    mkdirSync(join(kube, "ns", "team-a"));
    kubeEnv("shared", { mode: "pool", pool: ["team-a"], context: "shared-ctx", baseUrl: "http://{namespace}.apps.local" });
    const lease = await acquireLease(db, boot, "shared" as EnvironmentId, attempt);
    expect(lease.vars).toMatchObject({ YAGURA_NAMESPACE: "team-a", KUBECONTEXT: "shared-ctx", YAGURA_BASE_URL: "http://team-a.apps.local" });
    await releaseLease(db, boot, lease.id);
    expect(namespaces()).toEqual(["team-a"]);
    expect(calls().at(-1)).toBe("--context shared-ctx delete all,configmap,secret,pvc,ingress -n team-a -l yagura=1 --wait=false --ignore-not-found");
  });

  it("validates settings per provider", () => {
    const kube = PROVIDERS_IMPL["kube-namespace"]!;
    expect(kube.validateConfig({ mode: "pool", pool: [] }, 1)).toBe("config: pool mode needs at least one namespace in pool");
    expect(kube.validateConfig({ mode: "pool", pool: ["a"] }, 2)).toBe("pool mode has 1 namespace(s), so capacity cannot be 2");
    expect(kube.validateConfig({ cluster: "x" }, 1)).toMatch(/Unrecognized key/);
    expect(kube.validateConfig({ context: "rancher-desktop" }, 1)).toBeNull();
    expect(PROVIDERS_IMPL["local-process"]!.validateConfig({ context: "x" }, 1)).toBe("local-process takes no settings (got context)");
  });
});
