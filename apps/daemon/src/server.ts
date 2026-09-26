import { existsSync, readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  answerGate,
  claudeAdapter,
  effectiveSettings,
  findByRef,
  findUnitsByCommit,
  getAttempt,
  getProject,
  getUnit,
  getUnitBySeq,
  layout,
  listDeps,
  listEvidenceRuns,
  listGates,
  listProjects,
  listUnits,
  listAttempts,
  projectRepos,
  readArtifact,
  readiness,
  resolveSetting,
  setAndon,
  setSetting,
  stopAttempt,
  traceUnit,
  type ArtifactId,
  type AttemptId,
  type Bootstrap,
  type Db,
  type HarnessAdapter,
  type ProjectId,
  type SettingScope,
} from "@yagura/core";

export interface ServerOptions {
  db: Db;
  boot: Bootstrap;
  token: string | null;
  adapters?: Record<string, HarnessAdapter>;
  pollMs?: number;
}

type Row = Record<string, unknown>;

function eventsSince(db: Db, since: number, projectId: string | null, limit = 500) {
  return (
    db
      .prepare("SELECT id, ts, type, project_id, unit_id, attempt_id, data_json FROM events WHERE id > ? AND (? IS NULL OR project_id = ?) ORDER BY id LIMIT ?")
      .all(since, projectId, projectId, limit) as Row[]
  ).map((e) => ({ id: e.id, ts: e.ts, type: e.type, projectId: e.project_id, unitId: e.unit_id, attemptId: e.attempt_id, data: JSON.parse(e.data_json as string) }));
}

function readLog(opts: ServerOptions, attemptId: AttemptId, from: number) {
  const attempt = getAttempt(opts.db, attemptId);
  const unit = getUnit(opts.db, attempt.unitId);
  const path = layout(opts.boot).log(unit.projectId, unit.seq, attempt.n);
  const adapter = (opts.adapters ?? { claude: claudeAdapter })[attempt.harness] ?? claudeAdapter;
  if (!existsSync(path)) return { attempt, lines: [] as { line: number; raw: string; events: unknown[] }[], next: from };
  const complete = readFileSync(path, "utf8").split("\n").slice(0, -1);
  const lines = complete.slice(from).map((raw, i) => {
    let events: unknown[] = [];
    try {
      events = adapter.parse(raw);
    } catch {}
    return { line: from + i, raw, events };
  });
  return { attempt, lines, next: from + lines.length };
}

function projectSummary(db: Db, projectId: ProjectId) {
  const project = getProject(db, projectId);
  const units = listUnits(db, projectId);
  const counts: Record<string, number> = {};
  for (const u of units.filter((x) => x.type === "work")) counts[u.state] = (counts[u.state] ?? 0) + 1;
  const running = (db.prepare("SELECT COUNT(*) AS n FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ? AND a.state = 'running'").get(projectId) as { n: number }).n;
  return { project, workCounts: counts, running, openGates: listGates(db, projectId, "open").length };
}

export function createApp(opts: ServerOptions): Hono {
  const { db, boot } = opts;
  const app = new Hono();
  const pollMs = opts.pollMs ?? 500;

  app.use("/api/*", async (c, next) => {
    if (!opts.token) return next();
    const header = c.req.header("authorization");
    const supplied = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
    if (supplied !== opts.token) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.onError((e, c) => c.json({ error: e.message }, /not found/.test(e.message) ? 404 : 400));

  app.get("/api/health", (c) => c.json({ ok: true, home: boot.home }));

  app.get("/api/projects", (c) => c.json(listProjects(db).map((p) => projectSummary(db, p.id))));

  app.get("/api/projects/:id", (c) => {
    const id = c.req.param("id") as ProjectId;
    const r = readiness(db, id);
    return c.json({
      ...projectSummary(db, id),
      repos: projectRepos(db, id),
      units: listUnits(db, id).map((u) => ({ ...u, attempts: listAttempts(db, u.id) })),
      deps: listDeps(db, id),
      gates: listGates(db, id),
      waiting: r.waiting.map((w) => ({ unitId: w.unit.id, reason: w.reason })),
    });
  });

  app.get("/api/projects/:id/units/:seq", (c) => {
    const unit = getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq")));
    return c.json(traceUnit(db, boot, unit));
  });

  app.get("/api/projects/:id/events", (c) => c.json(eventsSince(db, Number(c.req.query("since") ?? 0), c.req.param("id"))));

  app.get("/api/agents", (c) => {
    const rows = db
      .prepare(
        `SELECT a.id FROM attempts a JOIN units u ON u.id = a.unit_id
         WHERE a.state = 'running' OR a.id IN (SELECT id FROM attempts ORDER BY id DESC LIMIT ?) ORDER BY a.id DESC`,
      )
      .all(Number(c.req.query("recent") ?? 50)) as { id: number }[];
    const attempts = rows.map((r) => {
      const a = getAttempt(db, r.id as AttemptId);
      const u = getUnit(db, a.unitId);
      return { ...a, unit: { id: u.id, seq: u.seq, type: u.type, goal: u.goal, projectId: u.projectId, state: u.state } };
    });
    return c.json({
      attempts,
      caps: {
        maxParallelAgents: resolveSetting(db, "max_parallel_agents").value,
        running: attempts.filter((a) => a.state === "running").length,
      },
    });
  });

  app.get("/api/attempts/:id", (c) => {
    const attempt = getAttempt(db, Number(c.req.param("id")) as AttemptId);
    const unit = getUnit(db, attempt.unitId);
    const paths = layout(boot);
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
    return c.json({
      attempt,
      unit,
      brief: read(paths.brief(unit.projectId, unit.seq, attempt.n)),
      handoff: read(paths.handoff(unit.projectId, unit.seq, attempt.n)),
      leftovers: read(paths.leftovers(unit.projectId, unit.seq, attempt.n)),
      runs: listEvidenceRuns(db, attempt.id),
    });
  });

  app.get("/api/attempts/:id/log", (c) => {
    const { lines, next } = readLog(opts, Number(c.req.param("id")) as AttemptId, Number(c.req.query("from") ?? 0));
    return c.json({ lines, next });
  });

  app.post("/api/attempts/:id/stop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const stopped = stopAttempt(db, Number(c.req.param("id")) as AttemptId, body.note ?? null);
    return stopped ? c.json({ stopped }) : c.json({ error: "attempt is not running" }, 409);
  });

  app.get("/api/artifacts/:id", (c) => {
    const data = readArtifact(db, boot, Number(c.req.param("id")) as ArtifactId);
    const text = !data.subarray(0, 4096).includes(0);
    return c.body(new Uint8Array(data), 200, { "content-type": text ? "text/plain; charset=utf-8" : "application/octet-stream" });
  });

  app.get("/api/gates", (c) => c.json(listGates(db, null, (c.req.query("state") as never) ?? undefined)));
  app.post("/api/gates/:id/answer", async (c) => {
    const { answer } = (await c.req.json()) as { answer: string };
    return c.json(answerGate(db, Number(c.req.param("id")), answer));
  });

  app.post("/api/projects/:id/andon", async (c) => {
    const { reason } = (await c.req.json()) as { reason: string | null };
    setAndon(db, c.req.param("id") as ProjectId, reason);
    return c.json(getProject(db, c.req.param("id") as ProjectId));
  });

  app.get("/api/environments", (c) => c.json(db.prepare("SELECT * FROM environments ORDER BY id").all()));
  app.get("/api/repos", (c) => c.json(db.prepare("SELECT * FROM repos ORDER BY id").all()));

  app.get("/api/settings", (c) =>
    c.json(effectiveSettings(db, { projectId: (c.req.query("project") as ProjectId) ?? null, repoId: (c.req.query("repo") as never) ?? null })),
  );
  app.post("/api/settings", async (c) => {
    const b = (await c.req.json()) as { scope: SettingScope; id?: string; key: string; value: unknown };
    setSetting(db, b.scope, b.id ?? "", b.key, b.value);
    return c.json({ ok: true });
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json([]);
    const rows = db
      .prepare("SELECT kind, ref_id, project_id, snippet(search, 0, '[', ']', '…', 12) AS snippet FROM search WHERE search MATCH ? LIMIT 50")
      .all(q.replace(/"/g, '""').split(/\s+/).map((t) => `"${t}"`).join(" ")) as Row[];
    return c.json(rows.map((r) => ({ kind: r.kind, attemptId: Number(r.ref_id), projectId: r.project_id, snippet: r.snippet })));
  });

  app.get("/api/trace/:target", (c) => {
    const target = c.req.param("target");
    const units = findUnitsByCommit(db, target);
    const byRef = units.length ? null : findByRef(db, target);
    return c.json({ projects: byRef?.projects ?? [], units: (units.length ? units : (byRef?.units ?? [])).map((u) => traceUnit(db, boot, u)) });
  });

  app.get("/api/stream", (c: Context) =>
    streamSSE(c, async (stream) => {
      let since = Number(c.req.query("since") ?? c.req.header("last-event-id") ?? 0);
      const projectId = c.req.query("project") ?? null;
      while (!stream.aborted) {
        for (const e of eventsSince(db, since, projectId)) {
          await stream.writeSSE({ id: String(e.id), event: "yagura", data: JSON.stringify(e) });
          since = e.id as number;
        }
        await stream.sleep(pollMs);
      }
    }),
  );

  app.get("/api/attempts/:id/stream", (c: Context) =>
    streamSSE(c, async (stream) => {
      const id = Number(c.req.param("id")) as AttemptId;
      let from = Number(c.req.query("from") ?? 0);
      while (!stream.aborted) {
        const { attempt, lines, next } = readLog(opts, id, from);
        for (const l of lines) await stream.writeSSE({ id: String(l.line), event: "line", data: JSON.stringify(l) });
        from = next;
        if (attempt.state !== "running" && attempt.state !== "queued" && !lines.length) {
          await stream.writeSSE({ event: "end", data: JSON.stringify({ state: attempt.state }) });
          return;
        }
        await stream.sleep(pollMs);
      }
    }),
  );

  return app;
}
