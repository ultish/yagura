import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addGate,
  addProject,
  addRepo,
  addUnit,
  commitAll,
  createAttempt,
  git,
  layout,
  openStore,
  parseClaudeLine,
  transitionUnit,
  updateAttempt,
  type Bootstrap,
  type Db,
  type ProjectId,
  type RepoId,
} from "@yagura/core";
import { createApp } from "./server.js";

let db: Db;
let boot: Bootstrap;
let app: ReturnType<typeof createApp>;
const project = "orders" as ProjectId;

beforeEach(() => {
  boot = { home: mkdtempSync(join(tmpdir(), "yagura-api-")), packsDir: "", skillsDir: "", bind: "0.0.0.0", port: 0, tokenFile: "" };
  db = openStore(layout(boot).db);
  addRepo(db, { id: "testbed", url: "file:///tb", defaultBranch: "main" });
  addProject(db, {
    id: project,
    name: "Orders",
    goal: "ship it",
    predicate: "done",
    minTier: "unit-verified",
    repos: ["testbed" as RepoId],
    refs: ["gitlab#7"],
  });
  const unit = addUnit(db, {
    projectId: project,
    type: "work",
    repoId: "testbed" as RepoId,
    goal: "Implement create",
    writeScope: ["app/**"],
    acceptance: ["a"],
    verify: "v",
    timeboxSeconds: 60,
    maxAttempts: 2,
  });
  transitionUnit(db, unit.id, "ready");
  transitionUnit(db, unit.id, "running");
  const attempt = createAttempt(db, unit.id, "claude", null);
  updateAttempt(db, attempt.id, { state: "running", pid: 999999 });
  const log = layout(boot).log(project, unit.seq, attempt.n);
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(
    log,
    [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m", plugins: [] }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reading the store" }] } }),
      "",
    ].join("\n"),
  );
  addGate(db, { projectId: project, unitId: unit.id, kind: "land", question: "Land U1?", options: ["land", "hold"], defaultOption: "hold" });
  db.prepare("INSERT INTO search (body, kind, ref_id, project_id) VALUES ('touched PaymentService retry path', 'handoff', ?, ?)").run(attempt.id, project);
  app = createApp({ db, boot, token: "secret", pollMs: 10 });
});

const get = (path: string) => app.request(path, { headers: { authorization: "Bearer secret" } });
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify(body) });

describe("daemon API", () => {
  it("requires the token when bound beyond localhost, by header or query", async () => {
    expect((await app.request("/api/projects")).status).toBe(401);
    expect((await app.request("/api/projects?token=secret")).status).toBe(200);
    expect((await get("/api/health")).status).toBe(200);
  });

  it("summarizes projects and returns a project's units with their attempts", async () => {
    expect(await (await get("/api/projects")).json()).toMatchObject([{ project: { id: "orders" }, workCounts: { running: 1 }, running: 1, openGates: 1 }]);
    const detail = (await (await get("/api/projects/orders")).json()) as { units: { seq: number; attempts: unknown[] }[] };
    expect(detail.units).toMatchObject([{ seq: 1, state: "running", attempts: [{ n: 1, state: "running" }] }]);
    expect((await get("/api/projects/nope")).status).toBe(404);
  });

  it("lists running agents against the cap", async () => {
    expect(await (await get("/api/agents")).json()).toMatchObject({
      attempts: [{ state: "running", unit: { seq: 1, goal: "Implement create" } }],
      caps: { maxParallelAgents: 4, running: 1 },
    });
  });

  it("returns an agent's log as parsed events, resumable by line", async () => {
    const log = (await (await get("/api/attempts/1/log")).json()) as { lines: { events: { kind: string }[] }[]; next: number };
    expect(log.next).toBe(2);
    expect(log.lines.map((l) => l.events[0]!.kind)).toEqual(["session", "text"]);
    expect(((await (await get("/api/attempts/1/log?from=2")).json()) as { lines: unknown[] }).lines).toEqual([]);
  });

  it("stops a running agent and refuses to stop one that is not running", async () => {
    expect(await (await post("/api/attempts/1/stop", { note: "wrong file" })).json()).toEqual({ stopped: true });
    const again = await post("/api/attempts/1/stop", {});
    expect(again.status).toBe(200);
    updateAttempt(db, 1 as never, { state: "stopped" });
    expect((await post("/api/attempts/1/stop", {})).status).toBe(409);
  });

  it("answers gates, raises andon, and changes settings", async () => {
    expect(await (await post("/api/gates/1/answer", { answer: "land" })).json()).toMatchObject({ state: "answered", answer: "land" });
    expect((await post("/api/gates/1/answer", { answer: "land" })).status).toBe(400);
    expect(await (await post("/api/projects/orders/andon", { reason: "bad deploy" })).json()).toMatchObject({ andonReason: "bad deploy" });
    await post("/api/settings", { scope: "project", id: "orders", key: "project.max_in_flight", value: 1 });
    expect(await (await get("/api/settings?project=orders")).json()).toMatchObject({ "project.max_in_flight": { value: 1, source: "project" } });
  });

  it("registers an existing repo and lists repos with their pack, projects, and landing queue", async () => {
    const seed = join(boot.home, "seed");
    mkdirSync(join(seed, ".agents/verify"), { recursive: true });
    writeFileSync(
      join(seed, ".agents/verify/verify.json"),
      JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] }),
    );
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@localhost" });
    const origin = join(boot.home, "Billing.git");
    await git(["clone", "--quiet", "--bare", seed, origin]);

    expect(await (await get(`/api/repos/suggest-id?source=${encodeURIComponent(origin)}`)).json()).toEqual({ id: "billing" });
    const created = await post("/api/repos", { source: origin });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      repo: { id: "billing", url: origin, defaultBranch: "main", packStatus: "unproven" },
      pack: { ok: true, checks: [{ name: "unit", tier: "unit-verified" }] },
      trunk: expect.stringMatching(/^[0-9a-f]{40}$/),
      notes: [],
    });
    expect((await post("/api/repos", { source: origin, id: "billing-2" })).status).toBe(409);
    expect(await (await post("/api/repos", { source: join(boot.home, "nowhere") })).json()).toMatchObject({ error: expect.stringMatching(/cannot read/) });

    const repos = (await (await get("/api/repos")).json()) as { repo: { id: string } }[];
    expect(repos.map((r) => r.repo.id)).toEqual(["billing", "testbed"]);
    expect(repos[1]).toMatchObject({ trunk: null, pack: null, projects: [{ id: "orders", state: "active" }], landingQueue: [], landedCount: 0 });
  });

  it("creates and edits environments and shows who holds and waits for their slots", async () => {
    expect((await post("/api/environments", { id: "dev", provider: "kube-namespace", capacity: 2 })).status).toBe(400);
    expect(await (await post("/api/environments", { id: "dev", provider: "local-process", capacity: -1 })).json()).toEqual({
      error: "capacity must be a whole number, 0 or more",
    });
    const created = await post("/api/environments", { id: "dev", provider: "local-process", capacity: 1 });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ environment: { id: "dev", name: "dev", capacity: 1 }, implemented: true, active: [], queued: [] });
    expect((await post("/api/environments", { id: "dev", provider: "local-process", capacity: 1 })).status).toBe(409);

    const attemptId = (db.prepare("SELECT id FROM attempts").get() as { id: number }).id;
    db.prepare("INSERT INTO leases (environment_id, attempt_id, slot, state, requested_at, granted_at) VALUES ('dev', ?, 'slot-1', 'active', 't1', 't2')").run(
      attemptId,
    );
    db.prepare("INSERT INTO leases (environment_id, attempt_id, state, requested_at) VALUES ('dev', ?, 'queued', 't3')").run(attemptId);
    db.prepare("UPDATE projects SET environment_id = 'dev' WHERE id = 'orders'").run();
    const unit = { projectId: "orders", seq: 1, type: "work", goal: "Implement create" };
    expect(await (await post("/api/environments/dev", { name: "Dev box", capacity: 3 })).json()).toMatchObject({
      environment: { name: "Dev box", capacity: 3 },
      active: [{ attemptId, slot: "slot-1", since: "t2", unit }],
      queued: [{ attemptId, since: "t3", unit }],
      projects: [{ id: "orders", state: "active" }],
    });
    expect(await (await post("/api/environments/dev", { capacity: 1.5 })).json()).toEqual({ error: "capacity must be a whole number, 0 or more" });
    expect((await (await get("/api/environments")).json()) as unknown[]).toHaveLength(1);
  });

  it("describes settings with live cap counts, and clears, exports, and imports them", async () => {
    await post("/api/settings", { scope: "global", key: "max_parallel_agents", value: 6 });
    const overview = (await (await get("/api/settings/overview")).json()) as { settings: { key: string }[]; caps: unknown };
    expect(overview.settings.find((s) => s.key === "max_parallel_agents")).toMatchObject({ value: 6, source: "global", default: 4 });
    expect(overview.caps).toEqual({
      max_parallel_agents: { running: 1, limit: 6 },
      max_parallel_per_harness: { limit: 4, byHarness: { claude: 1 } },
      "project.max_in_flight": [{ id: "orders", running: 1, limit: 3 }],
    });
    const exported = await get("/api/settings/export");
    expect(exported.headers.get("content-type")).toMatch(/yaml/);
    expect(await exported.text()).toBe("global:\n  max_parallel_agents: 6\n");
    expect(await (await post("/api/settings/clear", { scope: "global", key: "max_parallel_agents" })).json()).toEqual({ cleared: true });
    expect(await (await post("/api/settings/import", { yaml: "global:\n  max_attempts: 0\n" })).json()).toEqual({
      error: "global.max_attempts: Number must be greater than 0",
    });
    expect(await (await post("/api/settings/import", { yaml: "global:\n  max_attempts: 4\n" })).json()).toEqual({ applied: 1 });
    expect(await (await post("/api/settings", { scope: "global", key: "max_attempts", value: "lots" })).json()).toEqual({
      error: "Expected number, received string",
    });

    expect(await (await post("/api/settings", { scope: "repo", id: "testbed", key: "timebox.plan_seconds", value: 60 })).json()).toEqual({
      error: "timebox.plan_seconds cannot be set per repo; it can be set globally or per project",
    });
    await post("/api/settings", { scope: "repo", id: "testbed", key: "max_attempts", value: 5 });
    const repo = (await (await get("/api/settings/overview?scope=repo&id=testbed")).json()) as { settings: { key: string; value: unknown; source: string }[] };
    expect(repo.settings.find((s) => s.key === "max_attempts")).toMatchObject({ value: 5, source: "repo" });
    expect(repo.settings.find((s) => s.key === "timebox.work_seconds")).toMatchObject({ source: "default" });
    expect(repo.settings.some((s) => s.key === "timebox.plan_seconds")).toBe(false);
  });

  it("searches handoffs and traces issue refs", async () => {
    expect(await (await get("/api/search?q=PaymentService")).json()).toMatchObject([{ kind: "handoff", attemptId: 1, projectId: "orders" }]);
    expect(await (await get("/api/trace/gitlab%237")).json()).toMatchObject({ projects: [{ id: "orders" }], units: [{ unit: { seq: 1 } }] });
  });

  it("streams events as they happen", async () => {
    const res = await get("/api/stream?since=0");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("gate.opened")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toMatch(/event: yagura\ndata: .*"type":"project.created"/);
  });
});

describe("watchman API", () => {
  const fakeAgent = new URL("../../../packages/core/src/harness/fixtures/fake-agent.mjs", import.meta.url).pathname;
  const auth = { authorization: "Bearer secret", "content-type": "application/json" };

  it("starts a thread, answers it through the watchman, and applies the proposal on Go", async () => {
    process.env.FAKE_MODE = "engine";
    const talkApp = createApp({
      db,
      boot,
      token: "secret",
      adapters: { claude: { id: "claude", command: (run) => ({ argv: [process.execPath, fakeAgent], stdin: run.prompt }), parse: parseClaudeLine } },
    });
    const started = await talkApp.request("/api/threads", { method: "POST", headers: auth, body: JSON.stringify({ message: "prototype a chain" }) });
    expect(started.status).toBe(202);
    const { thread } = (await started.json()) as { thread: { id: number } };
    const again = await talkApp.request(`/api/threads/${thread.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ message: "and?" }) });
    expect(again.status).toBe(409);

    let view: { busy: boolean; messages: { role: string; body: string }[]; proposals: { id: number; state: string }[] };
    do {
      await new Promise((r) => setTimeout(r, 50));
      view = (await (await talkApp.request(`/api/threads/${thread.id}`, { headers: auth })).json()) as typeof view;
    } while (view.busy);
    expect(view.messages.map((m) => m.role)).toEqual(["human", "watchman"]);
    expect(view.proposals.map((p) => p.state)).toEqual(["pending"]);

    const applied = await talkApp.request(`/api/proposals/${view.proposals[0]!.id}/apply`, { method: "POST", headers: auth });
    expect(((await applied.json()) as { result: { projects: string[] } }).result.projects).toEqual(["proto-a", "proto-b"]);
    const found = (await (await talkApp.request("/api/search?q=prototype", { headers: auth })).json()) as { kind: string; messageId?: number }[];
    expect(found).toEqual([expect.objectContaining({ kind: "message", messageId: 1 })]);
  });
});
