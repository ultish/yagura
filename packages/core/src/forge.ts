import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolveSetting } from "./config.js";
import type { IsoTime, Repo, Sha, UnitId } from "./domain.js";
import { now, recordEvent, type Db } from "./store.js";

export type MergeState = "clean" | "behind" | "conflict" | "blocked" | "unknown";

export interface PrStatus {
  state: "open" | "merged" | "closed";
  merge: MergeState;
  failing: string[];
  pending: string[];
  headSha: Sha;
  mergedSha: Sha | null;
}

export interface ForgeAdapter {
  kind: "github" | "gitlab";
  repo: string;
  find(branch: string): Promise<{ number: number; url: string } | null>;
  open(pr: { branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  status(number: number): Promise<PrStatus>;
  merge(number: number, headSha: Sha, method: "rebase" | "squash" | "merge"): Promise<void>;
  close(number: number, comment: string): Promise<void>;
  failedRuns(headSha: Sha): Promise<{ id: number; name: string; log: string }[]>;
  // CI on a commit as a whole: none ran, still running, all passed, or something failed.
  commitChecks(sha: Sha): Promise<"none" | "pending" | "success" | "failure">;
  rerunFailed(runId: number): Promise<void>;
  threads(number: number): Promise<PrThread[]>;
  replyKeys(number: number): Promise<Set<string>>;
  reply(number: number, thread: Pick<PrThread, "id" | "kind">, body: string, key: string): Promise<void>;
  // A comment on one line of the change, for yagura's own reviewer; returns where to reply, or null when the forge took
  // it only as a plain comment (the line is not in the diff it shows).
  // `plain` is the text to post instead when the forge refuses the line (it names the location itself).
  comment(number: number, at: { path: string; line: number; headSha: Sha } | null, body: string, key: string, plain?: string): Promise<string | null>;
  replyTo(number: number, ref: string, body: string, key: string): Promise<void>;
  // Open issues (never pull or merge requests) updated at or after `since`, each with its comments oldest first.
  issues(since: string): Promise<ForgeIssue[]>;
  issueReplyKeys(number: number): Promise<Set<string>>;
  commentOnIssue(number: number, body: string, key: string): Promise<void>;
}

// Issue text is untrusted like review text: it reaches the watchman only as quoted messages.
export interface ForgeIssue {
  number: number;
  title: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  comments: { id: string; author: string; body: string; createdAt: string }[];
}

// What the forge calls a change under review: "pull request #4" on GitHub, "merge request !4" on GitLab.
const onGitlab = (forge: string) => forge === "glab" || forge === "gitlab";
export const prNoun = (forge: string) => (onGitlab(forge) ? "merge request" : "pull request");
export const prRef = (forge: string, n: number) => (onGitlab(forge) ? `merge request !${n}` : `pull request #${n}`);

export type ThreadKind = "review-thread" | "comment" | "review";

// Reviewer text is untrusted data: it reaches agents only as quoted CONTEXT, never a command.
export interface PrThread {
  id: string;
  kind: ThreadKind;
  author: string;
  path: string | null;
  line: number | null;
  comments: string[];
}

// Everything yagura posts carries this marker, so its own replies never read as new review activity.
export const YAGURA_MARK = "<!-- yagura -->";
// yagura posts through the developer's own account, so every post opens with one line saying who wrote it: yagura, the agent
// (role and run number, "A4"), and then the comment. An emoji per agent makes the author readable at a glance.
// Each emoji has a twin icon in the dashboard (apps/web/src/ui/RoleIcon.tsx): map, hammer, shield-check, eye, scale, compass, shuffle,
// search, package. A test in the web app keeps the two lists covering the same roles. The names under "later" are the decided new names.
export const AGENT_EMOJI: Record<string, string> = {
  planner: "\u{1F5FA}\uFE0F",
  worker: "\u{1F528}",
  verifier: "\u{1F6E1}\uFE0F",
  reviewer: "\u{1F441}\uFE0F",
  "review triage": "\u2696\uFE0F",
  manager: "\u{1F9ED}",
  rebase: "\u{1F500}",
  investigator: "\u{1F50D}",
  "pack writer": "\u{1F4E6}",
  // later: project lead, unit lead, arbiter
  "project lead": "\u{1F5FA}\uFE0F",
  "unit lead": "\u{1F9ED}",
  arbiter: "\u2696\uFE0F",
};
const YAGURA_EMOJI = "\u2699\uFE0F";
// `who` is the agent that wrote the text; yagura's own engine (a pin notice, a close) passes none.
export function signed(who: { role: string; run: string } | null, text: string): string {
  const head = who ? `${AGENT_EMOJI[who.role] ?? YAGURA_EMOJI} **yagura ${who.role}** \u00b7 ${who.run}` : `${YAGURA_EMOJI} **yagura**`;
  return `${head}\n\n${text}`;
}
const SIGNED = /^\S+ \*\*yagura[ *]/;
export const marked = (body: string) => `${SIGNED.test(body) ? body : signed(null, body)}\n\n${YAGURA_MARK}`;
// The PR watcher and the end of a triage run can both be about to post the same reply. The forge's keys do not show a post
// still in flight, so within this process only one caller posts a given key at a time; a caller that finds it taken skips it,
// and one that gets it after the first finished must check its own records again before posting.
const posting = new Set<string>();
export async function postOnce<T>(key: string, post: () => Promise<T>): Promise<{ posted: T } | null> {
  if (posting.has(key)) return null;
  posting.add(key);
  try {
    return { posted: await post() };
  } finally {
    posting.delete(key);
  }
}

// GitHub can report a failure for a reply it did post, so each reply carries a key yagura checks before posting again.
const keyed = (body: string, key: string) => `${marked(body)}\n<!-- yagura-reply:${key} -->`;

export function readReplyKeys(data: unknown): Set<string> {
  const keys = new Set<string>();
  for (const m of JSON.stringify(data).matchAll(/<!-- yagura-reply:([^ ]+?) -->/g)) keys.add(m[1]!);
  return keys;
}
const isYagura = (body: string) => body.includes(YAGURA_MARK);

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 50) { nodes { author { login } body } } } }
      comments(first: 100) { nodes { id author { login } body } }
      reviews(first: 50) { nodes { id author { login } body state } }
    }
  }
}`;
const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
}`;

type Author = { login: string } | null;
export function readThreads(data: unknown): PrThread[] {
  const pr = (
    data as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: { id: string; isResolved: boolean; path: string | null; line: number | null; comments: { nodes: { author: Author; body: string }[] } }[];
            };
            comments: { nodes: { id: string; author: Author; body: string }[] };
            reviews: { nodes: { id: string; author: Author; body: string; state: string }[] };
          };
        };
      };
    }
  ).data.repository.pullRequest;
  const out: PrThread[] = [];
  for (const t of pr.reviewThreads.nodes) {
    const comments = t.comments.nodes.filter((c) => !isYagura(c.body));
    if (t.isResolved || !comments.length) continue;
    out.push({
      id: t.id,
      kind: "review-thread",
      author: comments[0]!.author?.login ?? "ghost",
      path: t.path,
      line: t.line,
      comments: comments.map((c) => c.body),
    });
  }
  for (const c of pr.comments.nodes)
    if (!isYagura(c.body) && c.body.trim())
      out.push({ id: c.id, kind: "comment", author: c.author?.login ?? "ghost", path: null, line: null, comments: [c.body] });
  for (const r of pr.reviews.nodes)
    if (!isYagura(r.body) && r.body.trim())
      out.push({ id: r.id, kind: "review", author: r.author?.login ?? "ghost", path: null, line: null, comments: [r.body] });
  return out;
}

export class ForgeError extends Error {}

const LOG_LINES = 60;

// Titles, bodies, and comments go to gh and glab as arguments or stdin, never through a shell.
function gh(bin: string, args: string[], stdin?: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      // Outside any checkout: glab mr create reads the working directory's git remotes even when --repo names the project.
      { cwd: tmpdir(), env: { ...process.env, GH_PROMPT_DISABLED: "1", GLAB_NO_PROMPT: "1", NO_COLOR: "1", ...env }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new ForgeError(`${bin} ${args.slice(0, 2).join(" ")} failed: ${(stderr || err.message).trim().split("\n")[0]}`)) : resolve(stdout.trim()),
    );
    child.stdin?.end(stdin ?? "");
  });
}

// git@github.com:owner/name.git, https://github.com/owner/name(.git), ssh://git@host/owner/name
export function forgeRepoOf(url: string): string | null {
  const m = /^(?:git@([^:]+):|(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return null;
  const host = m[1] ?? m[2]!;
  return `${host === "github.com" ? "" : `${host}/`}${m[3]}/${m[4]}`;
}

type Check = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string };
const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

export function readChecks(rollup: Check[]): { failing: string[]; pending: string[] } {
  const failing: string[] = [];
  const pending: string[] = [];
  for (const c of rollup) {
    const name = c.name ?? c.context ?? "check";
    if (c.state !== undefined && c.status === undefined) {
      if (FAILED.has(c.state)) failing.push(name);
      else if (c.state !== "SUCCESS") pending.push(name);
    } else if (c.status !== "COMPLETED") pending.push(name);
    else if (FAILED.has(c.conclusion ?? "")) failing.push(name);
  }
  return { failing, pending };
}

const MERGE_STATES: Record<string, MergeState> = {
  CLEAN: "clean",
  HAS_HOOKS: "clean",
  UNSTABLE: "clean",
  BEHIND: "behind",
  DIRTY: "conflict",
  BLOCKED: "blocked",
  DRAFT: "blocked",
};

export function githubForge(bin: string, repo: string): ForgeAdapter {
  const R = ["--repo", repo];
  const repoParts = repo.split("/");
  const host = repoParts.length === 3 ? ["--hostname", repoParts[0]!] : [];
  const numberOf = (url: string) => {
    const n = /\/pull\/(\d+)/.exec(url)?.[1];
    if (!n) throw new ForgeError(`gh did not return a pull request URL: ${url.slice(0, 200)}`);
    return Number(n);
  };
  return {
    kind: "github",
    repo,
    async find(branch) {
      const found = JSON.parse(await gh(bin, ["pr", "list", ...R, "--head", branch, "--state", "open", "--json", "number,url"])) as {
        number: number;
        url: string;
      }[];
      return found[0] ?? null;
    },
    async open(pr) {
      const url = (await gh(bin, ["pr", "create", ...R, "--head", pr.branch, "--base", pr.base, "--title", pr.title, "--body-file", "-"], pr.body))
        .split("\n")
        .at(-1)!;
      return { number: numberOf(url), url };
    },
    async status(number) {
      const v = JSON.parse(
        await gh(bin, ["pr", "view", String(number), ...R, "--json", "state,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,mergeCommit"]),
      ) as {
        state: string;
        mergeable: string;
        mergeStateStatus: string;
        statusCheckRollup: Check[] | null;
        headRefOid: string;
        mergeCommit: { oid: string } | null;
      };
      const checks = readChecks(v.statusCheckRollup ?? []);
      return {
        state: v.state === "MERGED" ? "merged" : v.state === "CLOSED" ? "closed" : "open",
        merge: v.mergeable === "CONFLICTING" ? "conflict" : (MERGE_STATES[v.mergeStateStatus] ?? "unknown"),
        ...checks,
        headSha: v.headRefOid as Sha,
        mergedSha: (v.mergeCommit?.oid as Sha | undefined) ?? null,
      };
    },
    async merge(number, headSha, method) {
      await gh(bin, ["pr", "merge", String(number), ...R, `--${method}`, "--match-head-commit", headSha]);
    },
    async close(number, comment) {
      await gh(bin, ["pr", "close", String(number), ...R, "--comment", marked(comment)]);
    },
    async failedRuns(headSha) {
      const runs = JSON.parse(await gh(bin, ["run", "list", ...R, "--commit", headSha, "--json", "databaseId,name,conclusion"])) as {
        databaseId: number;
        name: string;
        conclusion: string;
      }[];
      const failed = runs.filter((r) => ["failure", "timed_out", "startup_failure"].includes(r.conclusion));
      return Promise.all(
        failed.map(async (r) => ({
          id: r.databaseId,
          name: r.name,
          log: (await gh(bin, ["run", "view", String(r.databaseId), ...R, "--log-failed"]).catch(() => "")).split("\n").slice(-LOG_LINES).join("\n"),
        })),
      );
    },
    async rerunFailed(runId) {
      await gh(bin, ["run", "rerun", String(runId), ...R, "--failed"]);
    },
    async commitChecks(sha) {
      const runs = JSON.parse(await gh(bin, ["run", "list", ...R, "--commit", sha, "--json", "databaseId,name,status,conclusion"])) as {
        status: string;
        conclusion: string;
      }[];
      if (!runs.length) return "none";
      if (runs.some((r) => r.status !== "completed")) return "pending";
      return runs.some((r) => ["failure", "timed_out", "startup_failure"].includes(r.conclusion)) ? "failure" : "success";
    },
    async threads(number) {
      const [owner, name] = repoParts.slice(-2);
      return readThreads(
        JSON.parse(
          await gh(bin, ["api", "graphql", ...host, "-f", `query=${THREADS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]),
        ),
      );
    },
    async replyKeys(number) {
      const [owner, name] = repoParts.slice(-2);
      return readReplyKeys(
        JSON.parse(
          await gh(bin, ["api", "graphql", ...host, "-f", `query=${THREADS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]),
        ),
      );
    },
    async reply(number, thread, body, key) {
      if (thread.kind === "review-thread")
        await gh(bin, ["api", "graphql", ...host, "-f", `query=${REPLY_MUTATION}`, "-F", `thread=${thread.id}`, "-F", "body=@-"], keyed(body, key));
      else await gh(bin, ["pr", "comment", String(number), ...R, "--body-file", "-"], keyed(body, key));
    },
    async comment(number, at, body, key, plain) {
      const path = `repos/${repoParts.slice(-2).join("/")}/pulls/${number}/comments`;
      if (at)
        try {
          const posted = JSON.parse(
            await gh(
              bin,
              ["api", ...host, "--method", "POST", path, "--input", "-"],
              JSON.stringify({ body: keyed(body, key), commit_id: at.headSha, path: at.path, line: at.line, side: "RIGHT" }),
            ),
          ) as { id: number };
          return `c:${posted.id}`;
        } catch {
          // GitHub refuses a line outside the diff it shows; the finding still goes on the pull request.
        }
      await gh(bin, ["pr", "comment", String(number), ...R, "--body-file", "-"], keyed(plain ?? body, key));
      return null;
    },
    async replyTo(number, ref, body, key) {
      await gh(
        bin,
        ["api", ...host, "--method", "POST", `repos/${repoParts.slice(-2).join("/")}/pulls/${number}/comments/${ref.slice(2)}/replies`, "--input", "-"],
        JSON.stringify({ body: keyed(body, key) }),
      );
    },
    async issues(since) {
      const listed = JSON.parse(
        await gh(bin, ["issue", "list", ...R, "--state", "open", "--limit", "100", "--json", "number,title,author,body,url,createdAt,updatedAt"]),
      ) as { number: number; title: string; author: Author; body: string; url: string; createdAt: string; updatedAt: string }[];
      return Promise.all(
        listed
          .filter((i) => i.updatedAt >= since)
          .sort((a, b) => a.number - b.number)
          .map(async (i) => ({
            number: i.number,
            title: i.title,
            author: i.author?.login ?? "ghost",
            body: i.body ?? "",
            url: i.url,
            createdAt: i.createdAt,
            comments: readGithubIssueComments(JSON.parse(await gh(bin, ["issue", "view", String(i.number), ...R, "--json", "comments"]))),
          })),
      );
    },
    async issueReplyKeys(number) {
      return readReplyKeys(JSON.parse(await gh(bin, ["issue", "view", String(number), ...R, "--json", "comments"])));
    },
    async commentOnIssue(number, body, key) {
      await gh(bin, ["issue", "comment", String(number), ...R, "--body-file", "-"], keyed(body, key));
    },
  };
}

export function readGithubIssueComments(data: { comments?: { id: string; author: Author; body: string; createdAt: string }[] }): ForgeIssue["comments"] {
  return (data.comments ?? []).map((c) => ({ id: c.id, author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt }));
}

type GlIssue = { iid: number; title: string; author: { username: string } | null; description: string | null; web_url: string; created_at: string };
export function readGitlabIssue(issue: GlIssue, notes: GlNote[]): ForgeIssue {
  return {
    number: issue.iid,
    title: issue.title,
    author: issue.author?.username ?? "ghost",
    body: issue.description ?? "",
    url: issue.web_url,
    createdAt: issue.created_at,
    comments: notes
      .filter((n) => !n.system)
      .map((n) => ({ id: String(n.id), author: n.author?.username ?? "ghost", body: n.body, createdAt: n.created_at ?? "" }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.id) - Number(b.id)),
  };
}

// GitLab: a merge request's discussions are its threads. A discussion of one note is a plain comment; the rest
// (diff notes and started threads) are review threads, skipped once resolved. System notes are GitLab's own log.
type GlNote = {
  id: number;
  body: string;
  system: boolean;
  author: { username: string } | null;
  created_at?: string;
  resolvable?: boolean;
  resolved?: boolean;
  position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null;
};
export function readGitlabThreads(discussions: { id: string; individual_note: boolean; notes: GlNote[] }[]): PrThread[] {
  const out: PrThread[] = [];
  for (const d of discussions) {
    const notes = d.notes.filter((n) => !n.system && !isYagura(n.body) && n.body.trim());
    if (!notes.length || d.notes.some((n) => n.resolvable && n.resolved)) continue;
    const first = d.notes[0]!;
    out.push({
      id: d.id,
      kind: d.individual_note ? "comment" : "review-thread",
      author: notes[0]!.author?.username ?? "ghost",
      path: first.position?.new_path ?? first.position?.old_path ?? null,
      line: first.position?.new_line ?? first.position?.old_line ?? null,
      comments: notes.map((n) => n.body),
    });
  }
  return out;
}

const GITLAB_MERGE: Record<string, MergeState> = {
  mergeable: "clean",
  need_rebase: "behind",
  conflict: "conflict",
  checking: "unknown",
  unchecked: "unknown",
  preparing: "unknown",
};
const PIPELINE_FAILED = new Set(["failed", "canceled"]);
const PIPELINE_DONE = new Set(["success", "skipped", "manual", ...PIPELINE_FAILED]);

export function readGitlabStatus(mr: {
  state: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  sha: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  head_pipeline?: { status: string } | null;
}): PrStatus {
  const pipeline = mr.head_pipeline?.status;
  const state = mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed";
  return {
    state,
    merge: mr.has_conflicts ? "conflict" : (GITLAB_MERGE[mr.detailed_merge_status ?? ""] ?? "blocked"),
    failing: pipeline && PIPELINE_FAILED.has(pipeline) ? ["pipeline"] : [],
    pending: pipeline && !PIPELINE_DONE.has(pipeline) ? ["pipeline"] : [],
    headSha: mr.sha as Sha,
    // A fast-forward merge has no merge commit: the head itself is what landed.
    mergedSha: state === "merged" ? ((mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha) as Sha) : null,
  };
}

// A GitLab job trace carries a timestamp and stream prefix on every line (runner 17+), colour codes, and section markers.
export function readableTrace(trace: string): string {
  return trace
    .split("\n")
    .map((line) =>
      line
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z \d\d[OE]\+?/, "")
        .replace(/section_(start|end):\d+:[\w-]+(\[collapsed=true\])?/g, "")
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
        .replace(/\r/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

// forge.repo for GitLab is host/group/…/name; groups nest, so the first segment is always the host.
export function gitlabForge(bin: string, repo: string): ForgeAdapter {
  const [host, ...rest] = repo.split("/");
  const path = rest.join("/");
  // glab api --hostname refuses a host with a port (localhost:8080); GITLAB_HOST alone selects the host for every command.
  const env = { GITLAB_HOST: host! };
  const R = ["--repo", path];
  const api = (args: string[], body?: unknown) =>
    gh(
      bin,
      ["api", ...args, ...(body === undefined ? [] : ["--input", "-", "--header", "Content-Type: application/json"])],
      body === undefined ? undefined : JSON.stringify(body),
      env,
    );
  const project = `projects/${encodeURIComponent(path)}`;
  const iidOf = (url: string) => {
    const n = /\/merge_requests\/(\d+)/.exec(url)?.[1];
    if (!n) throw new ForgeError(`glab did not return a merge request URL: ${url.slice(0, 200)}`);
    return Number(n);
  };
  const discussions = async (iid: number) =>
    JSON.parse(await api(["--paginate", `${project}/merge_requests/${iid}/discussions?per_page=100`])) as Parameters<typeof readGitlabThreads>[0];
  return {
    kind: "gitlab",
    repo,
    async find(branch) {
      const found = JSON.parse(await gh(bin, ["mr", "list", ...R, "--source-branch", branch, "--output", "json"], undefined, env)) as {
        iid: number;
        web_url: string;
      }[];
      return found[0] ? { number: found[0].iid, url: found[0].web_url } : null;
    },
    async open(mr) {
      const printed = await gh(
        bin,
        ["mr", "create", ...R, "--source-branch", mr.branch, "--target-branch", mr.base, "--title", mr.title, "--description-file", "-", "--yes"],
        mr.body,
        env,
      );
      const url =
        printed
          .split("\n")
          .find((l) => /\/merge_requests\/\d+/.test(l))
          ?.trim() ?? printed;
      return { number: iidOf(url), url: /(https?:\/\/\S+)/.exec(url)?.[1] ?? url };
    },
    async status(iid) {
      return readGitlabStatus(JSON.parse(await gh(bin, ["mr", "view", String(iid), ...R, "--output", "json"], undefined, env)));
    },
    // GitLab merges by the project's own method; squash is the one choice a merge request can make.
    async merge(iid, headSha, method) {
      await gh(
        bin,
        ["mr", "merge", String(iid), ...R, "--sha", headSha, "--auto-merge=false", "--yes", ...(method === "squash" ? ["--squash"] : [])],
        undefined,
        env,
      );
    },
    async close(iid, comment) {
      await api(["--method", "POST", `${project}/merge_requests/${iid}/notes`], { body: marked(comment) });
      await gh(bin, ["mr", "close", String(iid), ...R], undefined, env);
    },
    async failedRuns(headSha) {
      const [pipeline] = JSON.parse(await api([`${project}/pipelines?sha=${headSha}&order_by=id&sort=desc&per_page=1`])) as { id: number }[];
      if (!pipeline) return [];
      const jobs = JSON.parse(await api([`${project}/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=100`])) as { id: number; name: string }[];
      return Promise.all(
        jobs.map(async (j) => ({
          id: j.id,
          name: j.name,
          log: readableTrace(await api([`${project}/jobs/${j.id}/trace`]).catch(() => ""))
            .split("\n")
            .slice(-LOG_LINES)
            .join("\n"),
        })),
      );
    },
    async rerunFailed(jobId) {
      await api(["--method", "POST", `${project}/jobs/${jobId}/retry`]);
    },
    async commitChecks(sha) {
      const [pipeline] = JSON.parse(await api([`${project}/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=1`])) as { status: string }[];
      if (!pipeline) return "none";
      if (["failed", "canceled"].includes(pipeline.status)) return "failure";
      return pipeline.status === "success" ? "success" : "pending";
    },
    async threads(iid) {
      return readGitlabThreads(await discussions(iid));
    },
    async replyKeys(iid) {
      return readReplyKeys(await discussions(iid));
    },
    async reply(iid, thread, body, key) {
      if (thread.kind === "review-thread")
        await api(["--method", "POST", `${project}/merge_requests/${iid}/discussions/${thread.id}/notes`], { body: keyed(body, key) });
      else await api(["--method", "POST", `${project}/merge_requests/${iid}/notes`], { body: keyed(body, key) });
    },
    async comment(iid, at, body, key, plain) {
      if (at)
        try {
          const refs = (JSON.parse(await api([`${project}/merge_requests/${iid}`])) as { diff_refs: { base_sha: string; start_sha: string; head_sha: string } })
            .diff_refs;
          const d = JSON.parse(
            await api(["--method", "POST", `${project}/merge_requests/${iid}/discussions`], {
              body: keyed(body, key),
              position: { position_type: "text", ...refs, new_path: at.path, old_path: at.path, new_line: at.line },
            }),
          ) as { id: string };
          return `d:${d.id}`;
        } catch {
          // GitLab refuses a position outside the diff; the finding still goes on the merge request.
        }
      await api(["--method", "POST", `${project}/merge_requests/${iid}/notes`], { body: keyed(plain ?? body, key) });
      return null;
    },
    async replyTo(iid, ref, body, key) {
      await api(["--method", "POST", `${project}/merge_requests/${iid}/discussions/${ref.slice(2)}/notes`], { body: keyed(body, key) });
    },
    async issues(since) {
      const listed = JSON.parse(
        await api([`${project}/issues?state=opened&updated_after=${encodeURIComponent(since)}&per_page=100&order_by=created_at&sort=asc`]),
      ) as GlIssue[];
      return Promise.all(
        listed.map(async (i) => readGitlabIssue(i, JSON.parse(await api([`${project}/issues/${i.iid}/notes?per_page=100&sort=asc`])) as GlNote[])),
      );
    },
    async issueReplyKeys(iid) {
      return readReplyKeys(JSON.parse(await api([`${project}/issues/${iid}/notes?per_page=100`])));
    },
    async commentOnIssue(iid, body, key) {
      await api(["--method", "POST", `${project}/issues/${iid}/notes`], { body: keyed(body, key) });
    },
  };
}

// git@host:group/sub/name.git, https://host/group/sub/name(.git), ssh://git@host/group/name
export function gitlabRepoOf(url: string): string | null {
  const m = /^(?:git@([^:]+):|(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/)(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1] ?? m[2]}/${m[3]}` : null;
}

export function forgeFor(db: Db, repo: Repo): ForgeAdapter | null {
  const at = { repoId: repo.id };
  if (repo.forge === "none") return null;
  if (repo.forge === "glab") {
    const name = resolveSetting(db, "forge.repo", at).value ?? gitlabRepoOf(repo.url);
    if (!name || name.split("/").length < 3)
      throw new ForgeError(`cannot tell which GitLab project ${repo.url} is; set forge.repo for repo ${repo.id} to host/group/name`);
    return gitlabForge(resolveSetting(db, "forge.glab_bin").value, name);
  }
  const name = resolveSetting(db, "forge.repo", at).value ?? forgeRepoOf(repo.url);
  if (!name) throw new ForgeError(`cannot tell which GitHub repo ${repo.url} is; set forge.repo for repo ${repo.id}`);
  return githubForge(resolveSetting(db, "forge.gh_bin").value, name);
}

export interface MergeRequest {
  unitId: UnitId;
  forge: string;
  forgeRepo: string;
  number: number;
  url: string;
  branch: string;
  headSha: Sha;
  baseSha: Sha;
  state: "open" | "merged" | "closed";
  status: PrStatus | null;
  checkedAt: IsoTime | null;
}

type Row = Record<string, unknown>;
const toMr = (r: Row): MergeRequest => ({
  unitId: r.unit_id as UnitId,
  forge: r.forge as string,
  forgeRepo: r.forge_repo as string,
  number: r.number as number,
  url: r.url as string,
  branch: r.branch as string,
  headSha: r.head_sha as Sha,
  baseSha: r.base_sha as Sha,
  state: r.state as MergeRequest["state"],
  status: r.status_json ? (JSON.parse(r.status_json as string) as PrStatus) : null,
  checkedAt: (r.checked_at as IsoTime | null) ?? null,
});

export function getMergeRequest(db: Db, unitId: UnitId): MergeRequest | null {
  const r = db.prepare("SELECT * FROM merge_requests WHERE unit_id = ?").get(unitId) as Row | undefined;
  return r ? toMr(r) : null;
}

export function openMergeRequests(db: Db): MergeRequest[] {
  return (db.prepare("SELECT * FROM merge_requests WHERE state = 'open' ORDER BY unit_id").all() as Row[]).map(toMr);
}

export function saveMergeRequest(db: Db, mr: Omit<MergeRequest, "state" | "status" | "checkedAt">): void {
  db.prepare(
    `INSERT INTO merge_requests (unit_id, forge, forge_repo, number, url, branch, head_sha, base_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (unit_id) DO UPDATE SET number = excluded.number, url = excluded.url, head_sha = excluded.head_sha, base_sha = excluded.base_sha, state = 'open'`,
  ).run(mr.unitId, mr.forge, mr.forgeRepo, mr.number, mr.url, mr.branch, mr.headSha, mr.baseSha, now());
}

export function recordMergeStatus(db: Db, unitId: UnitId, status: PrStatus): void {
  db.prepare("UPDATE merge_requests SET status_json = ?, checked_at = ? WHERE unit_id = ?").run(JSON.stringify(status), now(), unitId);
}

export function setMergeState(db: Db, unitId: UnitId, state: "merged" | "closed", projectId: string, data: Record<string, unknown>): void {
  db.prepare("UPDATE merge_requests SET state = ? WHERE unit_id = ?").run(state, unitId);
  recordEvent(db, `pr.${state}`, { projectId: projectId as never, unitId }, data);
}

export function markMergeChecked(db: Db, unitId: UnitId): void {
  db.prepare("UPDATE merge_requests SET checked_at = ? WHERE unit_id = ?").run(now(), unitId);
}
