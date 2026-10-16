import type BetterSqlite3 from "better-sqlite3";

// A migration that rebuilds a table (SQLite cannot change a CHECK in place) runs with foreign keys off, then checks them.
export interface Migration {
  version: number;
  sql?: string;
  rebuild?: (db: BetterSqlite3.Database) => void;
}

// schema.sql is version 1, the clean start of the core-loop build; every later change to it is one entry here.
export const MIGRATIONS: readonly Migration[] = [];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 1;
