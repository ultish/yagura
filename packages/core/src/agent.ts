import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Bootstrap } from "./config.js";
import type { Attempt, HarnessEvent, ProjectId, Role, Unit } from "./domain.js";
import type { HarnessAdapter, HarnessRun } from "./harness/adapter.js";
import { missingSkills } from "./pack.js";
import { recordEvent, updateAttempt, type Db } from "./store.js";

export interface RunContext {
  db: Db;
  boot: Bootstrap;
  adapters: Record<string, HarnessAdapter>;
  cli: string[];
  onEvent?: (e: HarnessEvent) => void;
}

export type FinalEvent = Extract<HarnessEvent, { kind: "final" }>;

export interface SessionResult {
  final: FinalEvent | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderrTail: string;
  lastActivity: string | null;
  skills: string[];
  missingSkills: string[];
}

const KILL_GRACE_MS = 10_000;

export function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function describeCall(e: Extract<HarnessEvent, { kind: "tool_call" }>): string {
  const input = e.input as Record<string, unknown> | null;
  const detail = input?.skill ?? input?.command ?? input?.file_path ?? input?.pattern ?? input?.description ?? "";
  return `${e.name}: ${String(detail).slice(0, 120)}`;
}

export async function runAgentSession(
  ctx: RunContext,
  s: {
    attempt: Attempt;
    unit: Unit;
    projectId: ProjectId;
    role: Role;
    adapter: HarnessAdapter;
    run: HarnessRun;
    cwd: string;
    env: Record<string, string>;
    timeboxSeconds: number;
    logPath: string;
  },
): Promise<SessionResult> {
  const { db } = ctx;
  write(s.logPath, "");
  const { argv, stdin } = s.adapter.command(s.run);
  const [cmd, ...args] = argv as [string, ...string[]];
  const child = spawn(cmd, args, {
    cwd: s.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...s.env,
      YAGURA_HOME: ctx.boot.home,
      YAGURA_ATTEMPT: String(s.attempt.id),
      YAGURA_PROJECT: s.projectId,
      YAGURA_UNIT: `U${s.unit.seq}`,
      YAGURA_ROLE: s.role,
      YAGURA_CLI: ctx.cli.join(" "),
    },
  });
  updateAttempt(db, s.attempt.id, { pid: child.pid ?? null });
  recordEvent(db, "attempt.started", { projectId: s.projectId, unitId: s.unit.id, attemptId: s.attempt.id }, { pid: child.pid, role: s.role });
  child.stdin.end(stdin);

  let final: FinalEvent | null = null;
  let lastActivity: string | null = null;
  let contextPeak = 0;
  let tokensOut = 0;
  let stderr = "";
  const skills: string[] = [];
  child.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  let timedOut = false;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
  }, s.timeboxSeconds * 1000);

  for await (const line of createInterface({ input: child.stdout })) {
    appendFileSync(s.logPath, `${line}\n`);
    let events: HarnessEvent[];
    try {
      events = s.adapter.parse(line);
    } catch {
      continue;
    }
    for (const e of events) {
      if (e.kind === "session") updateAttempt(db, s.attempt.id, { pluginVersions: e.plugins, model: e.model });
      if (e.kind === "usage") {
        contextPeak = Math.max(contextPeak, e.contextTokens);
        tokensOut += e.outputTokens;
        updateAttempt(db, s.attempt.id, { contextPeak, tokensOut });
      }
      if (e.kind === "tool_call") {
        lastActivity = describeCall(e);
        const skill = (e.input as { skill?: unknown } | null)?.skill;
        if (e.name === "Skill" && typeof skill === "string") skills.push(skill);
      }
      if (e.kind === "final") final = e;
      ctx.onEvent?.(e);
    }
  }
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  const missing = missingSkills(s.role, skills);
  updateAttempt(db, s.attempt.id, { skills, missingSkills: missing });
  if (missing.length)
    recordEvent(db, "attempt.method_miss", { projectId: s.projectId, unitId: s.unit.id, attemptId: s.attempt.id }, { role: s.role, missing, loaded: skills });

  return { final, exitCode: exit.code, signal: exit.signal, timedOut, stderrTail: stderr, lastActivity, skills, missingSkills: missing };
}
