#!/usr/bin/env node
// A stand-in for the glab CLI over a local bare repo (FAKE_GLAB_ORIGIN), with merge requests and pipelines kept in
// FAKE_GLAB_STATE. It answers in GitLab's own shapes: `mr` commands print merge request JSON, and `glab api` serves
// the REST v4 paths yagura uses. Tests steer it by editing the state file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_GLAB_STATE;
const origin = process.env.FAKE_GLAB_ORIGIN;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { mrs: [], pipelines: [], calls: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const git = (...args) => execFileSync("git", ["--git-dir", origin, ...args], { encoding: "utf8" }).trim();
const [, , group, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  state.calls.push([group, ...rest.filter((a) => !a.includes("\n"))].join(" "));
  if (!process.env.GITLAB_HOST) fail("GITLAB_HOST is not set");
  if (group === "api") return api();
  if (group !== "mr") fail(`unknown command ${group}`);
  const [verb, ...args] = rest;
  if (verb === "list")
    return out(state.mrs.filter((m) => m.source_branch === flag("--source-branch") && m.state === "opened").map(({ iid, web_url }) => ({ iid, web_url })));
  if (verb === "create") {
    // Like the real glab: it reads the working directory's remotes despite --repo, and fails when none is the project's host.
    let remotes = "";
    try {
      remotes = execFileSync("git", ["remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {}
    if (remotes && !remotes.includes(process.env.GITLAB_HOST)) fail("Failed to create merge request.");
    const iid = state.mrs.length + 1;
    const web_url = `https://${process.env.GITLAB_HOST}/${flag("--repo")}/-/merge_requests/${iid}`;
    state.mrs.push({
      iid,
      web_url,
      source_branch: flag("--source-branch"),
      target_branch: flag("--target-branch"),
      title: flag("--title"),
      description: stdin,
      draft: rest.includes("--draft"),
      state: "opened",
      discussions: [],
    });
    save();
    return console.log(
      `\nCreating merge request for ${flag("--source-branch")} into ${flag("--target-branch")} in ${flag("--repo")}\n\n!${iid} ${flag("--title")}\n ${web_url}\n`,
    );
  }
  const m = state.mrs.find((x) => x.iid === Number(args[0]));
  if (!m) fail(`no merge request ${args[0]}`);
  const head = () => git("rev-parse", `refs/heads/${m.source_branch}`);
  if (verb === "view") {
    const sha = m.state === "opened" ? head() : m.sha;
    let status = m.detailed_merge_status;
    if (!status) {
      try {
        git("merge-base", "--is-ancestor", `refs/heads/${m.target_branch}`, sha);
        status = "mergeable";
      } catch {
        status = "need_rebase";
      }
    }
    const pipeline = [...state.pipelines].reverse().find((p) => p.sha === sha);
    return out({
      iid: m.iid,
      state: m.state,
      draft: m.draft ?? false,
      detailed_merge_status: status,
      has_conflicts: status === "conflict",
      sha,
      merge_commit_sha: m.merge_commit_sha ?? null,
      squash_commit_sha: null,
      head_pipeline: pipeline ? { id: pipeline.id, status: pipeline.status } : null,
      web_url: m.web_url,
    });
  }
  if (verb === "update") {
    if (rest.includes("--ready")) m.draft = false;
    if (rest.includes("--description-file")) m.description = stdin;
    return save();
  }
  if (verb === "merge") {
    if (!rest.includes("--auto-merge=false")) fail("yagura must not leave GitLab to merge on its own");
    if (m.draft) fail("Merge request is still a draft");
    const sha = head();
    if (flag("--sha") !== sha) fail("SHA does not match HEAD of source branch");
    // A merge commit whose first parent is the target, as a GitLab project with the default merge method makes.
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "GitLab",
      GIT_AUTHOR_EMAIL: "gitlab@example.com",
      GIT_COMMITTER_NAME: "GitLab",
      GIT_COMMITTER_EMAIL: "gitlab@example.com",
    };
    const merged = execFileSync(
      "git",
      [
        "--git-dir",
        origin,
        "commit-tree",
        execFileSync("git", ["--git-dir", origin, "merge-tree", "--write-tree", `refs/heads/${m.target_branch}`, sha], { encoding: "utf8" }).split("\n")[0],
        "-p",
        `refs/heads/${m.target_branch}`,
        "-p",
        sha,
        "-m",
        flag("--message") ?? `Merge branch '${m.source_branch}' into '${m.target_branch}'`,
      ],
      { encoding: "utf8", env },
    ).trim();
    git("update-ref", `refs/heads/${m.target_branch}`, merged);
    Object.assign(m, { state: "merged", merge_commit_sha: merged, sha });
    return save();
  }
  if (verb === "close") {
    Object.assign(m, { state: "closed", sha: head() });
    return save();
  }
  fail(`unknown verb ${verb}`);
});

function api() {
  const method = (flag("--method") ?? "GET").toUpperCase();
  if (flag("--hostname")) fail("Error parsing --hostname: invalid hostname.");
  if (!process.env.GITLAB_HOST) fail("GITLAB_HOST is not set");
  const skip = new Set(["--hostname", "--method", "--input", "--header"]);
  const path = rest.find((a, i) => !a.startsWith("--") && !skip.has(rest[i - 1]));
  const body = rest.includes("--input") ? JSON.parse(stdin) : null;
  const [route, query = ""] = path.split("?");
  const parts = route.split("/").map(decodeURIComponent);
  // projects/<path>/...
  const mrAt = parts.indexOf("merge_requests");
  if (mrAt > 0) {
    const m = state.mrs.find((x) => x.iid === Number(parts[mrAt + 1]));
    if (!m) fail(`404 merge request ${parts[mrAt + 1]}`);
    const tail = parts.slice(mrAt + 2);
    if (tail[0] === "discussions" && tail.length === 1 && method === "GET") return out(m.discussions);
    if (tail[0] === "notes" && method === "POST") {
      const note = { id: Date.now(), body: body.body, system: false, author: { username: "yagura-bot" } };
      m.discussions.push({ id: `d${m.discussions.length + 1}`, individual_note: true, notes: [note] });
      return out(note);
    }
    if (tail[0] === "discussions" && tail[2] === "notes" && method === "POST") {
      const d = m.discussions.find((x) => x.id === tail[1]);
      if (!d) fail(`404 discussion ${tail[1]}`);
      if (process.env.FAKE_GLAB_REPLY_FAIL === "before") fail("glab: 502 Bad Gateway");
      const note = { id: Date.now(), body: body.body, system: false, author: { username: "yagura-bot" }, resolvable: true, resolved: false };
      d.notes.push(note);
      if (process.env.FAKE_GLAB_REPLY_FAIL === "after") fail("glab: 502 Bad Gateway");
      return out(note);
    }
  }
  const at = (name) => parts.indexOf(name);
  if (at("pipelines") > 0 && parts.length === at("pipelines") + 1) {
    const sha = new URLSearchParams(query).get("sha");
    return out(
      state.pipelines
        .filter((p) => p.sha === sha)
        .sort((a, b) => b.id - a.id)
        .map(({ id, sha: s, status }) => ({ id, sha: s, status })),
    );
  }
  if (at("pipelines") > 0 && parts[at("pipelines") + 2] === "jobs") {
    const p = state.pipelines.find((x) => x.id === Number(parts[at("pipelines") + 1]));
    if (!p) fail("404 pipeline");
    return out(p.jobs.filter((j) => j.status === "failed").map(({ id, name, status }) => ({ id, name, status })));
  }
  if (at("jobs") > 0) {
    const job = state.pipelines.flatMap((p) => p.jobs).find((j) => j.id === Number(parts[at("jobs") + 1]));
    if (!job) fail("404 job");
    if (parts[at("jobs") + 2] === "trace") return console.log(job.trace ?? "");
    if (parts[at("jobs") + 2] === "retry" && method === "POST") {
      job.retries = (job.retries ?? 0) + 1;
      return out({ id: job.id + 1000, name: job.name, status: "pending" });
    }
  }
  fail(`404 ${method} ${path}`);
}

function out(v) {
  save();
  console.log(JSON.stringify(v));
}

function fail(message) {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
