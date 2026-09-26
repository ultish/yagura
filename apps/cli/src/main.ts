#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  addProject,
  addRepo,
  addUnit,
  claudeAdapter,
  effectiveSettings,
  getProject,
  getUnitBySeq,
  layout,
  listAttempts,
  listUnits,
  loadBootstrap,
  missingBriefFields,
  openStore,
  parseClaudeLine,
  PASS_TIERS,
  resolveSetting,
  runWorkUnit,
  setSetting,
  transitionUnit,
  type HarnessEvent,
  type PassTier,
  type ProjectId,
  type RepoId,
  type SettingScope,
} from "@yagura/core";

const USAGE = `yagura — agent orchestration

  yagura repo add <id> <url> [--branch main]
  yagura project new <id> --goal <text> --predicate <text> --repo <id>... [--name <text>] [--min-tier unit-verified]
  yagura unit add <project> --repo <id> --goal <text> --write <glob>... --accept <text>... --verify <cmd>
                  [--forbid <glob>...] [--context <path>...] [--playbook <name>] [--timebox <seconds>]
  yagura run <project> <unit#>
  yagura show <project> [unit#]
  yagura logs <project> <unit#> [--attempt <n>]
  yagura settings [--project <id>] [--repo <id>]
  yagura set <key> <json> [--scope global|environment|repo|project] [--id <scope id>]`;

const boot = loadBootstrap();
const db = openStore(layout(boot).db);
const [command, ...rest] = process.argv.slice(2);

function args<const O extends NonNullable<ParseArgsConfig["options"]>>(options: O) {
  return parseArgs({ args: rest, options, allowPositionals: true, strict: true });
}
const many = (v: unknown) => (Array.isArray(v) ? (v as string[]) : v ? [String(v)] : []);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

function renderEvent(e: HarnessEvent): string | null {
  const indent = e.kind !== "session" && e.kind !== "final" && e.kind !== "ignored" && e.kind !== "usage" && e.parentId ? "    " : "  ";
  switch (e.kind) {
    case "session":
      return `  session ${e.sessionId} · ${e.model ?? "default model"} · pstack ${e.plugins.pstack ?? "not loaded"}`;
    case "text":
      return `${indent}· ${e.text.split("\n")[0]!.slice(0, 160)}`;
    case "tool_call": {
      const input = e.input as Record<string, unknown> | null;
      return `${indent}→ ${e.name} ${String(input?.skill ?? input?.command ?? input?.file_path ?? input?.pattern ?? input?.description ?? "").slice(0, 140)}`;
    }
    case "tool_result":
      return e.isError ? `${indent}  ✗ ${e.output.split("\n")[0]!.slice(0, 140)}` : null;
    case "final":
      return `  ■ ${e.isError ? "error" : "finished"} (${e.stopReason ?? "?"}${e.costUsd !== null ? `, $${e.costUsd.toFixed(4)}` : ""})`;
    default:
      return null;
  }
}

async function main() {
  switch (command) {
    case "repo": {
      const { positionals, values } = args({ branch: { type: "string", default: "main" } });
      if (positionals[0] !== "add" || !positionals[1] || !positionals[2]) fail(USAGE);
      const repo = addRepo(db, { id: positionals[1]!, url: positionals[2]!, defaultBranch: values.branch as string });
      console.log(`repo ${repo.id} → ${repo.url} (${repo.defaultBranch})`);
      return;
    }
    case "project": {
      const { positionals, values } = args({
        goal: { type: "string" },
        predicate: { type: "string" },
        repo: { type: "string", multiple: true },
        name: { type: "string" },
        "min-tier": { type: "string", default: "unit-verified" },
      });
      const id = positionals[1];
      if (positionals[0] !== "new" || !id || !values.goal || !values.predicate || !many(values.repo).length) fail(USAGE);
      const minTier = values["min-tier"] as string;
      if (!(PASS_TIERS as readonly string[]).includes(minTier)) fail(`--min-tier must be one of ${PASS_TIERS.join(", ")}`);
      const p = addProject(db, {
        id: id!,
        name: (values.name as string) ?? id!,
        goal: values.goal as string,
        predicate: values.predicate as string,
        minTier: minTier as PassTier,
        repos: many(values.repo) as RepoId[],
      });
      console.log(`project ${p.id}: ${p.goal}`);
      return;
    }
    case "unit": {
      const { positionals, values } = args({
        repo: { type: "string" },
        goal: { type: "string" },
        write: { type: "string", multiple: true },
        forbid: { type: "string", multiple: true },
        accept: { type: "string", multiple: true },
        verify: { type: "string" },
        context: { type: "string", multiple: true },
        playbook: { type: "string" },
        timebox: { type: "string" },
      });
      const projectId = positionals[1] as ProjectId | undefined;
      if (positionals[0] !== "add" || !projectId || !values.repo) fail(USAGE);
      const fields = {
        goal: (values.goal as string) ?? "",
        scope: { write: many(values.write), forbid: many(values.forbid) },
        acceptance: many(values.accept),
        verify: (values.verify as string) ?? "",
      };
      const u = addUnit(db, {
        projectId: projectId!,
        type: "work",
        repoId: values.repo as RepoId,
        goal: fields.goal,
        writeScope: fields.scope.write,
        forbidScope: fields.scope.forbid,
        acceptance: fields.acceptance,
        verify: fields.verify || null,
        context: many(values.context),
        playbook: (values.playbook as string) ?? null,
        timeboxSeconds: values.timebox ? Number(values.timebox) : resolveSetting(db, "timebox.work_seconds", { projectId }).value,
        maxAttempts: resolveSetting(db, "max_attempts", { projectId }).value,
      });
      const missing = missingBriefFields(fields);
      if (missing.length) {
        console.log(`U${u.seq} created as draft; brief is missing ${missing.join(", ")}`);
        return;
      }
      transitionUnit(db, u.id, "ready");
      console.log(`U${u.seq} ready: ${u.goal}`);
      return;
    }
    case "run": {
      const [projectId, seq] = rest;
      if (!projectId || !seq) fail(USAGE);
      const unit = getUnitBySeq(db, projectId as ProjectId, Number(seq));
      console.log(`running ${projectId}/U${unit.seq}: ${unit.goal}`);
      const attempt = await runWorkUnit(
        {
          db,
          boot,
          adapters: { claude: claudeAdapter },
          onEvent: (e) => {
            const line = renderEvent(e);
            if (line) console.log(line);
          },
        },
        unit.id,
      );
      const after = getUnitBySeq(db, projectId as ProjectId, Number(seq));
      console.log(
        `\nU${after.seq} → ${after.state} · attempt ${attempt.n} ${attempt.state}` +
          `${attempt.handoffStatus ? ` (${attempt.handoffStatus}, self-reported ${attempt.selfTier ?? "no tier"})` : ""}` +
          `${attempt.failureMode ? ` · failure: ${attempt.failureMode}` : ""}` +
          `\n  branch ${attempt.branch} @ ${attempt.headSha?.slice(0, 10)} · worktree ${attempt.worktreePath}` +
          `\n  handoff ${layout(boot).handoff(projectId as ProjectId, after.seq, attempt.n)}`,
      );
      return;
    }
    case "show": {
      const [projectId, seq] = rest;
      if (!projectId) fail(USAGE);
      const project = getProject(db, projectId as ProjectId);
      if (!seq) {
        console.log(`${project.id} [${project.state}] ${project.goal}\n  predicate: ${project.predicate} · min tier: ${project.minTier}`);
        for (const u of listUnits(db, project.id)) console.log(`  U${u.seq}  ${u.state.padEnd(10)} ${u.type.padEnd(6)} ${u.goal}`);
        return;
      }
      const u = getUnitBySeq(db, project.id, Number(seq));
      console.log(`U${u.seq} [${u.state}] ${u.goal}\n  write: ${u.writeScope.join(", ")}\n  verify: ${u.verify}`);
      for (const a of listAttempts(db, u.id))
        console.log(
          `  attempt ${a.n}: ${a.state} ${a.handoffStatus ?? ""} ${a.failureMode ?? ""} · ${a.model ?? "?"} · ctx peak ${a.contextPeak} · ${a.branch}`,
        );
      return;
    }
    case "logs": {
      const { positionals, values } = args({ attempt: { type: "string" } });
      const [projectId, seq] = positionals;
      if (!projectId || !seq) fail(USAGE);
      const u = getUnitBySeq(db, projectId as ProjectId, Number(seq));
      const n = values.attempt ? Number(values.attempt) : (listAttempts(db, u.id).at(-1)?.n ?? fail("no attempts yet"));
      const path = layout(boot).log(projectId as ProjectId, u.seq, n);
      if (!existsSync(path)) fail(`no log at ${path}`);
      for (const line of readFileSync(path, "utf8").split("\n"))
        for (const e of parseClaudeLine(line)) {
          const out = renderEvent(e);
          if (out) console.log(out);
        }
      return;
    }
    case "settings": {
      const { values } = args({ project: { type: "string" }, repo: { type: "string" } });
      const all = effectiveSettings(db, { projectId: (values.project as ProjectId) ?? null, repoId: (values.repo as RepoId) ?? null });
      for (const [k, { value, source }] of Object.entries(all)) console.log(`  ${k.padEnd(32)} ${JSON.stringify(value).padEnd(24)} (${source})`);
      return;
    }
    case "set": {
      const { positionals, values } = args({ scope: { type: "string", default: "global" }, id: { type: "string", default: "" } });
      const [key, json] = positionals;
      if (!key || json === undefined) fail(USAGE);
      setSetting(db, values.scope as SettingScope, values.id as string, key!, JSON.parse(json!));
      console.log(`${key} = ${json} (${values.scope}${values.id ? ` ${values.id}` : ""})`);
      return;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
