#!/usr/bin/env node
// A stand-in for the gh CLI over a local bare repo (FAKE_GH_ORIGIN), with pull requests kept in FAKE_GH_STATE.
// Tests steer it by editing the state file: checks, a forced mergeStateStatus, or a closed state.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_GH_STATE;
const origin = process.env.FAKE_GH_ORIGIN;
// Calls run in parallel like a real forge's API, so each one holds the state file's lock from its read to its last write.
const lock = `${statePath}.lock`;
for (let i = 0; ; i++) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    if (i > 2000) throw new Error(`fake forge state ${lock} stayed locked`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
process.on("exit", () => rmSync(lock, { recursive: true, force: true }));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(1));
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { prs: [], calls: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const git = (...args) => execFileSync("git", ["--git-dir", origin, ...args], { encoding: "utf8" }).trim();
const [, , group, verb, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  // FAKE_GH_HANG: a call the forge never answers, as when a connection drops while the machine sleeps.
  if (process.env.FAKE_GH_HANG) {
    rmSync(lock, { recursive: true, force: true });
    return void setInterval(() => {}, 60_000);
  }
  state.calls.push([group, verb, ...rest.filter((a) => !a.includes("\n"))].join(" "));
  const pr = () => state.prs.find((p) => p.number === Number(rest[0]));
  if (group === "api" && verb === "graphql") {
    const fields = Object.fromEntries(
      rest.flatMap((a, i) => (rest[i - 1] === "-F" || rest[i - 1] === "-f" ? [[a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]] : [])),
    );
    if (fields.query.includes("addPullRequestReviewThreadReply")) {
      if (process.env.FAKE_GH_REPLY_FAIL === "before") fail("gh: HTTP 502");
      const thread = state.prs.flatMap((p) => p.threads ?? []).find((t) => t.id === fields.thread);
      if (!thread) fail(`no thread ${fields.thread}`);
      thread.comments.push({ author: { login: "ultish" }, body: fields.body === "@-" ? stdin : fields.body });
      // GitHub sometimes posts the reply and still answers 502.
      if (process.env.FAKE_GH_REPLY_FAIL === "after") fail("gh: HTTP 502");
      return out({ data: { addPullRequestReviewThreadReply: { comment: { id: "c" } } } });
    }
    const p = state.prs.find((x) => x.number === Number(fields.number));
    if (!p) fail(`no pull request ${fields.number}`);
    return out({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: (p.threads ?? []).map((t) => ({ ...t, comments: { nodes: t.comments } })) },
            comments: { nodes: p.comments ?? [] },
            reviews: { nodes: p.reviews ?? [] },
          },
        },
      },
    });
  }
  if (group === "run") {
    const runs = state.runs ?? [];
    if (verb === "list")
      return out(
        runs
          .filter((r) => r.head === flag("--commit"))
          .map(({ databaseId, name, conclusion, status }) => ({ databaseId, name, conclusion, status: status ?? "completed" })),
      );
    const r = runs.find((x) => x.databaseId === Number(rest[0]));
    if (!r) fail(`no run ${rest[0]}`);
    if (verb === "view") return console.log(r.log ?? "");
    if (verb === "rerun") {
      r.reruns = (r.reruns ?? 0) + 1;
      return save();
    }
  }
  // Issues in state.issues: { number, title, author: { login }, body, url, createdAt, updatedAt, comments: [{ id, author, body, createdAt }] }.
  // A comment yagura posts gets the next id and moves updatedAt, as GitHub does.
  if (group === "issue") {
    const issues = state.issues ?? [];
    if (verb === "list") return out(issues.filter((i) => (i.state ?? "OPEN") === "OPEN").map(({ comments, state: _, ...i }) => i));
    const i = issues.find((x) => x.number === Number(rest[0]));
    if (!i) fail(`no issue ${rest[0]}`);
    if (verb === "view") return out({ comments: i.comments ?? [] });
    if (verb === "comment") {
      const at = new Date().toISOString();
      i.comments = [...(i.comments ?? []), { id: `IC_y${(i.comments ?? []).length + 1}`, author: { login: "ultish" }, body: stdin, createdAt: at }];
      i.updatedAt = at;
      return save();
    }
  }
  if (group !== "pr") fail(`unknown command ${group}`);
  if (verb === "list") return out(state.prs.filter((p) => p.head === flag("--head") && p.state === "OPEN").map(({ number, url }) => ({ number, url })));
  if (verb === "create") {
    const number = state.prs.length + 1;
    const url = `https://github.com/${flag("--repo")}/pull/${number}`;
    state.prs.push({
      number,
      url,
      head: flag("--head"),
      base: flag("--base"),
      title: flag("--title"),
      body: stdin,
      state: "OPEN",
      isDraft: rest.includes("--draft"),
      checks: [],
    });
    save();
    return console.log(url);
  }
  const p = pr();
  if (!p) fail(`no pull request ${rest[0]}`);
  if (verb === "view") {
    const head = p.state === "OPEN" ? git("rev-parse", `refs/heads/${p.head}`) : p.headRefOid;
    let merge = p.mergeStateStatus;
    if (!merge) {
      try {
        git("merge-base", "--is-ancestor", `refs/heads/${p.base}`, head);
        merge = "CLEAN";
      } catch {
        merge = "BEHIND";
      }
    }
    return out({
      state: p.state,
      isDraft: p.isDraft ?? false,
      mergeable: merge === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
      mergeStateStatus: merge,
      statusCheckRollup: p.checks,
      headRefOid: head,
      mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
    });
  }
  if (verb === "edit") {
    p.body = stdin;
    return save();
  }
  if (verb === "ready") {
    p.isDraft = false;
    return save();
  }
  if (verb === "merge") {
    if (!rest.includes("--merge")) fail("yagura merges only with a merge commit");
    if (p.isDraft) fail("Pull request is still a draft");
    const head = git("rev-parse", `refs/heads/${p.head}`);
    if (flag("--match-head-commit") !== head) fail("head commit does not match");
    const tree = execFileSync("git", ["--git-dir", origin, "merge-tree", "--write-tree", `refs/heads/${p.base}`, head], { encoding: "utf8" }).split("\n")[0];
    const env = { ...process.env, GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com", GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" };
    const message = `${flag("--subject")}\n\n${stdin}`;
    const merged = execFileSync("git", ["--git-dir", origin, "commit-tree", tree, "-p", `refs/heads/${p.base}`, "-p", head, "-m", message], {
      encoding: "utf8",
      env,
    }).trim();
    git("update-ref", `refs/heads/${p.base}`, merged);
    Object.assign(p, { state: "MERGED", mergeCommit: merged, headRefOid: head });
    save();
    return;
  }
  if (verb === "comment") {
    p.comments = [...(p.comments ?? []), { id: `IC_${(p.comments ?? []).length + 1}`, author: { login: "ultish" }, body: stdin }];
    return save();
  }
  if (verb === "close") {
    Object.assign(p, { state: "CLOSED", comment: flag("--comment"), headRefOid: git("rev-parse", `refs/heads/${p.head}`) });
    save();
    return;
  }
  fail(`unknown verb ${verb}`);
});

function out(v) {
  save();
  console.log(JSON.stringify(v));
}

function fail(message) {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
