import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findAction, getAction, recordActionRun } from "./actions.js";
import type { Bootstrap } from "./config.js";
import type { ActionRun, ActionRunner, AttemptId, EnvironmentId, RepoId, Sha } from "./domain.js";
import { valueMap } from "./envvalues.js";
import { runShell } from "./evidence.js";
import { addDetachedWorktree, ensureMirror, removeWorktree, resolveRef } from "./git.js";
import { layout } from "./paths.js";
import { getRepo, type Db } from "./store.js";

type Ctx = { db: Db; boot: Bootstrap };
type Who = { by: ActionRunner; attemptId?: AttemptId | null };

const COMMAND_SECONDS = 900;
const AVAILABLE_TRIES = 24;

// A clean checkout of a commit of the repo, by default the head of its default branch, removed afterwards.
export async function inCheckout<T>(ctx: Ctx, repoId: RepoId, sha: Sha | null, fn: (dir: string, sha: Sha) => Promise<T>): Promise<T> {
  const repo = getRepo(ctx.db, repoId);
  const mirror = layout(ctx.boot).mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const at = sha ?? (await resolveRef(mirror, `refs/remotes/origin/${repo.defaultBranch}`));
  const parent = join(ctx.boot.home, "checkouts");
  mkdirSync(parent, { recursive: true });
  const dir = join(mkdtempSync(join(parent, `${repo.id}-`)), "repo");
  await addDetachedWorktree(mirror, dir, at);
  try {
    return await fn(dir, at);
  } finally {
    await removeWorktree(mirror, dir).catch(() => undefined);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

// Runs one command in a checkout with the environment's values and records it, against the action when there is one.
export async function runIn(
  ctx: Ctx,
  s: { dir: string; sha: Sha; environmentId: EnvironmentId; repoId: RepoId; actionId: number | null; command: string; vars?: Record<string, string> } & Who,
): Promise<ActionRun> {
  const started = Date.now();
  const r = await runShell(s.command, s.dir, { ...process.env, ...valueMap(ctx.db, s.environmentId), YAGURA_SHA: s.sha, ...(s.vars ?? {}) }, COMMAND_SECONDS);
  return recordActionRun(ctx.db, {
    actionId: s.actionId,
    environmentId: s.environmentId,
    repoId: s.repoId,
    sha: s.sha,
    command: s.command,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    durationMs: Date.now() - started,
    output: `${r.stdout.toString("utf8")}${r.stderr.toString("utf8")}`,
    by: s.by,
    attemptId: s.attemptId ?? null,
  });
}

// The version a check publishes under: never a release, never one a unit would use.
export const checkVersion = (raw: string, sha: Sha) =>
  `${raw.trim().replace(/-SNAPSHOT$/, "")}-yg-check-${sha.slice(0, 7)}${/-SNAPSHOT$/.test(raw.trim()) ? "-SNAPSHOT" : ""}`;

const PUBLISHING = ["version", "publish-snapshot", "snapshot-available"];

// Publishing is checked as one: the version, a publish under a check version, and the wait until it can be fetched.
async function checkPublishing(ctx: Ctx, environmentId: EnvironmentId, repoId: RepoId, who: Who, pollMs: number): Promise<ActionRun[]> {
  const action = (name: string) => findAction(ctx.db, environmentId, repoId, name);
  const [version, publish, available] = PUBLISHING.map(action);
  return inCheckout(ctx, repoId, null, async (dir, sha) => {
    const runs: ActionRun[] = [];
    const run = (a: NonNullable<typeof version>, vars?: Record<string, string>) =>
      runIn(ctx, { dir, sha, environmentId, repoId, actionId: a.id, command: a.command, vars, ...who }).then((r) => (runs.push(r), r));
    if (!version) return runs;
    const v = await run(version);
    const raw = v.output.trim().split("\n")[0] ?? "";
    if (v.exitCode !== 0 || !raw || !publish) return runs;
    const vars = { YAGURA_VERSION: checkVersion(raw, sha) };
    if ((await run(publish, vars)).exitCode !== 0 || !available) return runs;
    for (let i = 0; i < AVAILABLE_TRIES; i++) {
      if ((await run(available, vars)).exitCode === 0) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return runs;
  });
}

// Run now: proves or breaks one saved action on the repo it applies to (an environment-wide action needs a repo named).
export async function runAction(ctx: Ctx, actionId: number, repoId: RepoId | null, who: Who, opts: { pollMs?: number } = {}): Promise<ActionRun[]> {
  const a = getAction(ctx.db, actionId);
  const repo = a.repoId ?? repoId;
  if (!repo) throw new Error(`${a.name} applies to every repo here; say which repo to run it on`);
  if (PUBLISHING.includes(a.name)) return checkPublishing(ctx, a.environmentId, repo, who, opts.pollMs ?? 5000);
  return [
    await inCheckout(ctx, repo, null, (dir, sha) =>
      runIn(ctx, { dir, sha, environmentId: a.environmentId, repoId: repo, actionId: a.id, command: a.command, ...who }),
    ),
  ];
}
