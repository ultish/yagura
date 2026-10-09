import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  askLead,
  addUnitNote,
  deleteTemplate,
  exportTemplate,
  importTemplate,
  setProviderConfig,
  getSpec,
  recordEvent,
  writeSpec,
  PROMPT_ROLES,
  defaultGuidance,
  effectiveGuidance,
  getPromptText,
  setPromptText,
  type PromptRole,
  getMessage,
  readTurnCalls,
  bumpMaxAttempts,
  logTimesPath,
  threadsForProject,
  transitionUnit,
  messagesMentioning,
  suggestMentions,
  addMessage,
  applyProposal,
  createThread,
  discardProposal,
  getProposal,
  getThread,
  listDecisions,
  listMessages,
  listProposals,
  listQuestions,
  listThreads,
  runWatchmanTurn,
  runQueuedTurns,
  queueMessage,
  queuedMessages,
  clearWatchmanSession,
  currentSession,
  sessionStarts,
  searchMessages,
  setThreadAutonomy,
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
  addSteer,
  listSteers,
  SteerRefused,
  RouteNeeded,
  find,
  excerpt,
  proposalRoutes,
  traceUnit,
  type ArtifactId,
  type AttemptId,
  type Bootstrap,
  type Db,
  type HarnessAdapter,
  type ProjectId,
  type RepoId,
  type SettingScope,
  registerRepo,
  RepoUnusable,
  applyTemplate,
  runningTurn,
  stopTurn,
  TurnBusy,
  listTurns,
  deleteEnvironment,
  projectSkillChecks,
  ENVIRONMENT_ID,
  deleteKept,
  deleteValue,
  listTemplates,
  applyPreset,
  PRESETS,
  saveTemplate,
  setEnvironmentNotes,
  setValue,
  artifactContentType,
  artifactName,
  getEvidenceRun,
  runArtifacts,
  addEnvironment,
  clearSetting,
  describeSettings,
  exportSettings,
  importSettings,
  PROVIDERS_IMPL,
  SettingsImportInvalid,
  updateEnvironment,
  getEnvironment,
  type EnvironmentId,
  type Provider,
  suggestRepoId,
  unitStory,
  recordDisagreement,
  repoTree,
  repoFile,
  repoHistory,
  repoChange,
  unitCode,
  repoDiffFiles,
} from "@yagura/core";
import {
  attemptDetail,
  attemptDiff,
  attemptDiffFiles,
  bell,
  capCounts,
  environmentDetail,
  environmentView,
  projectSummary,
  repoView,
  resolvedGates,
  unitView,
} from "./views.js";

export interface ServerOptions {
  db: Db;
  boot: Bootstrap;
  token: string | null;
  adapters?: Record<string, HarnessAdapter>;
  cli?: string[];
  pollMs?: number;
  webDir?: string | null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

type Row = Record<string, unknown>;

function eventsSince(db: Db, since: number, projectId: string | null, limit = 500) {
  return (
    db
      .prepare("SELECT id, ts, type, project_id, unit_id, attempt_id, data_json FROM events WHERE id > ? AND (? IS NULL OR project_id = ?) ORDER BY id LIMIT ?")
      .all(since, projectId, projectId, limit) as Row[]
  ).map((e) => ({
    id: e.id,
    ts: e.ts,
    type: e.type,
    projectId: e.project_id,
    unitId: e.unit_id,
    attemptId: e.attempt_id,
    data: JSON.parse(e.data_json as string),
  }));
}

function readLog(opts: ServerOptions, attemptId: AttemptId, from: number) {
  const attempt = getAttempt(opts.db, attemptId);
  const unit = getUnit(opts.db, attempt.unitId);
  const path = layout(opts.boot).log(unit.projectId, unit.seq, attempt.n);
  const adapter = (opts.adapters ?? { claude: claudeAdapter })[attempt.harness] ?? claudeAdapter;
  if (!existsSync(path)) return { attempt, lines: [] as { line: number; at: number | null; raw: string; events: unknown[] }[], next: from };
  const complete = readFileSync(path, "utf8").split("\n").slice(0, -1);
  const timesPath = logTimesPath(path);
  const times = existsSync(timesPath) ? readFileSync(timesPath, "utf8").split("\n").map(Number) : [];
  const lines = complete.slice(from).map((raw, i) => {
    let events: unknown[] = [];
    try {
      events = adapter.parse(raw);
    } catch {}
    return { line: from + i, at: times[from + i] || null, raw, events };
  });
  return { attempt, lines, next: from + lines.length };
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

  app.onError((e, c) => {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    const message = issues ? issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") : e.message;
    return c.json({ error: message }, /not found/.test(message) ? 404 : 400);
  });

  app.get("/api/health", (c) => c.json({ ok: true, home: boot.home }));

  app.get("/api/projects", (c) => c.json(listProjects(db).map((p) => projectSummary(db, p.id))));

  app.get("/api/projects/:id", (c) => {
    const id = c.req.param("id") as ProjectId;
    const r = readiness(db, id);
    return c.json({
      ...projectSummary(db, id),
      repos: projectRepos(db, id),
      units: listUnits(db, id).map((u) => unitView(db, u)),
      threads: threadsForProject(db, id),
      deps: listDeps(db, id),
      gates: listGates(db, id),
      waiting: r.waiting.map((w) => ({ unitId: w.unit.id, reason: w.reason })),
      skills: projectSkillChecks(db, boot, id),
    });
  });

  app.get("/api/projects/:id/units/:seq", (c) => {
    const unit = getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq")));
    return c.json(traceUnit(db, boot, unit));
  });

  app.get("/api/projects/:id/units/:seq/story", (c) =>
    c.json(unitStory(db, boot, getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq"))))),
  );
  app.get("/api/projects/:id/units/:seq/code", async (c) =>
    c.json({ code: await unitCode(db, boot, getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq")))) }),
  );
  app.post("/api/projects/:id/units/:seq/disagreements", async (c) => {
    const unit = getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq")));
    const b = (await c.req.json()) as { ref?: string; about?: string; reason?: string; action?: string };
    if (b.action !== "follow-up" && b.action !== "note") return c.json({ error: "action must be follow-up or note" }, 400);
    return c.json(recordDisagreement(db, { unitId: unit.id, ref: b.ref ?? "", about: b.about ?? "", reason: b.reason ?? "", action: b.action }), 201);
  });

  app.get("/api/projects/:id/events", (c) => c.json(eventsSince(db, Number(c.req.query("since") ?? 0), c.req.param("id"))));

  app.post("/api/watchman-turns/:id/stop", (c) => {
    const stopped = stopTurn(db, Number(c.req.param("id")));
    return stopped ? c.json({ stopped }) : c.json({ error: "that watchman turn is not running" }, 409);
  });
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
      return {
        ...a,
        unit: { id: u.id, seq: u.seq, type: u.type, goal: u.goal, projectId: u.projectId, state: u.state },
      };
    });
    return c.json({
      attempts,
      watchman: listTurns(db, 20),
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
    return c.json(
      attemptDetail(
        db,
        {
          brief: paths.brief(unit.projectId, unit.seq, attempt.n),
          handoff: paths.handoff(unit.projectId, unit.seq, attempt.n),
          leftovers: paths.leftovers(unit.projectId, unit.seq, attempt.n),
        },
        attempt.id,
      ),
    );
  });

  app.get("/api/bell", (c) => c.json(bell(db)));
  app.get("/api/inbox", (c) => c.json({ waiting: bell(db), resolved: resolvedGates(db) }));

  app.post("/api/projects/:id/units/:seq/retry", async (c) => {
    const unit = getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq")));
    const note = String(((await c.req.json().catch(() => ({}))) as { note?: unknown }).note ?? "").trim();
    if (unit.state !== "stuck") return c.json({ error: `U${unit.seq} is ${unit.state}; only a stuck unit can be retried` }, 409);
    if (note) addUnitNote(db, unit.id, `The developer: ${note}`);
    bumpMaxAttempts(db, unit.id, listAttempts(db, unit.id).filter((a) => a.role === "worker").length + 1);
    transitionUnit(db, unit.id, "waiting", { by: "developer", reason: note || "retried by the developer" });
    return c.json(unitView(db, getUnit(db, unit.id)));
  });

  app.post("/api/projects/:id/units/:seq/wake", async (c) => {
    const unit = getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq")));
    const note = String(((await c.req.json().catch(() => ({}))) as { note?: unknown }).note ?? "").trim();
    const refused = askLead(db, unit, note || "Look at this unit now.");
    if (refused) return c.json({ error: refused }, 409);
    return c.json(unitView(db, getUnit(db, unit.id)));
  });

  app.post("/api/projects/:id/units/:seq/cancel", async (c) => {
    const unit = getUnitBySeq(db, c.req.param("id") as ProjectId, Number(c.req.param("seq")));
    const reason = String(((await c.req.json().catch(() => ({}))) as { reason?: unknown }).reason ?? "cancelled by operator");
    if (["building", "merged", "dropped"].includes(unit.state)) return c.json({ error: `U${unit.seq} is ${unit.state} and cannot be cancelled` }, 409);
    transitionUnit(db, unit.id, "dropped", { by: "operator", reason });
    return c.json(unitView(db, getUnit(db, unit.id)));
  });

  app.get("/api/attempts/:id/log", (c) => {
    const { lines, next } = readLog(opts, Number(c.req.param("id")) as AttemptId, Number(c.req.query("from") ?? 0));
    return c.json({ lines, next });
  });

  app.get("/api/attempts/:id/steers", (c) => c.json(listSteers(db, Number(c.req.param("id")) as AttemptId)));
  app.post("/api/attempts/:id/steer", async (c) => {
    const attempt = getAttempt(db, Number(c.req.param("id")) as AttemptId);
    const b = (await c.req.json().catch(() => ({}))) as { message?: unknown };
    if (!(opts.adapters ?? { claude: claudeAdapter })[attempt.harness]?.message)
      return c.json({ error: `${attempt.harness} agents cannot take messages while they run` }, 400);
    try {
      return c.json(addSteer(db, attempt.id, String(b.message ?? "")));
    } catch (e) {
      if (e instanceof SteerRefused) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  app.post("/api/attempts/:id/stop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const stopped = stopAttempt(db, Number(c.req.param("id")) as AttemptId, body.note ?? null);
    return stopped ? c.json({ stopped }) : c.json({ error: "attempt is not running" }, 409);
  });

  app.get("/api/artifacts/:id", (c) => {
    const id = Number(c.req.param("id")) as ArtifactId;
    const data = readArtifact(db, boot, id);
    const name = artifactName(db, id);
    return c.body(new Uint8Array(data), 200, {
      "content-type": artifactContentType(name, data),
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "content-disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename="${name.split("/").pop()!.replace(/"/g, "")}"`,
    });
  });
  app.get("/api/evidence/:id", (c) => {
    const id = Number(c.req.param("id"));
    return c.json({ run: getEvidenceRun(db, id), artifacts: runArtifacts(db, boot, id) });
  });
  app.get("/api/attempts/:id/diff", async (c) => c.json(await attemptDiff(db, boot, Number(c.req.param("id")) as AttemptId)));
  app.get("/api/repos/:id/diff-files", async (c) => {
    const [base, head] = [c.req.query("base") ?? "", c.req.query("head") ?? ""];
    if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) return c.json({ error: "base and head must be full commit ids" }, 400);
    return c.json(await repoDiffFiles(db, boot, c.req.param("id") as RepoId, base, head));
  });
  app.get("/api/attempts/:id/diff-files", async (c) => c.json(await attemptDiffFiles(db, boot, Number(c.req.param("id")) as AttemptId)));

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

  app.get("/api/environments", (c) =>
    c.json((db.prepare("SELECT id FROM environments ORDER BY id").all() as { id: EnvironmentId }[]).map((e) => environmentView(db, e.id))),
  );
  app.post("/api/environments", async (c) => {
    const b = (await c.req.json()) as { id?: string; name?: string; provider?: string; capacity?: number; providerConfig?: Record<string, unknown> };
    if (!b.id || !ENVIRONMENT_ID.test(b.id)) return c.json({ error: "id must be lowercase words joined by dashes, e.g. dev-2" }, 400);
    if (!PROVIDERS_IMPL[b.provider as Provider])
      return c.json({ error: `provider ${b.provider} is not available yet; use ${Object.keys(PROVIDERS_IMPL).join(", ")}` }, 400);
    if (!Number.isInteger(b.capacity) || b.capacity! < 0) return c.json({ error: "capacity must be a whole number, 0 or more" }, 400);
    if (db.prepare("SELECT 1 FROM environments WHERE id = ?").get(b.id)) return c.json({ error: `environment ${b.id} already exists` }, 409);
    const problem = PROVIDERS_IMPL[b.provider as Provider]!.validateConfig(b.providerConfig ?? {}, b.capacity!);
    if (problem) return c.json({ error: problem }, 400);
    addEnvironment(db, {
      id: b.id,
      name: b.name?.trim() || b.id,
      provider: b.provider as Provider,
      capacity: b.capacity!,
      providerConfig: b.providerConfig ?? {},
    });
    return c.json(environmentView(db, b.id as EnvironmentId), 201);
  });
  app.post("/api/environments/:id/delete", (c) => {
    deleteEnvironment(db, c.req.param("id") as EnvironmentId);
    return c.json({ deleted: true });
  });
  app.get("/api/environments/:id", (c) => c.json(environmentDetail(db, c.req.param("id") as EnvironmentId)));
  app.post("/api/environments/:id/values", async (c) => {
    const b = (await c.req.json()) as { name: string; value: string; note?: string; replaces?: string; source?: string };
    return c.json(setValue(db, c.req.param("id") as EnvironmentId, b));
  });
  app.post("/api/environments/:id/values/:name/delete", (c) => c.json({ deleted: deleteValue(db, c.req.param("id") as EnvironmentId, c.req.param("name")) }));
  app.post("/api/environments/:id/presets/:preset", (c) => {
    if (!PRESETS.some((p) => p.id === c.req.param("preset"))) return c.json({ error: `no preset ${c.req.param("preset")}` }, 404);
    return c.json(applyPreset(db, c.req.param("id") as EnvironmentId, c.req.param("preset")));
  });
  app.post("/api/environments/:id/notes", async (c) => {
    setEnvironmentNotes(db, c.req.param("id") as EnvironmentId, ((await c.req.json()) as { notes: string }).notes ?? "");
    return c.json({ ok: true });
  });
  app.post("/api/leases/:id/delete-kept", async (c) => c.json({ deleted: await deleteKept(db, boot, Number(c.req.param("id")) as never) }));
  app.get("/api/templates", (c) => c.json(listTemplates(db)));
  app.post("/api/environments/:id/template", async (c) => {
    const b = (await c.req.json()) as { name: string; description?: string; ask?: string[] };
    return c.json(saveTemplate(db, c.req.param("id") as EnvironmentId, b), 201);
  });
  app.get("/api/templates/:name/export", (c) => c.text(exportTemplate(db, c.req.param("name")), 200, { "content-type": "text/yaml; charset=utf-8" }));
  app.post("/api/templates/import", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { yaml?: unknown };
    if (typeof b.yaml !== "string" || !b.yaml.trim()) return c.json({ error: "paste a template's YAML" }, 400);
    try {
      return c.json(importTemplate(db, b.yaml), 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
  app.post("/api/templates/:name/delete", (c) => {
    deleteTemplate(db, c.req.param("name"));
    return c.json(listTemplates(db));
  });
  app.post("/api/templates/:name/apply", async (c) => {
    const b = (await c.req.json()) as { id: string; name?: string; answers?: Record<string, string> };
    const result = await applyTemplate({ db, boot }, c.req.param("name"), b);
    return c.json({ ...result, view: environmentView(db, result.environmentId) }, 201);
  });
  app.post("/api/environments/:id", async (c) => {
    const b = (await c.req.json()) as { name?: string; capacity?: number; providerConfig?: Record<string, unknown> };
    const env = getEnvironment(db, c.req.param("id") as EnvironmentId);
    const problem = b.capacity === undefined ? null : PROVIDERS_IMPL[env.provider]?.validateConfig(b.providerConfig ?? env.providerConfig, b.capacity);
    if (problem) return c.json({ error: problem }, 400);
    if (b.providerConfig && JSON.stringify(b.providerConfig) !== JSON.stringify(env.providerConfig))
      try {
        setProviderConfig(db, env.id, b.providerConfig);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    updateEnvironment(db, c.req.param("id") as EnvironmentId, { name: b.name, capacity: b.capacity });
    return c.json(environmentView(db, c.req.param("id") as EnvironmentId));
  });
  app.get("/api/repos", async (c) => {
    const ids = (db.prepare("SELECT id FROM repos ORDER BY id").all() as { id: RepoId }[]).map((r) => r.id);
    return c.json(await Promise.all(ids.map((id) => repoView(db, boot, id))));
  });
  app.post("/api/repos", async (c) => {
    const b = (await c.req.json()) as { source?: string; id?: string; forge?: string; land?: string };
    if (!b.source?.trim()) return c.json({ error: "give a local path or a git URL" }, 400);
    if (b.forge && b.forge !== "gh" && b.forge !== "glab") return c.json({ error: "forge must be gh or glab" }, 400);
    try {
      const { repo, inspection } = await registerRepo(
        { db, boot },
        { source: b.source, id: b.id, forge: b.forge as "gh" | "glab" | undefined, land: b.land === "push" ? "push" : undefined },
      );
      return c.json(await repoView(db, boot, repo.id), 201);
    } catch (e) {
      if (e instanceof RouteNeeded) return c.json({ error: e.message, needsRoute: true }, 400);
      if (e instanceof RepoUnusable) return c.json({ error: e.message }, e.message.includes("already") ? 409 : 400);
      throw e;
    }
  });
  app.get("/api/repos/:id/tree", async (c) => c.json(await repoTree(db, boot, c.req.param("id") as RepoId, c.req.query("ref") || undefined)));
  app.get("/api/repos/:id/file", async (c) =>
    c.json(await repoFile(db, boot, c.req.param("id") as RepoId, c.req.query("path") ?? "", c.req.query("ref") || undefined)),
  );
  app.get("/api/repos/:id/history", async (c) =>
    c.json(await repoHistory(db, boot, c.req.param("id") as RepoId, { path: c.req.query("path") || undefined, limit: Number(c.req.query("limit") ?? 100) })),
  );
  app.get("/api/repos/:id/change/:sha", async (c) =>
    c.json(await repoChange(db, boot, c.req.param("id") as RepoId, c.req.param("sha"), c.req.query("base") || undefined)),
  );
  app.get("/api/repos/suggest-id", (c) => c.json({ id: suggestRepoId(c.req.query("source") ?? "") }));

  app.get("/api/settings", (c) =>
    c.json(effectiveSettings(db, { projectId: (c.req.query("project") as ProjectId) ?? null, repoId: (c.req.query("repo") as never) ?? null })),
  );
  app.get("/api/settings/overview", (c) => {
    const scope = c.req.query("scope") as SettingScope | undefined;
    const id = c.req.query("id") ?? "";
    if (!scope || scope === "global") return c.json({ settings: describeSettings(db), caps: capCounts(db) });
    const ctx = {
      projectId: scope === "project" ? (id as ProjectId) : null,
      repoId: scope === "repo" ? (id as RepoId) : null,
      environmentId: scope === "environment" ? (id as EnvironmentId) : null,
    };
    return c.json({ settings: describeSettings(db, ctx, scope), caps: capCounts(db) });
  });
  app.post("/api/settings/clear", async (c) => {
    const b = (await c.req.json()) as { scope: SettingScope; id?: string; key: string };
    return c.json({ cleared: clearSetting(db, b.scope, b.id ?? "", b.key) });
  });
  app.get("/api/settings/export", (c) =>
    c.body(exportSettings(db), 200, { "content-type": "text/yaml; charset=utf-8", "content-disposition": 'attachment; filename="yagura-settings.yaml"' }),
  );
  app.post("/api/settings/import", async (c) => {
    const b = (await c.req.json()) as { yaml?: string };
    try {
      return c.json({ applied: importSettings(db, b.yaml ?? "") });
    } catch (e) {
      if (e instanceof SettingsImportInvalid) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  app.post("/api/settings", async (c) => {
    const b = (await c.req.json()) as { scope: SettingScope; id?: string; key: string; value: unknown };
    setSetting(db, b.scope, b.id ?? "", b.key, b.value);
    return c.json({ ok: true });
  });

  app.get("/api/find", (c) => {
    const q = c.req.query("q") ?? "";
    const per = Number(c.req.query("per") ?? 0);
    const r = find(db, q);
    const shown = new Map<string, number>();
    const hits = r.hits.filter((h) => {
      const n = (shown.get(h.kind) ?? 0) + 1;
      shown.set(h.kind, n);
      return !per || n <= per;
    });
    return c.json({ ...r, hits: hits.map((h) => ({ ...h, title: excerpt(h.title, q, 200), text: excerpt(h.text, q, 200) })) });
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json([]);
    const rows = db.prepare("SELECT kind, ref_id, project_id, snippet(search, 0, '[', ']', '…', 12) AS snippet FROM search WHERE search MATCH ? LIMIT 50").all(
      q
        .replace(/"/g, '""')
        .split(/\s+/)
        .map((t) => `"${t}"`)
        .join(" "),
    ) as Row[];
    return c.json(
      rows.map((r) => ({
        kind: r.kind,
        ...(r.kind === "message" ? { messageId: Number(r.ref_id) } : { attemptId: Number(r.ref_id) }),
        projectId: r.project_id,
        snippet: r.snippet,
      })),
    );
  });

  const busy = (threadId: number) => runningTurn(db, threadId) !== null;
  const talk = (threadId: number, text: string) => {
    const ctx = { db, boot, adapters: opts.adapters ?? { claude: claudeAdapter }, cli: opts.cli ?? [] };
    return runWatchmanTurn(ctx, threadId, text)
      .then((r) => (r.reply ? runQueuedTurns(ctx, threadId) : undefined))
      .catch((e: unknown) => {
        if (e instanceof TurnBusy) return;
        addMessage(db, { threadId, role: "system", body: `the watchman failed: ${e instanceof Error ? e.message : String(e)}` });
      });
  };
  const threadView = (id: number) => ({
    thread: getThread(db, id),
    projects: getThread(db, id).projects.map((p) => projectSummary(db, p)),
    busy: busy(id),
    messages: listMessages(db, id),
    decisions: listDecisions(db, id),
    questions: listQuestions(db, id),
    proposals: listProposals(db, id).map((p) => ({ ...p, routes: proposalRoutes(db, p.body) })),
    session: (() => {
      const current = currentSession(db, id);
      return current
        ? { startedAt: current.startedAt, contextPeak: current.lastContextPeak, rollAt: resolveSetting(db, "watchman.session_roll_tokens").value }
        : null;
    })(),
    sessionStarts: sessionStarts(db, id),
    queued: busy(id) ? queuedMessages(db, id).map((m) => m.id) : [],
  });
  const clearSession = (id: number) => {
    if (busy(id)) return false;
    clearWatchmanSession(db, id);
    return true;
  };
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  app.get("/api/mentions", (c) => c.json(suggestMentions(db, c.req.query("q") ?? "")));
  app.get("/api/mentions/:token/messages", (c) => c.json(messagesMentioning(db, decodeURIComponent(c.req.param("token")))));
  app.get("/api/threads", (c) => c.json(listThreads(db).map((t) => ({ ...t, busy: busy(t.id) }))));
  app.get("/api/threads/search", (c) => c.json(searchMessages(db, c.req.query("q") ?? "", c.req.query("thread") ? Number(c.req.query("thread")) : undefined)));
  app.post("/api/threads", async (c) => {
    const b = await body(c);
    if (typeof b.message !== "string" || !b.message.trim()) return c.json({ error: "message is required" }, 400);
    const thread = createThread(db, { title: b.message.trim().slice(0, 60), autonomy: b.autonomy === "go" ? "go" : "propose" });
    void talk(thread.id, b.message.trim());
    return c.json(threadView(thread.id), 202);
  });
  const ROLE_UNIT: Record<PromptRole, string> = {
    planner: "plan",
    worker: "work",
    judge: "work",
    lead: "work",
    watchman: "",
  };
  const promptsView = (projectId: string | null) => ({
    projectId,
    allNotes: projectId ? getPromptText(db, "project", projectId, "all", "notes") : null,
    roles: PROMPT_ROLES.filter((r) => !projectId || r !== "watchman").map((role) => {
      const last = projectId
        ? (db
            .prepare(
              "SELECT a.id FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ? AND u.type = ? AND a.harness NOT LIKE 'yagura-%' ORDER BY a.id DESC LIMIT 1",
            )
            .get(projectId, ROLE_UNIT[role]) as { id: number } | undefined)
        : undefined;
      const e = effectiveGuidance(db, boot, role, projectId);
      return {
        role,
        default: defaultGuidance(boot, role),
        global: getPromptText(db, "global", "", role, "guidance"),
        project: projectId ? getPromptText(db, "project", projectId, role, "guidance") : null,
        source: e.source,
        sha: e.sha,
        notes: projectId ? getPromptText(db, "project", projectId, role, "notes") : role === "watchman" ? getPromptText(db, "global", "", role, "notes") : null,
        lastAttemptId: last?.id ?? null,
        followUps: [],
      };
    }),
  });
  app.get("/api/projects/:id/spec", (c) => {
    const project = getProject(db, c.req.param("id") as ProjectId);
    return c.json(getSpec(db, project.id) ?? { text: "", updatedBy: null, updatedAt: null });
  });
  app.put("/api/projects/:id/spec", async (c) => {
    const project = getProject(db, c.req.param("id") as ProjectId);
    const b = (await c.req.json().catch(() => ({}))) as { text?: unknown; since?: string | null };
    if (typeof b.text !== "string") return c.json({ error: "text is required" }, 400);
    const current = getSpec(db, project.id);
    if (b.since !== undefined && (current?.updatedAt ?? null) !== b.since)
      return c.json({ error: `the spec was changed (by ${current?.updatedBy ?? "someone"}) since you opened it; reload to see it before saving` }, 409);
    db.transaction(() => {
      writeSpec(db, project.id, b.text as string, "developer");
      recordEvent(db, "project.spec_changed", { projectId: project.id }, { by: "developer" });
    })();
    return c.json(getSpec(db, project.id));
  });
  app.get("/api/prompts", (c) => {
    const projectId = c.req.query("project") || null;
    if (projectId) getProject(db, projectId as ProjectId);
    return c.json(promptsView(projectId));
  });
  app.put("/api/prompts", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { scope?: string; projectId?: string; role?: string; kind?: string; text?: string | null };
    if (b.scope !== "global" && b.scope !== "project") return c.json({ error: "scope must be global or project" }, 400);
    if (b.kind !== "guidance" && b.kind !== "notes") return c.json({ error: "kind must be guidance or notes" }, 400);
    if (b.role !== "all" && !(PROMPT_ROLES as readonly string[]).includes(b.role ?? ""))
      return c.json({ error: `role must be one of ${PROMPT_ROLES.join(", ")} or all` }, 400);
    if (b.scope === "project") getProject(db, (b.projectId ?? "") as ProjectId);
    try {
      setPromptText(db, b.scope, b.scope === "project" ? b.projectId! : "", b.role as PromptRole | "all", b.kind, b.text ?? null);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return c.json(promptsView(b.scope === "project" ? b.projectId! : null));
  });
  app.get("/api/threads/:id", (c) => c.json(threadView(Number(c.req.param("id")))));
  const turnAdapter = () => (opts.adapters ?? { claude: claudeAdapter })[resolveSetting(db, "role.watchman.harness").value as string] ?? claudeAdapter;
  app.get("/api/messages/:id/calls", (c) => {
    const m = getMessage(db, Number(c.req.param("id")));
    const logs = m.turnLog ? [m.turnLog.replace(/\.retry\.jsonl$/, ".jsonl"), m.turnLog] : [];
    return c.json({ ...readTurnCalls(turnAdapter(), [...new Set(logs)]), running: false });
  });
  app.get("/api/threads/:id/live-calls", (c) => {
    const turn = runningTurn(db, Number(c.req.param("id")));
    if (!turn) return c.json({ calls: [], running: false });
    return c.json({ ...readTurnCalls(turnAdapter(), [turn.logPath]), running: true });
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await body(c);
    getThread(db, id);
    if (typeof b.message !== "string" || !b.message.trim()) return c.json({ error: "message is required" }, 400);
    if (b.message.trim() === "/clear") {
      if (busy(id)) return c.json({ error: `thread ${id} is waiting on the watchman; stop it or wait before starting a new session` }, 409);
      clearSession(id);
      return c.json(threadView(id));
    }
    if (busy(id)) {
      queueMessage(db, id, b.message.trim());
      return c.json(threadView(id), 202);
    }
    void talk(id, b.message.trim());
    return c.json(threadView(id), 202);
  });
  app.post("/api/threads/:id/clear", (c) => {
    const id = Number(c.req.param("id"));
    getThread(db, id);
    if (!clearSession(id)) return c.json({ error: `thread ${id} is waiting on the watchman; stop it or wait before starting a new session` }, 409);
    return c.json(threadView(id));
  });
  app.post("/api/threads/:id/autonomy", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await body(c);
    if (b.autonomy !== "go" && b.autonomy !== "propose") return c.json({ error: "autonomy must be propose or go" }, 400);
    setThreadAutonomy(db, id, b.autonomy);
    return c.json(getThread(db, id));
  });
  app.post("/api/proposals/:id/apply", async (c) => {
    const proposal = getProposal(db, Number(c.req.param("id")));
    try {
      const result = await applyProposal({ db, boot }, proposal.id);
      addMessage(db, { threadId: proposal.threadId, role: "system", body: `Go: applied proposal ${proposal.id}: ${JSON.stringify(result)}` });
      return c.json({ proposal: getProposal(db, proposal.id), result });
    } catch (e) {
      addMessage(db, {
        threadId: proposal.threadId,
        role: "system",
        body: `Applying proposal ${proposal.id} failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      throw e;
    }
  });
  app.post("/api/proposals/:id/discard", async (c) => {
    const proposal = getProposal(db, Number(c.req.param("id")));
    discardProposal(db, proposal.id, String((await body(c)).reason ?? ""));
    addMessage(db, { threadId: proposal.threadId, role: "system", body: `Proposal ${proposal.id} discarded.` });
    return c.json(getProposal(db, proposal.id));
  });

  app.get("/api/trace/:target", (c) => {
    const target = c.req.param("target");
    const units = findUnitsByCommit(db, target);
    const byRef = units.length ? null : findByRef(db, target);
    return c.json({ projects: byRef?.projects ?? [], units: (units.length ? units : (byRef?.units ?? [])).map((u) => traceUnit(db, boot, u)) });
  });

  app.get("/api/stream", (c: Context) =>
    streamSSE(c, async (stream) => {
      const from = c.req.query("since") ?? c.req.header("last-event-id") ?? "0";
      let since = from === "latest" ? (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number }).id : Number(from);
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

  if (opts.webDir) {
    const webDir = opts.webDir;
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
      const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\.])+/, "");
      const file = join(webDir, rel);
      const target = rel && file.startsWith(webDir) && existsSync(file) && statSync(file).isFile() ? file : join(webDir, "index.html");
      const type = MIME[extname(target)] ?? "application/octet-stream";
      const cache = target.includes(`${webDir}/assets/`) ? "public, max-age=31536000, immutable" : "no-cache";
      return c.body(readFileSync(target), 200, { "content-type": type, "cache-control": cache });
    });
  }

  return app;
}
