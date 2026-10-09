import { actionsFor, environmentSection } from "./actions.js";
import { inCheckout } from "./actionrun.js";
import { attemptRecorder, runAgentSession, write, type RunContext } from "./agent.js";
import { resolveSetting } from "./config.js";
import type { EnvironmentId, IsoTime, ProjectId, RepoId } from "./domain.js";
import { listValues } from "./envvalues.js";
import { ensureRecorded, sessionReport } from "./finish.js";
import { layout } from "./paths.js";
import { promptPlugin, standingFor } from "./prompts.js";
import { getRecord, type RecordData } from "./records.js";
import { recordInstructions } from "./record-usage.js";
import { addUnit, createAttempt, getEnvironment, getProject, getUnit, now, recordEvent, transitionUnit, updateAttempt, type Db } from "./store.js";

export type DoctorTrigger = "first" | "asked" | "broken";
export interface DoctorWake {
  trigger: DoctorTrigger;
  detail: string;
}

const WHY: Record<DoctorTrigger, string> = {
  first: "No doctor has looked at this repo in this environment yet.",
  asked: "The developer asked for a doctor.",
  broken: "An action for this repo is broken.",
};

// The last doctor that looked at a repo in an environment, from any project that runs there.
function lastDoctor(db: Db, environmentId: EnvironmentId, repoId: RepoId): { state: string; endedAt: IsoTime | null; updatedAt: IsoTime } | null {
  return (
    (db
      .prepare(
        `SELECT u.state, u.updated_at AS updatedAt, (SELECT MAX(a.ended_at) FROM attempts a WHERE a.unit_id = u.id) AS endedAt
         FROM units u JOIN projects p ON p.id = u.project_id
         WHERE u.type = 'doctor' AND u.repo_id = ? AND p.environment_id = ? ORDER BY u.id DESC LIMIT 1`,
      )
      .get(repoId, environmentId) as { state: string; endedAt: IsoTime | null; updatedAt: IsoTime } | undefined) ?? null
  );
}

// Derived, not queued: a repo needs a doctor when none has looked at it here, when the developer asked since the last one ended,
// or when an action for it broke since then. Changes the doctor makes during its own run never wake it again.
export function doctorWake(db: Db, projectId: ProjectId, repoId: RepoId): DoctorWake | null {
  const environmentId = getProject(db, projectId).environmentId;
  if (!environmentId) return null;
  const last = lastDoctor(db, environmentId, repoId);
  if (!last) return { trigger: "first", detail: WHY.first };
  if (last.state === "building" || last.state === "waiting") return null;
  const since = last.endedAt ?? last.updatedAt;
  const asked = (
    db
      .prepare("SELECT data_json FROM events WHERE type = 'doctor.wake' AND ts > ? AND json_extract(data_json, '$.environment') = ? ORDER BY id")
      .all(since, environmentId) as { data_json: string }[]
  ).map((r) => String((JSON.parse(r.data_json) as { note?: string }).note ?? "").trim());
  if (asked.length) return { trigger: "asked", detail: [WHY.asked, ...asked.filter(Boolean).map((n) => `They said: ${n}`)].join("\n") };
  const broken = actionsFor(db, environmentId, repoId).filter((a) => a.state === "broken" && a.updatedAt > since);
  if (broken.length) return { trigger: "broken", detail: [WHY.broken, ...broken.map((a) => `- ${a.name}: ${a.reason ?? "no reason recorded"}`)].join("\n") };
  return null;
}

export function requestDoctor(db: Db, environmentId: EnvironmentId, note: string): void {
  getEnvironment(db, environmentId);
  recordEvent(db, "doctor.wake", {}, { environment: environmentId, note });
}

export const DOCTOR_REPORT = recordInstructions(
  ["doctor"],
  ["- Offer each action with `yagura action propose` before you report; the report says what you found, the actions are what agents use."],
);

export function renderDoctorBrief(db: Db, projectId: ProjectId, repoId: RepoId, checkout: string, wake: DoctorWake): string {
  const environmentId = getProject(db, projectId).environmentId!;
  return `# yagura brief: doctor ${environmentId}/${repoId}

You turn the developer's answers about environment ${environmentId} into proven actions for repo ${repoId}, and report what works, what fails, and what you cannot tell. Change nothing in the repo; commit and push nothing.

## WHY YOU WERE WOKEN
${wake.detail}

## THE REPO
- repo: ${repoId}
- checkout: ${checkout} (a throwaway checkout of its main branch, your working directory)

## THE ENVIRONMENT
${environmentSection(db, environmentId, repoId)}

Values (names agents and commands read from the environment): ${
    listValues(db, environmentId)
      .map((v) => v.name)
      .join(", ") || "(none)"
  }

## REPORT
${DOCTOR_REPORT}

## STANDING ORDERS
${standingFor(db, projectId, "doctor").trim() || "(none)"}
`;
}

// One doctor session on one repo: a unit of its own, in a clean checkout, ending merged with its report or dropped without one.
export async function runDoctorRound(ctx: RunContext, projectId: ProjectId, repoId: RepoId, wake: DoctorWake): Promise<RecordData<"doctor"> | null> {
  const { db, boot } = ctx;
  const project = getProject(db, projectId);
  const sctx = { projectId, environmentId: project.environmentId ?? undefined };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.doctor.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const unit = addUnit(db, {
    projectId,
    type: "doctor",
    repoId,
    goal: `Doctor: ${repoId} in ${project.environmentId}`,
    acceptance: [],
    timeboxSeconds: setting("timebox.doctor_seconds"),
    maxAttempts: 1,
  });
  transitionUnit(db, unit.id, "building", { trigger: wake.trigger });
  const paths = layout(boot);
  const attempt = createAttempt(db, unit.id, harnessId, setting("role.doctor.model"));
  updateAttempt(db, attempt.id, { state: "running", startedAt: now(), role: "doctor" });
  recordEvent(db, "doctor.woken", { projectId, unitId: unit.id, attemptId: attempt.id }, { trigger: wake.trigger, repo: repoId });
  const role = "doctor";
  const report = await inCheckout(ctx, repoId, null, async (checkout) => {
    const brief = renderDoctorBrief(db, projectId, repoId, checkout, wake);
    write(paths.brief(projectId, unit.seq, attempt.n), brief);
    const doctor = (prompt: string, resume: string | undefined, reminder = false) =>
      runAgentSession(ctx, {
        recorder: attemptRecorder(db, { attempt, unit, projectId, role }),
        adapter,
        run: {
          prompt,
          bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
          model: setting("role.doctor.model"),
          permissionMode: setting("harness.claude.permission_mode"),
          pluginDirs: [promptPlugin(db, boot, projectId, { attemptId: attempt.id, role })],
          addDirs: [],
          extraArgs: setting("harness.claude.extra_args"),
          disallowedTools: [],
          resume,
        },
        cwd: checkout,
        env: {},
        timeboxSeconds: setting("timebox.doctor_seconds"),
        logPath: reminder ? paths.log(projectId, unit.seq, attempt.n).replace(/\.jsonl$/, ".resume.jsonl") : paths.log(projectId, unit.seq, attempt.n),
      });
    const first = await doctor(brief, undefined);
    const session = await ensureRecorded(db, attempt.id, role, first, (prompt, sessionId) => doctor(prompt, sessionId, true));
    write(paths.handoff(projectId, unit.seq, attempt.n), sessionReport(first, session) ?? "");
    updateAttempt(db, attempt.id, { endedAt: now(), exitCode: session.exitCode });
    return getRecord(db, attempt.id, "doctor");
  });
  updateAttempt(db, attempt.id, { state: report ? "handed_off" : "failed" });
  transitionUnit(db, getUnit(db, unit.id).id, report ? "merged" : "dropped", report ? {} : { reason: "the doctor ended without a report" });
  recordEvent(db, report ? "doctor.reported" : "doctor.no_report", { projectId, unitId: unit.id, attemptId: attempt.id }, report ?? {});
  return report;
}

export interface DoctorReport {
  repoId: RepoId;
  projectId: ProjectId;
  unitSeq: number;
  attemptId: number | null;
  agentNo: number | null;
  startedAt: IsoTime | null;
  costUsd: number;
  running: boolean;
  report: RecordData<"doctor"> | null;
}

// The latest doctor on each repo in an environment, from whichever project ran it.
export function doctorReports(db: Db, environmentId: EnvironmentId): DoctorReport[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.project_id, u.seq, u.repo_id, u.state FROM units u JOIN projects p ON p.id = u.project_id
       WHERE u.type = 'doctor' AND p.environment_id = ? AND u.id = (
         SELECT MAX(v.id) FROM units v JOIN projects q ON q.id = v.project_id WHERE v.type = 'doctor' AND v.repo_id = u.repo_id AND q.environment_id = ?)
       ORDER BY u.repo_id`,
    )
    .all(environmentId, environmentId) as { id: number; project_id: ProjectId; seq: number; repo_id: RepoId; state: string }[];
  return rows.map((r) => {
    const a = db.prepare("SELECT id, agent_no, started_at, cost_usd FROM attempts WHERE unit_id = ? ORDER BY n DESC LIMIT 1").get(r.id) as
      { id: number; agent_no: number; started_at: IsoTime | null; cost_usd: number } | undefined;
    return {
      repoId: r.repo_id,
      projectId: r.project_id,
      unitSeq: r.seq,
      attemptId: a?.id ?? null,
      agentNo: a?.agent_no ?? null,
      startedAt: a?.started_at ?? null,
      costUsd: a?.cost_usd ?? 0,
      running: r.state === "building",
      report: a ? getRecord(db, a.id as never, "doctor") : null,
    };
  });
}
