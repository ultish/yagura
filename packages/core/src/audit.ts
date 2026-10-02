import { existsSync, readFileSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import { BUILD_TYPES_SQL, isBuild, type Attempt, type Project, type Unit, type VerdictId } from "./domain.js";
import { listEvidenceRuns } from "./evidence.js";
import { parseHandoff } from "./handoff.js";
import { layout } from "./paths.js";
import { getAttempt, getProject, getUnit, listAttempts, listUnits, type Db } from "./store.js";

const SUBJECT_MAX = 72;
const BODY_MAX = 1500;

export function commitSubject(goal: string): string {
  const firstSentence = goal
    .split(/(?<=[.!?])\s/)[0]!
    .replace(/\s+/g, " ")
    .trim();
  const subject = firstSentence.replace(/[.]$/, "");
  return subject.length <= SUBJECT_MAX ? subject : `${subject.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

export function citedRunsOfVerdict(db: Db, verdictId: VerdictId): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT e.id FROM evidence_runs e JOIN verdict_artifacts va
         ON va.artifact_id = e.stdout_artifact_id OR va.artifact_id = e.stderr_artifact_id
         WHERE va.verdict_id = ? ORDER BY e.id`,
      )
      .all(verdictId) as { id: number }[]
  ).map((r) => r.id);
}

export function unitLink(url: string | null, project: Project, unit: Unit): string | null {
  return url ? `${url.replace(/\/$/, "")}/p/${project.id}/u/${unit.seq}` : null;
}

export function landMessage(
  db: Db,
  boot: Bootstrap,
  p: { unit: Unit; work: Attempt; verdict: { id: VerdictId; tier: string; attemptId: number }; url: string | null },
): string {
  const project = getProject(db, p.unit.projectId);
  const handoffPath = layout(boot).handoff(project.id, p.unit.seq, p.work.n);
  const handoff = existsSync(handoffPath) ? parseHandoff(readFileSync(handoffPath, "utf8")) : null;
  const body = handoff?.whatIDid.trim() ?? "";
  const verifyAttempt = getAttempt(db, p.verdict.attemptId as never);
  const verifyUnit = getUnit(db, verifyAttempt.unitId);
  const runs = citedRunsOfVerdict(db, p.verdict.id);
  const pstack = p.work.pluginVersions.pstack;
  const refs = [...new Set([...project.refs, ...p.unit.refs])];
  const link = unitLink(p.url, project, p.unit);
  const trailers = [
    `Yagura-Project: ${project.id}`,
    `Yagura-Unit: U${p.unit.seq}`,
    `Yagura-Attempt: A${p.work.agentNo} (U${p.unit.seq}, ${[p.work.model ?? p.work.harness, pstack ? `pstack ${pstack}` : null].filter(Boolean).join(", ")})`,
    ...(p.work.branch ? [`Yagura-Branch: ${p.work.branch}`] : []),
    `Yagura-Verdict: ${p.verdict.tier} by U${verifyUnit.seq}${runs.length ? ` (${runs.map((r) => `run:${r}`).join(", ")})` : ""}`,
    ...(link ? [`Yagura-Link: ${link}`] : []),
    ...refs.map((r) => `Refs: ${r}`),
  ];
  return `${commitSubject(p.unit.goal)}\n\n${body ? `${body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n…` : body}\n\n` : ""}${trailers.join("\n")}\n`;
}

export interface Trace {
  project: Project;
  unit: Unit;
  work: Attempt[];
  verifications: { unit: Unit; attempts: Attempt[]; runs: ReturnType<typeof listEvidenceRuns> }[];
  verdicts: { id: number; tier: string; headSha: string; voided: boolean; voidReason: string | null }[];
  handoffPaths: string[];
}

export function traceUnit(db: Db, boot: Bootstrap, unit: Unit): Trace {
  const project = getProject(db, unit.projectId);
  const work = listAttempts(db, unit.id);
  const paths = layout(boot);
  const verifications = listUnits(db, project.id)
    .filter((u) => u.type === "verify" && u.targetUnitId === unit.id)
    .map((v) => {
      const attempts = listAttempts(db, v.id);
      return { unit: v, attempts, runs: attempts.flatMap((a) => listEvidenceRuns(db, a.id)) };
    });
  const verdicts = (
    db.prepare("SELECT id, tier, head_sha, voided_at, void_reason FROM verdicts WHERE unit_id = ? ORDER BY id").all(unit.id) as {
      id: number;
      tier: string;
      head_sha: string;
      voided_at: string | null;
      void_reason: string | null;
    }[]
  ).map((v) => ({ id: v.id, tier: v.tier, headSha: v.head_sha, voided: v.voided_at !== null, voidReason: v.void_reason }));
  const handoffPaths = [
    ...work.map((a) => paths.handoff(project.id, unit.seq, a.n)),
    ...verifications.flatMap((v) => v.attempts.map((a) => paths.handoff(project.id, v.unit.seq, a.n))),
  ].filter((p) => existsSync(p));
  return { project, unit, work, verifications, verdicts, handoffPaths };
}

export function findUnitsByCommit(db: Db, sha: string): Unit[] {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return [];
  const like = `${sha}%`;
  const ids = db
    .prepare(
      `SELECT id FROM units WHERE landed_sha LIKE ?
       UNION SELECT unit_id FROM verdicts WHERE head_sha LIKE ?
       UNION SELECT a.unit_id FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.type IN ${BUILD_TYPES_SQL} AND a.head_sha LIKE ?`,
    )
    .all(like, like, like) as { id: number }[];
  return ids.map((r) => getUnit(db, r.id as never));
}

export function findByRef(db: Db, ref: string): { projects: Project[]; units: Unit[] } {
  const projects = (db.prepare("SELECT p.id FROM projects p, json_each(p.refs_json) r WHERE r.value = ?").all(ref) as { id: string }[]).map((r) =>
    getProject(db, r.id as never),
  );
  const direct = db.prepare("SELECT u.id FROM units u, json_each(u.refs_json) r WHERE r.value = ?").all(ref) as { id: number }[];
  const inherited = projects.flatMap((p) => listUnits(db, p.id).filter(isBuild));
  const seen = new Set<number>();
  const units = [...direct.map((r) => getUnit(db, r.id as never)), ...inherited].filter((u) => !seen.has(u.id) && seen.add(u.id));
  return { projects, units };
}
