import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { EnvironmentId, ProjectId, RepoId, SettingScope } from "./domain.js";
import { now, type Db } from "./store.js";

export interface Bootstrap {
  home: string;
  packsDir: string;
  skillsDir: string;
  bind: string;
  port: number;
  tokenFile: string;
}

const BootstrapFile = z
  .object({
    home: z.string(),
    packs_dir: z.string(),
    skills_dir: z.string(),
    bind: z.string(),
    port: z.number().int().positive(),
    token_file: z.string(),
  })
  .partial();

export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../../../plugins/yagura", import.meta.url));

export function loadBootstrap(env: NodeJS.ProcessEnv = process.env): Bootstrap {
  const home = env.YAGURA_HOME ?? join(homedir(), ".yagura");
  const filePath = join(home, "yagura.yaml");
  const file = existsSync(filePath) ? BootstrapFile.parse(parseYaml(readFileSync(filePath, "utf8")) ?? {}) : {};
  return {
    home,
    packsDir: env.YAGURA_PACKS_DIR ?? file.packs_dir ?? join(home, "packs"),
    skillsDir: env.YAGURA_SKILLS_DIR ?? file.skills_dir ?? BUNDLED_SKILLS_DIR,
    bind: env.YAGURA_BIND ?? file.bind ?? "127.0.0.1",
    port: env.YAGURA_PORT ? Number(env.YAGURA_PORT) : (file.port ?? 7300),
    tokenFile: env.YAGURA_TOKEN_FILE ?? file.token_file ?? join(home, "token"),
  };
}

export const SETTINGS = {
  max_parallel_agents: z.number().int().positive().default(4).describe("Most agents running at once, across every project"),
  max_parallel_per_harness: z.number().int().positive().default(4).describe("Most agents running at once on one harness (claude, …)"),
  "project.max_in_flight": z.number().int().positive().default(3).describe("Most agents running at once in one project"),
  "timebox.plan_seconds": z.number().int().positive().default(900).describe("How long a planner may run before it is stopped"),
  "harness.claude.bin": z.string().default("claude").describe("The claude executable yagura runs"),
  "harness.claude.permission_mode": z.string().default("bypassPermissions").describe("Permission mode passed to claude"),
  "harness.claude.extra_args": z.array(z.string()).default([]).describe("Extra arguments added to every claude run"),
  "role.worker.harness": z.string().default("claude").describe("Harness that runs workers"),
  "role.worker.model": z.string().nullable().default(null).describe("Model for workers (empty: the harness default)"),
  "role.verifier.harness": z.string().default("claude").describe("Harness that runs verifiers"),
  "role.verifier.model": z.string().nullable().default(null).describe("Model for verifiers (empty: the harness default)"),
  "role.planner.harness": z.string().default("claude").describe("Harness that runs planners"),
  "role.planner.model": z.string().nullable().default(null).describe("Model for planners (empty: the harness default)"),
  "role.watchman.harness": z.string().default("claude").describe("Harness that runs the watchman"),
  "role.watchman.model": z.string().nullable().default(null).describe("Model for the watchman (empty: the harness default)"),
  "timebox.watchman_seconds": z.number().int().positive().default(900).describe("How long one watchman turn may run"),
  "watchman.context_tokens": z.number().int().min(4000).default(40000).describe("Size budget for the watchman's brief"),
  "timebox.work_seconds": z.number().int().positive().default(1800).describe("How long a worker may run before it is stopped"),
  "timebox.verify_seconds": z.number().int().positive().default(1200).describe("How long a verifier may run before it is stopped"),
  "verify.max_retries": z.number().int().positive().default(2).describe("Fresh verify runs after an invalid or blocked verdict"),
  max_attempts: z.number().int().positive().default(2).describe("Tries a unit gets before it blocks"),
  "git.author_name": z.string().default("yagura").describe("Author name on landed commits"),
  "git.author_email": z.string().default("yagura@localhost").describe("Author email on landed commits"),
  "git.branch_prefix": z.string().default("yg").describe("Prefix for unit branches"),
  "yagura.url": z.string().url().nullable().default(null).describe("Dashboard URL linked from commit trailers"),
  "method.enforce_required_skills": z.boolean().default(true).describe("Reject work that skipped a required skill"),
} satisfies Record<string, z.ZodTypeAny>;

export type SettingKey = keyof typeof SETTINGS;
export type OverrideScope = Exclude<SettingScope, "global">;

const P: readonly OverrideScope[] = ["project"];
const PR: readonly OverrideScope[] = ["project", "repo"];
const PRE: readonly OverrideScope[] = ["project", "repo", "environment"];

// The layers each setting is read at; an override anywhere else would never take effect.
export const SETTING_LAYERS: Record<SettingKey, readonly OverrideScope[]> = {
  max_parallel_agents: [],
  max_parallel_per_harness: [],
  "project.max_in_flight": P,
  "timebox.plan_seconds": P,
  "harness.claude.bin": P,
  "harness.claude.permission_mode": P,
  "harness.claude.extra_args": P,
  "role.worker.harness": PR,
  "role.worker.model": PR,
  "role.verifier.harness": PRE,
  "role.verifier.model": PRE,
  "role.planner.harness": P,
  "role.planner.model": P,
  "role.watchman.harness": [],
  "role.watchman.model": [],
  "timebox.watchman_seconds": [],
  "watchman.context_tokens": [],
  "timebox.work_seconds": PR,
  "timebox.verify_seconds": PRE,
  "verify.max_retries": P,
  max_attempts: PR,
  "git.author_name": PR,
  "git.author_email": PR,
  "git.branch_prefix": PR,
  "yagura.url": PR,
  "method.enforce_required_skills": PR,
};
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]>;
export type SettingSource = SettingScope | "default";

export interface SettingsContext {
  environmentId?: EnvironmentId | null;
  repoId?: RepoId | null;
  projectId?: ProjectId | null;
}

export class UnknownSetting extends Error {}
export class SettingNotLayered extends Error {}

function checkLayer(key: string, scope: SettingScope): void {
  schemaFor(key);
  if (scope === "global") return;
  const layers = SETTING_LAYERS[key as SettingKey];
  if (!layers.includes(scope))
    throw new SettingNotLayered(
      `${key} cannot be set per ${scope}; ${layers.length ? `it can be set globally or per ${layers.join(" or ")}` : "it is global only"}`,
    );
}

function schemaFor(key: string): z.ZodTypeAny {
  const schema = (SETTINGS as Record<string, z.ZodTypeAny>)[key];
  if (!schema) throw new UnknownSetting(`unknown setting ${key}`);
  return schema;
}

export function setSetting(db: Db, scope: SettingScope, scopeId: string, key: string, value: unknown): void {
  checkLayer(key, scope);
  const parsed = schemaFor(key).parse(value);
  db.prepare(
    `INSERT INTO settings (scope, scope_id, key, value_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (scope, scope_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(scope, scope === "global" ? "" : scopeId, key, JSON.stringify(parsed), now());
}

export function resolveSetting<K extends SettingKey>(db: Db, key: K, ctx: SettingsContext = {}): { value: SettingValue<K>; source: SettingSource } {
  const layers: [SettingScope, string | null | undefined][] = [
    ["project", ctx.projectId],
    ["repo", ctx.repoId],
    ["environment", ctx.environmentId],
    ["global", ""],
  ];
  const get = db.prepare("SELECT value_json FROM settings WHERE scope = ? AND scope_id = ? AND key = ?");
  for (const [scope, id] of layers) {
    if (id === null || id === undefined) continue;
    const row = get.get(scope, id, key) as { value_json: string } | undefined;
    if (row) return { value: schemaFor(key).parse(JSON.parse(row.value_json)), source: scope };
  }
  return { value: schemaFor(key).parse(undefined), source: "default" };
}

export function effectiveSettings(db: Db, ctx: SettingsContext = {}): Record<SettingKey, { value: unknown; source: SettingSource }> {
  return Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map((k) => [k, resolveSetting(db, k, ctx)])) as Record<
    SettingKey,
    { value: unknown; source: SettingSource }
  >;
}

export function clearSetting(db: Db, scope: SettingScope, scopeId: string, key: string): boolean {
  schemaFor(key);
  return db.prepare("DELETE FROM settings WHERE scope = ? AND scope_id = ? AND key = ?").run(scope, scope === "global" ? "" : scopeId, key).changes > 0;
}

export interface SettingInfo {
  key: SettingKey;
  value: unknown;
  source: SettingSource;
  default: unknown;
  description: string;
  layers: readonly OverrideScope[];
}

export function describeSettings(db: Db, ctx: SettingsContext = {}, scope: OverrideScope | null = null): SettingInfo[] {
  return (Object.keys(SETTINGS) as SettingKey[])
    .filter((key) => !scope || SETTING_LAYERS[key].includes(scope))
    .map((key) => ({
      key,
      ...resolveSetting(db, key, ctx),
      default: SETTINGS[key].parse(undefined),
      description: SETTINGS[key].description ?? "",
      layers: SETTING_LAYERS[key],
    }));
}

type ScopedValues = Record<string, Record<string, unknown>>;
export interface SettingsFile {
  global?: Record<string, unknown>;
  environment?: ScopedValues;
  repo?: ScopedValues;
  project?: ScopedValues;
}

export function exportSettings(db: Db): string {
  const rows = db.prepare("SELECT scope, scope_id, key, value_json FROM settings ORDER BY scope, scope_id, key").all() as {
    scope: SettingScope;
    scope_id: string;
    key: string;
    value_json: string;
  }[];
  const out: SettingsFile = {};
  for (const r of rows) {
    const value = JSON.parse(r.value_json);
    if (r.scope === "global") (out.global ??= {})[r.key] = value;
    else ((out[r.scope] ??= {})[r.scope_id] ??= {})[r.key] = value;
  }
  return stringifyYaml(out);
}

export class SettingsImportInvalid extends Error {}

export function importSettings(db: Db, text: string): number {
  let doc: unknown;
  try {
    doc = parseYaml(text) ?? {};
  } catch (e) {
    throw new SettingsImportInvalid(`not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const values = z.record(z.unknown());
  const parsed = z
    .object({ global: values.optional(), environment: z.record(values).optional(), repo: z.record(values).optional(), project: z.record(values).optional() })
    .strict()
    .safeParse(doc);
  if (!parsed.success) throw new SettingsImportInvalid(parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; "));
  const writes: [SettingScope, string, string, unknown][] = [];
  for (const [key, value] of Object.entries(parsed.data.global ?? {})) writes.push(["global", "", key, value]);
  for (const scope of ["environment", "repo", "project"] as const)
    for (const [id, entries] of Object.entries(parsed.data[scope] ?? {}))
      for (const [key, value] of Object.entries(entries)) writes.push([scope, id, key, value]);
  for (const [scope, id, key, value] of writes) {
    const schema = (SETTINGS as Record<string, z.ZodTypeAny>)[key];
    const where = scope === "global" ? `global.${key}` : `${scope}.${id}.${key}`;
    if (!schema) throw new SettingsImportInvalid(`${where}: unknown setting`);
    try {
      checkLayer(key, scope);
    } catch (e) {
      throw new SettingsImportInvalid(`${where}: ${(e as Error).message}`);
    }
    const check = schema.safeParse(value);
    if (!check.success) throw new SettingsImportInvalid(`${where}: ${check.error.issues.map((i) => i.message).join("; ")}`);
  }
  db.transaction(() => {
    for (const [scope, id, key, value] of writes) setSetting(db, scope, id, key, value);
  })();
  return writes.length;
}
