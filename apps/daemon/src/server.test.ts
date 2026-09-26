import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addGate,
  addProject,
  addRepo,
  addUnit,
  createAttempt,
  layout,
  openStore,
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
  addProject(db, { id: project, name: "Orders", goal: "ship it", predicate: "done", minTier: "unit-verified", repos: ["testbed" as RepoId], refs: ["gitlab#7"] });
  const unit = addUnit(db, { projectId: project, type: "work", repoId: "testbed" as RepoId, goal: "Implement create", writeScope: ["app/**"], acceptance: ["a"], verify: "v", timeboxSeconds: 60, maxAttempts: 2 });
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
    expect(await (await get("/api/agents")).json()).toMatchObject({ attempts: [{ state: "running", unit: { seq: 1, goal: "Implement create" } }], caps: { maxParallelAgents: 4, running: 1 } });
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
