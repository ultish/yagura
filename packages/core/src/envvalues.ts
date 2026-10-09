import type { EnvironmentId } from "./domain.js";
import { getEnvironment, recordEvent, type Db } from "./store.js";

// Values are context for agents, not checks: a value that does not work shows up when an agent uses it.
export interface EnvValue {
  name: string;
  value: string;
  note: string;
  source: string;
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
  source: r.source as string,
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
  v: { name: string; value: string; note?: string; source?: string; replaces?: string },
): EnvValue {
  getEnvironment(db, environmentId);
  checkValueName(v.name);
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
    db.prepare("INSERT INTO environment_values (environment_id, name, value, note, source, position) VALUES (?, ?, ?, ?, ?, ?)").run(
      environmentId,
      v.name,
      v.value,
      v.note ?? "",
      v.source ?? existing?.source ?? "you",
      position,
    );
    recordEvent(db, "environment.value_set", {}, { environment: environmentId, name: v.name, replaces: v.replaces ?? null });
  })();
  return listValues(db, environmentId).find((x) => x.name === v.name)!;
}

export function deleteValue(db: Db, environmentId: EnvironmentId, name: string): boolean {
  const gone = db.prepare("DELETE FROM environment_values WHERE environment_id = ? AND name = ?").run(environmentId, name).changes > 0;
  if (gone) recordEvent(db, "environment.value_deleted", {}, { environment: environmentId, name });
  return gone;
}

export function valueBriefLines(db: Db, environmentId: EnvironmentId | null): string[] {
  if (!environmentId) return [];
  return listValues(db, environmentId).map((v) => `${v.name}=${v.value}${v.note ? ` (${v.note})` : ""}`);
}
