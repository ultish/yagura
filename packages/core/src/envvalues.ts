import { exec } from "node:child_process";
import picomatch from "picomatch";
import type { EnvironmentId, IsoTime } from "./domain.js";
import { getEnvironment, now, recordEvent, type Db } from "./store.js";

export interface EnvValue {
  name: string;
  value: string;
  note: string;
  check: string | null;
  source: string;
  last: { ok: boolean; detail: string; at: IsoTime } | null;
}

export const VALUE_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
// yagura sets these per slot or per session; a value of the same name would silently lose or win.
const RESERVED = /^(YAGURA_|KUBECONTEXT$|PATH$|HOME$)/;

export class ValueInvalid extends Error {}

export function checkValueName(name: string): void {
  if (!VALUE_NAME.test(name)) throw new ValueInvalid(`${name || "(empty)"}: names are UPPER_CASE letters, digits, and _`);
  if (RESERVED.test(name)) throw new ValueInvalid(`${name} is set by yagura; choose another name`);
}

type Row = Record<string, unknown>;
const toValue = (r: Row): EnvValue => ({
  name: r.name as string,
  value: r.value as string,
  note: r.note as string,
  check: (r.check_cmd as string | null) ?? null,
  source: r.source as string,
  last: r.last_checked_at ? { ok: r.last_ok === 1, detail: (r.last_detail as string) ?? "", at: r.last_checked_at as IsoTime } : null,
});

export function listValues(db: Db, environmentId: EnvironmentId): EnvValue[] {
  return (db.prepare("SELECT * FROM environment_values WHERE environment_id = ? ORDER BY position, name").all(environmentId) as Row[]).map(toValue);
}

export function valueMap(db: Db, environmentId: EnvironmentId | null): Record<string, string> {
  if (!environmentId) return {};
  return Object.fromEntries(listValues(db, environmentId).map((v) => [v.name, v.value]));
}

export function setValue(
  db: Db,
  environmentId: EnvironmentId,
  v: { name: string; value: string; note?: string; check?: string | null; source?: string; replaces?: string },
): EnvValue {
  getEnvironment(db, environmentId);
  checkValueName(v.name);
  const check = v.check?.trim() || null;
  db.transaction(() => {
    const old = v.replaces && v.replaces !== v.name ? v.replaces : v.name;
    const existing = db.prepare("SELECT position, source FROM environment_values WHERE environment_id = ? AND name = ?").get(environmentId, old) as
      { position: number; source: string } | undefined;
    if (v.replaces && v.replaces !== v.name && db.prepare("SELECT 1 FROM environment_values WHERE environment_id = ? AND name = ?").get(environmentId, v.name))
      throw new ValueInvalid(`${v.name} already exists in ${environmentId}`);
    const position =
      existing?.position ??
      ((db.prepare("SELECT MAX(position) AS p FROM environment_values WHERE environment_id = ?").get(environmentId) as { p: number | null }).p ?? -1) + 1;
    if (existing) db.prepare("DELETE FROM environment_values WHERE environment_id = ? AND name = ?").run(environmentId, old);
    db.prepare("INSERT INTO environment_values (environment_id, name, value, note, check_cmd, source, position) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      environmentId,
      v.name,
      v.value,
      v.note ?? "",
      check,
      v.source ?? existing?.source ?? "you",
      position,
    );
    recordEvent(db, "environment.value_set", {}, { environment: environmentId, name: v.name, replaces: v.replaces ?? null, checked: check !== null });
  })();
  return listValues(db, environmentId).find((x) => x.name === v.name)!;
}

export function deleteValue(db: Db, environmentId: EnvironmentId, name: string): boolean {
  const gone = db.prepare("DELETE FROM environment_values WHERE environment_id = ? AND name = ?").run(environmentId, name).changes > 0;
  if (gone) recordEvent(db, "environment.value_deleted", {}, { environment: environmentId, name });
  return gone;
}

export function setEnvironmentNotes(db: Db, environmentId: EnvironmentId, notes: string): void {
  getEnvironment(db, environmentId);
  db.prepare("UPDATE environments SET notes = ? WHERE id = ?").run(notes, environmentId);
}

export function environmentNotes(db: Db, environmentId: EnvironmentId | null): string {
  if (!environmentId) return "";
  return (db.prepare("SELECT notes FROM environments WHERE id = ?").get(environmentId) as { notes: string } | undefined)?.notes ?? "";
}

export function runCheck(command: string, values: Record<string, string>, timeoutMs = 20_000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    exec(command, { env: { ...process.env, ...values }, timeout: timeoutMs, shell: "/bin/sh" }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300) ?? "";
      if (!err) return resolve({ ok: true, detail: out || "exit 0" });
      const e = err as { killed?: boolean; code?: number | null };
      resolve({ ok: false, detail: e.killed ? `timed out after ${timeoutMs / 1000}s` : `exit ${e.code ?? "?"}${out ? `: ${out}` : ""}` });
    });
  });
}

export async function checkValues(db: Db, environmentId: EnvironmentId): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const values = valueMap(db, environmentId);
  const results: { name: string; ok: boolean; detail: string }[] = [];
  for (const v of listValues(db, environmentId).filter((x) => x.check)) {
    const r = await runCheck(v.check!, values);
    db.prepare("UPDATE environment_values SET last_ok = ?, last_detail = ?, last_checked_at = ? WHERE environment_id = ? AND name = ?").run(
      r.ok ? 1 : 0,
      r.detail,
      now(),
      environmentId,
      v.name,
    );
    results.push({ name: `value ${v.name}`, ...r });
  }
  return results;
}

// Deterministic, from the value's shape only; the developer sees it run once and decides.
export function suggestCheck(name: string, value: string): string | null {
  const ref = `"$${name}"`;
  if (/^rediss?:\/\//.test(value)) return `redis-cli -u ${ref} ping`;
  if (/^https?:\/\//.test(value)) return `curl -sf -o /dev/null ${ref}`;
  if (/^(postgres|postgresql):\/\//.test(value)) return `pg_isready -d ${ref}`;
  if (/^mongodb(\+srv)?:\/\//.test(value)) return `mongosh --quiet --eval 'db.runCommand({ping:1})' ${ref}`;
  const hostPort = /^([A-Za-z0-9.-]+):(\d{2,5})$/.exec(value);
  if (hostPort) return `nc -z -w 5 ${hostPort[1]} ${hostPort[2]}`;
  return null;
}

export function valueBriefLines(db: Db, environmentId: EnvironmentId | null): string[] {
  if (!environmentId) return [];
  return listValues(db, environmentId).map((v) => `${v.name}=${v.value}${v.note ? ` (${v.note})` : ""}`);
}

// Short values ("dev", "true") are too common to mean anything when they appear in a file.
const MIN_LITERAL = 8;

export function hardCodedValues(
  added: { path: string; line: string }[],
  values: Record<string, string>,
  allowed: string[],
): { name: string; value: string; path: string }[] {
  const isAllowed = picomatch(allowed.length ? allowed : ["\0"], { dot: true });
  const found = new Map<string, { name: string; value: string; path: string }>();
  for (const [name, value] of Object.entries(values)) {
    if (value.length < MIN_LITERAL) continue;
    for (const a of added)
      if (!isAllowed(a.path) && a.line.includes(value) && !found.has(`${name}:${a.path}`)) found.set(`${name}:${a.path}`, { name, value, path: a.path });
  }
  return [...found.values()];
}
