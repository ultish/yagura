import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addDecision,
  addGate,
  addMessage,
  createThread,
  addProject,
  addRepo,
  addUnit,
  commitAll,
  createAttempt,
  git,
  layout,
  openStore,
  putArtifact,
  parseClaudeLine,
  transitionUnit,
  updateAttempt,
  type AttemptId,
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
  it("wakes a stuck unit's unit lead with the developer's note, and says why when it cannot", async () => {
    const url = `/api/projects/${project}/units/1/wake`;
    db.prepare("UPDATE units SET state = 'running' WHERE seq = 1").run();
    const refused = await post(url, { note: "look" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("U1 is running; the unit lead looks at blocked, failed, or rejected units");
    db.prepare("UPDATE units SET state = 'blocked' WHERE seq = 1").run();
    expect((await post(url, { note: "I want emojis" })).status).toBe(200);
    const manager = db.prepare("SELECT context_json FROM units WHERE type = 'manager'").get() as { context_json: string };
    expect(JSON.parse(manager.context_json)).toEqual(["The developer asked you to look at U1 now: I want emojis. Answer what they wrote first.", "asked"]);
    const twice = await post(url, {});
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { error: string }).error).toBe("U1's unit lead is already deciding");
  });

  it("imports, lists, exports, and deletes environment templates, all in the store", async () => {
    const post = (path: string, body: object) =>
      app.request(path, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/templates/import", { yaml: "name: box\nprovider: local-process\ncapacity: 1\n" })).status).toBe(201);
    expect((await post("/api/templates/import", { yaml: "name: Bad\n" })).status).toBe(400);
    expect(((await (await get("/api/templates")).json()) as { name: string }[]).map((t) => t.name)).toEqual(["box"]);
    const exported = await get("/api/templates/box/export");
    expect(exported.headers.get("content-type")).toMatch(/^text\/yaml/);
    expect(await exported.text()).toMatch(/^name: box\n/);
    expect(await (await post("/api/templates/box/delete", {})).json()).toEqual([]);
  });

  it("shows and saves a project's spec, which asks the planner to look again", async () => {
    expect(await (await get(`/api/projects/${project}/spec`)).json()).toEqual({ text: "", updatedBy: null, updatedAt: null });
    const saved = await app.request(`/api/projects/${project}/spec`, {
      method: "PUT",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ text: "# orders\n\n## Goal\n\nship it\n" }),
    });
    expect(await saved.json()).toMatchObject({ text: "# orders\n\n## Goal\n\nship it\n", updatedBy: "developer" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'project.spec_changed'").get()).toEqual({ n: 1 });
  });

  it("shows each role's guidance with where it comes from, and sets and resets a project's", async () => {
    const put = (body: object) =>
      app.request("/api/prompts", {
        method: "PUT",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    type View = {
      roles: { role: string; source: string; project: string | null; notes: string | null; lastAttemptId: number | null }[];
      allNotes: string | null;
    };
    const view = (await (await get(`/api/prompts?project=${project}`)).json()) as View;
    expect(view.roles.map((r) => r.role)).toEqual(["planner", "worker", "verifier", "reviewer", "review-triage", "rebase", "pack", "manager"]);
    expect(view.roles.find((r) => r.role === "worker")).toMatchObject({ source: "default", lastAttemptId: expect.any(Number) });
    const set = (await (
      await put({ scope: "project", projectId: project, role: "planner", kind: "guidance", text: "One unit per feature, with its tests." })
    ).json()) as View;
    expect(set.roles.find((r) => r.role === "planner")).toMatchObject({ source: "project", project: "One unit per feature, with its tests.\n" });
    await put({ scope: "project", projectId: project, role: "all", kind: "notes", text: "Python 3.9 only." });
    const reset = (await (await put({ scope: "project", projectId: project, role: "planner", kind: "guidance", text: null })).json()) as View;
    expect(reset.roles.find((r) => r.role === "planner")!.source).toBe("default");
    expect(reset.allNotes).toBe("Python 3.9 only.\n");
    expect((await put({ scope: "project", projectId: project, role: "watchman", kind: "guidance", text: "x" })).status).toBe(400);
  });

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

  it("tells a unit's story, records a disagreement on it, and refuses one without a reason", async () => {
    const story = (await (await get("/api/projects/orders/units/1/story")).json()) as { unit: { seq: number }; entries: unknown[] };
    expect(story.unit.seq).toBe(1);
    expect(await (await post("/api/projects/orders/units/1/disagreements", { ref: "a1:chose:0", about: "x", reason: " ", action: "note" })).json()).toEqual({
      error: "say why you disagree",
    });
    expect((await post("/api/projects/orders/units/1/disagreements", { ref: "a1:chose:0", about: "x", reason: "r", action: "maybe" })).status).toBe(400);
    const made = await post("/api/projects/orders/units/1/disagreements", {
      ref: "a1:chose:0",
      about: "skipping tests",
      reason: "always add one",
      action: "note",
    });
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ about: "skipping tests", reason: "always add one", action: "note", state: "noted" });
    const after = (await (await get("/api/projects/orders/units/1/story")).json()) as { entries: { who: string; body: string }[] };
    expect(after.entries.at(-1)).toMatchObject({ who: "You disagreed", body: "About skipping tests: always add one" });
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

  it("lists what waits for an answer with each gate's deadline, and what was resolved", async () => {
    const planner = addGate(db, {
      projectId: project,
      kind: "planner",
      question: "SQLite or Postgres?",
      options: ["sqlite", "postgres"],
      defaultOption: "sqlite",
    });
    const inbox = (await (await get("/api/inbox")).json()) as { waiting: { gate?: { id: number; deadline: string | null } }[]; resolved: unknown[] };
    const deadlines = Object.fromEntries(inbox.waiting.filter((w) => w.gate).map((w) => [w.gate!.id, w.gate!.deadline]));
    expect(deadlines[1]).toBeNull();
    expect(Date.parse(deadlines[planner]!) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(inbox.resolved).toEqual([]);
    await post(`/api/gates/${planner}/answer`, { answer: "postgres" });
    expect(((await (await get("/api/inbox")).json()) as { resolved: unknown[] }).resolved).toMatchObject([
      { id: planner, state: "answered", answer: "postgres", kind: "planner", unit: null },
    ]);
  });

  it("serves a run's evidence files as images or plain text only, sandboxed", async () => {
    const attemptId = (db.prepare("SELECT id FROM attempts").get() as { id: number }).id as AttemptId;
    const runId = Number(
      db
        .prepare(
          "INSERT INTO evidence_runs (attempt_id, at, sha, label, command, exit_code, timed_out, tampered, duration_ms, created_at) VALUES (?, 'head', 'abc', 'ui', 'sh s.sh', 0, 0, 0, 12, 't')",
        )
        .run(attemptId).lastInsertRowid,
    );
    const put = (kind: string, label: string, data: string) =>
      putArtifact(db, boot, { projectId: project, attemptId, kind, label, data: Buffer.from(data), evidenceRunId: runId });
    put("stdout", "ui@head stdout", "ok\n");
    put("file", "ui@head shots/home.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const page = put("file", "ui@head report.html", "<script>alert(1)</script>");

    expect(await (await get(`/api/evidence/${runId}`)).json()).toMatchObject({
      run: { id: runId, label: "ui", at: "head", exitCode: 0 },
      artifacts: [
        { kind: "stdout", name: "stdout", contentType: "text/plain; charset=utf-8" },
        { kind: "file", name: "shots/home.svg", contentType: "image/svg+xml" },
        { kind: "file", name: "report.html", contentType: "text/plain; charset=utf-8" },
      ],
    });
    const html = await get(`/api/artifacts/${page}?download=1`);
    expect(
      Object.fromEntries(["content-type", "content-security-policy", "x-content-type-options", "content-disposition"].map((h) => [h, html.headers.get(h)])),
    ).toEqual({
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "content-disposition": 'attachment; filename="report.html"',
    });
    expect(await (await get(`/api/attempts/${attemptId}/diff`)).json()).toEqual({ base: null, head: null, text: null, truncated: false });
  });

  it("registers an existing repo and lists repos with their projects and landing queue", async () => {
    const seed = join(boot.home, "seed");
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "README.md"), "billing\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@localhost" });
    const origin = join(boot.home, "Billing.git");
    await git(["clone", "--quiet", "--bare", seed, origin]);

    expect(await (await get(`/api/repos/suggest-id?source=${encodeURIComponent(origin)}`)).json()).toEqual({ id: "billing" });
    const created = await post("/api/repos", { source: origin });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      repo: { id: "billing", url: origin, defaultBranch: "main" },
      trunk: expect.stringMatching(/^[0-9a-f]{40}$/),
      route: { text: "lands by pushing to main", confirmed: true },
    });
    const unknown = await post("/api/repos", { source: "git@git.example.com:team/x.git" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ needsRoute: true, error: expect.stringMatching(/cannot tell how git@git.example.com:team\/x.git lands/) });
    expect((await post("/api/repos", { source: origin, id: "billing-2" })).status).toBe(409);
    expect(await (await post("/api/repos", { source: join(boot.home, "nowhere") })).json()).toMatchObject({ error: expect.stringMatching(/cannot read/) });

    const repos = (await (await get("/api/repos")).json()) as { repo: { id: string } }[];
    expect(repos.map((r) => r.repo.id)).toEqual(["billing", "testbed"]);
    expect(repos[1]).toMatchObject({ trunk: null, projects: [{ id: "orders", state: "active" }], landingQueue: [], landedCount: 0 });
  });

  it("creates and edits environments and shows who holds and waits for their slots", async () => {
    expect((await post("/api/environments", { id: "dev", provider: "docker-compose", capacity: 2 })).status).toBe(400);
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

  it("edits an environment's values, adds a preset, and saves and applies a template", async () => {
    await post("/api/environments", { id: "box", provider: "local-process", capacity: 1 });
    await post("/api/environments/box/values", { name: "REDIS_URL", value: "redis://hostname:6379", note: "redis from this box" });
    expect(await (await post("/api/environments/box/values", { name: "yagura_x", value: "v" })).json()).toEqual({
      error: "yagura_x: names are UPPER_CASE letters, digits, and _",
    });
    expect(await (await post("/api/environments/box/presets/registry", {})).json()).toEqual({ added: ["REGISTRY_PUSH", "REGISTRY_PULL"], skipped: [] });
    expect(await (await post("/api/environments/box/presets/registry", {})).json()).toEqual({ added: [], skipped: ["REGISTRY_PUSH", "REGISTRY_PULL"] });
    await post("/api/environments/box/notes", { notes: "deps in cluster" });
    await post("/api/environments/box/values/REGISTRY_PULL/delete", {});
    const detail = (await (await get("/api/environments/box")).json()) as {
      values: { name: string; source: string }[];
      environment: { notes: string };
      keep: unknown;
      presets: unknown[];
    };
    expect(detail.values.map((v) => [v.name, v.source])).toEqual([
      ["REDIS_URL", "you"],
      ["REGISTRY_PUSH", "registry"],
    ]);
    expect(detail).toMatchObject({ environment: { notes: "deps in cluster" }, keep: { policy: { value: "never", source: "default" }, hours: { value: 2 } } });
    expect(detail.presets.length).toBeGreaterThan(3);

    expect((await post("/api/environments/box/template", { name: "box-shape", ask: ["REDIS_URL"] })).status).toBe(201);
    expect(((await (await get("/api/templates")).json()) as { template: { name: string } }[]).map((t) => t.template.name)).toEqual(["box-shape"]);
    expect(await (await post("/api/templates/box-shape/apply", { id: "box2" })).json()).toEqual({ error: "template box-shape needs a value for REDIS_URL" });
    const applied = await post("/api/templates/box-shape/apply", { id: "box2", answers: { REDIS_URL: "redis://box2:6379" } });
    expect(applied.status).toBe(201);
    expect(await applied.json()).toMatchObject({ environmentId: "box2" });
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

describe("find API", () => {
  it("finds units, decisions, and messages by words, a unit by its commit, and caps hits per kind for the drop-down", async () => {
    const thread = createThread(db, { title: "orders talk" });
    const said = addMessage(db, { threadId: thread.id, role: "human", body: "please make the discount rounding exact" });
    const reply = addMessage(db, { threadId: thread.id, role: "watchman", body: "Recorded." });
    addDecision(db, { threadId: thread.id, text: "Discounts round half up to the cent", sourceMessageId: reply.id });
    const find = async (q: string, per = 0) =>
      (await (await get(`/api/find?q=${encodeURIComponent(q)}&per=${per}`)).json()) as {
        total: number;
        counts: Record<string, number>;
        hits: { kind: string; ref: string; href: string; text: string }[];
      };
    const r = await find("discount round");
    expect(r.counts).toEqual({ decision: 1, message: 1 });
    expect(r.hits.map((h) => [h.kind, h.href])).toEqual([
      ["decision", `/talk/${thread.id}?m=${reply.id}`],
      ["message", `/talk/${thread.id}?m=${said.id}`],
    ]);
    expect((await find("discount", 1)).hits.length).toBe(2);
    expect((await find("")).total).toBe(0);
    expect((await find("100%_off")).total).toBe(0);
    expect((await find("Implement create")).hits).toEqual([expect.objectContaining({ kind: "unit", ref: "orders/U1", href: "/p/orders/u/1" })]);
    expect((await find("gitlab#7")).hits.map((h) => h.ref)).toEqual(["orders/U1", "orders"]);
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
      adapters: {
        claude: {
          id: "claude",
          canResume: true,
          command: (run) => ({ argv: [process.execPath, fakeAgent, ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
          parse: parseClaudeLine,
        },
      },
    });
    const started = await talkApp.request("/api/threads", { method: "POST", headers: auth, body: JSON.stringify({ message: "prototype a chain" }) });
    expect(started.status).toBe(202);
    const { thread } = (await started.json()) as { thread: { id: number } };
    const again = await talkApp.request(`/api/threads/${thread.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ message: "and?" }) });
    expect(again.status).toBe(202);
    const queued = (await again.json()) as { queued: number[]; messages: { id: number; role: string; body: string }[] };
    expect(queued.messages.map((m) => [m.role, m.body])).toEqual([
      ["human", "prototype a chain"],
      ["human", "and?"],
    ]);
    expect(queued.queued).toEqual([2]);

    let view: {
      busy: boolean;
      messages: { id: number; role: string; body: string }[];
      proposals: { id: number; state: string }[];
      session: { contextPeak: number; rollAt: number } | null;
      sessionStarts: number[];
    };
    do {
      await new Promise((r) => setTimeout(r, 50));
      view = (await (await talkApp.request(`/api/threads/${thread.id}`, { headers: auth })).json()) as typeof view;
    } while (view.busy);
    expect(view.messages.map((m) => m.role)).toEqual(["human", "human", "watchman", "watchman"]);
    expect(view.proposals.map((p) => p.state)).toEqual(["pending"]);
    expect(readFileSync(layout(boot).turnBrief(thread.id, 2), "utf8")).toContain("and?");
    const calls = (await (await talkApp.request(`/api/messages/${view.messages[1]!.id}/calls`, { headers: auth })).json()) as {
      calls: { name: string; outcome: string }[];
      running: boolean;
    };
    expect(calls.running).toBe(false);
    expect(calls.calls.every((c) => c.outcome === "ok")).toBe(true);
    expect((await (await talkApp.request(`/api/threads/${thread.id}/live-calls`, { headers: auth })).json()) as { running: boolean }).toEqual({
      calls: [],
      running: false,
    });

    const applied = await talkApp.request(`/api/proposals/${view.proposals[0]!.id}/apply`, { method: "POST", headers: auth });
    expect(((await applied.json()) as { result: { projects: string[] } }).result.projects).toEqual(["proto-a", "proto-b"]);
    const found = (await (await talkApp.request("/api/search?q=prototype", { headers: auth })).json()) as { kind: string; messageId?: number }[];
    expect(found).toEqual([expect.objectContaining({ kind: "message", messageId: 1 })]);

    expect(view.session).toMatchObject({ rollAt: 150000 });
    expect(view.sessionStarts).toEqual([1]);
    const cleared = await talkApp.request(`/api/threads/${thread.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ message: "/clear" }) });
    expect(cleared.status).toBe(200);
    view = (await cleared.json()) as typeof view;
    expect(view.session).toBeNull();
    expect(view.messages.at(-1)).toMatchObject({ role: "system", body: expect.stringMatching(/^New session/) });
    expect(view.messages.filter((m) => m.role === "human").map((m) => m.body)).toEqual(["prototype a chain", "and?"]);
    expect((await talkApp.request(`/api/threads/${thread.id}/clear`, { method: "POST", headers: auth })).status).toBe(200);
  });
});
