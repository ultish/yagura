import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

type Mode = "deferred" | "immediate" | "exclusive";
export type Transaction<A extends unknown[], R> = ((...args: A) => R) & Record<Mode, (...args: A) => R>;

// SQLITE_BUSY is result code 5; extended codes keep it in the low byte.
export const isBusy = (e: unknown): boolean => {
  const code = (e as { errcode?: number } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === 5;
};

const statement = (s: StatementSync): Statement => {
  const binds = (params: unknown[]) => (params.length === 1 && Array.isArray(params[0]) ? (params[0] as never[]) : (params as never[]));
  return {
    get: (...p) => s.get(...binds(p)),
    all: (...p) => s.all(...binds(p)),
    run: (...p) => s.run(...binds(p)),
  };
};

// The node:sqlite calls yagura makes, shaped like better-sqlite3's so the store reads the same on a Node that ships SQLite and needs nothing compiled.
export class Database {
  private readonly raw: DatabaseSync;
  private savepoints = 0;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.raw = new DatabaseSync(path, { readOnly: options.readonly ?? false });
  }

  get inTransaction(): boolean {
    return this.raw.isTransaction;
  }

  prepare(sql: string): Statement {
    return statement(this.raw.prepare(sql));
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.raw.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[];
    return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }

  close(): void {
    this.raw.close();
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): Transaction<A, R> {
    const within =
      (mode: Mode) =>
      (...args: A): R => {
        if (this.raw.isTransaction) {
          const name = `yagura_sp_${this.savepoints++}`;
          this.raw.exec(`SAVEPOINT ${name}`);
          try {
            const result = fn(...args);
            this.raw.exec(`RELEASE ${name}`);
            return result;
          } catch (e) {
            if (this.raw.isTransaction) {
              this.raw.exec(`ROLLBACK TO ${name}`);
              this.raw.exec(`RELEASE ${name}`);
            }
            throw e;
          }
        }
        this.raw.exec(`BEGIN ${mode.toUpperCase()}`);
        try {
          const result = fn(...args);
          this.raw.exec("COMMIT");
          return result;
        } catch (e) {
          if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
          throw e;
        }
      };
    return Object.assign(within("deferred"), { deferred: within("deferred"), immediate: within("immediate"), exclusive: within("exclusive") });
  }
}
