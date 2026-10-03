import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { resolveSetting, setSetting, SETTING_LAYERS, SETTINGS, type Bootstrap, type SettingKey } from "./config.js";
import { PROVIDERS, type EnvironmentId } from "./domain.js";
import { checkValueName, listValues, setEnvironmentNotes, setValue } from "./envvalues.js";
import { PROVIDERS_IMPL } from "./leases.js";
import { applyPreset, PRESETS } from "./presets.js";
import { addEnvironment, getEnvironment, now, recordEvent, type Db } from "./store.js";

const TEMPLATE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const ENVIRONMENT_ID = /^[a-z][a-z0-9-]{1,39}$/;
const Keep = z.object({ policy: z.enum(["never", "failed", "always"]), hours: z.number().positive() }).strict();

export const EnvTemplate = z
  .object({
    name: z.string().regex(TEMPLATE_NAME),
    description: z.string().default(""),
    provider: z.enum(PROVIDERS),
    providerConfig: z.record(z.unknown()).default({}),
    capacity: z.number().int().min(0),
    notes: z.string().default(""),
    keep: Keep.optional(),
    settings: z.record(z.unknown()).default({}),
    values: z
      .array(
        z
          .object({
            name: z.string(),
            value: z.string(),
            note: z.string().default(""),
            // Templates saved before value checks were removed (2026-09-30) still carry them; they are ignored.
            check: z.unknown().optional(),
            ask: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type EnvTemplate = z.output<typeof EnvTemplate>;

export class TemplateInvalid extends Error {}

// Templates live in yagura's store and are shared as YAML: export one, and a teammate imports it.
export function listTemplates(db: Db): { name: string; template: EnvTemplate | null; error: string | null }[] {
  return (db.prepare("SELECT name, body_json FROM env_templates ORDER BY name").all() as { name: string; body_json: string }[]).map((r) => {
    const parsed = EnvTemplate.safeParse(JSON.parse(r.body_json));
    return parsed.success
      ? { name: r.name, template: parsed.data, error: null }
      : { name: r.name, template: null, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  });
}

export function getTemplate(db: Db, name: string): EnvTemplate {
  const found = listTemplates(db).find((t) => t.name === name);
  if (!found?.template) throw new TemplateInvalid(`no template named ${name}`);
  return found.template;
}

function storeTemplate(db: Db, template: EnvTemplate): void {
  db.prepare(
    `INSERT INTO env_templates (name, body_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET body_json = excluded.body_json, updated_at = excluded.updated_at`,
  ).run(template.name, JSON.stringify(template), now());
}

// Values marked ask are facts about one machine: the template keeps them as examples and applying asks for them.
export function saveTemplate(db: Db, environmentId: EnvironmentId, input: { name: string; description?: string; ask?: string[] }): { template: EnvTemplate } {
  if (!TEMPLATE_NAME.test(input.name)) throw new TemplateInvalid(`template names are lowercase words joined by dashes, e.g. spring-kube`);
  const env = getEnvironment(db, environmentId);
  const values = listValues(db, environmentId);
  const unknown = (input.ask ?? []).filter((n) => !values.some((v) => v.name === n));
  if (unknown.length) throw new TemplateInvalid(`not values of ${environmentId}: ${unknown.join(", ")}`);
  const sctx = { environmentId };
  const template = EnvTemplate.parse({
    name: input.name,
    description: input.description ?? "",
    provider: env.provider,
    providerConfig: env.providerConfig,
    capacity: env.capacity,
    notes: env.notes,
    keep: { policy: resolveSetting(db, "lease.keep", sctx).value, hours: resolveSetting(db, "lease.keep_hours", sctx).value },
    settings: Object.fromEntries(
      (
        db.prepare("SELECT key, value_json FROM settings WHERE scope = 'environment' AND scope_id = ? ORDER BY key").all(environmentId) as {
          key: string;
          value_json: string;
        }[]
      )
        .filter((r) => !r.key.startsWith("lease.keep"))
        .map((r) => [r.key, JSON.parse(r.value_json)]),
    ),
    values: values.map((v) => ({ name: v.name, value: v.value, note: v.note, ask: (input.ask ?? []).includes(v.name) })),
  });
  storeTemplate(db, template);
  recordEvent(db, "template.saved", {}, { template: input.name, from: environmentId, ask: input.ask ?? [] });
  return { template };
}

export function exportTemplate(db: Db, name: string): string {
  return stringifyYaml(getTemplate(db, name));
}

export function importTemplate(db: Db, yaml: string): EnvTemplate {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    throw new TemplateInvalid(`not YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = EnvTemplate.safeParse(raw ?? {});
  if (!parsed.success) throw new TemplateInvalid(parsed.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`).join("; "));
  storeTemplate(db, parsed.data);
  recordEvent(db, "template.imported", {}, { template: parsed.data.name });
  return parsed.data;
}

export function deleteTemplate(db: Db, name: string): void {
  getTemplate(db, name);
  db.prepare("DELETE FROM env_templates WHERE name = ?").run(name);
  recordEvent(db, "template.deleted", {}, { template: name });
}

// Templates used to be YAML files under ~/.yagura/templates; the daemon imports each valid one and removes it, and
// leaves a file it cannot read where it is, for the developer to fix.
export function importTemplateFiles(db: Db, boot: Bootstrap): { moved: string[]; refused: string[] } {
  const dir = join(boot.home, "templates");
  const out = { moved: [] as string[], refused: [] as string[] };
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const path = join(dir, file);
    try {
      const t = EnvTemplate.parse(parseYaml(readFileSync(path, "utf8")) ?? {});
      if (!listTemplates(db).some((x) => x.name === t.name)) storeTemplate(db, t);
      rmSync(path);
      out.moved.push(path);
    } catch (e) {
      out.refused.push(`${path}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  return out;
}

// What every way of making an environment (form, template, watchman) comes down to.
export const EnvironmentDraft = z
  .object({
    id: z.string().regex(ENVIRONMENT_ID, "environment ids are lowercase words joined by dashes, e.g. dev-2"),
    name: z.string().optional(),
    provider: z.enum(PROVIDERS).default("local-process"),
    providerConfig: z.record(z.unknown()).default({}),
    capacity: z.number().int().min(0).default(1),
    notes: z.string().default(""),
    keep: Keep.optional(),
    settings: z.record(z.unknown()).default({}),
    presets: z.array(z.string()).default([]),
    values: z.array(z.object({ name: z.string(), value: z.string(), note: z.string().default("") }).strict()).default([]),
  })
  .strict();
export type EnvironmentDraft = z.output<typeof EnvironmentDraft>;

export function draftFromTemplate(
  db: Db,
  name: string,
  input: { id: string; name?: string; answers?: Record<string, string>; config?: Record<string, unknown> },
): EnvironmentDraft {
  const t = getTemplate(db, name);
  const answers = input.answers ?? {};
  const unanswered = t.values.filter((v) => v.ask && !answers[v.name]?.trim()).map((v) => v.name);
  if (unanswered.length) throw new TemplateInvalid(`template ${name} needs a value for ${unanswered.join(", ")}`);
  return EnvironmentDraft.parse({
    id: input.id,
    name: input.name?.trim() || undefined,
    provider: t.provider,
    providerConfig: { ...t.providerConfig, ...(input.config ?? {}) },
    capacity: t.capacity,
    notes: t.notes,
    keep: t.keep,
    settings: t.settings,
    values: t.values.map((v) => ({ name: v.name, value: v.ask ? answers[v.name]!.trim() : v.value, note: v.note })),
  });
}

export function checkDraft(db: Db, d: EnvironmentDraft): void {
  if (db.prepare("SELECT 1 FROM environments WHERE id = ?").get(d.id)) throw new TemplateInvalid(`environment ${d.id} already exists`);
  const seen = new Set<string>();
  for (const v of d.values) {
    checkValueName(v.name);
    if (seen.has(v.name)) throw new TemplateInvalid(`${v.name} is listed twice`);
    seen.add(v.name);
  }
  const unknown = d.presets.filter((p) => !PRESETS.some((x) => x.id === p));
  if (unknown.length) throw new TemplateInvalid(`no preset ${unknown.join(", ")}; presets are ${PRESETS.map((p) => p.id).join(", ")}`);
  for (const [key, value] of Object.entries(d.settings)) {
    if (!(key in SETTINGS)) throw new TemplateInvalid(`no setting ${key}`);
    if (!SETTING_LAYERS[key as SettingKey].includes("environment")) throw new TemplateInvalid(`${key} cannot be set per environment`);
    const parsed = SETTINGS[key as SettingKey].safeParse(value);
    if (!parsed.success) throw new TemplateInvalid(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const impl = PROVIDERS_IMPL[d.provider];
  const problem = impl ? impl.validateConfig(d.providerConfig, d.capacity) : `provider ${d.provider} is not available yet`;
  if (problem) throw new TemplateInvalid(problem);
}

// Presets go after the draft's own values, so a value the draft sets wins over the preset's example.
export function createEnvironment(db: Db, d: EnvironmentDraft, source: string): EnvironmentId {
  checkDraft(db, d);
  const id = d.id as EnvironmentId;
  db.transaction(() => {
    addEnvironment(db, { id, name: d.name?.trim() || id, provider: d.provider, capacity: d.capacity, providerConfig: d.providerConfig });
    for (const v of d.values) setValue(db, id, { ...v, source });
    for (const p of d.presets) applyPreset(db, id, p);
    setEnvironmentNotes(db, id, d.notes);
    if (d.keep) {
      setSetting(db, "environment", id, "lease.keep", d.keep.policy);
      setSetting(db, "environment", id, "lease.keep_hours", d.keep.hours);
    }
    for (const [key, value] of Object.entries(d.settings)) setSetting(db, "environment", id, key as SettingKey, value as never);
    recordEvent(db, "environment.created", {}, { environment: id, source });
  })();
  return id;
}

export async function applyTemplate(
  ctx: { db: Db; boot: Bootstrap },
  name: string,
  input: { id: string; name?: string; answers?: Record<string, string>; config?: Record<string, unknown> },
): Promise<{ environmentId: EnvironmentId }> {
  const id = createEnvironment(ctx.db, draftFromTemplate(ctx.db, name, input), `template ${name}`);
  recordEvent(ctx.db, "template.applied", {}, { template: name, environment: id });
  return { environmentId: id };
}
