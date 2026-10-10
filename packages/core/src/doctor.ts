import { randomBytes, timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { actionsFor, environmentSection } from "./actions.js";
import { inCheckout } from "./actionrun.js";
import { runAgentSession, write, type RunContext, type SessionRecorder } from "./agent.js";
import { loadBootstrap, resolveSetting } from "./config.js";
import type { DoctorReport, DoctorRun, DoctorTrigger, EnvironmentId, IsoTime, ProjectId, RepoId } from "./domain.js";
import { listValues } from "./envvalues.js";
import { layout } from "./paths.js";
import { promptPlugin, standingFor } from "./prompts.js";
import { missingSkills } from "./skills.js";
import { getEnvironment, now, openStore, recordEvent, type Db } from "./store.js";

export interface DoctorWake {
  repoId: RepoId;
  trigger: DoctorTrigger;
  detail: string;
  projectId: ProjectId | null;
}

const lines = z.array(z.string().trim().min(1)).default([]);
const DoctorReportSchema = z
  .object({ works: lines, fails: lines, unknown: lines })
  .strict()
  .refine((d) => d.works.length + d.fails.length + d.unknown.length > 0, { message: "report at least one line: --works, --fails, or --unknown" });

const toRun = (r: Record<string, unknown>): DoctorRun => ({
  id: r.id as number,
  environmentId: r.environment_id as EnvironmentId,
  repoId: r.repo_id as RepoId,
  projectId: (r.project_id as ProjectId | null) ?? null,
  trigger: r.trigger as DoctorTrigger,
  detail: r.detail as string,
  state: r.state as DoctorRun["state"],
  pid: (r.pid as number | null) ?? null,
  model: (r.model as string | null) ?? null,
  harness: r.harness as string,
  contextPeak: r.context_peak as number,
  costUsd: r.cost_usd as number,
  report: r.report_json ? (JSON.parse(r.report_json as string) as DoctorReport) : null,
  logPath: r.log_path as string,
  startedAt: r.started_at as IsoTime,
  endedAt: (r.ended_at as IsoTime | null) ?? null,
});

export function getDoctorRun(db: Db, id: number): DoctorRun {
  const r = db.prepare("SELECT * FROM doctor_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`doctor run D${id} not found`);
  return toRun(r);
}

export function listDoctorRuns(db: Db, environmentId: EnvironmentId, limit = 20): DoctorRun[] {
  return (db.prepare("SELECT * FROM doctor_runs WHERE environment_id = ? ORDER BY id DESC LIMIT ?").all(environmentId, limit) as Record<string, unknown>[]).map(
    toRun,
  );
}

export const runningDoctorRuns = (db: Db): number => (db.prepare("SELECT COUNT(*) AS n FROM doctor_runs WHERE state = 'running'").get() as { n: number }).n;

// The repos an environment's doctor looks after: every repo of every project that runs there, and a project on it that is not closed.
function reposOf(db: Db, environmentId: EnvironmentId): { repoId: RepoId; openProject: ProjectId | null }[] {
  const rows = db
    .prepare(
      `SELECT pr.repo_id, MIN(CASE WHEN p.state != 'closed' THEN p.id END) AS open_project
       FROM project_repos pr JOIN projects p ON p.id = pr.project_id WHERE p.environment_id = ? GROUP BY pr.repo_id ORDER BY pr.repo_id`,
    )
    .all(environmentId) as { repo_id: RepoId; open_project: ProjectId | null }[];
  return rows.map((r) => ({ repoId: r.repo_id, openProject: r.open_project }));
}

// Derived, not queued. A repo gets a doctor when a project that is not closed is set up on it here and no doctor has looked yet, when
// the developer asked since the last one ended (or while it ran), or when an action for it broke since then. Changes made during a run never wake it again.
export function doctorWakes(db: Db, environmentId: EnvironmentId): DoctorWake[] {
  const wakes: DoctorWake[] = [];
  for (const { repoId, openProject } of reposOf(db, environmentId)) {
    const last = db
      .prepare("SELECT state, ended_at FROM doctor_runs WHERE environment_id = ? AND repo_id = ? ORDER BY id DESC LIMIT 1")
      .get(environmentId, repoId) as { state: string; ended_at: IsoTime | null } | undefined;
    if (last?.state === "running") continue;
    if (!last) {
      if (openProject)
        wakes.push({
          repoId,
          trigger: "setup",
          detail: `Project ${openProject} was set up on this environment, and no doctor has looked at ${repoId} here yet.`,
          projectId: openProject,
        });
      continue;
    }
    const since = last.ended_at ?? "";
    const asked = (
      db
        .prepare(
          `SELECT data_json FROM events WHERE type = 'doctor.wake' AND ts >= ? AND json_extract(data_json, '$.environment') = ?
           AND coalesce(json_extract(data_json, '$.repo'), ?) = ? ORDER BY id`,
        )
        .all(since, environmentId, repoId, repoId) as { data_json: string }[]
    ).map((r) => String((JSON.parse(r.data_json) as { note?: string }).note ?? "").trim());
    if (asked.length) {
      wakes.push({
        repoId,
        trigger: "asked",
        detail: ["The developer asked for a doctor.", ...asked.filter(Boolean).map((n) => `They said: ${n}`)].join("\n"),
        projectId: null,
      });
      continue;
    }
    const broken = actionsFor(db, environmentId, repoId).filter((a) => a.state === "broken" && a.updatedAt > since);
    if (broken.length)
      wakes.push({
        repoId,
        trigger: "broken",
        detail: ["An action for this repo is broken.", ...broken.map((a) => `- ${a.name}: ${a.reason ?? "no reason recorded"}`)].join("\n"),
        projectId: null,
      });
  }
  return wakes;
}

export function requestDoctor(db: Db, environmentId: EnvironmentId, note: string, repoId?: RepoId): void {
  getEnvironment(db, environmentId);
  recordEvent(db, "doctor.wake", {}, { environment: environmentId, note, ...(repoId ? { repo: repoId } : {}) });
}

const REPORT_USAGE = 'yagura doctor report [--works "<what>: <action>"] [--fails "<what>: <why>"] [--unknown "<what>: <why>"]';

export function renderDoctorBrief(db: Db, run: DoctorRun, checkout: string): string {
  const env = run.environmentId;
  return `# yagura brief: doctor ${env}/${run.repoId}

You turn the developer's answers about environment ${env} into proven actions for repo ${run.repoId}, and report what works, what fails, and what you cannot tell. Change nothing in the repo; commit and push nothing.

## WHY YOU WERE WOKEN
${run.detail}

## THE REPO
- repo: ${run.repoId}
- checkout: ${checkout} (a throwaway checkout of its main branch, your working directory)

## THE ENVIRONMENT
${environmentSection(db, env, run.repoId)}

Values (names agents and commands read from the environment): ${
    listValues(db, env)
      .map((v) => v.name)
      .join(", ") || "(none)"
  }

## REPORT
Offer each action with \`yagura action propose\` first; the report says what you found, the actions are what agents use. Then record:
- \`${REPORT_USAGE}\`, one flag per line, repeated as needed.
End with a short note for the developer in any form; yagura shows the report on the environment page and never reads your final message.

## STANDING ORDERS
${(run.projectId ? standingFor(db, run.projectId, "doctor") : "").trim() || "(none)"}
`;
}

function doctorRecorder(db: Db, id: number, token: string): SessionRecorder {
  return {
    env: { YAGURA_DOCTOR_RUN: String(id), YAGURA_DOCTOR_TOKEN: token, YAGURA_ROLE: "doctor" },
    started: (pid) => db.prepare("UPDATE doctor_runs SET pid = ? WHERE id = ?").run(pid, id),
    session: (e) => db.prepare("UPDATE doctor_runs SET model = ?, session_id = ? WHERE id = ?").run(e.model, e.sessionId, id),
    usage: (contextPeak) => db.prepare("UPDATE doctor_runs SET context_peak = MAX(context_peak, ?) WHERE id = ?").run(contextPeak, id),
    cost: (usd) => db.prepare("UPDATE doctor_runs SET cost_usd = cost_usd + ? WHERE id = ?").run(usd, id),
    finished: (skills) => missingSkills("doctor", skills),
  };
}

// One doctor run on one repo: a session in a clean checkout of its main branch, reminded once if it ends without its report.
export async function runDoctor(ctx: RunContext, environmentId: EnvironmentId, wake: DoctorWake): Promise<DoctorRun> {
  const { db, boot } = ctx;
  const sctx = { projectId: wake.projectId ?? undefined, environmentId };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.doctor.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const token = randomBytes(24).toString("hex");
  const paths = layout(boot);
  const id = db.transaction(() => {
    const next = (db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS n FROM doctor_runs").get() as { n: number }).n;
    db.prepare(
      `INSERT INTO doctor_runs (id, environment_id, repo_id, project_id, trigger, detail, harness, model, token, log_path, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      next,
      environmentId,
      wake.repoId,
      wake.projectId,
      wake.trigger,
      wake.detail,
      harnessId,
      setting("role.doctor.model"),
      token,
      paths.doctorLog(next),
      now(),
    );
    return next;
  })();
  recordEvent(db, "doctor.started", {}, { run: id, environment: environmentId, repo: wake.repoId, trigger: wake.trigger });
  await inCheckout(ctx, wake.repoId, null, async (checkout) => {
    const brief = renderDoctorBrief(db, getDoctorRun(db, id), checkout);
    write(paths.doctorBrief(id), brief);
    const session = (prompt: string, resume: string | undefined, logPath: string) =>
      runAgentSession(ctx, {
        recorder: doctorRecorder(db, id, token),
        adapter,
        run: {
          prompt,
          bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
          model: setting("role.doctor.model"),
          permissionMode: setting("harness.claude.permission_mode"),
          pluginDirs: [promptPlugin(db, boot, wake.projectId)],
          addDirs: [],
          extraArgs: setting("harness.claude.extra_args"),
          disallowedTools: [],
          resume,
        },
        cwd: checkout,
        env: {},
        timeboxSeconds: setting("timebox.doctor_seconds"),
        logPath,
      });
    await session(brief, undefined, paths.doctorLog(id));
    const after = db.prepare("SELECT state, report_json, session_id FROM doctor_runs WHERE id = ?").get(id) as {
      state: string;
      report_json: string | null;
      session_id: string | null;
    };
    if (!after.report_json && after.state === "running" && after.session_id)
      await session(
        `You ended without your report. Record it now: \`${REPORT_USAGE}\`.`,
        after.session_id,
        paths.doctorLog(id).replace(/\.jsonl$/, ".resume.jsonl"),
      );
  });
  const reported = getDoctorRun(db, id).report !== null;
  db.prepare("UPDATE doctor_runs SET state = ?, ended_at = ?, token = NULL WHERE id = ? AND state = 'running'").run(reported ? "done" : "failed", now(), id);
  recordEvent(db, reported ? "doctor.reported" : "doctor.no_report", {}, { run: id, environment: environmentId, repo: wake.repoId });
  return getDoctorRun(db, id);
}

export function stopDoctorRun(db: Db, id: number, reason: string): boolean {
  const run = getDoctorRun(db, id);
  if (run.state !== "running") return false;
  db.prepare("UPDATE doctor_runs SET state = 'stopped', ended_at = ?, token = NULL WHERE id = ?").run(now(), id);
  recordEvent(db, "doctor.stopped", {}, { run: id, reason });
  if (run.pid)
    try {
      process.kill(-run.pid, "SIGTERM");
    } catch {}
  return true;
}

// The doctor run whose token the caller holds, or why not.
export function doctorRunOf(db: Db, env: NodeJS.ProcessEnv): DoctorRun | string {
  const id = Number(env.YAGURA_DOCTOR_RUN);
  const row = db.prepare("SELECT token FROM doctor_runs WHERE id = ?").get(id) as { token: string | null } | undefined;
  const given = Buffer.from(env.YAGURA_DOCTOR_TOKEN ?? "");
  const expected = Buffer.from(row?.token ?? "");
  if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected))
    return "refused: YAGURA_DOCTOR_TOKEN does not match a running doctor run";
  return getDoctorRun(db, id);
}

// `yagura doctor report`, inside a doctor run: records what it found. Running it again replaces the report.
export async function doctorCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; output: string }> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { works: { type: "string", multiple: true }, fails: { type: "string", multiple: true }, unknown: { type: "string", multiple: true } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals[0] !== "report") return { code: 2, output: `usage: ${REPORT_USAGE}\n` };
  if (!env.YAGURA_DOCTOR_RUN) return { code: 2, output: "yagura doctor report only works inside a doctor run (YAGURA_DOCTOR_RUN is not set)\n" };
  const db = openStore(layout(loadBootstrap(env)).db);
  try {
    const run = doctorRunOf(db, env);
    if (typeof run === "string") return { code: 2, output: `yagura doctor report ${run}\n` };
    const parsed = DoctorReportSchema.safeParse({ works: values.works ?? [], fails: values.fails ?? [], unknown: values.unknown ?? [] });
    if (!parsed.success) return { code: 1, output: `${parsed.error.issues[0]?.message ?? "invalid report"}\n` };
    db.prepare("UPDATE doctor_runs SET report_json = ? WHERE id = ?").run(JSON.stringify(parsed.data), run.id);
    return { code: 0, output: `D${run.id}'s report recorded\n` };
  } finally {
    db.close();
  }
}
