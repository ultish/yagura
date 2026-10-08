import { findByRef, findUnitsByCommit } from "./audit.js";
import { isBuild, type Unit } from "./domain.js";
import { listUnits, type Db } from "./store.js";

export const FIND_KINDS = ["unit", "project", "decision", "question", "review", "message", "handoff", "repo"] as const;
export type FindKind = (typeof FIND_KINDS)[number];

// One thing the header search found: where it lives, what it is, and the words that matched.
export interface FindHit {
  kind: FindKind;
  ref: string;
  href: string;
  title: string;
  meta: string;
  text: string;
}

export interface FindResult {
  query: string;
  total: number;
  counts: Partial<Record<FindKind, number>>;
  hits: FindHit[];
}

type Row = Record<string, unknown>;
const PER_KIND = 200;

// Every word must appear, in any order and case; LIKE's own wildcards in the query are taken literally.
function wordsClause(column: string, words: string[]): { sql: string; args: string[] } {
  return {
    sql: words.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND "),
    args: words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
  };
}

const unitHit = (u: Unit, text: string, meta?: string): FindHit => ({
  kind: "unit",
  ref: `${u.projectId}/U${u.seq}`,
  href: `/p/${u.projectId}/u/${u.seq}`,
  title: u.goal,
  meta: meta ?? `${u.type} · ${u.state}${u.mergedSha ? ` · merged ${u.mergedSha.slice(0, 7)}` : ""}`,
  text,
});

export function find(db: Db, query: string): FindResult {
  const q = query.trim();
  const out: FindResult = { query: q, total: 0, counts: {}, hits: [] };
  if (!q) return out;
  const words = q.split(/\s+/).filter(Boolean);
  const hits: FindHit[] = [];
  const seenUnits = new Set<number>();
  const seenProjects = new Set<string>();
  const refHits: FindHit[] = [];
  const addUnit = (u: Unit, text: string, meta?: string) => {
    if (seenUnits.has(u.id)) return;
    seenUnits.add(u.id);
    hits.push(unitHit(u, text, meta));
  };

  // A commit, an issue key, or a unit reference names its units exactly; they come first.
  if (words.length === 1) {
    for (const u of findUnitsByCommit(db, q.toLowerCase())) addUnit(u, u.goal, `${u.type} · ${u.state} · commit ${q.slice(0, 10)}`);
    const byRef = findByRef(db, q);
    for (const u of byRef.units) addUnit(u, u.goal, `${u.type} · ${u.state} · refs ${q}`);
    for (const p of byRef.projects) {
      seenProjects.add(p.id);
      refHits.push({ kind: "project", ref: p.id, href: `/p/${p.id}`, title: p.goal, meta: `${p.state} · refs ${q}`, text: p.goal });
    }
    const m = /^(?:([a-z][a-z0-9-]*)\/)?U(\d+)$/i.exec(q);
    if (m) {
      const projects = m[1] ? [m[1]] : (db.prepare("SELECT id FROM projects ORDER BY created_at").all() as { id: string }[]).map((p) => p.id);
      for (const p of projects) {
        const u = listUnits(db, p as never).find((x) => x.seq === Number(m[2]));
        if (u) addUnit(u, u.goal);
      }
    }
  }

  const goals = wordsClause("goal", words);
  for (const r of db.prepare(`SELECT project_id, seq FROM units WHERE ${goals.sql} ORDER BY updated_at DESC LIMIT ${PER_KIND}`).all(...goals.args) as Row[]) {
    const u = listUnits(db, r.project_id as never).find((x) => x.seq === r.seq)!;
    if (isBuild(u)) addUnit(u, u.goal);
  }

  const projects = wordsClause("(id || ' ' || name || ' ' || goal || ' ' || predicate)", words);
  hits.push(...refHits);
  for (const r of db
    .prepare(`SELECT id, goal, state FROM projects WHERE ${projects.sql} ORDER BY created_at DESC LIMIT ${PER_KIND}`)
    .all(...projects.args) as Row[])
    if (!seenProjects.has(r.id as string))
      hits.push({ kind: "project", ref: r.id as string, href: `/p/${r.id}`, title: r.goal as string, meta: r.state as string, text: r.goal as string });

  const decisions = wordsClause("d.text", words);
  for (const r of db
    .prepare(
      `SELECT d.id, d.thread_id, d.text, d.superseded_by, d.source_message_id, t.title FROM thread_decisions d JOIN threads t ON t.id = d.thread_id WHERE ${decisions.sql} ORDER BY d.id DESC LIMIT ${PER_KIND}`,
    )
    .all(...decisions.args) as Row[])
    hits.push({
      kind: "decision",
      ref: `D${r.id}`,
      href: `/talk/${r.thread_id}${r.source_message_id ? `?m=${r.source_message_id}` : ""}`,
      title: r.text as string,
      meta: `${r.title}${r.superseded_by ? ` · superseded by D${r.superseded_by}` : ""}`,
      text: r.text as string,
    });

  const questions = wordsClause("(q.text || ' ' || COALESCE(q.answer, ''))", words);
  for (const r of db
    .prepare(
      `SELECT q.id, q.thread_id, q.text, q.answer, q.source_message_id, t.title FROM thread_questions q JOIN threads t ON t.id = q.thread_id WHERE ${questions.sql} ORDER BY q.id DESC LIMIT ${PER_KIND}`,
    )
    .all(...questions.args) as Row[])
    hits.push({
      kind: "question",
      ref: `Q${r.id}`,
      href: `/talk/${r.thread_id}${r.source_message_id ? `?m=${r.source_message_id}` : ""}`,
      title: r.text as string,
      meta: `${r.title} · ${r.answer ? `answered: ${r.answer}` : "open"}`,
      text: `${r.text} ${r.answer ?? ""}`,
    });

  const reviews = wordsClause("m.comments_json", words);
  for (const r of db
    .prepare(
      `SELECT m.author, m.path, m.line, m.comments_json, m.decision, u.project_id, u.seq FROM mr_threads m JOIN units u ON u.id = m.unit_id WHERE ${reviews.sql} ORDER BY m.rowid DESC LIMIT ${PER_KIND}`,
    )
    .all(...reviews.args) as Row[]) {
    const said = (JSON.parse(r.comments_json as string) as string[]).join("\n");
    hits.push({
      kind: "review",
      ref: `${r.project_id}/U${r.seq}`,
      href: `/p/${r.project_id}/u/${r.seq}`,
      title: said,
      meta: `${r.author}${r.path ? ` on ${r.path}${r.line ? `:${r.line}` : ""}` : ""}${r.decision ? ` · ${r.decision}` : ""}`,
      text: said,
    });
  }

  const messages = wordsClause("m.body", words);
  for (const r of db
    .prepare(
      `SELECT m.id, m.thread_id, m.role, m.body, t.title FROM thread_messages m JOIN threads t ON t.id = m.thread_id WHERE ${messages.sql} ORDER BY m.id DESC LIMIT ${PER_KIND}`,
    )
    .all(...messages.args) as Row[])
    hits.push({
      kind: "message",
      ref: `thread ${r.thread_id} #${r.id}`,
      href: `/talk/${r.thread_id}?m=${r.id}`,
      title: r.body as string,
      meta: `${r.role === "human" ? "you" : r.role === "system" ? "yagura" : "watchman"} · ${r.title}`,
      text: r.body as string,
    });

  const handoffs = wordsClause("s.body", words);
  for (const r of db
    .prepare(
      `SELECT s.body, s.ref_id, u.project_id, u.seq, u.type, a.n, a.agent_no FROM search s JOIN attempts a ON a.id = CAST(s.ref_id AS INTEGER) JOIN units u ON u.id = a.unit_id
       WHERE s.kind = 'handoff' AND ${handoffs.sql} ORDER BY a.id DESC LIMIT ${PER_KIND}`,
    )
    .all(...handoffs.args) as Row[])
    hits.push({
      kind: "handoff",
      ref: `${r.project_id}/A${r.agent_no}`,
      href: `/a/${r.ref_id}`,
      title: `${r.type} handoff`,
      meta: "handoff",
      text: r.body as string,
    });

  const repos = wordsClause("(id || ' ' || url)", words);
  for (const r of db.prepare(`SELECT id, url, default_branch FROM repos WHERE ${repos.sql} ORDER BY id LIMIT ${PER_KIND}`).all(...repos.args) as Row[])
    hits.push({ kind: "repo", ref: r.id as string, href: `/r/${r.id}`, title: r.url as string, meta: r.default_branch as string, text: r.url as string });

  for (const h of hits) out.counts[h.kind] = (out.counts[h.kind] ?? 0) + 1;
  out.total = hits.length;
  out.hits = hits;
  return out;
}

// The words around the first match, so a long body shows why it matched.
export function excerpt(text: string, query: string, width = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const at = Math.min(...words.map((w) => flat.toLowerCase().indexOf(w)).filter((i) => i >= 0), Infinity);
  if (at === Infinity || flat.length <= width) return flat.slice(0, width);
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  return `${start ? "…" : ""}${flat.slice(start, start + width).trim()}${start + width < flat.length ? "…" : ""}`;
}
