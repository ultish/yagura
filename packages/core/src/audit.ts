import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { resolveSetting, type Bootstrap } from "./config.js";
import { listDisagreements } from "./disagreements.js";
import { listEvidenceRuns } from "./evidence.js";
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

// The conversation whose applied proposal started a unit or created its project.
export function startedBy(db: Db, unit: Unit): { proposalId: number; threadId: number; title: string } | null {
  const row = db
    .prepare(
      `SELECT p.id AS proposal, t.id AS thread, t.title FROM proposals p JOIN threads t ON t.id = p.thread_id
       WHERE p.state = 'applied' AND p.result_json IS NOT NULL AND (
         EXISTS (SELECT 1 FROM json_each(json_extract(p.result_json, ?)) j WHERE j.value = ?)
         OR EXISTS (SELECT 1 FROM json_each(json_extract(p.result_json, '$.projects')) j WHERE j.value = ?))
       ORDER BY p.id LIMIT 1`,
    )
    .get(`$.units."${unit.projectId}"`, `U${unit.seq}`, unit.projectId) as { proposal: number; thread: number; title: string } | undefined;
  return row ? { proposalId: row.proposal, threadId: row.thread, title: row.title } : null;
}

export interface Approvals {
  // Who asked for the work: a trusted user's yes on an issue, or the conversation the developer said Go in.
  requestedBy: string | null;
  // Who let it merge: the developer at the merge gate, or the project's auto-merge policy. Null until it has been allowed.
  approvedBy: string | null;
}

// The daemon runs as the developer and only they can answer its gate, so the account it runs under is who approved.
export function approvalsOf(db: Db, unit: Unit): Approvals {
  const project = getProject(db, unit.projectId);
  const origin = startedBy(db, unit);
  let requestedBy: string | null = null;
  if (origin) {
    const issue = db
      .prepare("SELECT data_json FROM events WHERE type = 'issue.approved' AND json_extract(data_json, '$.proposal') = ? ORDER BY id LIMIT 1")
      .get(origin.proposalId) as { data_json: string } | undefined;
    const said = issue ? (JSON.parse(issue.data_json) as { by?: string | null; number?: number }) : null;
    requestedBy = said ? `${said.by ? `@${said.by}` : "a trusted user"} on issue #${said.number}` : `Talk conversation ${origin.threadId}, "${origin.title}"`;
  }
  let approvedBy: string | null = null;
  if (project.mergePolicy === "auto") approvedBy = `the auto-merge policy of project ${project.id}`;
  else {
    const gate = db
      .prepare("SELECT id, resolved_at FROM gates WHERE unit_id = ? AND kind = 'land' AND state = 'answered' AND answer = 'land' ORDER BY id DESC LIMIT 1")
      .get(unit.id) as { id: number; resolved_at: string } | undefined;
    if (gate) approvedBy = `${userInfo().username} via merge gate #${gate.id} at ${gate.resolved_at}`;
  }
  return { requestedBy, approvedBy };
}

const oneLine = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const AUDIT_RUNS = 15;
const AUDIT_JUDGMENTS = 20;

// How the unit was made, for a reader who only has the pull request: who asked, who built and judged it, the runs yagura recorded,
// the judgment calls nobody checked, and every disagreement the developer raised.
export function auditSection(db: Db, unit: Unit): string[] {
  const attempts = listAttempts(db, unit.id);
  const workers = attempts.filter((a) => a.role === "worker" && a.state === "handed_off");
  const judge = attempts.filter((a) => a.role === "judge").at(-1);
  const verdict = judge ? getRecord(db, judge.id, "judge") : null;
  const { requestedBy, approvedBy } = approvalsOf(db, unit);
  const out = ["## How it was made", ""];
  if (requestedBy) out.push(`- Requested by: ${requestedBy}`);
  out.push(`- Built by: ${workers.map((a) => `A${a.agentNo}${a.model ? ` (${a.model})` : ""}`).join(", ") || "no worker yet"}`);
  if (judge && verdict)
    out.push(
      `- Judge: A${judge.agentNo}${judge.model ? ` (${judge.model})` : ""} ${verdict.verdict === "approve" ? `approved ${unit.approvedSha?.slice(0, 10) ?? ""}` : `said ${verdict.verdict}`}`,
    );
  if (approvedBy) out.push(`- Allowed to merge by: ${approvedBy}`);

  const runs = judge ? listEvidenceRuns(db, judge.id) : [];
  if (runs.length) {
    out.push("", "### Runs yagura recorded for the judge", "");
    for (const r of runs.slice(0, AUDIT_RUNS)) out.push(`- \`${oneLine(r.command, 100)}\`: ${r.timedOut ? "timed out" : `exit ${r.exitCode}`} (run ${r.id})`);
    if (runs.length > AUDIT_RUNS) out.push(`- and ${runs.length - AUDIT_RUNS} more`);
  }

  const judgment = workers.flatMap((a) => {
    const h = getRecord(db, a.id, "handoff");
    return h ? [...h.decisions.map((d) => `choice: ${d}`), ...h.notes.map((n) => `note: ${n}`)] : [];
  });
  if (judgment.length) {
    out.push("", "### Judgment calls the agents recorded, which yagura did not check", "");
    for (const j of judgment.slice(0, AUDIT_JUDGMENTS)) out.push(`- ${oneLine(j)}`);
    if (judgment.length > AUDIT_JUDGMENTS) out.push(`- and ${judgment.length - AUDIT_JUDGMENTS} more`);
  }

  const disagreements = listDisagreements(db, { unitId: unit.id });
  if (disagreements.length) {
    out.push("", "### Disagreements the developer raised", "");
    for (const d of disagreements) out.push(`- ${oneLine(d.about, 80)}: ${oneLine(d.reason)} (${d.state})`);
  }
  return out;
}

// The pull request's description: what the unit must make true, the issues it closes, how it was made, and where to follow it in yagura.
export function pullRequestBody(db: Db, project: Project, unit: Unit, url: string | null): string {
  const link = unitLink(url, project, unit);
  return [
    unit.goal,
    "",
    "## Acceptance",
    ...unit.acceptance.map((a) => `- ${a}`),
    ...(closesIssues(unit).length ? ["", ...closesIssues(unit).map((n) => `Closes #${n}`)] : []),
    "",
    ...auditSection(db, unit),
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
  const link = resolveSetting(db, "yagura.link_in_commits", { projectId: project.id, repoId: unit.repoId }).value ? unitLink(url, project, unit) : null;
  const { requestedBy, approvedBy } = approvalsOf(db, unit);
  return {
    subject: `${project.id}/U${unit.seq}: ${commitSubject(unit.goal)}${pr ? ` (#${pr})` : ""}`,
    body: [
      `Workers: ${workers.map((a) => `A${a.agentNo}${a.model ? ` (${a.model})` : ""}`).join(", ") || "none"}`,
      ...(judge && approval?.verdict === "approve"
        ? [`Judge: A${judge.agentNo} approved ${unit.approvedSha?.slice(0, 10) ?? ""}, on ${approval.runs.map((r) => `run:${r}`).join(", ")}`]
        : []),
      ...closesIssues(unit).map((n) => `Closes #${n}`),
      ...(requestedBy ? [`Requested-by: ${requestedBy}`] : []),
      ...(approvedBy ? [`Approved-by: ${approvedBy}`] : []),
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
