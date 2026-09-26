import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { HANDOFF_TEMPLATE, renderBrief } from "./brief.js";
import { resolveSetting, type Bootstrap } from "./config.js";
import type { Attempt, HarnessEvent, RenderedBrief, UnitId } from "./domain.js";
import { addWorktree, changedPaths, discardLeftovers, ensureMirror, headSha, resolveRef } from "./git.js";
import { classifyFailure, parseHandoff, syntheticFailureHandoff, type ExitFacts } from "./handoff.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { layout, unitRef } from "./paths.js";
import { checkScope } from "./scope.js";
import { createAttempt, getAttempt, getProject, getRepo, getUnit, now, recordEvent, transitionUnit, updateAttempt, type Db } from "./store.js";

export interface RunContext {
  db: Db;
  boot: Bootstrap;
  adapters: Record<string, HarnessAdapter>;
  onEvent?: (e: HarnessEvent) => void;
}

const KILL_GRACE_MS = 10_000;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function describeCall(e: Extract<HarnessEvent, { kind: "tool_call" }>): string {
  const input = e.input as Record<string, unknown> | null;
  const detail = input?.skill ?? input?.command ?? input?.file_path ?? input?.pattern ?? input?.description ?? "";
  return `${e.name}: ${String(detail).slice(0, 120)}`;
}

export async function runWorkUnit(ctx: RunContext, unitId: UnitId): Promise<Attempt> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (unit.type !== "work") throw new Error(`U${unit.seq} is a ${unit.type} unit; only work units run in this phase`);
  if (unit.state !== "ready") throw new Error(`U${unit.seq} is ${unit.state}, not ready`);
  if (!unit.repoId || !unit.verify) throw new Error(`U${unit.seq} has no repo or verify recipe`);

  const project = getProject(db, unit.projectId);
  const repo = getRepo(db, unit.repoId);
  const sctx = { projectId: project.id, repoId: repo.id };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.worker.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);

  const mirror = paths.mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const base = await resolveRef(mirror, `origin/${repo.defaultBranch}`);

  const attempt = createAttempt(db, unit.id, harnessId, setting("role.worker.model"));
  const branch = `${setting("git.branch_prefix")}/${project.id}/${unitRef(unit.seq)}-${attempt.n}`;
  const worktree = paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  mkdirSync(dirname(worktree), { recursive: true });
  await addWorktree(mirror, worktree, branch, base);

  const standingPath = paths.standingOrders(project.id);
  const brief: RenderedBrief = {
    goal: unit.goal,
    repo: { id: repo.id, worktree, branch, baseSha: base },
    scope: { write: unit.writeScope, forbid: unit.forbidScope },
    context: unit.context,
    readonly: [],
    acceptance: unit.acceptance,
    verify: unit.verify,
    env: {},
    timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
    forbidden: ["no git push, rebase, merge, or branch switching", "nothing outside SCOPE", `do not edit ${repo.verifyPackPath}`],
    method: `Load the yagura-worker skill first and follow it. Then use pstack:poteto-mode${unit.playbook ? ` with the ${unit.playbook} playbook` : ""}.`,
    report: HANDOFF_TEMPLATE,
    standing: existsSync(standingPath) ? readFileSync(standingPath, "utf8") : "",
  };
  const briefText = renderBrief(brief);
  write(paths.brief(project.id, unit.seq, attempt.n), briefText);

  const logPath = paths.log(project.id, unit.seq, attempt.n);
  write(logPath, "");
  const startedAt = now();
  transitionUnit(db, unit.id, "running", { attempt: attempt.n });
  updateAttempt(db, attempt.id, { state: "running", startedAt, worktreePath: worktree, branch, baseSha: base });

  const { argv, stdin } = adapter.command({
    prompt: briefText,
    bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
    model: setting("role.worker.model"),
    permissionMode: setting("harness.claude.permission_mode"),
    pluginDirs: [boot.skillsDir],
    extraArgs: setting("harness.claude.extra_args"),
  });
  const [cmd, ...args] = argv as [string, ...string[]];
  const child = spawn(cmd, args, {
    cwd: worktree,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      YAGURA_ATTEMPT: String(attempt.id),
      YAGURA_PROJECT: project.id,
      YAGURA_UNIT: `U${unit.seq}`,
      YAGURA_ROLE: "worker",
    },
  });
  updateAttempt(db, attempt.id, { pid: child.pid ?? null });
  recordEvent(db, "attempt.started", { projectId: project.id, unitId: unit.id, attemptId: attempt.id }, { pid: child.pid, branch });
  child.stdin.end(stdin);

  let final: Extract<HarnessEvent, { kind: "final" }> | null = null;
  let lastActivity: string | null = null;
  let contextPeak = 0;
  let tokensOut = 0;
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  let timedOut = false;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid && child.exitCode === null) process.kill(-child.pid, signal);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
  }, unit.timeboxSeconds * 1000);

  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    appendFileSync(logPath, `${line}\n`);
    let events: HarnessEvent[];
    try {
      events = adapter.parse(line);
    } catch {
      continue;
    }
    for (const e of events) {
      if (e.kind === "session") updateAttempt(db, attempt.id, { pluginVersions: e.plugins, model: e.model });
      if (e.kind === "usage") {
        contextPeak = Math.max(contextPeak, e.contextTokens);
        tokensOut += e.outputTokens;
        updateAttempt(db, attempt.id, { contextPeak, tokensOut });
      }
      if (e.kind === "tool_call") lastActivity = describeCall(e);
      if (e.kind === "final") final = e;
      ctx.onEvent?.(e);
    }
  }
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const endedAt = now();

  const leftovers = await discardLeftovers(worktree);
  if (leftovers.paths.length) write(paths.leftovers(project.id, unit.seq, attempt.n), leftovers.patch);
  const head = await headSha(worktree);
  const touched = await changedPaths(worktree, base);
  const refs = { projectId: project.id, unitId: unit.id, attemptId: attempt.id };
  const finalMessage = final as Extract<HarnessEvent, { kind: "final" }> | null;
  const handoff = finalMessage && !finalMessage.isError && !timedOut ? parseHandoff(finalMessage.text) : null;

  if (handoff) {
    write(paths.handoff(project.id, unit.seq, attempt.n), finalMessage!.text);
    db.prepare("INSERT INTO search (body, kind, ref_id, project_id) VALUES (?, 'handoff', ?, ?)").run(finalMessage!.text, String(attempt.id), project.id);
    updateAttempt(db, attempt.id, {
      state: "handed_off",
      endedAt,
      exitCode: exit.code,
      headSha: head,
      handoffStatus: handoff.status,
      selfTier: handoff.verification === "not-verified" ? null : handoff.verification,
    });
    transitionUnit(db, unit.id, "handed_off", { attempt: attempt.n, status: handoff.status, head, leftovers: leftovers.paths });
    const violations = checkScope(touched, unit.writeScope, unit.forbidScope);
    if (violations.length) {
      updateAttempt(db, attempt.id, { failureMode: "scope" });
      transitionUnit(db, unit.id, "rejected", { reason: "scope", violations });
    } else if (handoff.status === "blocked") {
      transitionUnit(db, unit.id, "blocked", { reason: "agent reported blocked" });
    }
  } else {
    const facts: ExitFacts = {
      timedOut,
      exitCode: exit.code,
      signal: exit.signal,
      finalText: finalMessage?.text ?? null,
      finalIsError: finalMessage?.isError ?? true,
      stderrTail: stderr,
    };
    const mode = classifyFailure(facts);
    write(
      paths.handoff(project.id, unit.seq, attempt.n),
      syntheticFailureHandoff({ unit: `${project.id}/U${unit.seq}`, attempt: attempt.n, mode, branch, startedAt, endedAt, lastActivity, facts }),
    );
    updateAttempt(db, attempt.id, { state: "failed", endedAt, exitCode: exit.code, headSha: head, failureMode: mode });
    transitionUnit(db, unit.id, "failed", { attempt: attempt.n, mode });
  }
  recordEvent(db, "attempt.ended", refs, { exit: exit.code, signal: exit.signal, timedOut, touched });
  return getAttempt(db, attempt.id);
}
