import type BetterSqlite3 from "better-sqlite3";

// A migration that rebuilds a table (SQLite cannot change a CHECK in place) runs with foreign keys off, then checks them.
export interface Migration {
  version: number;
  sql?: string;
  rebuild?: (db: BetterSqlite3.Database) => void;
}

// schema.sql is version 1, the clean start of the core-loop build; every later change to it is one entry here.
export const MIGRATIONS: readonly Migration[] = [
  // Which verification-guide page proves each acceptance line: a JSON array as long as acceptance_json, each entry null or { pages, isNew }.
  { version: 2, sql: "ALTER TABLE units ADD COLUMN proof_json TEXT NOT NULL DEFAULT '[]';" },
  // The guide page a recorded run drove, so a judge's runs can be matched to the pages a unit names.
  { version: 3, sql: "ALTER TABLE evidence_runs ADD COLUMN page TEXT;" },
  // A standing project has no end: it is never closed, and the developer adds work to it whenever they like.
  { version: 4, sql: "ALTER TABLE projects ADD COLUMN standing INTEGER NOT NULL DEFAULT 0 CHECK (standing IN (0, 1));" },
];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 1;
