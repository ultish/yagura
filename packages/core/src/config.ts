import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
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
  max_parallel_agents: z.number().int().positive().default(4),
  max_parallel_per_harness: z.number().int().positive().default(4),
  "project.max_in_flight": z.number().int().positive().default(3),
  "timebox.plan_seconds": z.number().int().positive().default(900),
  "harness.claude.bin": z.string().default("claude"),
  "harness.claude.permission_mode": z.string().default("bypassPermissions"),
  "harness.claude.extra_args": z.array(z.string()).default([]),
  "role.worker.harness": z.string().default("claude"),
  "role.worker.model": z.string().nullable().default(null),
  "role.verifier.harness": z.string().default("claude"),
  "role.verifier.model": z.string().nullable().default(null),
  "role.planner.harness": z.string().default("claude"),
  "role.planner.model": z.string().nullable().default(null),
  "timebox.work_seconds": z.number().int().positive().default(1800),
  "timebox.verify_seconds": z.number().int().positive().default(1200),
  "verify.max_retries": z.number().int().positive().default(2),
  max_attempts: z.number().int().positive().default(2),
  "git.author_name": z.string().default("yagura"),
  "git.author_email": z.string().default("yagura@localhost"),
  "git.branch_prefix": z.string().default("yg"),
  "yagura.url": z.string().url().nullable().default(null),
  "method.enforce_required_skills": z.boolean().default(true),
} satisfies Record<string, z.ZodTypeAny>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]>;
export type SettingSource = SettingScope | "default";

export interface SettingsContext {
  environmentId?: EnvironmentId | null;
  repoId?: RepoId | null;
  projectId?: ProjectId | null;
}

export class UnknownSetting extends Error {}

function schemaFor(key: string): z.ZodTypeAny {
  const schema = (SETTINGS as Record<string, z.ZodTypeAny>)[key];
  if (!schema) throw new UnknownSetting(`unknown setting ${key}`);
  return schema;
}

export function setSetting(db: Db, scope: SettingScope, scopeId: string, key: string, value: unknown): void {
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
