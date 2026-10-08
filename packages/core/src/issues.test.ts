import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import { setSetting, type Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { githubForge, readGitlabIssue } from "./forge.js";
import { answerIssue, approvalOf, listIssues, pollIssues } from "./issues.js";
import { layout } from "./paths.js";
import { addProject, addRepo, getRepo, listUnits, openStore, setProjectState, setRepoForge, type Db } from "./store.js";
import { addDecision, getThread, listMessages, listProposals } from "./threads.js";
import { runWatchmanTurn } from "./watchman.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;
const fake: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs"), ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
  parse: parseClaudeLine,
};

type Comment = { id: string; author: { login: string }; body: string; createdAt: string };
type Issue = { number: number; title: string; author: { login: string }; body: string; url: string; createdAt: string; updatedAt: string; comments: Comment[] };

describe("forge issues (§30, fake gh)", () => {
  let db: Db;
  let ctx: RunContext;
  let statePath: string;
  const project = "p" as ProjectId;
  const repo = () => getRepo(db, "testbed" as RepoId);
  const state = () => JSON.parse(readFileSync(statePath, "utf8")) as { issues: Issue[]; calls: string[] };
  const issue = (n: number) => state().issues.find((i) => i.number === n)!;
  const setIssues = (f: (issues: Issue[]) => void) => {
    const s = state();
    f(s.issues);
    writeFileSync(statePath, JSON.stringify(s));
  };
  const open = (number: number, author: string, body: string, createdAt = new Date().toISOString()) =>
    setIssues((all) =>
      all.push({
        number,
        title: `issue ${number}`,
        author: { login: author },
        body,
        url: `https://github.com/ultish/sandbox/issues/${number}`,
        createdAt,
        updatedAt: createdAt,
        comments: [],
      }),
    );
  const comment = (number: number, author: string, body: string) =>
    setIssues((all) => {
      const i = all.find((x) => x.number === number)!;
      const at = new Date().toISOString();
      i.comments.push({ id: `IC_${author}_${i.comments.length + 1}`, author: { login: author }, body, createdAt: at });
      i.updatedAt = at;
    });
  const cycle = async () => {
    await pollIssues(ctx, repo());
    for (const i of listIssues(db, "testbed" as RepoId)) await answerIssue(ctx, repo(), i.number);
  };
  const posted = (n: number) => issue(n).comments.filter((c) => c.body.includes("<!-- yagura -->"));

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "yagura-issues-"));
    const boot: Bootstrap = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
    db = openStore(layout(boot).db);
    ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
    statePath = join(root, "gh.json");
    writeFileSync(statePath, JSON.stringify({ prs: [], issues: [], calls: [] }));
    const bin = fixtures("fake-gh.mjs");
    chmodSync(bin, 0o755);
    process.env.FAKE_GH_STATE = statePath;
    process.env.FAKE_ISSUE_PROJECT = project;
    addRepo(db, { id: "testbed", url: join(root, "origin"), defaultBranch: "main" });
    setRepoForge(db, "testbed" as RepoId, "gh");
    setSetting(db, "repo", "testbed", "forge.repo", "ultish/sandbox");
    setSetting(db, "global", "", "forge.gh_bin", bin);
    setSetting(db, "repo", "testbed", "forge.watch_issues", true);
    setSetting(db, "global", "", "forge.trusted_authors", ["ultish"]);
    addProject(db, { id: project, name: "p", goal: "g", predicate: "p", repos: ["testbed" as RepoId] });
    setProjectState(db, project, "active");
  });

  it("answers a stranger's issue on the issue, and starts the work only when a trusted login says yes", async () => {
    open(1, "stranger", "please build a thing", "2020-01-01T00:00:00Z");
    await cycle();
    open(2, "stranger", "please build a thing");
    await cycle();

    expect(listIssues(db, "testbed" as RepoId).map((i) => i.number)).toEqual([2]);
    const [row] = listIssues(db, "testbed" as RepoId);
    expect(getThread(db, row!.threadId)).toMatchObject({ title: "#2 issue 2", autonomy: "propose", projects: [project] });
    expect(listMessages(db, row!.threadId)[0]!.body).toBe("@stranger opened on issue #2:\n\n> **issue 2**\n> \n> please build a thing");
    expect(posted(2)).toHaveLength(1);
    expect(posted(2)[0]!.body).toMatch(
      /^⚙️ \*\*yagura\*\*\n\nI can build that: one unit writing issue-2\.txt\.\n\n---\n\*\*Proposed:\*\* build what issue #2 asks\n\nA trusted user can reply \*\*yes\*\* to go ahead, or \*\*no\*\* to decline\./,
    );
    expect(listUnits(db, project)).toEqual([]);

    comment(2, "stranger", "yes");
    await cycle();
    expect(listProposals(db, row!.threadId, "pending")).toHaveLength(1);
    expect(listUnits(db, project)).toEqual([]);
    expect(posted(2).at(-1)!.body).toContain("Which file should change?");

    comment(2, "ultish", "Yes, go ahead");
    await cycle();
    expect(listUnits(db, project).map((u) => ({ goal: u.goal, refs: u.refs }))).toEqual([{ goal: "write issue-2.txt", refs: ["testbed#2"] }]);
    expect(posted(2).at(-1)!.body).toBe(
      "⚙️ **yagura**\n\nApproved by @ultish. Started U1 on project **p**; the change closes this issue when it merges.\n\n<!-- yagura -->\n<!-- yagura-reply:issue-testbed-2-p1 -->",
    );

    // A restart that lost what was posted (or a post the forge reported as failed) never posts the same reply twice.
    const before = issue(2).comments.length;
    db.prepare("UPDATE forge_issues SET posted_through = 0").run();
    db.prepare("UPDATE issue_watches SET polled_at = ?").run("2020-01-01T00:00:00Z");
    await cycle();
    expect(issue(2).comments.length).toBe(before);
    expect(listUnits(db, project)).toHaveLength(1);
  }, 60_000);

  it("starts what a trusted author's issue asks for at once, and asks again once a stranger joins in", async () => {
    await cycle();
    open(3, "ultish", "build it please");
    await cycle();
    expect(listUnits(db, project).map((u) => u.goal)).toEqual(["write issue-3.txt"]);
    expect(posted(3).map((c) => c.body.split("\n\n")[1])).toEqual([
      "I can build that: one unit writing issue-3.txt.",
      "Started U1 on project **p**; the change closes this issue when it merges.",
    ]);

    comment(3, "stranger", "also build a second one");
    await cycle();
    expect(listUnits(db, project)).toHaveLength(1);
    expect(posted(3).at(-1)!.body).toContain("A trusted user can reply **yes** to go ahead");

    comment(3, "ultish", "no");
    await cycle();
    expect(listUnits(db, project)).toHaveLength(1);
    expect(posted(3).at(-1)!.body.split("\n\n")[1]).toBe("Declined by @ultish: nothing will be built for this.");
  }, 60_000);

  it("keeps the developer's dashboard conversation off the issue, and posts again once the issue speaks", async () => {
    await cycle();
    open(5, "stranger", "what does it do?");
    await cycle();
    expect(posted(5)).toHaveLength(1);
    const [row] = listIssues(db, "testbed" as RepoId);
    await runWatchmanTurn(ctx, row!.threadId, "private note: never mind them");
    await cycle();
    const replies = listMessages(db, row!.threadId).filter((m) => m.role === "watchman");
    expect(replies).toHaveLength(2);
    // The private reply stays in yagura; the decision that turn recorded is still news for the issue.
    expect(posted(5).map((c) => c.body.split("\n\n")[1])).toEqual(["Which file should change?", "Decided: Timestamps are ignored"]);
    comment(5, "stranger", "hello?");
    await cycle();
    expect(posted(5)).toHaveLength(3);
    expect(
      posted(5)
        .map((c) => c.body)
        .join("\n"),
    ).not.toContain(replies[1]!.body.split("\n")[0]);
  }, 60_000);

  it("tells the issue each decision and how its work moves, once, without being asked", async () => {
    await cycle();
    open(6, "ultish", "build it please");
    await cycle();
    const [row] = listIssues(db, "testbed" as RepoId);
    const [unit] = listUnits(db, project);
    addDecision(db, { threadId: row!.threadId, text: "The greeting names the developer", sourceMessageId: null });
    db.prepare(
      "INSERT INTO merge_requests (unit_id, forge, forge_repo, number, url, branch, head_sha, base_sha, created_at) VALUES (?, 'gh', 'ultish/sandbox', 9, 'https://github.com/ultish/sandbox/pull/9', 'b', 'h', 'b', 't')",
    ).run(unit!.id);
    await cycle();
    await cycle();
    expect(
      posted(6)
        .slice(2)
        .map((c) => c.body.split("\n\n")[1]),
    ).toEqual(["Decided: The greeting names the developer", "U1 is up for review: https://github.com/ultish/sandbox/pull/9"]);

    // An issue yagura was answering before these updates existed starts from what had happened, and tells only what comes after.
    db.prepare("UPDATE forge_issues SET announced_json = NULL").run();
    addDecision(db, { threadId: row!.threadId, text: "Already decided before", sourceMessageId: null });
    await cycle();
    addDecision(db, { threadId: row!.threadId, text: "Decided after", sourceMessageId: null });
    await cycle();
    expect(
      posted(6)
        .slice(4)
        .map((c) => c.body.split("\n\n")[1]),
    ).toEqual(["Decided: Decided after"]);
  }, 60_000);

  it("stops answering an issue for the day once it reaches its cap, keeping the comments for later", async () => {
    setSetting(db, "repo", "testbed", "issues.max_turns_per_day", 1);
    await cycle();
    open(4, "stranger", "what does it do?");
    await cycle();
    comment(4, "stranger", "hello?");
    await cycle();
    expect(posted(4)).toHaveLength(1);
    const [row] = listIssues(db, "testbed" as RepoId);
    expect(listMessages(db, row!.threadId).at(-1)!.body).toBe("@stranger commented on issue #4:\n\n> hello?");
  }, 60_000);
});

describe("approvalOf", () => {
  it("reads only a plain yes or no in the first word", () => {
    expect(["yes", "Yes, go ahead", "LGTM!", "go", "👍"].map(approvalOf)).toEqual(["yes", "yes", "yes", "yes", "yes"]);
    expect(["no", "No.", "decline this"].map(approvalOf)).toEqual(["no", "no", "no"]);
    expect(["yesterday it broke", "I think yes", ""].map(approvalOf)).toEqual([null, null, null]);
  });
});

describe("readGitlabIssue", () => {
  it("keeps people's notes oldest first and drops GitLab's own system notes", () => {
    const issue = {
      iid: 5,
      title: "t",
      author: { username: "ultish" },
      description: null,
      web_url: "https://gl/x/-/issues/5",
      created_at: "2026-10-07T00:00:00Z",
    };
    const notes = [
      { id: 12, body: "second", system: false, author: { username: "b" }, created_at: "2026-10-07T02:00:00Z" },
      { id: 11, body: "changed the description", system: true, author: { username: "ultish" }, created_at: "2026-10-07T01:30:00Z" },
      { id: 10, body: "first", system: false, author: { username: "a" }, created_at: "2026-10-07T01:00:00Z" },
    ];
    expect(readGitlabIssue(issue, notes)).toEqual({
      number: 5,
      title: "t",
      author: "ultish",
      body: "",
      url: "https://gl/x/-/issues/5",
      createdAt: "2026-10-07T00:00:00Z",
      comments: [
        { id: "10", author: "a", body: "first", createdAt: "2026-10-07T01:00:00Z" },
        { id: "12", author: "b", body: "second", createdAt: "2026-10-07T02:00:00Z" },
      ],
    });
  });
});

describe("a forge call that never answers", () => {
  it("fails after the timeout instead of holding its watcher", async () => {
    process.env.FAKE_GH_HANG = "1";
    try {
      const started = Date.now();
      await expect(githubForge(fixtures("fake-gh.mjs"), "ultish/sandbox", 500).issues("2026-01-01T00:00:00Z")).rejects.toThrow(
        / issue list gave no answer in 0\.5 s$/,
      );
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      delete process.env.FAKE_GH_HANG;
    }
  });
});
