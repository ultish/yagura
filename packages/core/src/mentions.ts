import { existsSync, readFileSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import { BUILD_TYPES_SQL, type MentionKind, type ProjectId } from "./domain.js";
import { layout } from "./paths.js";
import { generateStatus } from "./status.js";
import { lastDrainEventId } from "./planner.js";
import { getProject, getRepo, getUnitBySeq, listAttempts, type Db } from "./store.js";
import type { Unit } from "./domain.js";
import { attemptAccount } from "./finish.js";

export interface Mention {
  kind: MentionKind;
  ref: string;
  projectId: ProjectId | null;
}

const MENTION = /(?<![\w@])@(thread:\d+|repo:[a-z][a-z0-9-]*|[a-z][a-z0-9-]*(?:\/(?:U\d+(?:\.\d+)?|A\d+))?)/g;

export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1]!.replace(/[-.]+$/, "")))];
}

const exists = (db: Db, sql: string, ...args: unknown[]) => !!db.prepare(sql).get(...args);

function agentUnit(db: Db, projectId: ProjectId, agentNo: number): { unitSeq: number; n: number } | null {
  const r = db
    .prepare("SELECT u.seq AS unitSeq, a.n AS n FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ? AND a.agent_no = ?")
    .get(projectId, agentNo) as { unitSeq: number; n: number } | undefined;
  return r ?? null;
}

export function resolveMention(db: Db, token: string): Mention | null {
  if (token.startsWith("thread:"))
    return exists(db, "SELECT 1 FROM threads WHERE id = ?", Number(token.slice(7))) ? { kind: "thread", ref: token, projectId: null } : null;
  if (token.startsWith("repo:")) return exists(db, "SELECT 1 FROM repos WHERE id = ?", token.slice(5)) ? { kind: "repo", ref: token, projectId: null } : null;
  const m = /^([a-z][a-z0-9-]*)(?:\/(?:U(\d+)(?:\.(\d+))?|A(\d+)))?$/.exec(token);
  if (!m || !exists(db, "SELECT 1 FROM projects WHERE id = ?", m[1])) return null;
  const projectId = m[1] as ProjectId;
  if (m[4]) return agentUnit(db, projectId, Number(m[4])) ? { kind: "attempt", ref: token, projectId } : null;
  if (!m[2]) return { kind: "project", ref: token, projectId };
  const unit = db.prepare("SELECT id FROM units WHERE project_id = ? AND seq = ?").get(projectId, Number(m[2])) as { id: number } | undefined;
  if (!unit) return null;
  if (!m[3]) return { kind: "unit", ref: token, projectId };
  return exists(db, "SELECT 1 FROM attempts WHERE unit_id = ? AND n = ?", unit.id, Number(m[3])) ? { kind: "attempt", ref: token, projectId } : null;
}

export function resolveMentions(db: Db, text: string): Mention[] {
  return parseMentions(text)
    .map((t) => resolveMention(db, t))
    .filter((m): m is Mention => m !== null);
}

export function indexMentions(db: Db, messageId: number, text: string): Mention[] {
  const mentions = resolveMentions(db, text);
  const insert = db.prepare("INSERT OR IGNORE INTO message_refs (message_id, kind, ref, project_id) VALUES (?, ?, ?, ?)");
  for (const m of mentions) insert.run(messageId, m.kind, m.ref, m.projectId);
  return mentions;
}

export interface MentionHit {
  threadId: number;
  messageId: number;
  role: string;
  createdAt: string;
  body: string;
}

export function messagesMentioning(db: Db, token: string): MentionHit[] {
  const exact = token.includes("/") || token.includes(":");
  const rows = db
    .prepare(
      `SELECT DISTINCT m.id, m.thread_id, m.role, m.created_at, m.body FROM message_refs r JOIN thread_messages m ON m.id = r.message_id
       WHERE r.ref = ? ${exact ? "" : "OR r.project_id = ?"} ORDER BY m.id DESC LIMIT 100`,
    )
    .all(...(exact ? [token] : [token, token])) as { id: number; thread_id: number; role: string; created_at: string; body: string }[];
  return rows.map((r) => ({ threadId: r.thread_id, messageId: r.id, role: r.role, createdAt: r.created_at, body: r.body }));
}

export interface Suggestion {
  token: string;
  kind: MentionKind;
  label: string;
}

export function suggestMentions(db: Db, query: string, limit = 20): Suggestion[] {
  const q = query.replace(/^@/, "").toLowerCase();
  const out: Suggestion[] = [];
  const agentRef = /^([a-z][a-z0-9-]*)\/a(\d*)$/.exec(q);
  if (agentRef) {
    const rows = db
      .prepare(
        `SELECT a.agent_no, a.state, u.seq, u.type FROM attempts a JOIN units u ON u.id = a.unit_id
         WHERE u.project_id = ? AND CAST(a.agent_no AS TEXT) LIKE ? ORDER BY a.agent_no DESC LIMIT ?`,
      )
      .all(agentRef[1], `${agentRef[2] ?? ""}%`, limit) as { agent_no: number; state: string; seq: number; type: string }[];
    return rows.map((r) => ({ token: `${agentRef[1]}/A${r.agent_no}`, kind: "attempt" as const, label: `${r.type} agent for U${r.seq} · ${r.state}` }));
  }
  const unitRef = /^([a-z][a-z0-9-]*)\/(?:u(\d*)(?:\.(\d*))?)?$/.exec(q);
  if (unitRef) {
    const units = db
      .prepare(
        "SELECT id, seq, type, state, goal FROM units WHERE project_id = ? AND type IN ('work', 'pack') AND CAST(seq AS TEXT) LIKE ? ORDER BY seq DESC LIMIT ?",
      )
      .all(unitRef[1], `${unitRef[2] ?? ""}%`, limit) as { id: number; seq: number; type: string; state: string; goal: string }[];
    for (const u of units) {
      if (unitRef[3] !== undefined) {
        const attempts = db.prepare("SELECT n, agent_no AS agentNo, state FROM attempts WHERE unit_id = ? ORDER BY n").all(u.id) as {
          n: number;
          agentNo: number;
          state: string;
        }[];
        for (const a of attempts) out.push({ token: `${unitRef[1]}/A${a.agentNo}`, kind: "attempt", label: `agent A${a.agentNo} for U${u.seq} · ${a.state}` });
      } else out.push({ token: `${unitRef[1]}/U${u.seq}`, kind: "unit", label: `${u.type} · ${u.state} · ${u.goal}` });
    }
    return out.slice(0, limit);
  }
  const like = `%${q}%`;
  for (const p of db
    .prepare("SELECT id, state, goal FROM projects WHERE id LIKE ? OR name LIKE ? ORDER BY id LIKE ? DESC, created_at DESC LIMIT ?")
    .all(like, like, `${q}%`, limit) as {
    id: string;
    state: string;
    goal: string;
  }[])
    out.push({ token: p.id, kind: "project", label: `project · ${p.state} · ${p.goal}` });
  for (const u of db
    .prepare(`SELECT project_id, seq, state, goal FROM units WHERE type IN ${BUILD_TYPES_SQL} AND goal LIKE ? ORDER BY updated_at DESC LIMIT ?`)
    .all(like, q.length >= 3 ? limit : 0) as { project_id: string; seq: number; state: string; goal: string }[])
    out.push({ token: `${u.project_id}/U${u.seq}`, kind: "unit", label: `${u.state} · ${u.goal}` });
  for (const t of db
    .prepare("SELECT id, title FROM threads WHERE title LIKE ? OR CAST(id AS TEXT) = ? ORDER BY updated_at DESC LIMIT ?")
    .all(like, q.replace(/^thread:?/, ""), limit) as {
    id: number;
    title: string;
  }[])
    out.push({ token: `thread:${t.id}`, kind: "thread", label: `thread · ${t.title}` });
  for (const r of db.prepare("SELECT id, url FROM repos WHERE id LIKE ? ORDER BY id LIMIT ?").all(like.replace(/^%repo:?/, "%"), limit) as {
    id: string;
    url: string;
  }[])
    out.push({ token: `repo:${r.id}`, kind: "repo", label: `repo · ${r.url}` });
  return out.slice(0, limit);
}

const HANDOFF_LIMIT = 2500;

function describeUnit(db: Db, boot: Bootstrap, unit: Unit, onlyAttempt: number | null): string {
  const attempts = listAttempts(db, unit.id).filter((a) => onlyAttempt === null || a.n === onlyAttempt);
  const blocked = db
    .prepare("SELECT data_json FROM events WHERE unit_id = ? AND type = 'unit.state' AND json_extract(data_json, '$.to') = 'blocked' ORDER BY id DESC LIMIT 1")
    .get(unit.id) as { data_json: string } | undefined;
  const lines = [
    `- ${unit.type} · ${unit.state}${unit.landedSha ? ` · landed ${unit.landedSha.slice(0, 10)}` : ""} · repo ${unit.repoId ?? "-"} · goal: ${unit.goal}`,
    `- write: ${unit.writeScope.join(", ") || "-"} · accept: ${unit.acceptance.join(" / ")}`,
  ];
  if (unit.state === "blocked" && blocked) lines.push(`- blocked: ${JSON.stringify(JSON.parse(blocked.data_json).reason ?? "no reason recorded")}`);
  if (unit.notes.length) lines.push(`- notes: ${unit.notes.join(" / ")}`);
  for (const a of attempts) {
    lines.push(
      `- agent A${a.agentNo} (try ${a.n}): ${a.state}${a.handoffStatus ? ` ${a.handoffStatus}` : ""}${a.failureMode ? ` (${a.failureMode})` : ""} · ${a.model ?? a.harness}${a.missingSkills.length ? ` · skipped ${a.missingSkills.join(", ")}` : ""}${a.stopNote ? ` · stopped: ${a.stopNote}` : ""}`,
    );
  }
  const last = attempts.filter((a) => a.endedAt).at(-1);
  const path = last ? layout(boot).handoff(unit.projectId, unit.seq, last.n) : null;
  const text = last ? attemptAccount(db, last.id, path) : null;
  if (text) {
    lines.push(`- handoff of attempt ${last!.n}:\n${text.length > HANDOFF_LIMIT ? `${text.slice(0, HANDOFF_LIMIT)}\n… (truncated; ${path})` : text}`);
  }
  if (last) lines.push(`- log: ${layout(boot).log(unit.projectId, unit.seq, last.n)}`);
  return lines.join("\n");
}

export function describeMention(db: Db, boot: Bootstrap, m: Mention): string {
  if (m.kind === "project") return generateStatus(db, boot, m.projectId!, lastDrainEventId(db, m.projectId!)).replace(/^# /, "");
  if (m.kind === "repo") {
    const repo = getRepo(db, m.ref.slice(5) as never);
    return `- url ${repo.url} · default branch ${repo.defaultBranch} · verify pack ${repo.verifyPackPath} (${repo.packStatus})`;
  }
  if (m.kind === "thread") {
    const id = Number(m.ref.slice(7));
    const t = db.prepare("SELECT title, state FROM threads WHERE id = ?").get(id) as { title: string; state: string };
    const decisions = db.prepare("SELECT id, text FROM thread_decisions WHERE thread_id = ? AND superseded_by IS NULL ORDER BY id").all(id) as {
      id: number;
      text: string;
    }[];
    const projects = (db.prepare("SELECT project_id FROM thread_projects WHERE thread_id = ?").all(id) as { project_id: string }[]).map((r) => r.project_id);
    return [`- ${t.title} [${t.state}]${projects.length ? ` · projects ${projects.join(", ")}` : ""}`, ...decisions.map((d) => `- D${d.id}: ${d.text}`)].join(
      "\n",
    );
  }
  const agent = /\/A(\d+)$/.exec(m.ref);
  const [, seq, n] = agent
    ? (() => {
        const r = agentUnit(db, m.projectId!, Number(agent[1]))!;
        return ["", String(r.unitSeq), String(r.n)];
      })()
    : /\/U(\d+)(?:\.(\d+))?$/.exec(m.ref)!;
  const project = getProject(db, m.projectId!);
  return `- project ${project.id} (${project.state})\n${describeUnit(db, boot, getUnitBySeq(db, project.id, Number(seq)), n ? Number(n) : null)}`;
}
