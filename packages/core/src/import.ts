import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { SETTINGS } from "./config.js";
import type { Db } from "./store.js";

// What the core-loop build keeps from an old home: how the developer set yagura up, and their conversations. Projects, units,
// and everything that hangs off them are not imported (a clean break).
export interface ImportCounts {
  settings: number;
  environments: number;
  environmentValues: number;
  templates: number;
  repos: number;
  prompts: number;
  threads: number;
  messages: number;
  decisions: number;
  questions: number;
  issues: number;
  skipped: string[];
}

// Settings that moved: the unit manager became the unit lead.
const RENAMED: Record<string, string> = {
  "role.manager.harness": "role.lead.harness",
  "role.manager.model": "role.lead.model",
  "manager.max_decisions_per_unit": "lead.max_decisions_per_unit",
};
const PROMPT_ROLES: Record<string, string> = { planner: "planner", worker: "worker", manager: "lead", watchman: "watchman" };

const columnsOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const hasTable = (db: Database.Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

// Copies the rows of `table` that pass `keep`, by column name: a column the old table had and the new one dropped is left behind.
function copy(from: Database.Database, to: Db, table: string, keep: (row: Record<string, unknown>) => Record<string, unknown> | null = (r) => r): number {
  if (!hasTable(from, table)) return 0;
  const cols = columnsOf(to, table);
  let n = 0;
  for (const raw of from.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
    const row = keep(raw);
    if (!row) continue;
    const names = cols.filter((c) => c in row);
    to.prepare(`INSERT OR REPLACE INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((c) => row[c]));
    n++;
  }
  return n;
}

export function importHome(db: Db, oldDbPath: string): ImportCounts {
  if (!existsSync(oldDbPath)) throw new Error(`no yagura database at ${oldDbPath}`);
  const from = new Database(oldDbPath, { readonly: true, fileMustExist: true });
  const skipped: string[] = [];
  try {
    return db.transaction((): ImportCounts => {
      const settings = copy(from, db, "settings", (r) => {
        const key = RENAMED[r.key as string] ?? (r.key as string);
        if (r.scope === "project" || !(key in SETTINGS)) {
          skipped.push(`${r.scope}${r.scope_id ? `:${r.scope_id}` : ""} ${r.key}`);
          return null;
        }
        return { ...r, key };
      });
      const environments = copy(from, db, "environments");
      const environmentValues = copy(from, db, "environment_values");
      const templates = copy(from, db, "env_templates");
      const repos = copy(from, db, "repos", (r) => ({ ...r, revert_scan_sha: null }));
      const prompts = copy(from, db, "prompt_texts", (r) => {
        const role = r.role === "all" ? "all" : PROMPT_ROLES[r.role as string];
        return r.scope === "global" && role ? { ...r, role } : null;
      });
      const threads = copy(from, db, "threads", (r) => ({ ...r, reported_json: "{}" }));
      const messages = copy(from, db, "thread_messages");
      const decisions = copy(from, db, "thread_decisions");
      const questions = copy(from, db, "thread_questions");
      copy(from, db, "issue_watches");
      const issues = copy(from, db, "forge_issues");
      return { settings, environments, environmentValues, templates, repos, prompts, threads, messages, decisions, questions, issues, skipped };
    })();
  } finally {
    from.close();
  }
}

export const describeImport = (c: ImportCounts) =>
  [
    `settings ${c.settings}`,
    `environments ${c.environments} (${c.environmentValues} values)`,
    `templates ${c.templates}`,
    `repos ${c.repos}`,
    `prompts ${c.prompts}`,
    `threads ${c.threads} (${c.messages} messages, ${c.decisions} decisions, ${c.questions} questions, ${c.issues} issues)`,
    ...(c.skipped.length ? [`skipped ${c.skipped.length} settings that no longer exist or belong to a project`] : []),
  ].join("\n");
