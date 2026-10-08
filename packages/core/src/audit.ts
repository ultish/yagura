import { existsSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import { isBuild, type Attempt, type Project, type Unit } from "./domain.js";
import { layout } from "./paths.js";
import { getRecord } from "./records.js";
import { getProject, getUnit, listAttempts, listUnits, type Db } from "./store.js";

const SUBJECT_MAX = 72;

export function commitSubject(goal: string): string {
  const firstSentence = goal
    .split(/(?<=[.!?])\s/)[0]!
    .replace(/\s+/g, " ")
    .trim();
  const subject = firstSentence.replace(/[.]$/, "");
  return subject.length <= SUBJECT_MAX ? subject : `${subject.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

export function unitLink(url: string | null, project: Project, unit: Unit): string | null {
  return url ? `${url.replace(/\/$/, "")}/p/${project.id}/u/${unit.seq}` : null;
}

// A unit's ref to an issue in its own repo (`app#12`) closes that issue when it merges; refs to other repos only point at them.
export function closesIssues(unit: Unit): number[] {
  return unit.refs.flatMap((r) => {
    const m = /^(.+)#(\d+)$/.exec(r);
    return m && m[1] === unit.repoId ? [Number(m[2])] : [];
  });
}

// The pull request's description: what the unit must make true, the issues it closes, and where to follow it in yagura.
export function pullRequestBody(project: Project, unit: Unit, url: string | null): string {
  const link = unitLink(url, project, unit);
  return [
    unit.goal,
    "",
    "## Acceptance",
    ...unit.acceptance.map((a) => `- ${a}`),
    ...(closesIssues(unit).length ? ["", ...closesIssues(unit).map((n) => `Closes #${n}`)] : []),
    "",
    link ? `Built by yagura: ${project.id}/U${unit.seq}, ${link}` : `Built by yagura: ${project.id}/U${unit.seq}.`,
  ].join("\n");
}

// The merge commit names the unit, the agents that built it, and the judge's approval, so main's history says how it was made.
export function mergeMessage(db: Db, unit: Unit, pr: number | null, url: string | null): { subject: string; body: string } {
  const project = getProject(db, unit.projectId);
  const attempts = listAttempts(db, unit.id);
  const workers = attempts.filter((a) => a.role === "worker" && a.state === "handed_off");
  const judge = attempts.filter((a) => a.role === "judge").at(-1);
  const approval = judge ? getRecord(db, judge.id, "judge") : null;
  const link = unitLink(url, project, unit);
  return {
    subject: `${project.id}/U${unit.seq}: ${commitSubject(unit.goal)}${pr ? ` (#${pr})` : ""}`,
    body: [
      `Workers: ${workers.map((a) => `A${a.agentNo}${a.model ? ` (${a.model})` : ""}`).join(", ") || "none"}`,
      ...(judge && approval?.verdict === "approve"
        ? [`Judge: A${judge.agentNo} approved ${unit.approvedSha?.slice(0, 10) ?? ""}, on ${approval.runs.map((r) => `run:${r}`).join(", ")}`]
        : []),
      ...closesIssues(unit).map((n) => `Closes #${n}`),
      ...(link ? [`yagura: ${link}`] : []),
    ].join("\n"),
  };
}

export interface Trace {
  project: Project;
  unit: Unit;
  attempts: Attempt[];
  handoffPaths: string[];
}

export function traceUnit(db: Db, boot: Bootstrap, unit: Unit): Trace {
  const project = getProject(db, unit.projectId);
  const attempts = listAttempts(db, unit.id);
  const handoffPaths = attempts.map((a) => layout(boot).handoff(project.id, unit.seq, a.n)).filter((p) => existsSync(p));
  return { project, unit, attempts, handoffPaths };
}

export function findUnitsByCommit(db: Db, sha: string): Unit[] {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return [];
  const like = `${sha}%`;
  const ids = db
    .prepare(
      `SELECT id FROM units WHERE merged_sha LIKE ?
       UNION SELECT a.unit_id FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.type = 'work' AND a.head_sha LIKE ?`,
    )
    .all(like, like) as { id: number }[];
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
