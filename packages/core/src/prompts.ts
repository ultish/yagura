import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import type { AttemptId } from "./domain.js";
import { layout } from "./paths.js";
import { now, type Db } from "./store.js";

// Each role's prompt has a contract yagura parses (the brief: handoff format, evidence and scope rules; visible, never
// editable) and guidance on how to do the job (its overlay skill's body), which the developer may override globally or
// per project. Notes are extra standing orders per role, or for every role ("all").
export const PROMPT_ROLES = ["planner", "worker", "judge", "lead", "watchman", "doctor"] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];
export const PROMPT_SCOPES = ["global", "project"] as const;
export type PromptScope = (typeof PROMPT_SCOPES)[number];
export const PROMPT_KINDS = ["guidance", "notes"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const skillOf = (role: PromptRole) => (role === "lead" ? "yagura-unit-lead" : `yagura-${role}`);

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function splitSkill(file: string): { frontmatter: string; body: string } {
  const m = /^(---\n[\s\S]*?\n---\n)\n?([\s\S]*)$/.exec(file);
  return m ? { frontmatter: m[1]!, body: m[2]! } : { frontmatter: "", body: file };
}

const skillPath = (boot: Bootstrap, role: PromptRole) => join(boot.skillsDir, "skills", skillOf(role), "SKILL.md");

export function defaultGuidance(boot: Bootstrap, role: PromptRole): string {
  const path = skillPath(boot, role);
  return existsSync(path) ? splitSkill(readFileSync(path, "utf8")).body.trimEnd() + "\n" : "";
}

export function getPromptText(db: Db, scope: PromptScope, scopeId: string, role: PromptRole | "all", kind: PromptKind): string | null {
  const r = db.prepare("SELECT text FROM prompt_texts WHERE scope = ? AND scope_id = ? AND role = ? AND kind = ?").get(scope, scopeId, role, kind) as
    { text: string } | undefined;
  return r?.text ?? null;
}

export function setPromptText(db: Db, scope: PromptScope, scopeId: string, role: PromptRole | "all", kind: PromptKind, text: string | null): void {
  if (scope === "global" && scopeId !== "") throw new Error("global prompts take no id");
  if (scope === "project" && !scopeId) throw new Error("a project prompt needs the project id");
  if (kind === "guidance" && role === "all") throw new Error("guidance is per role");
  if (role === "watchman" && scope === "project") throw new Error("the watchman serves threads, not projects: its guidance is global only");
  if (text === null || !text.trim())
    db.prepare("DELETE FROM prompt_texts WHERE scope = ? AND scope_id = ? AND role = ? AND kind = ?").run(scope, scopeId, role, kind);
  else
    db.prepare(
      `INSERT INTO prompt_texts (scope, scope_id, role, kind, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, scope_id, role, kind) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    ).run(scope, scopeId, role, kind, text.trimEnd() + "\n", now());
}

export interface EffectiveGuidance {
  role: PromptRole;
  text: string;
  source: "default" | "global" | "project";
  sha: string;
}

export function effectiveGuidance(db: Db, boot: Bootstrap, role: PromptRole, projectId: string | null): EffectiveGuidance {
  const project = projectId && role !== "watchman" ? getPromptText(db, "project", projectId, role, "guidance") : null;
  const global = getPromptText(db, "global", "", role, "guidance");
  const [text, source] = project ? [project, "project" as const] : global ? [global, "global" as const] : [defaultGuidance(boot, role), "default" as const];
  return { role, text, source, sha: sha(text) };
}

// The standing orders a role's brief carries: the project's notes for every role, then the role's own.
export function standingFor(db: Db, projectId: string, role: PromptRole): string {
  const all = getPromptText(db, "project", projectId, "all", "notes");
  const own = getPromptText(db, "project", projectId, role, "notes");
  return [all, own].filter((t) => t && t.trim()).join("\n");
}

// Standing orders used to be hand-edited files; they now live in the store, where the dashboard shows and edits them.
// A project's file becomes its notes for every role, a conversation's file joins the watchman's notes; each file is then removed.
export function importStandingFiles(db: Db, boot: Bootstrap): string[] {
  const moved: string[] = [];
  const projects = db.prepare("SELECT id FROM projects").all() as { id: string }[];
  for (const { id } of projects) {
    const path = layout(boot).standingOrders(id as never);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (text.trim() && !getPromptText(db, "project", id, "all", "notes")) setPromptText(db, "project", id, "all", "notes", text);
    rmSync(path);
    moved.push(path);
  }
  const threads = db.prepare("SELECT id FROM threads").all() as { id: number }[];
  for (const { id } of threads) {
    const path = join(layout(boot).thread(id), "standing-orders.md");
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (text) {
      const now_ = getPromptText(db, "global", "", "watchman", "notes");
      setPromptText(db, "global", "", "watchman", "notes", [now_?.trim(), `From thread ${id}:\n${text}`].filter(Boolean).join("\n\n"));
    }
    rmSync(path);
    moved.push(path);
  }
  return moved;
}

// The plugin directory a session loads. With no overrides it is yagura's own; otherwise a copy whose skills carry the
// effective guidance, named by its content so concurrent sessions never see a half-written copy.
export function promptPlugin(db: Db, boot: Bootstrap, projectId: string | null, record?: { attemptId: AttemptId; role: PromptRole }): string {
  const effective = PROMPT_ROLES.map((r) => effectiveGuidance(db, boot, r, projectId));
  if (record) {
    const g = effective.find((e) => e.role === record.role)!;
    db.prepare("INSERT OR IGNORE INTO prompt_versions (sha, role, text, created_at) VALUES (?, ?, ?, ?)").run(g.sha, g.role, g.text, now());
    db.prepare("UPDATE attempts SET guidance_sha = ? WHERE id = ?").run(g.sha, record.attemptId);
  }
  const changed = effective.filter((e) => e.source !== "default");
  if (!changed.length) return boot.skillsDir;
  const dir = join(boot.home, "plugins", sha(changed.map((e) => `${e.role}:${e.sha}`).join(",")));
  if (existsSync(dir)) return dir;
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  cpSync(boot.skillsDir, tmp, { recursive: true });
  for (const e of changed) {
    const path = join(tmp, "skills", skillOf(e.role), "SKILL.md");
    const { frontmatter } = splitSkill(existsSync(path) ? readFileSync(path, "utf8") : "");
    mkdirSync(join(tmp, "skills", skillOf(e.role)), { recursive: true });
    writeFileSync(path, `${frontmatter}\n${e.text}`);
  }
  try {
    renameSync(tmp, dir);
  } catch {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}
