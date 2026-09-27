import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { Environment } from "./domain.js";

const run = promisify(execFile);

export const KubeConfig = z
  .object({
    context: z.string().min(1).optional(),
    mode: z.enum(["create", "pool"]).default("create"),
    pool: z.array(z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)).default([]),
    prefix: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,15}$/)
      .default("yg"),
    kubectl: z.string().min(1).default("kubectl"),
    baseUrl: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => c.mode === "create" || c.pool.length > 0, "pool mode needs at least one namespace in pool");
export type KubeConfig = z.output<typeof KubeConfig>;

export const YAGURA_LABEL = "yagura=1";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function kubeConfig(env: Environment): KubeConfig {
  return KubeConfig.parse(env.providerConfig);
}

export async function kubectl(cfg: KubeConfig, args: string[], timeoutMs = 30_000): Promise<string> {
  const full = cfg.context ? ["--context", cfg.context, ...args] : args;
  try {
    const { stdout } = await run(cfg.kubectl, full, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`kubectl ${args.join(" ")}: ${(err.stderr || err.message).trim().split("\n").at(-1)}`);
  }
}

export function namespaceFor(env: Environment, cfg: KubeConfig, lease: { id: number; slot: string }): string {
  if (cfg.mode === "pool") {
    const index = Number(lease.slot.replace("slot-", "")) - 1;
    const ns = cfg.pool[index];
    if (!ns) throw new Error(`${lease.slot} has no namespace in the pool of ${env.id}`);
    return ns;
  }
  return `${cfg.prefix}-${env.id}-${lease.id}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63)
    .replace(/-+$/, "");
}

export async function createNamespaceSlot(env: Environment, lease: { id: number; slot: string }): Promise<Record<string, string>> {
  const cfg = kubeConfig(env);
  const ns = namespaceFor(env, cfg, lease);
  const context = cfg.context ?? (await kubectl(cfg, ["config", "current-context"]));
  const pinned = { ...cfg, context };
  if (cfg.mode === "create") {
    await kubectl(pinned, ["create", "namespace", ns]);
    await kubectl(pinned, ["label", "namespace", ns, YAGURA_LABEL, `yagura/env=${env.id}`, `yagura/lease=${lease.id}`]);
  } else await kubectl(pinned, ["get", "namespace", ns]);
  return {
    YAGURA_NAMESPACE: ns,
    KUBECONTEXT: context,
    YAGURA_LABEL,
    ...(cfg.baseUrl ? { YAGURA_BASE_URL: cfg.baseUrl.replaceAll("{namespace}", ns) } : {}),
  };
}

// Create mode deletes the whole namespace, but only one yagura labelled; pool mode keeps the namespace and deletes only
// what carries the yagura label, so a shared namespace keeps everything else in it.
export async function destroyNamespaceSlot(env: Environment, vars: Record<string, string>): Promise<void> {
  const cfg = { ...kubeConfig(env), context: vars.KUBECONTEXT };
  const ns = vars.YAGURA_NAMESPACE;
  if (!ns) return;
  if (cfg.mode === "pool") {
    await kubectl(cfg, ["delete", "all,configmap,secret,pvc,ingress", "-n", ns, "-l", YAGURA_LABEL, "--wait=false", "--ignore-not-found"]);
    return;
  }
  if (!(await kubectl(cfg, ["get", "namespace", ns, "--ignore-not-found", "-o", "name"]))) return;
  const label = await kubectl(cfg, ["get", "namespace", ns, "-o", "jsonpath={.metadata.labels.yagura}"]);
  if (label !== "1") throw new Error(`namespace ${ns} is not labelled ${YAGURA_LABEL}; yagura leaves it alone`);
  await kubectl(cfg, ["delete", "namespace", ns, "--wait=false"]);
}

export async function doctorKube(env: Environment): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
      return true;
    } catch (e) {
      checks.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  let cfg: KubeConfig;
  try {
    cfg = kubeConfig(env);
  } catch (e) {
    return [{ name: "config", ok: false, detail: e instanceof Error ? e.message : String(e) }];
  }
  const reach = await step("reach the cluster", async () => {
    const context = cfg.context ?? (await kubectl(cfg, ["config", "current-context"]));
    const version = JSON.parse(await kubectl(cfg, ["version", "-o", "json", "--request-timeout=10s"])) as { serverVersion?: { gitVersion?: string } };
    return `context ${context}, server ${version.serverVersion?.gitVersion ?? "unknown"}`;
  });
  if (!reach) return checks;
  if (cfg.mode === "create") {
    const probe = `${cfg.prefix}-probe-${randomBytes(3).toString("hex")}`;
    const created = await step("create a probe namespace", async () => {
      await kubectl(cfg, ["create", "namespace", probe]);
      await kubectl(cfg, ["label", "namespace", probe, YAGURA_LABEL, "yagura/probe=1"]);
      return probe;
    });
    if (created) await step("delete the probe namespace", async () => (await kubectl(cfg, ["delete", "namespace", probe, "--wait=false"]), probe));
  } else
    for (const ns of cfg.pool)
      await step(`use namespace ${ns}`, async () => {
        await kubectl(cfg, ["get", "namespace", ns]);
        const can = await kubectl(cfg, ["auth", "can-i", "create", "pods", "-n", ns]).catch(() => "no");
        if (can !== "yes") throw new Error(`cannot create pods in ${ns}`);
        return "can create pods";
      });
  return checks;
}
