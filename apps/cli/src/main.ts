#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  messagesMentioning,
  addMessage,
  applyProposal,
  createThread,
  describeProposal,
  discardProposal,
  getProposal,
  getThread,
  listDecisions,
  listMessages,
  listProposals,
  listQuestions,
  listThreads,
  ProposalBody,
  runWatchmanTurn,
  RouteNeeded,
  describeRoute,
  addSteer,
  clearWatchmanSession,
  searchMessages,
  setThreadAutonomy,
  addEnvironment,
  addProject,
  answerGate,
  daemonPid,
  Engine,
  findByRef,
  findUnitsByCommit,
  setProjectRefs,
  traceUnit,
  listGates,
  setAndon,
  setMergePolicy,
  registerRepo,
  addUnitNote,
  evidenceCli,
  agentRefusal,
  retryState,
  gitRead,
  landUnit,
  listEvidenceRuns,
  PROVIDERS,
  reapLeases,
  runVerifyUnit,
  setProjectEnvironment,
  setRepoUrl,
  setRepoForge,
  getRepo,
  type Forge,
  type EnvironmentId,
  type Provider,
  type RunContext,
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
  projectSkillChecks,
  clearSetting,
  exportSettings,
  importSettings,
  updateEnvironment,
  deleteEnvironment,
  applyPreset,
  applyTemplate,
  deleteValue,
  environmentNotes,
  getEnvironment,
  listTemplates,
  listValues,
  PRESETS,
  saveTemplate,
  setEnvironmentNotes,
  setValue,
  templatesDir,
  type EnvValue,
  PROVIDERS_IMPL,
  transitionUnit,
  type HarnessEvent,
  type PassTier,
  type ProjectId,
  type RepoId,
  type SettingScope,
  isBuild,
  jobLabel,
  PROMPT_ROLES,
  effectiveGuidance,
  setPromptText,
  standingFor,
  type PromptRole,
} from "@yagura/core";

const USAGE = `yagura — agent orchestration

  yagura repo add <git URL> [--id <id>] [--forge gh|glab | --land push]   mirror an existing repo; github.com lands through pull requests, hosts in forge.glab_hosts through merge requests; any other remote needs --forge or --land push
  yagura project new <id> --goal <text> --predicate <text> --repo <id>... [--name <text>] [--min-tier unit-verified] [--issue <ref>...]
                  [--after <project>...] [--phase-gate] [--merge auto|human] [--env <id>]
  yagura unit add <project> --repo <id> --goal <text> --write <glob>... --accept <text>... --verify <cmd>
                  [--forbid <glob>...] [--context <path>...] [--playbook <name>] [--timebox <seconds>]
  yagura repo set <id> [--url <url>] [--forge gh|glab | --land push]   gh and glab land through pull/merge requests (forge.repo, forge.merge_method)
  yagura env add <id> --provider local-process|kube-namespace [--capacity 1] [--name <text>]
               [--context <kube context>] [--pool <ns,ns>] [--base-url http://{namespace}.apps]
  yagura env set <id> [--capacity <n>] [--name <text>]
  yagura env rm <id>                                refused while a project that is not closed uses it
  yagura env values <id>
  yagura env value set <id> <NAME> <value> [--note <text>]
  yagura env value rm <id> <NAME>
  yagura env preset <id> <preset>          add that preset's values; names already set are left alone
  yagura env presets
  yagura env notes <id> | notes set <id> --text <text>
  yagura template list
  yagura template save <env> <name> [--description <text>] [--ask <NAME>...]
  yagura template apply <name> --id <new env> [--name <text>] [--answer <NAME=value>...]
  yagura project set <id> [--env <env id>] [--merge auto|human] [--issue <ref>...] [--reference <repo id>...]
  yagura project skills <id>                       checks the project's skills.* are installed where agents run
  yagura talk [--thread <id>] [--go] <message>   talk to the watchman (a new thread unless --thread)
  yagura steer <project>/U<n> <message>          tell a unit's running agent something; it reads it after its current step
  yagura thread list | show <id> | search [--thread <id>] <words> | set <id> --autonomy propose|go | clear <id>
  yagura thread mentions <@project | @project/U3 | @project/A7 | @thread:4 | @repo:id>   conversations that mention it
  yagura proposal apply|discard <id>
  yagura trace <commit sha | issue ref>  who and what produced a commit, or everything behind an issue
  yagura daemon                          run yagura for every active project and serve the API (YAGURA_BIND/YAGURA_PORT)
  yagura drive <project>                 plan, run, verify, and land until nothing is left to do (without a daemon)
  yagura andon <project> --reason <text> | --clear
  yagura gates [project]                 open questions for a human
  yagura gate answer <id> <option>
  yagura unit reject|requeue <project> <unit#> [--note <text>]   requeue lands a blocked unit that is still verified again
  yagura run <project> <unit#>           run a ready work unit
  yagura verify <project> <unit#>        run the queued verify unit for a unit in verifying
  yagura land <project> <unit#>          land a verified unit onto its repo's default branch
  yagura evidence run --at base|head --label <name> -- <command>   (inside a verify session)
  yagura show <project> [unit#]
  yagura git <repo> log|show|ls-tree|diff|grep|blame [args]   read a registered repo's mirror (trunk is origin/<default branch>)
  yagura logs <project> <unit#> [--attempt <n>]
  yagura settings [--project <id>] [--repo <id>]
  yagura settings export > settings.yaml     every explicitly set value, by layer
  yagura settings import <file.yaml>         set every value in the file (others are kept)
  yagura prompt show <role> [--project <id>]        a role's guidance and where it comes from (default, global, or the project's)
  yagura prompt set <role|all> (--project <id> | --global) [--notes] <file | ->   override a role's guidance, or set notes (all = every role)
  yagura prompt reset <role|all> (--project <id> | --global) [--notes]           back to the next layer
  yagura set <key> <json> [--scope global|environment|repo|project] [--id <scope id>]
  yagura unset <key> [--scope global|environment|repo|project] [--id <scope id>]   back to the next layer's value`;

const [command, ...rest] = process.argv.slice(2);
const refusal = agentRefusal(process.argv.slice(2), process.env);
if (refusal) {
  process.stderr.write(refusal);
  process.exit(2);
}
if (command === "evidence") {
  const result = await evidenceCli(rest);
  process.stdout.write(result.output);
  process.exit(result.code);
}
if (command === "daemon") {
  const { startDaemon } = await import("@yagura/daemon");
  await startDaemon([process.execPath, fileURLToPath(import.meta.url)]);
  process.exit(0);
}
const boot = loadBootstrap();
const db = openStore(layout(boot).db);
const agentCtx = (): RunContext => ({
  db,
  boot,
  adapters: { claude: claudeAdapter },
  cli: [process.execPath, fileURLToPath(import.meta.url)],
  onEvent: (e) => {
    const line = renderEvent(e);
    if (line) console.log(line);
  },
});

function args<const O extends NonNullable<ParseArgsConfig["options"]>>(options: O) {
  return parseArgs({ args: rest, options, allowPositionals: true, strict: true });
}
const many = (v: unknown) => (Array.isArray(v) ? (v as string[]) : v ? [String(v)] : []);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

function printValue(v: EnvValue): void {
  console.log(`${v.name}=${v.value}  (${v.source})`);
  if (v.note) console.log(`  ${v.note}`);
}

function answersOf(raw: string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const entry of raw) {
    const at = entry.indexOf("=");
    if (at <= 0) fail(`--answer must be NAME=value, got ${entry}`);
    answers[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return answers;
}

function renderEvent(e: HarnessEvent): string | null {
  const indent = "parentId" in e && e.parentId ? "    " : "  ";
  switch (e.kind) {
    case "session":
      return `  session ${e.sessionId} · ${e.model ?? "default model"} · pstack ${e.plugins.pstack ?? "not loaded"}`;
    case "text":
      return `${indent}· ${e.text.split("\n")[0]!.slice(0, 160)}`;
    case "user_text":
      return `  > ${e.text.split("\n")[0]!.slice(0, 160)}`;
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

function printRecords(threadId: number, sinceMessageId: number) {
  for (const d of listDecisions(db, threadId).filter((x) => (x.sourceMessageId ?? 0) > sinceMessageId)) console.log(`  decision D${d.id}: ${d.text}`);
  for (const q of listQuestions(db, threadId).filter((x) => (x.sourceMessageId ?? 0) > sinceMessageId)) console.log(`  question Q${q.id}: ${q.text}`);
  for (const q of listQuestions(db, threadId).filter((x) => (x.resolvedMessageId ?? 0) > sinceMessageId)) console.log(`  answered Q${q.id}: ${q.answer}`);
  for (const p of listProposals(db, threadId).filter((x) => (x.messageId ?? 0) > sinceMessageId)) {
    const body = ProposalBody.safeParse(p.body);
    console.log(`\nproposal ${p.id} [${p.state}]\n${body.success ? describeProposal(body.data) : JSON.stringify(p.body)}`);
  }
}

async function main() {
  switch (command) {
    case "repo": {
      const { positionals, values } = args({ id: { type: "string" }, url: { type: "string" }, forge: { type: "string" }, land: { type: "string" } });
      if (values.forge && values.forge !== "gh" && values.forge !== "glab") fail("--forge must be gh or glab (to push to the default branch, use --land push)");
      if (values.land && values.land !== "push") fail("--land takes push");
      if (positionals[0] === "set" && positionals[1] && (values.url || values.forge || values.land)) {
        if (values.forge && values.land) fail("choose --forge or --land push, not both");
        const id = positionals[1] as RepoId;
        if (values.url) setRepoUrl(db, id, values.url);
        if (values.forge) setRepoForge(db, id, values.forge as Forge);
        if (values.land) setRepoForge(db, id, "none", true);
        console.log(`repo ${id}:${values.url ? ` url → ${values.url}` : ""}${values.forge || values.land ? ` lands ${describeRoute(getRepo(db, id))}` : ""}`);
        return;
      }
      if (positionals[0] !== "add" || !positionals[1] || positionals[2]) fail(USAGE);
      if (values.forge && values.land) fail("choose --forge or --land push, not both");
      let registered;
      try {
        registered = await registerRepo(
          { db, boot },
          { source: positionals[1]!, id: values.id as string | undefined, forge: values.forge as Forge | undefined, land: values.land as "push" | undefined },
        );
      } catch (e) {
        if (e instanceof RouteNeeded) fail(`${e.message}\n  e.g. yagura repo add ${positionals[1]} --forge gh`);
        throw e;
      }
      const { repo, inspection } = registered!;
      console.log(
        `repo ${repo.id} → ${repo.url} (${repo.defaultBranch} at ${inspection.trunk.slice(0, 10)}, verify pack ${repo.packStatus}); lands ${describeRoute(repo)}`,
      );
      for (const n of inspection.notes) console.log(`  note: ${n}`);
      return;
    }
    case "project": {
      const { positionals, values } = args({
        goal: { type: "string" },
        predicate: { type: "string" },
        repo: { type: "string", multiple: true },
        name: { type: "string" },
        "min-tier": { type: "string", default: "unit-verified" },
        env: { type: "string" },
        merge: { type: "string" },
        issue: { type: "string", multiple: true },
        after: { type: "string", multiple: true },
        "phase-gate": { type: "boolean" },
        reference: { type: "string", multiple: true },
      });
      const id = positionals[1];
      if (positionals[0] === "skills" && id) {
        const checks = projectSkillChecks(db, boot, id as ProjectId);
        if (!checks.length) console.log(`project ${id} names no project skills (set skills.scaffold, skills.work, skills.pack, skills.verify)`);
        for (const c of checks)
          console.log(
            `${c.installed ? "✓" : "✗"} ${c.skill}  ${c.purposes.join(", ")} · ${c.repos.join(", ")}${c.installed ? "" : "  not installed where agents run"}`,
          );
        if (checks.some((c) => !c.installed)) process.exitCode = 1;
        return;
      }
      if (positionals[0] === "set" && id && values.reference) {
        setSetting(db, "project", id as ProjectId, "project.reference_repos", many(values.reference));
        console.log(`project ${id}: reference repos → ${many(values.reference).join(", ")}`);
        if (!values.env && !values.merge && !values.issue) return;
      }
      if (positionals[0] === "set" && id && (values.env || values.merge || values.issue)) {
        if (values.issue) setProjectRefs(db, id as ProjectId, many(values.issue));
        if (values.env) setProjectEnvironment(db, id as ProjectId, values.env as EnvironmentId);
        if (values.merge) {
          if (values.merge !== "auto" && values.merge !== "human") fail("--merge must be auto or human");
          setMergePolicy(db, id as ProjectId, values.merge as "auto" | "human");
        }
        console.log(
          `project ${id}:${values.env ? ` environment → ${values.env}` : ""}${values.merge ? ` merge → ${values.merge}` : ""}${values.issue ? ` refs → ${many(values.issue).join(", ")}` : ""}`,
        );
        return;
      }
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
        refs: many(values.issue),
        after: many(values.after) as ProjectId[],
        phaseGate: !!values["phase-gate"],
        mergePolicy: values.merge === "auto" ? "auto" : "human",
        environmentId: (values.env as EnvironmentId) ?? null,
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
        note: { type: "string" },
        issue: { type: "string", multiple: true },
      });
      const projectId = positionals[1] as ProjectId | undefined;
      if ((positionals[0] === "reject" || positionals[0] === "requeue") && projectId && positionals[2]) {
        const u = getUnitBySeq(db, projectId, Number(positionals[2]));
        if (values.note) addUnitNote(db, u.id, values.note);
        const direct = positionals[0] === "requeue" && (u.state === "blocked" || u.state === "failed");
        if (!direct && u.state !== "rejected") transitionUnit(db, u.id, "rejected", { by: "operator", note: values.note ?? null });
        if (positionals[0] === "requeue") transitionUnit(db, u.id, direct ? retryState(db, u) : "ready", { by: "operator" });
        console.log(`U${u.seq} → ${getUnitBySeq(db, projectId, u.seq).state}`);
        return;
      }
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
        refs: many(values.issue),
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
      await reapLeases(db, boot);
      const attempt = await runWorkUnit(agentCtx(), unit.id);
      const after = getUnitBySeq(db, projectId as ProjectId, Number(seq));
      console.log(
        `\nU${after.seq} → ${after.state} · attempt ${attempt.n} ${attempt.state}` +
          `${attempt.handoffStatus ? ` (${attempt.handoffStatus}, self-reported ${attempt.selfTier ?? "no tier"})` : ""}` +
          `${attempt.failureMode ? ` · failure: ${attempt.failureMode}` : ""}` +
          `\n  branch ${attempt.branch} @ ${attempt.headSha?.slice(0, 10)} · worktree ${attempt.worktreePath}` +
          `\n  handoff ${layout(boot).handoff(projectId as ProjectId, after.seq, attempt.n)}` +
          (after.state === "verifying" ? `\n  next: yagura verify ${projectId} ${after.seq}` : ""),
      );
      return;
    }
    case "verify": {
      const [projectId, seq] = rest;
      if (!projectId || !seq) fail(USAGE);
      const target = getUnitBySeq(db, projectId as ProjectId, Number(seq));
      const verifyUnit = listUnits(db, target.projectId)
        .filter((u) => u.type === "verify" && u.targetUnitId === target.id && u.state === "ready")
        .at(-1);
      if (!verifyUnit) fail(`U${target.seq} has no ready verify unit (it is ${target.state})`);
      await reapLeases(db, boot);
      console.log(`verifying ${projectId}/U${target.seq} with U${verifyUnit!.seq}`);
      const result = await runVerifyUnit(agentCtx(), verifyUnit!.id);
      const after = getUnitBySeq(db, projectId as ProjectId, target.seq);
      console.log(
        `\nverdict: ${result.decision.outcome}${result.decision.tier ? ` (${result.decision.tier})` : ""} — ${result.decision.reason}` +
          `\n  trunk: ${result.decision.trunkOutcome ?? "-"}\n  head:  ${result.decision.headOutcome ?? "-"}` +
          `\n  cited: ${result.decision.citedRunIds.map((id) => `run:${id}`).join(", ") || "none"}` +
          `\nU${after.seq} → ${after.state}${after.state === "verified" ? `\n  next: yagura land ${projectId} ${after.seq}` : ""}`,
      );
      return;
    }
    case "drive": {
      const [projectId] = rest;
      if (!projectId) fail(USAGE);
      const daemon = daemonPid(boot);
      if (daemon) fail(`a yagura daemon (pid ${daemon}) is already running this project; watch it in the dashboard instead`);
      const engine = new Engine(agentCtx(), {
        projectId: projectId as ProjectId,
        log: (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`),
      });
      await engine.runUntilIdle();
      const project = getProject(db, projectId as ProjectId);
      const open = listGates(db, project.id, "open");
      console.log(
        `\n${project.id} is ${project.state}${project.andonReason ? ` (andon: ${project.andonReason})` : ""}` +
          (open.length
            ? `\nwaiting on ${open.length} gate(s):\n${open.map((g) => `  gate ${g.id}: ${g.question} [${g.options.join(" | ")}]`).join("\n")}`
            : ""),
      );
      return;
    }
    case "trace": {
      const [target] = rest;
      if (!target) fail(USAGE);
      const byCommit = findUnitsByCommit(db, target!);
      const byRef = byCommit.length ? { projects: [], units: [] } : findByRef(db, target!);
      const units = byCommit.length ? byCommit : byRef.units;
      if (!units.length) fail(`nothing in yagura matches ${target}`);
      if (byRef.projects.length) console.log(`${target} is referenced by project(s): ${byRef.projects.map((p) => p.id).join(", ")}`);
      for (const unit of units) {
        const t = traceUnit(db, boot, unit);
        console.log(`\n${t.project.id}/U${unit.seq} [${unit.state}] ${unit.goal}`);
        if (unit.landedSha) console.log(`  landed as ${unit.landedSha}`);
        if (unit.refs.length || t.project.refs.length) console.log(`  refs: ${[...new Set([...t.project.refs, ...unit.refs])].join(", ")}`);
        for (const a of t.work)
          console.log(
            `  work attempt ${a.n} (attempt id ${a.id}): ${a.state} ${a.handoffStatus ?? a.failureMode ?? ""} · ${a.model ?? a.harness}` +
              `${a.pluginVersions.pstack ? ` · pstack ${a.pluginVersions.pstack}` : ""} · skills ${a.skills.join(", ") || "none"} · ${a.branch ?? ""}`,
          );
        for (const v of t.verifications) {
          console.log(`  verified by ${jobLabel(db, v.unit as never)} [${v.unit.state}]`);
          for (const r of v.runs)
            console.log(`    run:${r.id} ${r.label}@${r.at} ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}${r.tampered ? " TAMPERED" : ""}`);
        }
        for (const v of t.verdicts) console.log(`  verdict ${v.id}: ${v.tier} @ ${v.headSha.slice(0, 10)}${v.voided ? ` (void: ${v.voidReason})` : " (live)"}`);
        for (const h of t.handoffPaths) console.log(`  handoff ${h}`);
      }
      return;
    }
    case "andon": {
      const { positionals, values } = args({ reason: { type: "string" }, clear: { type: "boolean" } });
      const [projectId] = positionals;
      if (!projectId || (!values.reason && !values.clear)) fail(USAGE);
      setAndon(db, projectId as ProjectId, values.clear ? null : values.reason!);
      console.log(values.clear ? `andon cleared on ${projectId}` : `andon raised on ${projectId}: ${values.reason}`);
      return;
    }
    case "gates": {
      const [projectId] = rest;
      for (const g of listGates(db, (projectId as ProjectId) ?? null, "open"))
        console.log(
          `gate ${g.id} (${g.projectId}, ${g.kind}): ${g.question} [${g.options.join(" | ")}]${g.defaultOption ? ` default ${g.defaultOption}` : ""}`,
        );
      return;
    }
    case "gate": {
      const [sub, id, answer] = rest;
      if (sub !== "answer" || !id || !answer) fail(USAGE);
      const g = answerGate(db, Number(id), answer!);
      console.log(`gate ${g.id} answered: ${g.answer}`);
      return;
    }
    case "template": {
      const { positionals, values } = args({
        description: { type: "string" },
        ask: { type: "string", multiple: true },
        answer: { type: "string", multiple: true },
        id: { type: "string" },
        name: { type: "string" },
      });
      const [sub, first, second] = positionals;
      if (sub === "list" || !sub) {
        const found = listTemplates(boot);
        if (!found.length) {
          console.log(`no templates in ${templatesDir(boot)}`);
          return;
        }
        for (const item of found) {
          if (item.template) console.log(`${item.template.name}  ${item.template.description}  (${item.file})`);
          else console.log(`${item.file}: ${item.error}`);
        }
        return;
      }
      if (sub === "save" && first && second) {
        const saved = saveTemplate(db, boot, first as EnvironmentId, {
          name: second,
          description: values.description,
          ask: many(values.ask),
        });
        const asks = saved.template.values.filter((v) => v.ask).map((v) => v.name);
        console.log(`saved ${saved.template.name} to ${saved.path}${asks.length ? `; applying asks for ${asks.join(", ")}` : ""}`);
        return;
      }
      if (sub === "apply" && first && values.id) {
        const result = await applyTemplate({ db, boot }, first, {
          id: values.id,
          name: values.name,
          answers: answersOf(many(values.answer)),
        });
        const created = getEnvironment(db, result.environmentId);
        console.log(`environment ${created.id}: ${created.provider}, capacity ${created.capacity}`);
        return;
      }
      fail(USAGE);
    }
    case "land": {
      const [projectId, seq] = rest;
      if (!projectId || !seq) fail(USAGE);
      const unit = getUnitBySeq(db, projectId as ProjectId, Number(seq));
      const result = await landUnit({ db, boot }, unit.id);
      console.log(`U${unit.seq} ${result.outcome}: ${result.reason}${result.landedSha ? ` @ ${result.landedSha.slice(0, 10)}` : ""}`);
      return;
    }
    case "env": {
      const { positionals, values } = args({
        provider: { type: "string" },
        capacity: { type: "string" },
        name: { type: "string" },
        context: { type: "string" },
        pool: { type: "string" },
        "base-url": { type: "string" },
        note: { type: "string" },
        text: { type: "string" },
        value: { type: "string" },
      });
      const [sub, a, b, ...more] = positionals;
      const id = a;
      if (sub === "rm" && id) {
        deleteEnvironment(db, id as EnvironmentId);
        console.log(`deleted environment ${id}`);
        return;
      }
      if (sub === "set" && id) {
        const e = updateEnvironment(db, id as EnvironmentId, {
          name: values.name,
          capacity: values.capacity === undefined ? undefined : Number(values.capacity),
        });
        console.log(`environment ${e.id}: ${e.name}, capacity ${e.capacity}`);
        return;
      }
      if (sub === "values" && id) {
        getEnvironment(db, id as EnvironmentId);
        const notes = environmentNotes(db, id as EnvironmentId);
        const listed = listValues(db, id as EnvironmentId);
        if (notes) console.log(notes);
        if (!listed.length) console.log(`environment ${id} has no values`);
        for (const v of listed) printValue(v);
        return;
      }
      if (sub === "value" && a === "set" && b && more.length >= 2) {
        const name = more[0]!;
        const value = more.slice(1).join(" ");
        const existing = listValues(db, b as EnvironmentId).find((v) => v.name === name);
        const saved = setValue(db, b as EnvironmentId, {
          name,
          value,
          note: values.note !== undefined ? values.note : (existing?.note ?? ""),
        });
        printValue(saved);
        return;
      }
      if (sub === "value" && a === "rm" && b && more.length === 1) {
        const name = more[0]!;
        const gone = deleteValue(db, b as EnvironmentId, name);
        console.log(gone ? `removed ${name} from ${b}` : `${name} is not a value of ${b}`);
        if (!gone) process.exitCode = 1;
        return;
      }
      if (sub === "preset" && id && b) {
        const result = applyPreset(db, id as EnvironmentId, b);
        console.log(result.added.length ? `added ${result.added.join(", ")}` : `added nothing to ${id}`);
        if (result.skipped.length) console.log(`left existing: ${result.skipped.join(", ")}`);
        return;
      }
      if (sub === "presets") {
        for (const preset of PRESETS) console.log(`${preset.id.padEnd(14)} ${preset.values.map((v) => v.name).join(", ")}`);
        return;
      }
      if (sub === "notes" && a === "set" && b) {
        const text = values.text;
        if (typeof text !== "string") fail("env notes set needs --text");
        else setEnvironmentNotes(db, b as EnvironmentId, text);
        console.log(`environment ${b} notes saved`);
        return;
      }
      if (sub === "notes" && id && a !== "set") {
        getEnvironment(db, id as EnvironmentId);
        const notes = environmentNotes(db, id as EnvironmentId);
        console.log(notes || `environment ${id} has no notes`);
        return;
      }
      if (sub !== "add" || !id || !values.provider) fail(USAGE);
      if (!(PROVIDERS as readonly string[]).includes(values.provider!)) fail(`--provider must be one of ${PROVIDERS.join(", ")}`);
      const providerConfig: Record<string, unknown> = {
        ...(values.context ? { context: values.context } : {}),
        ...(values.pool ? { mode: "pool", pool: values.pool.split(",").map((n) => n.trim()) } : {}),
        ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
      };
      const capacity = Number(values.capacity ?? "1");
      const impl = PROVIDERS_IMPL[values.provider as Provider];
      if (!impl) fail(`provider ${values.provider} is not available yet; use ${Object.keys(PROVIDERS_IMPL).join(" or ")}`);
      const problem = impl!.validateConfig(providerConfig, capacity);
      if (problem) fail(problem);
      const e = addEnvironment(db, { id: id!, name: values.name ?? id!, provider: values.provider as Provider, capacity, providerConfig });
      console.log(`environment ${e.id}: ${e.provider}, capacity ${e.capacity}`);
      return;
    }
    case "show": {
      const [projectId, seq] = rest;
      if (!projectId) fail(USAGE);
      const project = getProject(db, projectId as ProjectId);
      if (!seq) {
        const costs = new Map(
          (
            db
              .prepare(
                "SELECT a.unit_id AS id, SUM(a.cost_usd) AS usd FROM attempts a JOIN units u ON u.id = a.unit_id WHERE u.project_id = ? GROUP BY a.unit_id",
              )
              .all(project.id) as { id: number; usd: number }[]
          ).map((r) => [r.id, r.usd]),
        );
        const total = [...costs.values()].reduce((a, b) => a + b, 0);
        console.log(
          `${project.id} [${project.state}] ${project.goal}\n  predicate: ${project.predicate} · min tier: ${project.minTier} · agent cost $${total.toFixed(2)}`,
        );
        const units = listUnits(db, project.id);
        for (const u of units.filter(isBuild)) {
          const own = units.filter((j) => j.targetUnitId === u.id).reduce((sum, j) => sum + (costs.get(j.id) ?? 0), costs.get(u.id) ?? 0);
          console.log(`  U${u.seq}  ${u.state.padEnd(10)} ${u.type.padEnd(6)} ${`$${own.toFixed(2)}`.padStart(6)}  ${u.goal}`);
        }
        const agents = db
          .prepare(
            `SELECT a.agent_no, a.state, a.cost_usd, a.started_at, u.type, u.seq, t.seq AS target FROM attempts a JOIN units u ON u.id = a.unit_id LEFT JOIN units t ON t.id = u.target_unit_id
             WHERE u.project_id = ? ORDER BY a.agent_no`,
          )
          .all(project.id) as {
          agent_no: number;
          state: string;
          cost_usd: number;
          started_at: string | null;
          type: string;
          seq: number;
          target: number | null;
        }[];
        console.log("  agents (cost above includes the agents that worked on each unit):");
        for (const a of agents)
          console.log(
            `  A${a.agent_no}  ${a.state.padEnd(10)} ${(a.type === "plan" ? "planner" : a.type).padEnd(13)} ${`$${a.cost_usd.toFixed(2)}`.padStart(6)}  ${a.type === "plan" ? "plan" : `for U${a.target ?? a.seq}`}  ${a.started_at ?? ""}`,
          );
        return;
      }
      const u = getUnitBySeq(db, project.id, Number(seq));
      console.log(`U${u.seq} [${u.state}] ${u.goal}\n  write: ${u.writeScope.join(", ")}\n  verify: ${u.verify}`);
      if (u.notes.length) console.log(`  notes:\n${u.notes.map((n) => `    - ${n}`).join("\n")}`);
      for (const a of listAttempts(db, u.id)) {
        console.log(
          `  attempt ${a.n}: ${a.state} ${a.handoffStatus ?? ""} ${a.failureMode ?? ""} · ${a.model ?? "?"} · $${a.costUsd.toFixed(2)} · ctx peak ${a.contextPeak} · ${a.branch ?? a.headSha?.slice(0, 10) ?? ""}` +
            (a.missingSkills.length ? `\n    skipped required skills: ${a.missingSkills.join(", ")}` : ""),
        );
        for (const r of listEvidenceRuns(db, a.id))
          console.log(`    run:${r.id} ${r.label}@${r.at} ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}${r.tampered ? " TAMPERED" : ""}`);
      }
      for (const v of db.prepare("SELECT id, tier, head_sha, voided_at, void_reason FROM verdicts WHERE unit_id = ? ORDER BY id").all(u.id) as {
        id: number;
        tier: string;
        head_sha: string;
        voided_at: string | null;
        void_reason: string | null;
      }[])
        console.log(`  verdict ${v.id}: ${v.tier} @ ${v.head_sha.slice(0, 10)}${v.voided_at ? ` (void: ${v.void_reason})` : " (live)"}`);
      return;
    }
    case "git": {
      const result = await gitRead(db, boot, rest);
      process.stdout.write(result.output);
      process.exitCode = result.code;
      return;
    }
    case "prompt": {
      const { positionals, values } = args({ project: { type: "string" }, global: { type: "boolean" }, notes: { type: "boolean" } });
      const [verb, role, file] = positionals;
      if (!verb || !role || (role !== "all" && !(PROMPT_ROLES as readonly string[]).includes(role)))
        fail(`role is one of ${PROMPT_ROLES.join(", ")}${verb === "show" ? "" : ", or all"}\n${USAGE}`);
      const projectId = (values.project as string | undefined) ?? null;
      if (projectId) getProject(db, projectId as ProjectId);
      if (verb === "show") {
        if (role === "all") fail("show takes one role");
        const e = effectiveGuidance(db, boot, role as PromptRole, projectId);
        console.log(`# ${role} guidance (${e.source}, version ${e.sha})\n\n${e.text}`);
        if (projectId) {
          const notes = standingFor(db, boot, projectId, role as PromptRole);
          console.log(`# notes in its brief\n\n${notes || "(none)"}`);
        }
        return;
      }
      if (verb !== "set" && verb !== "reset") fail(USAGE);
      if (!!values.global === !!projectId) fail("say where: --project <id> or --global");
      const text = verb === "reset" ? null : readFileSync(file === "-" || !file ? 0 : file, "utf8");
      setPromptText(db, values.global ? "global" : "project", projectId ?? "", role as PromptRole | "all", values.notes ? "notes" : "guidance", text);
      console.log(`${role} ${values.notes ? "notes" : "guidance"} ${verb === "reset" ? "reset" : "set"} (${values.global ? "global" : projectId})`);
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
      const { positionals, values } = args({ project: { type: "string" }, repo: { type: "string" } });
      if (positionals[0] === "export") return void process.stdout.write(exportSettings(db));
      if (positionals[0] === "import") {
        if (!positionals[1]) fail(USAGE);
        console.log(`set ${importSettings(db, readFileSync(positionals[1]!, "utf8"))} value(s)`);
        return;
      }
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
    case "unset": {
      const { positionals, values } = args({ scope: { type: "string", default: "global" }, id: { type: "string", default: "" } });
      if (!positionals[0]) fail(USAGE);
      const cleared = clearSetting(db, values.scope as SettingScope, values.id as string, positionals[0]!);
      console.log(cleared ? `${positionals[0]} cleared (${values.scope}${values.id ? ` ${values.id}` : ""})` : `${positionals[0]} was not set there`);
      return;
    }
    case "steer": {
      const [target, ...words] = rest;
      const m = /^([\w-]+)\/U(\d+)$/.exec(target ?? "");
      if (!m || !words.length) fail(USAGE);
      const unit = getUnitBySeq(db, m![1] as ProjectId, Number(m![2]));
      const attempt = listAttempts(db, unit.id).find((a) => a.state === "running");
      if (!attempt) fail(`${target} has no running agent`);
      const steer = addSteer(db, attempt!.id, words.join(" "));
      console.log(`sent to ${target}.${attempt!.n} (steer ${steer.id}); it reads it after its current step`);
      return;
    }
    case "talk": {
      const { positionals, values } = args({ thread: { type: "string" }, go: { type: "boolean" } });
      const text = positionals.join(" ").trim();
      if (!text) fail(USAGE);
      const thread = values.thread
        ? getThread(db, Number(values.thread))
        : createThread(db, { title: text.slice(0, 60), autonomy: values.go ? "go" : "propose" });
      if (values.go && thread.autonomy !== "go") setThreadAutonomy(db, thread.id, "go");
      console.log(`thread ${thread.id} · ${values.go ? "go" : thread.autonomy}`);
      if (text === "/clear") {
        console.log(clearWatchmanSession(db, thread.id) ? "new session: the next message starts the watchman fresh" : "no session to clear");
        return;
      }
      const ctx = { ...agentCtx(), onEvent: (e: HarnessEvent) => (e.kind === "tool_call" ? console.log(renderEvent(e)) : undefined) };
      const turn = await runWatchmanTurn(ctx, thread.id, text);
      if (turn.reply) console.log(`\n${turn.reply.body}\n`);
      if (turn.problem) console.log(`! ${turn.problem}`);
      printRecords(thread.id, turn.human.id);
      if (turn.applied) console.log(`applied proposal ${turn.proposal!.id}: ${JSON.stringify(turn.applied)}`);
      else if (turn.proposal?.state === "pending")
        console.log(`proposal ${turn.proposal.id} is waiting: yagura proposal apply ${turn.proposal.id}   (or discard)`);
      return;
    }
    case "thread": {
      const { positionals, values } = args({ thread: { type: "string" }, autonomy: { type: "string" } });
      const [sub, ...more] = positionals;
      if (sub === "list" || !sub) {
        for (const t of listThreads(db))
          console.log(`thread ${t.id} [${t.state}, ${t.autonomy}] ${t.title}${t.projects.length ? ` · ${t.projects.join(", ")}` : ""} · ${t.updatedAt}`);
        return;
      }
      if (sub === "show" && more[0]) {
        const t = getThread(db, Number(more[0]));
        console.log(`thread ${t.id} [${t.state}, ${t.autonomy}] ${t.title}${t.projects.length ? `\nprojects: ${t.projects.join(", ")}` : ""}`);
        for (const m of listMessages(db, t.id)) console.log(`\n── ${m.role} #${m.id} · ${m.createdAt}\n${m.body}`);
        const decisions = listDecisions(db, t.id);
        if (decisions.length)
          console.log(
            `\ndecisions:\n${decisions.map((d) => `  D${d.id}${d.supersededBy ? ` (superseded by D${d.supersededBy})` : ""}: ${d.text}`).join("\n")}`,
          );
        const questions = listQuestions(db, t.id);
        if (questions.length)
          console.log(`\nquestions:\n${questions.map((q) => `  Q${q.id}: ${q.text}${q.answer ? ` → ${q.answer}` : " (open)"}`).join("\n")}`);
        for (const p of listProposals(db, t.id)) {
          const body = ProposalBody.safeParse(p.body);
          console.log(
            `\nproposal ${p.id} [${p.state}]\n${body.success ? describeProposal(body.data) : JSON.stringify(p.body)}${p.result ? `\n→ ${JSON.stringify(p.result)}` : ""}`,
          );
        }
        return;
      }
      if (sub === "search" && more.length) {
        for (const m of searchMessages(db, more.join(" "), values.thread ? Number(values.thread) : undefined))
          console.log(`thread ${m.threadId} ${m.role} #${m.id} · ${m.createdAt}: ${m.snippet}`);
        return;
      }
      if (sub === "mentions" && more[0]) {
        for (const m of messagesMentioning(db, more[0].replace(/^@/, "")))
          console.log(`thread ${m.threadId} ${m.role} #${m.messageId} · ${m.createdAt}: ${m.body.split("\n")[0]!.slice(0, 140)}`);
        return;
      }
      if (sub === "clear" && more[0]) {
        console.log(
          clearWatchmanSession(db, Number(more[0]))
            ? `thread ${more[0]}: new session; the next message starts the watchman fresh`
            : `thread ${more[0]} has no session to clear`,
        );
        return;
      }
      if (sub === "set" && more[0] && (values.autonomy === "go" || values.autonomy === "propose")) {
        setThreadAutonomy(db, Number(more[0]), values.autonomy);
        console.log(`thread ${more[0]} autonomy → ${values.autonomy}`);
        return;
      }
      fail(USAGE);
      return;
    }
    case "proposal": {
      const [sub, id] = rest;
      if (!id || (sub !== "apply" && sub !== "discard")) fail(USAGE);
      const proposal = getProposal(db, Number(id));
      if (sub === "discard") {
        discardProposal(db, proposal.id);
        addMessage(db, { threadId: proposal.threadId, role: "system", body: `Proposal ${proposal.id} discarded.` });
        console.log(`proposal ${proposal.id} discarded`);
        return;
      }
      try {
        const result = await applyProposal({ db, boot }, proposal.id);
        addMessage(db, { threadId: proposal.threadId, role: "system", body: `Go: applied proposal ${proposal.id}: ${JSON.stringify(result)}` });
        console.log(
          `applied proposal ${proposal.id}: ${JSON.stringify(result)}${daemonPid(boot) ? "" : `\nno daemon is running; start one with \`yagura daemon\` or drive a project with \`yagura drive <project>\``}`,
        );
      } catch (e) {
        addMessage(db, {
          threadId: proposal.threadId,
          role: "system",
          body: `Applying proposal ${proposal.id} failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        throw e;
      }
      return;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
