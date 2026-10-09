import {
  ANSWER_KEYS,
  ANSWER_QUESTIONS,
  type Action,
  type ActionAuthor,
  type ActionRun,
  type ActionRunner,
  type Answers,
  type AttemptId,
  type EnvironmentId,
  type IsoTime,
  type RepoId,
  type Sha,
} from "./domain.js";
import { getEnvironment, now, recordEvent, type Db } from "./store.js";

const OUTPUT_TAIL = 8000;

export function setAnswers(db: Db, environmentId: EnvironmentId, patch: Partial<Answers>): Answers {
  const answers = { ...getEnvironment(db, environmentId).answers };
  for (const [k, v] of Object.entries(patch)) {
    if (!(ANSWER_KEYS as readonly string[]).includes(k)) throw new Error(`no question "${k}"; the questions are ${ANSWER_KEYS.join(", ")}`);
    answers[k as keyof Answers] = String(v ?? "").trim();
  }
  db.prepare("UPDATE environments SET answers_json = ? WHERE id = ?").run(JSON.stringify(answers), environmentId);
  recordEvent(db, "environment.answers", {}, { environment: environmentId, keys: Object.keys(patch) });
  return answers;
}

// The answers as an agent's brief shows them: question, then the developer's words; unanswered questions are left out.
export function answerLines(answers: Answers): string[] {
  return ANSWER_KEYS.filter((k) => answers[k]).map((k) => (k === "other" ? answers[k] : `${ANSWER_QUESTIONS[k]} ${answers[k]}`));
}

const toAction = (r: Record<string, unknown>): Action => ({
  id: r.id as number,
  environmentId: r.environment_id as EnvironmentId,
  repoId: (r.repo_id as RepoId | null) ?? null,
  name: r.name as string,
  use: r.purpose as string,
  command: r.command as string,
  state: r.state as Action["state"],
  author: r.author as ActionAuthor,
  authorAttemptId: (r.author_attempt_id as AttemptId | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  suggestion: r.suggestion_json ? (JSON.parse(r.suggestion_json as string) as Action["suggestion"]) : null,
  lastRunId: (r.last_run_id as number | null) ?? null,
  createdAt: r.created_at as IsoTime,
  updatedAt: r.updated_at as IsoTime,
});

const toRun = (r: Record<string, unknown>): ActionRun => ({
  id: r.id as number,
  actionId: (r.action_id as number | null) ?? null,
  environmentId: r.environment_id as EnvironmentId,
  repoId: r.repo_id as RepoId,
  sha: r.sha as Sha,
  command: r.command as string,
  exitCode: (r.exit_code as number | null) ?? null,
  timedOut: r.timed_out === 1,
  durationMs: r.duration_ms as number,
  output: r.output as string,
  by: r.by as ActionRunner,
  attemptId: (r.attempt_id as AttemptId | null) ?? null,
  createdAt: r.created_at as IsoTime,
});

export function getAction(db: Db, id: number): Action {
  const r = db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`action ${id} not found`);
  return toAction(r);
}

export function listActions(db: Db, environmentId: EnvironmentId): Action[] {
  return (
    db.prepare("SELECT * FROM actions WHERE environment_id = ? ORDER BY name, coalesce(repo_id, '')").all(environmentId) as Record<string, unknown>[]
  ).map(toAction);
}

// The actions that apply to one repo: its own, and the environment-wide ones it does not override by name.
export function actionsFor(db: Db, environmentId: EnvironmentId, repoId: RepoId): Action[] {
  const all = listActions(db, environmentId).filter((a) => a.repoId === repoId || a.repoId === null);
  return all.filter((a) => a.repoId === repoId || !all.some((b) => b.name === a.name && b.repoId === repoId));
}

export const findAction = (db: Db, environmentId: EnvironmentId, repoId: RepoId, name: string): Action | null =>
  actionsFor(db, environmentId, repoId).find((a) => a.name === name) ?? null;

export function getActionRun(db: Db, id: number): ActionRun {
  const r = db.prepare("SELECT * FROM action_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`action run ${id} not found`);
  return toRun(r);
}

export function listActionRuns(db: Db, actionId: number, limit = 10): ActionRun[] {
  return (db.prepare("SELECT * FROM action_runs WHERE action_id = ? ORDER BY id DESC LIMIT ?").all(actionId, limit) as Record<string, unknown>[]).map(toRun);
}

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
function checkFields(f: { name: string; use: string; command: string }) {
  if (!NAME.test(f.name)) throw new Error(`action name "${f.name}" must be lower case letters, digits and dashes, up to 48`);
  if (!f.use.trim()) throw new Error("say when to use the action");
  if (!f.command.trim()) throw new Error("the action needs a command");
}

// The developer adds or changes an action. A new one is unproven; a changed command or scope is unproven again (edited); a
// reworded use keeps its proof. Once the developer has touched an action it is theirs, and the doctor only suggests.
export function saveAction(
  db: Db,
  a: { id?: number; environmentId: EnvironmentId; repoId: RepoId | null; name: string; use: string; command: string },
): Action {
  checkFields(a);
  const t = now();
  if (a.id === undefined) {
    const id = Number(
      db
        .prepare(
          "INSERT INTO actions (environment_id, repo_id, name, purpose, command, state, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'unproven', 'you', ?, ?)",
        )
        .run(a.environmentId, a.repoId, a.name, a.use.trim(), a.command.trim(), t, t).lastInsertRowid,
    );
    recordEvent(db, "action.saved", {}, { action: id, by: "you", name: a.name });
    return getAction(db, id);
  }
  const before = getAction(db, a.id);
  const rerun = before.command !== a.command.trim() || before.repoId !== a.repoId;
  const state = !rerun ? before.state : before.state === "unproven" ? "unproven" : "edited";
  db.prepare("UPDATE actions SET repo_id = ?, name = ?, purpose = ?, command = ?, state = ?, author = 'you', reason = ?, updated_at = ? WHERE id = ?").run(
    a.repoId,
    a.name,
    a.use.trim(),
    a.command.trim(),
    state,
    rerun ? null : before.reason,
    t,
    a.id,
  );
  recordEvent(db, "action.saved", {}, { action: a.id, by: "you", name: a.name, rerun });
  return getAction(db, a.id);
}

export function deleteAction(db: Db, id: number): void {
  const a = getAction(db, id);
  db.prepare("DELETE FROM actions WHERE id = ?").run(id);
  recordEvent(db, "action.deleted", {}, { action: id, name: a.name, environment: a.environmentId });
}

// Every run yagura makes of an action's command, kept with its output; a run of a saved action proves or breaks it.
export function recordActionRun(
  db: Db,
  r: {
    actionId: number | null;
    environmentId: EnvironmentId;
    repoId: RepoId;
    sha: Sha;
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    output: string;
    by: ActionRunner;
    attemptId?: AttemptId | null;
  },
): ActionRun {
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO action_runs (action_id, environment_id, repo_id, sha, command, exit_code, timed_out, duration_ms, output, by, attempt_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.actionId,
          r.environmentId,
          r.repoId,
          r.sha,
          r.command,
          r.exitCode,
          r.timedOut ? 1 : 0,
          r.durationMs,
          r.output.slice(-OUTPUT_TAIL),
          r.by,
          r.attemptId ?? null,
          now(),
        ).lastInsertRowid,
    );
    const run = getActionRun(db, id);
    if (r.actionId !== null) {
      const ok = passed(run);
      db.prepare("UPDATE actions SET state = ?, reason = ?, last_run_id = ?, updated_at = ? WHERE id = ?").run(
        ok ? "proven" : "broken",
        ok ? null : failure(run),
        id,
        now(),
        r.actionId,
      );
      recordEvent(db, ok ? "action.proven" : "action.broken", {}, { action: r.actionId, run: id });
    }
    return run;
  })();
}

export const passed = (run: ActionRun) => run.exitCode === 0 && !run.timedOut;

export function failure(run: ActionRun): string {
  const last = run.output.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
  return `${run.timedOut ? "timed out" : `exit ${run.exitCode}`} on ${run.sha.slice(0, 7)}${last ? `: ${last}` : ""}`;
}

// An agent says a saved action does not work; it stays broken until a run of it passes.
export function reportBroken(db: Db, id: number, reason: string, attemptId: AttemptId): Action {
  if (!reason.trim()) throw new Error("say what went wrong");
  db.prepare("UPDATE actions SET state = 'broken', reason = ?, updated_at = ? WHERE id = ?").run(reason.trim(), now(), id);
  recordEvent(db, "action.broken", {}, { action: id, attempt: attemptId, reason });
  return getAction(db, id);
}

// A doctor or agent proposal whose run passed. An action the developer wrote or edited is never overwritten: the command
// becomes a suggestion beside theirs. Otherwise the proposal is saved, proven by that run.
export function adoptProposal(
  db: Db,
  p: {
    environmentId: EnvironmentId;
    repoId: RepoId | null;
    name: string;
    use: string;
    author: Exclude<ActionAuthor, "you">;
    attemptId: AttemptId;
    run: ActionRun;
  },
): { action: Action; suggested: boolean } {
  if (!passed(p.run)) throw new Error(`the run did not pass (${failure(p.run)}); nothing was saved`);
  checkFields({ name: p.name, use: p.use, command: p.run.command });
  const existing = db
    .prepare("SELECT id FROM actions WHERE environment_id = ? AND coalesce(repo_id, '') = coalesce(?, '') AND name = ?")
    .get(p.environmentId, p.repoId, p.name) as { id: number } | undefined;
  const t = now();
  if (existing) {
    const before = getAction(db, existing.id);
    if (before.author === "you") {
      if (before.command === p.run.command) return { action: before, suggested: false };
      db.prepare("UPDATE actions SET suggestion_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ command: p.run.command, why: p.use }),
        t,
        before.id,
      );
      recordEvent(db, "action.suggested", {}, { action: before.id, attempt: p.attemptId });
      return { action: getAction(db, before.id), suggested: true };
    }
    db.prepare(
      "UPDATE actions SET purpose = ?, command = ?, state = 'proven', author = ?, author_attempt_id = ?, reason = NULL, last_run_id = ?, updated_at = ? WHERE id = ?",
    ).run(p.use.trim(), p.run.command, p.author, p.attemptId, p.run.id, t, before.id);
    db.prepare("UPDATE action_runs SET action_id = ? WHERE id = ?").run(before.id, p.run.id);
    recordEvent(db, "action.saved", {}, { action: before.id, by: p.author, attempt: p.attemptId, name: p.name });
    return { action: getAction(db, before.id), suggested: false };
  }
  const id = Number(
    db
      .prepare(
        `INSERT INTO actions (environment_id, repo_id, name, purpose, command, state, author, author_attempt_id, last_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'proven', ?, ?, ?, ?, ?)`,
      )
      .run(p.environmentId, p.repoId, p.name, p.use.trim(), p.run.command, p.author, p.attemptId, p.run.id, t, t).lastInsertRowid,
  );
  db.prepare("UPDATE action_runs SET action_id = ? WHERE id = ?").run(id, p.run.id);
  recordEvent(db, "action.saved", {}, { action: id, by: p.author, attempt: p.attemptId, name: p.name });
  return { action: getAction(db, id), suggested: false };
}

// The developer takes the doctor's suggested command (it is then theirs and needs a run) or sets it aside.
export function answerSuggestion(db: Db, id: number, accept: boolean): Action {
  const a = getAction(db, id);
  if (!a.suggestion) throw new Error(`action ${a.name} has no suggestion`);
  if (accept)
    db.prepare("UPDATE actions SET command = ?, state = 'edited', reason = NULL, suggestion_json = NULL, updated_at = ? WHERE id = ?").run(
      a.suggestion.command,
      now(),
      id,
    );
  else db.prepare("UPDATE actions SET suggestion_json = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  recordEvent(db, "action.suggestion", {}, { action: id, accepted: accept });
  return getAction(db, id);
}

// What every agent's brief says about its environment: the developer's answers, then the actions for its repo and how to use them.
export function environmentSection(db: Db, environmentId: EnvironmentId | null, repoId: RepoId | null): string {
  if (!environmentId) return "This project has no environment, so yagura knows nothing about how things run here: work it out and say so in your decision log.";
  const env = getEnvironment(db, environmentId);
  const words = answerLines(env.answers);
  const actions = repoId ? actionsFor(db, environmentId, repoId) : [];
  const line = (a: Action) => `- \`${a.name}\` (${a.state}${a.reason ? `: ${a.reason}` : ""}): ${a.use}\n  \`${a.command}\``;
  return [
    `Environment ${environmentId}, in the developer's words:`,
    ...(words.length ? words.map((w) => `- ${w}`) : ["- (no answers yet)"]),
    "",
    repoId ? `Actions for ${repoId}: commands for this environment, each proven or broken by yagura's own runs.` : "",
    ...actions.map(line),
    ...(repoId && !actions.some((a) => a.name === "test")
      ? ["- No action runs this repo's tests yet: work out the command from the answers above, use it, and say so in your decision log."]
      : []),
    "",
    "Run an action's command with `yagura evidence run -- <command>` so the run is recorded and can be cited.",
    'When one does not work here, say so: `yagura action broken --name <name> --reason "…"`. When you work out a command worth keeping, offer it: `yagura action propose --name <name> --use "<when to use it>" -- <command>`; yagura runs it on a clean checkout and keeps it only if it passes.',
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}
