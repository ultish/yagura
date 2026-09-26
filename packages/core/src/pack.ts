import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PASS_TIERS, PROVIDERS, type Role } from "./domain.js";

export const VerifyPack = z.object({
  provider: z.enum(PROVIDERS),
  doctor: z.string().optional(),
  deploy: z.string().optional(),
  teardown: z.string().optional(),
  checks: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        command: z.string().min(1),
        tier: z.enum(PASS_TIERS),
        timeoutSeconds: z.number().int().positive().default(300),
      }),
    )
    .min(1),
  features: z.array(z.object({ name: z.string(), doc: z.string() })).default([]),
  protected: z.array(z.string()).default([]),
});
export type VerifyPack = z.output<typeof VerifyPack>;

export type PackLoad = { ok: true; pack: VerifyPack } | { ok: false; reason: string };

export function loadPack(worktree: string, packPath: string): PackLoad {
  const file = join(worktree, packPath, "verify.json");
  if (!existsSync(file)) return { ok: false, reason: `no verify pack at ${packPath}/verify.json` };
  const parsed = VerifyPack.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) return { ok: false, reason: `invalid verify.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { ok: true, pack: parsed.data };
}

export const REQUIRED_SKILLS: Partial<Record<Role, readonly string[]>> = {
  worker: ["yagura:yagura-worker", "pstack:poteto-mode"],
  verifier: ["yagura:yagura-verifier"],
};

export function missingSkills(role: Role, loaded: readonly string[]): string[] {
  const bare = (s: string) => s.slice(s.indexOf(":") + 1);
  return (REQUIRED_SKILLS[role] ?? []).filter((req) => !loaded.some((l) => l === req || bare(l) === bare(req)));
}
