import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { resolveSetting, setSetting, type Bootstrap } from "./config.js";
import { PROVIDERS, type EnvironmentId } from "./domain.js";
import { checkValueName, listValues, setEnvironmentNotes, setValue } from "./envvalues.js";
import { doctorEnvironment, PROVIDERS_IMPL } from "./leases.js";
import { applyPreset, PRESETS } from "./presets.js";
import { addEnvironment, getEnvironment, recordEvent, type Db } from "./store.js";

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
    values: z
      .array(
        z
          .object({
            name: z.string(),
            value: z.string(),
            note: z.string().default(""),
            check: z.string().nullable().default(null),
            ask: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type EnvTemplate = z.output<typeof EnvTemplate>;

export class TemplateInvalid extends Error {}

export const templatesDir = (boot: Bootstrap) => join(boot.home, "templates");

export function listTemplates(boot: Bootstrap): { template: EnvTemplate | null; file: string; error: string | null }[] {
  const dir = templatesDir(boot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => {
      const parsed = EnvTemplate.safeParse(parseYaml(readFileSync(join(dir, file), "utf8")) ?? {});
      return parsed.success
        ? { template: parsed.data, file, error: null }
        : { template: null, file, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    });
}

export function getTemplate(boot: Bootstrap, name: string): EnvTemplate {
  const found = listTemplates(boot).find((t) => t.template?.name === name);
  if (!found?.template) throw new TemplateInvalid(`no template named ${name} in ${templatesDir(boot)}`);
  return found.template;
}

// Values marked ask are facts about one machine: the file keeps them as examples and applying asks for them.
export function saveTemplate(
  db: Db,
  boot: Bootstrap,
  environmentId: EnvironmentId,
  input: { name: string; description?: string; ask?: string[] },
): { template: EnvTemplate; path: string } {
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
    values: values.map((v) => ({ name: v.name, value: v.value, note: v.note, check: v.check, ask: (input.ask ?? []).includes(v.name) })),
  });
  mkdirSync(templatesDir(boot), { recursive: true });
  const path = join(templatesDir(boot), `${input.name}.yaml`);
  writeFileSync(path, stringifyYaml(template));
  recordEvent(db, "template.saved", {}, { template: input.name, from: environmentId, ask: input.ask ?? [] });
  return { template, path };
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
    presets: z.array(z.string()).default([]),
    values: z
      .array(z.object({ name: z.string(), value: z.string(), note: z.string().default(""), check: z.string().nullable().default(null) }).strict())
      .default([]),
  })
  .strict();
export type EnvironmentDraft = z.output<typeof EnvironmentDraft>;

export function draftFromTemplate(
  boot: Bootstrap,
  name: string,
  input: { id: string; name?: string; answers?: Record<string, string>; config?: Record<string, unknown> },
): EnvironmentDraft {
  const t = getTemplate(boot, name);
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
    values: t.values.map((v) => ({ name: v.name, value: v.ask ? answers[v.name]!.trim() : v.value, note: v.note, check: v.check })),
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
    recordEvent(db, "environment.created", {}, { environment: id, source });
  })();
  return id;
}

export async function applyTemplate(
  ctx: { db: Db; boot: Bootstrap },
  name: string,
  input: { id: string; name?: string; answers?: Record<string, string>; config?: Record<string, unknown> },
): Promise<{ ok: boolean; environmentId: EnvironmentId }> {
  const id = createEnvironment(ctx.db, draftFromTemplate(ctx.boot, name, input), `template ${name}`);
  recordEvent(ctx.db, "template.applied", {}, { template: name, environment: id });
  const doctor = await doctorEnvironment(ctx.db, ctx.boot, id);
  return { ok: doctor.ok, environmentId: id };
}
