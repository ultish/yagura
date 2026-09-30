import { execFile } from "node:child_process";
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
  kind: "github";
  repo: string;
  find(branch: string): Promise<{ number: number; url: string } | null>;
  open(pr: { branch: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  status(number: number): Promise<PrStatus>;
  merge(number: number, headSha: Sha, method: "rebase" | "squash" | "merge"): Promise<void>;
  close(number: number, comment: string): Promise<void>;
  failedRuns(headSha: Sha): Promise<{ id: number; name: string; log: string }[]>;
  rerunFailed(runId: number): Promise<void>;
  threads(number: number): Promise<PrThread[]>;
  replyKeys(number: number): Promise<Set<string>>;
  reply(number: number, thread: Pick<PrThread, "id" | "kind">, body: string, key: string): Promise<void>;
}

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
export const marked = (body: string) => `${body}\n\n${YAGURA_MARK}`;
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

// Titles, bodies, and comments go to gh as arguments or stdin, never through a shell.
function gh(bin: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, maxBuffer: 16 * 1024 * 1024 },
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
  };
}

export function forgeFor(db: Db, repo: Repo): ForgeAdapter | null {
  const at = { repoId: repo.id };
  if (repo.forge === "none") return null;
  if (repo.forge === "glab") throw new ForgeError(`repo ${repo.id} is on GitLab, which yagura cannot land through yet`);
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
