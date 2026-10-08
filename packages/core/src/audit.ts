import { existsSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import { isBuild, type Attempt, type Project, type Unit } from "./domain.js";
import { layout } from "./paths.js";
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

// A ref to an issue yagura is answering (§30) closes it when a change to that issue's own repo merges; a change to another repo
// of the project only refers to it.
export function watchedIssues(db: Db, unit: Unit, refs: string[]): number[] {
  if (!unit.repoId) return [];
  const numbers = refs.flatMap((r) => {
    const m = /^(.+)#(\d+)$/.exec(r);
    return m && m[1] === unit.repoId ? [Number(m[2])] : [];
  });
  return numbers.filter((n) => db.prepare("SELECT 1 FROM forge_issues WHERE repo_id = ? AND number = ?").get(unit.repoId, n));
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
