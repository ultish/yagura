import type { RunContext } from "./agent.js";
// First: proposal.js reaches watchman.js through a cycle, and watchman.js needs ProposalBody while it loads.
import { queuedMessages, runQueuedTurns } from "./watchman.js";
import { resolveSetting } from "./config.js";
import { activeHold } from "./limits.js";
import type { ProjectId, Repo, RepoId } from "./domain.js";
import { YAGURA_MARK, forgeFor, postOnce, signed, type ForgeAdapter, type ForgeIssue } from "./forge.js";
import { applyProposal, describeProposal, discardProposal, ProposalBody, type ApplyProposalResult } from "./proposal.js";
import { getRepo, now, recordEvent, type Db } from "./store.js";
import { addMessage, createThread, linkThreadProject, listMessages, listProposals, type Proposal } from "./threads.js";
import { runningTurn } from "./turns.js";

// Issues are read from a little before the last poll, so one updated while a poll ran is not missed; ids already read are skipped.
const POLL_OVERLAP_MS = 5 * 60_000;
const APPROVE = new Set(["yes", "y", "go", "approve", "approved", "lgtm", "ok", "👍"]);
const DECLINE = new Set(["no", "n", "decline", "declined", "stop", "👎"]);

interface IssueRow {
  repoId: RepoId;
  number: number;
  threadId: number;
  url: string;
  seen: string[];
  postedThrough: number;
  needsApproval: boolean;
}

function toRow(r: Record<string, unknown>): IssueRow {
  return {
    repoId: r.repo_id as RepoId,
    number: r.number as number,
    threadId: r.thread_id as number,
    url: r.url as string,
    seen: JSON.parse(r.seen_json as string) as string[],
    postedThrough: r.posted_through as number,
    needsApproval: r.needs_approval === 1,
  };
}

export function listIssues(db: Db, repoId: RepoId): IssueRow[] {
  return (db.prepare("SELECT * FROM forge_issues WHERE repo_id = ? ORDER BY number").all(repoId) as Record<string, unknown>[]).map(toRow);
}

function getIssue(db: Db, repoId: RepoId, number: number): IssueRow | null {
  const r = db.prepare("SELECT * FROM forge_issues WHERE repo_id = ? AND number = ?").get(repoId, number) as Record<string, unknown> | undefined;
  return r ? toRow(r) : null;
}

const isTrusted = (db: Db, repoId: RepoId, login: string) =>
  resolveSetting(db, "forge.trusted_authors", { repoId })
    .value.map((a) => a.toLowerCase())
    .includes(login.toLowerCase());

export function watchedRepos(db: Db): Repo[] {
  return (db.prepare("SELECT id FROM repos ORDER BY id").all() as { id: RepoId }[])
    .map((r) => getRepo(db, r.id))
    .filter((r) => r.forge !== "none" && resolveSetting(db, "forge.watch_issues", { repoId: r.id }).value);
}

// yagura reads a trusted reply to its question itself; only a first word that plainly says yes or no decides.
export function approvalOf(body: string): "yes" | "no" | null {
  const word =
    body
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[.,!:;]+$/, "") ?? "";
  return APPROVE.has(word) ? "yes" : DECLINE.has(word) ? "no" : null;
}

const quote = (text: string) =>
  (text.trim() || "(empty)")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

function addIssueMessage(db: Db, row: IssueRow, author: string, verb: string, body: string): void {
  const trusted = isTrusted(db, row.repoId, author);
  addMessage(db, {
    threadId: row.threadId,
    role: "human",
    body: `@${author}${trusted ? " (trusted)" : ""} ${verb} on issue #${row.number}:\n\n${quote(body)}`,
  });
  if (!trusted) db.prepare("UPDATE forge_issues SET needs_approval = 1 WHERE repo_id = ? AND number = ?").run(row.repoId, row.number);
}

function projectFor(db: Db, repoId: RepoId): ProjectId | null {
  const row = db
    .prepare(
      "SELECT p.id FROM projects p JOIN project_repos r ON r.project_id = p.id WHERE r.repo_id = ? AND p.state = 'active' ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1",
    )
    .get(repoId) as { id: ProjectId } | undefined;
  return row?.id ?? null;
}

function openIssueThread(db: Db, repo: Repo, issue: ForgeIssue): IssueRow {
  return db.transaction(() => {
    const thread = createThread(db, { title: `#${issue.number} ${issue.title}`, autonomy: "propose" });
    db.prepare("INSERT INTO forge_issues (repo_id, number, thread_id, author, title, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      issue.number,
      thread.id,
      issue.author,
      issue.title,
      issue.url,
      now(),
    );
    const project = projectFor(db, repo.id);
    if (project) linkThreadProject(db, thread.id, project);
    const row = getIssue(db, repo.id, issue.number)!;
    addIssueMessage(db, row, issue.author, "opened", `**${issue.title}**\n\n${issue.body}`);
    recordEvent(db, "issue.opened", project ? { projectId: project } : {}, { repo: repo.id, number: issue.number, thread: thread.id, author: issue.author });
    return getIssue(db, repo.id, issue.number)!;
  })();
}

function pendingProposal(db: Db, threadId: number): Proposal | null {
  return listProposals(db, threadId, "pending").at(-1) ?? null;
}

const keyOf = (row: IssueRow, what: string) => `issue-${row.repoId}-${row.number}-${what}`;

async function post(forge: ForgeAdapter, row: IssueRow, what: string, body: string, keys?: Set<string>): Promise<void> {
  const key = keyOf(row, what);
  if ((keys ?? (await forge.issueReplyKeys(row.number))).has(key)) return;
  await postOnce(key, () => forge.commentOnIssue(row.number, signed(null, body), key));
}

function describeApplied(r: ApplyProposalResult): string {
  const units = (p: string) => (r.units[p]?.length ? ` (${r.units[p]!.join(", ")})` : "");
  const started = r.projects.map((p) => `project **${p}**${units(p)}`);
  const added = Object.keys(r.units)
    .filter((p) => !r.projects.includes(p))
    .map((p) => `${r.units[p]!.join(", ")} on project **${p}**`);
  return [...started, ...added].join("; ") || "nothing new";
}

async function decide(ctx: RunContext, forge: ForgeAdapter, row: IssueRow, proposal: Proposal, verdict: "yes" | "no", by: string | null): Promise<void> {
  const { db } = ctx;
  const who = by ? `@${by}` : "the trusted author";
  db.prepare("UPDATE forge_issues SET needs_approval = 0 WHERE repo_id = ? AND number = ?").run(row.repoId, row.number);
  if (verdict === "no") {
    discardProposal(db, proposal.id, `declined by ${who} on issue #${row.number}`);
    addMessage(db, { threadId: row.threadId, role: "system", body: `Proposal ${proposal.id} declined by ${who} on the issue.` });
    return post(forge, row, `p${proposal.id}`, `Declined by ${who}: nothing will be built for this.`);
  }
  try {
    const applied = await applyProposal(ctx, proposal.id);
    addMessage(db, {
      threadId: row.threadId,
      role: "system",
      body: `Applied proposal ${proposal.id} (approved by ${who} on the issue): ${JSON.stringify(applied)}`,
    });
    await post(forge, row, `p${proposal.id}`, `Approved by ${who}. Started ${describeApplied(applied)}; the change closes this issue when it merges.`);
  } catch (e) {
    const problem = e instanceof Error ? e.message : String(e);
    addMessage(db, { threadId: row.threadId, role: "system", body: `Proposal ${proposal.id} could not be applied: ${problem}` });
    await post(forge, row, `p${proposal.id}`, `Approved by ${who}, but yagura could not start it: ${problem}`);
  }
}

// One poll of a watched repo: new issues become threads and new comments become messages; a trusted yes or no to a pending
// proposal is decided here, without an agent. The first poll only sets the watermark, so issues opened earlier are left alone.
export async function pollIssues(ctx: RunContext, repo: Repo): Promise<void> {
  const { db } = ctx;
  const forge = forgeFor(db, repo);
  if (!forge) return;
  const watch = db.prepare("SELECT since, polled_at FROM issue_watches WHERE repo_id = ?").get(repo.id) as
    { since: string; polled_at: string | null } | undefined;
  if (!watch) {
    db.prepare("INSERT INTO issue_watches (repo_id, since, polled_at) VALUES (?, ?, ?)").run(repo.id, now(), now());
    recordEvent(db, "issue.watch_started", {}, { repo: repo.id });
    return;
  }
  const started = now();
  const issues = await forge.issues(new Date(Date.parse(watch.polled_at ?? watch.since) - POLL_OVERLAP_MS).toISOString());
  for (const issue of issues) {
    let row = getIssue(db, repo.id, issue.number);
    if (!row) {
      if (issue.createdAt < watch.since) continue;
      row = openIssueThread(db, repo, issue);
    }
    for (const c of issue.comments) {
      if (getIssue(db, repo.id, issue.number)!.seen.includes(c.id)) continue;
      db.prepare("UPDATE forge_issues SET seen_json = json_insert(seen_json, '$[#]', ?) WHERE repo_id = ? AND number = ?").run(c.id, repo.id, issue.number);
      if (c.body.includes(YAGURA_MARK)) continue;
      const verdict = isTrusted(db, repo.id, c.author) ? approvalOf(c.body) : null;
      const pending = verdict ? pendingProposal(db, row.threadId) : null;
      if (verdict && pending) await decide(ctx, forge, row, pending, verdict, c.author);
      else addIssueMessage(db, row, c.author, "commented", c.body);
    }
  }
  db.prepare("UPDATE issue_watches SET polled_at = ? WHERE repo_id = ?").run(started, repo.id);
}

function turnsToday(db: Db, threadId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM watchman_turns WHERE thread_id = ? AND started_at >= ?").get(threadId, now().slice(0, 10)) as { n: number }).n;
}

// Answers what is waiting on one issue: the watchman reads the queued comments (within the day's cap), a proposal only trusted
// logins asked for starts at once, and every watchman reply not yet on the issue is posted with its key.
export async function answerIssue(ctx: RunContext, repo: Repo, number: number): Promise<void> {
  const { db } = ctx;
  const forge = forgeFor(db, repo);
  let row = getIssue(db, repo.id, number);
  if (!forge || !row) return;
  if (queuedMessages(db, row.threadId).length && !runningTurn(db, row.threadId) && !activeHold(db)) {
    const cap = resolveSetting(db, "issues.max_turns_per_day", { repoId: repo.id }).value;
    if (turnsToday(db, row.threadId) < cap) await runQueuedTurns(ctx, row.threadId);
    else recordEvent(db, "issue.turn_cap", {}, { repo: repo.id, number, cap });
  }
  row = getIssue(db, repo.id, number)!;
  const pending = pendingProposal(db, row.threadId);
  const replies = listMessages(db, row.threadId).filter((m) => m.role === "watchman" && m.id > row!.postedThrough);
  if (replies.length) {
    const keys = await forge.issueReplyKeys(number);
    for (const m of replies) {
      const asks = pending?.messageId === m.id && row.needsApproval;
      const footer = asks
        ? `\n\n---\n**Proposed:** ${describeProposal(ProposalBody.parse(pending!.body)).split("\n")[0]}\n\nA trusted user can reply **yes** to go ahead, or **no** to decline.`
        : "";
      await post(forge, row, `m${m.id}`, `${m.body}${footer}`, keys);
      db.prepare("UPDATE forge_issues SET posted_through = ? WHERE repo_id = ? AND number = ?").run(m.id, repo.id, number);
    }
  }
  if (pending && !row.needsApproval) await decide(ctx, forge, row, pending, "yes", null);
}
