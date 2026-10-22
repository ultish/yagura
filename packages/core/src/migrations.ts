import type BetterSqlite3 from "better-sqlite3";
import { titleFromGoal } from "./title.js";

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
  // A release tag yagura puts on the commit that merged the unit and pushes to the forge itself; a worker's push is limited to its own branch.
  { version: 5, sql: "ALTER TABLE units ADD COLUMN tag TEXT; ALTER TABLE units ADD COLUMN tag_pushed_at TEXT;" },
  // A short human-readable name for a unit, apart from its goal, which may be as long and detailed as the work needs. Existing units get a clipped goal.
  {
    version: 6,
    sql: "ALTER TABLE units ADD COLUMN title TEXT NOT NULL DEFAULT ''; UPDATE units SET title = CASE WHEN length(goal) <= 80 THEN goal ELSE substr(goal, 1, 79) || '…' END;",
  },
  // Version 6 cut a long goal at 80 characters, mid-word; cut at a word instead.
  {
    version: 7,
    rebuild: (db) => {
      const rows = db.prepare("SELECT id, goal FROM units WHERE length(title) = 80 AND title LIKE '%…'").all() as { id: number; goal: string }[];
      const set = db.prepare("UPDATE units SET title = ? WHERE id = ?");
      for (const r of rows) set.run(titleFromGoal(r.goal), r.id);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 1;
