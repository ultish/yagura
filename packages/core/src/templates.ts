import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { resolveSetting, setSetting, type Bootstrap } from "./config.js";
import { PROVIDERS, type EnvironmentId } from "./domain.js";
import { checkValueName, listValues, setEnvironmentNotes, setValue } from "./envvalues.js";
import { doctorEnvironment, PROVIDERS_IMPL } from "./leases.js";
import { addEnvironment, getEnvironment, recordEvent, type Db } from "./store.js";

const TEMPLATE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export const EnvTemplate = z
  .object({
    name: z.string().regex(TEMPLATE_NAME),
    description: z.string().default(""),
    provider: z.enum(PROVIDERS),
    providerConfig: z.record(z.unknown()).default({}),
    capacity: z.number().int().min(0),
    notes: z.string().default(""),
    keep: z
      .object({ policy: z.enum(["never", "failed", "always"]), hours: z.number().positive() })
      .strict()
      .optional(),
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

export async function applyTemplate(
  ctx: { db: Db; boot: Bootstrap },
  name: string,
  input: { id: string; name?: string; answers?: Record<string, string>; config?: Record<string, unknown> },
): Promise<{ ok: boolean; environmentId: EnvironmentId }> {
  const { db, boot } = ctx;
  const t = getTemplate(boot, name);
  const answers = input.answers ?? {};
  const unanswered = t.values.filter((v) => v.ask && !answers[v.name]?.trim()).map((v) => v.name);
  if (unanswered.length) throw new TemplateInvalid(`template ${name} needs a value for ${unanswered.join(", ")}`);
  for (const v of t.values) checkValueName(v.name);
  const providerConfig = { ...t.providerConfig, ...(input.config ?? {}) };
  const impl = PROVIDERS_IMPL[t.provider];
  const problem = impl ? impl.validateConfig(providerConfig, t.capacity) : `provider ${t.provider} is not available yet`;
  if (problem) throw new TemplateInvalid(problem);
  if (db.prepare("SELECT 1 FROM environments WHERE id = ?").get(input.id)) throw new TemplateInvalid(`environment ${input.id} already exists`);
  const id = input.id as EnvironmentId;
  db.transaction(() => {
    addEnvironment(db, { id, name: input.name?.trim() || id, provider: t.provider, capacity: t.capacity, providerConfig });
    for (const v of t.values)
      setValue(db, id, { name: v.name, value: v.ask ? answers[v.name]!.trim() : v.value, note: v.note, check: v.check, source: `template ${t.name}` });
    setEnvironmentNotes(db, id, t.notes);
    if (t.keep) {
      setSetting(db, "environment", id, "lease.keep", t.keep.policy);
      setSetting(db, "environment", id, "lease.keep_hours", t.keep.hours);
    }
    recordEvent(db, "template.applied", {}, { template: t.name, environment: id });
  })();
  const doctor = await doctorEnvironment(db, boot, id);
  return { ok: doctor.ok, environmentId: id };
}
