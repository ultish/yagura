import { getSpec } from "./spec.js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { resolveSetting } from "./config.js";
import { listValues } from "./envvalues.js";
import { saveTemplate } from "./templates.js";
import { Engine } from "./engine.js";
import { write } from "./agent.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter, HarnessRun } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import { applyProposal, proposalRoutes } from "./proposal.js";
import { editSpec, parseSpec, relevantSections, renderSpec } from "./spec.js";
import { addProject, addRepo, getEnvironment, getProject, getRepo, listGates, listUnits, openStore, type Db } from "./store.js";
import { createThread, getProposal, getThread, linkThreadProject, listDecisions, listMessages, listProposals, listQuestions } from "./threads.js";
import { assembleContext, clearWatchmanSession, parseReply, runWatchmanTurn, storeTurn, TurnRecords, type ContextParts } from "./watchman.js";
import { listTurns, runningTurn, stopTurn, TurnBusy } from "./turns.js";

const fixtures = (f: string) => fileURLToPath(new URL(`./harness/fixtures/${f}`, import.meta.url));
const fake: HarnessAdapter = {
  id: "claude",
  canResume: true,
  command: (run) => ({ argv: [process.execPath, fixtures("fake-agent.mjs"), ...(run.resume ? ["--resume", run.resume] : [])], stdin: run.prompt }),
  parse: parseClaudeLine,
};
const tsx = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs")).href;

describe("assembleContext", () => {
  const msg = (id: number, chars: number) => ({ id, role: "human", body: "x".repeat(chars) });
  const parts = (over: Partial<ContextParts>): ContextParts => ({ fixed: ["f".repeat(4000)], statuses: [], spec: [], history: [], ...over });

  it("keeps the newest messages and drops the oldest when the budget runs out", () => {
    const history = [1, 2, 3, 4, 5].map((i) => msg(i, 2000));
    const ctx = assembleContext(parts({ history }), 1000 + 1600);
    expect(ctx.dropped.messages).toBe(2);
    expect(ctx.sections.history).not.toContain("#2]");
    expect(ctx.sections.history.indexOf("#3]")).toBeLessThan(ctx.sections.history.indexOf("#5]"));
  });

  it("always keeps the newest message even when it alone exceeds the budget", () => {
    const ctx = assembleContext(parts({ history: [msg(1, 100), msg(2, 40_000)] }), 2000);
    expect(ctx.sections.history).toContain("#2]");
    expect(ctx.dropped.messages).toBe(1);
  });

  it("truncates an oversized project status with a pointer to the rest", () => {
    const ctx = assembleContext(parts({ statuses: [{ projectId: "big", text: "s".repeat(40_000) }] }), 5000);
    expect(ctx.dropped.statusTruncated).toEqual(["big"]);
    expect(ctx.sections.status).toMatch(/yagura show big/);
    expect(ctx.sections.status.length).toBeLessThan(40_000);
  });

  it("includes a small spec whole, and only relevant sections of a large one", () => {
    const small = { projectId: "a", toc: ["Scope"], whole: "## Scope\nsmall", relevant: [] };
    const large = { projectId: "b", toc: ["Scope", "Timestamps"], whole: "y".repeat(60_000), relevant: [{ heading: "Timestamps", body: "ignore *_ts" }] };
    const ctx = assembleContext(parts({ spec: [small, large] }), 10_000);
    expect(ctx.sections.spec).toContain("spec of a (whole)");
    expect(ctx.sections.spec).toContain(`spec of b: sections "Scope", "Timestamps"`);
    expect(ctx.sections.spec).toContain("ignore *_ts");
    expect(ctx.sections.spec).not.toContain("yyyy");
  });
});

describe("spec sections", () => {
  it("edits, appends, and deletes sections by heading, case-insensitively", () => {
    let spec = parseSpec("# kafka-diff\n\n## Scope\nold scope\n\n## Open\n- what cluster\n");
    spec = editSpec(spec, "scope", "new scope");
    spec = editSpec(spec, "Ignored fields", "- *_ts");
    spec = editSpec(spec, "Open", null);
    expect(renderSpec(spec)).toBe("# kafka-diff\n\n## Scope\n\nnew scope\n\n## Ignored fields\n\n- *_ts\n");
    expect(relevantSections(spec, "also ignore the fields called seq").map((s) => s.heading)).toEqual(["Ignored fields"]);
  });
});

describe("parseReply", () => {
  it("treats a reply without a yagura block as conversation with no records", () => {
    expect(parseReply("Which topic?")).toEqual({ body: "Which topic?", records: TurnRecords.parse({}), error: null });
  });

  it("splits the prose from the last yagura block", () => {
    const r = parseReply('Noted.\n\n```yagura\n{"decisions":[{"text":"ignore ts"}]}\n```\n');
    expect(r.body).toBe("Noted.");
    expect(r.records?.decisions).toEqual([{ text: "ignore ts" }]);
  });

  it("rejects unknown fields and bad JSON with a reason", () => {
    expect(parseReply('ok\n```yagura\n{"decision":[]}\n```').error).toMatch(/Unrecognized key/);
    expect(parseReply("ok\n```yagura\n{nope}\n```").error).toMatch(/not valid JSON/);
  });
});

describe("watchman turns", () => {
  let db: Db;
  let ctx: RunContext;
  let boot: Bootstrap;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "yagura-watchman-"));
    boot = { home: join(root, "home"), packsDir: "", skillsDir: join(root, "skills"), bind: "", port: 0, tokenFile: "" };
    db = openStore(layout(boot).db);
    ctx = { db, boot, adapters: { claude: fake }, cli: [process.execPath, "--import", tsx, fixtures("evidence-shim.ts")] };
    process.env.FAKE_MODE = "engine";
  });

  it("runs the watchman read-only: dontAsk, the allow-list, writes denied, and only its linked projects' directories", async () => {
    const runs: HarnessRun[] = [];
    ctx.adapters = { claude: { ...fake, command: (run) => (runs.push(run), fake.command(run)) } };
    addRepo(db, { id: "proto" as RepoId, url: "/nowhere", defaultBranch: "main" });
    addProject(db, { id: "a" as ProjectId, name: "a", goal: "g", predicate: "p", minTier: "unit-verified", repos: ["proto" as RepoId] });
    addProject(db, { id: "b" as ProjectId, name: "b", goal: "g", predicate: "p", minTier: "unit-verified", repos: ["proto" as RepoId] });
    const t = createThread(db, { title: "t" });
    linkThreadProject(db, t.id, "a" as ProjectId);
    await runWatchmanTurn(ctx, t.id, "hello");

    expect(runs[0]).toMatchObject({
      permissionMode: "dontAsk",
      addDirs: [join(boot.home, "projects", "a")],
      disallowedTools: ["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
    });
    expect(runs[0]!.allowedTools).toContain("Bash(yagura git:*)");
    expect(runs[0]!.allowedTools!.filter((t) => !t.startsWith("Bash(yagura "))).toEqual(["Skill"]);
    expect(runs[0]!.prompt).toContain(`\`${join(boot.home, "projects")}/<project>/\` for each project in this thread`);
  });

  it("stores nothing when any record is invalid", () => {
    const t = createThread(db, { title: "t" });
    addRepo(db, { id: "r", url: "/nowhere", defaultBranch: "main" });
    addProject(db, { id: "linked", name: "l", goal: "g", predicate: "p", minTier: "unit-verified", repos: ["r" as RepoId] });
    linkThreadProject(db, t.id, "linked" as ProjectId);
    const attempt = (records: unknown) => () => storeTurn(ctx, t.id, { body: "b", records: TurnRecords.parse(records), turnLog: null });
    expect(attempt({ decisions: [{ text: "a" }], answered: [{ question: "Q9", answer: "x" }] })).toThrow(/Q9 does not exist/);
    expect(attempt({ spec: [{ project: "other", section: "S", body: "x" }] })).toThrow(/not a project of this thread/);
    expect(attempt({ proposal: { summary: "s", projects: [{ id: "linked", goal: "g", predicate: "p", repos: ["r"] }] } })).toThrow(/already exists/);
    expect(attempt({ proposal: { summary: "s", projects: [{ id: "newp", goal: "g", predicate: "p", repos: ["r"], after: ["ghost"] }] } })).toThrow(
      /after ghost/,
    );
    expect(listMessages(db, t.id)).toEqual([]);
    expect(listDecisions(db, t.id)).toEqual([]);

    const stored = storeTurn(ctx, t.id, {
      body: "b",
      records: TurnRecords.parse({ spec: [{ project: "linked", section: "Scope", body: "all of it" }] }),
      turnLog: null,
    });
    expect(stored.message.body).toBe("b");
    expect(getSpec(db, "linked")).toMatchObject({ text: "# linked\n\n## Scope\n\nall of it\n", updatedBy: "watchman" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'project.spec_changed'").get()).toEqual({ n: 1 });
  });

  it("checks a proposed project's landing route against its repo, and shows the route for the card", () => {
    const t = createThread(db, { title: "t" });
    addRepo(db, { id: "local", url: "/tmp/local.git", defaultBranch: "main", pushConfirmed: true });
    addRepo(db, { id: "hub", url: "https://github.com/o/hub.git", defaultBranch: "main", forge: "gh" });
    addRepo(db, { id: "loose", url: "https://git.example.com/o/loose.git", defaultBranch: "main" });
    const propose = (proposal: unknown) => () => storeTurn(ctx, t.id, { body: "b", records: TurnRecords.parse({ proposal }), turnLog: null });
    const project = (id: string, repos: string[], land?: string) => ({ id, goal: "g", predicate: "p", repos, ...(land ? { land } : {}) });
    expect(propose({ summary: "s", projects: [project("route-a", ["local"], "pr")] })).toThrow(
      /route-a: land "pr", but repo local lands by pushing to main \(it has no forge\)/,
    );
    expect(propose({ summary: "s", projects: [project("route-b", ["hub"], "push")] })).toThrow(
      /route-b: land "push", but repo hub lands through pull requests \(gh\)/,
    );
    expect(propose({ summary: "s", projects: [project("route-c", ["loose"])] })).toThrow(/route-c: repo loose has no confirmed landing route/);
    expect(propose({ summary: "s", repos: [{ id: "ext", existing: "git@git.example.com:o/ext.git" }], projects: [] })).toThrow(
      /repo ext: yagura cannot tell how git@git.example.com:o\/ext.git lands/,
    );
    const { proposal } = storeTurn(ctx, t.id, {
      body: "b",
      records: TurnRecords.parse({ proposal: { summary: "s", projects: [project("route-d", ["hub"], "pr"), project("route-e", ["local"])] } }),
      turnLog: null,
    });
    expect(proposalRoutes(db, proposal!.body)).toEqual({
      "route-d": { text: "lands through pull requests (gh)", ok: true },
      "route-e": { text: "lands by pushing to main", ok: true },
    });
  });

  it("retries once with the rejection reason, and stores only the corrected turn", async () => {
    const t = createThread(db, { title: "t" });
    const turn = await runWatchmanTurn(ctx, t.id, "typo once");
    expect(turn.problem).toBeNull();
    expect(listMessages(db, t.id).map((m) => [m.role, m.body])).toEqual([
      ["human", "typo once"],
      ["watchman", "Corrected."],
    ]);
    expect(listDecisions(db, t.id).map((d) => d.text)).toEqual(["fixed on retry"]);
    expect(readFileSync(turn.reply!.turnLog!, "utf8")).toContain("Corrected.");
    expect(listTurns(db).map((x) => x.costUsd)).toEqual([0.02]);
  });

  it("gives up after the retry and says why", async () => {
    const t = createThread(db, { title: "t" });
    const turn = await runWatchmanTurn(ctx, t.id, "typo twice");
    expect(turn.problem).toBe("Q99 does not exist");
    expect(listMessages(db, t.id).map((m) => m.role)).toEqual(["human", "watchman", "system"]);
    expect(listMessages(db, t.id)[2]!.body).toMatch(/rejected this turn's records twice.*Q99 does not exist/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'watchman.records_rejected'").get()).toEqual({ n: 1 });
  });

  it("keeps a proposal pending under autonomy propose until it is applied", async () => {
    const t = createThread(db, { title: "t" });
    const turn = await runWatchmanTurn(ctx, t.id, "prototype a chain");
    expect(turn.problem).toBeNull();
    expect(turn.reply?.body).toBe("Here is the plan.");
    expect(getThread(db, t.id).title).toBe("proto chain");
    expect(getProposal(db, turn.proposal!.id).state).toBe("pending");
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(existsSync(layout(boot).turnBrief(t.id, turn.human.id))).toBe(true);
    expect(readFileSync(layout(boot).turnBrief(t.id, turn.human.id), "utf8")).toContain("[human #1]\nprototype a chain");
  });

  it("goes from a message to two chained projects built, landed, and reported back", async () => {
    const t = createThread(db, { title: "t", autonomy: "go" });
    const turn = await runWatchmanTurn(ctx, t.id, "prototype a chain");
    expect(turn.applied).toEqual({ repos: ["proto"], projects: ["proto-a", "proto-b"], environments: ["local"], units: {} });
    expect(getProject(db, "proto-b" as ProjectId).state).toBe("framing");
    expect(getSpec(db, "proto-a")!.text).toContain("## Scope");

    const second = await runWatchmanTurn(ctx, t.id, "timestamps do not matter; use local");
    expect(second.problem).toBeNull();
    expect(listDecisions(db, t.id, { activeOnly: true }).map((d) => d.text)).toEqual(["Timestamps are ignored"]);
    expect(listQuestions(db, t.id)[0]).toMatchObject({ answer: "local", resolvedMessageId: second.reply!.id });

    await new Engine(ctx, { tickMs: 50 }).runUntilIdle();
    for (const p of ["proto-a", "proto-b"] as ProjectId[]) {
      expect(getProject(db, p).state).toBe("closed");
      expect(
        listUnits(db, p)
          .filter((u) => u.type === "work")
          .every((u) => u.state === "landed"),
      ).toBe(true);
    }
    const aClosed = db
      .prepare("SELECT MIN(id) AS id FROM events WHERE project_id = 'proto-a' AND type = 'project.state' AND json_extract(data_json, '$.state') = 'closed'")
      .get() as { id: number };
    const bStarted = db.prepare("SELECT MIN(id) AS id FROM events WHERE project_id = 'proto-b' AND type = 'plan.drain_started'").get() as { id: number };
    expect(bStarted.id).toBeGreaterThan(aClosed.id);

    const reports = listMessages(db, t.id).filter((m) => m.role === "system" && m.body.includes("is done"));
    expect(reports.map((m) => m.body.split("\n")[0])).toEqual(["**proto-a is done.** all landed", "**proto-b is done.** all landed"]);
    expect(reports[0]!.body).toMatch(/### Landed\n- U\d+ write a — landed `[0-9a-f]{10}` on proto, verified unit-verified/);
    expect(reports[0]!.body).toContain("- unit (unit-verified): `test -f README.md`");
    expect(
      listGates(db, null, "open")
        .filter((g) => g.kind === "report")
        .map((g) => g.projectId),
    ).toEqual(["proto-a", "proto-b"]);
    const files = await git(["ls-tree", "-r", "--name-only", "main"], { cwd: layout(boot).newRepo("proto") });
    expect(files.split("\n").filter((f) => f.startsWith("app/")).length).toBe(6);
  }, 120_000);

  it("registers an existing repo from a proposal, checking it before storing and mirroring it on apply", async () => {
    const seed = join(boot.home, "..", "billing-seed");
    write(join(seed, "README.md"), "# billing\n");
    write(
      join(seed, ".agents/verify/verify.json"),
      JSON.stringify({ provider: "local-process", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] }),
    );
    await git(["init", "--quiet", "-b", "trunk"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@localhost" });
    const origin = join(boot.home, "..", "billing.git");
    await git(["clone", "--quiet", "--bare", seed, origin]);

    const t = createThread(db, { title: "t" });
    const turn = await runWatchmanTurn(ctx, t.id, `register billing ${origin}`);
    expect(turn.problem).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 0 });
    expect(await applyProposal(ctx, turn.proposal!.id)).toMatchObject({ repos: ["billing"], projects: ["billing-work"] });
    expect(getRepo(db, "billing" as RepoId)).toMatchObject({ url: origin, defaultBranch: "trunk", packStatus: "unproven" });
    expect(existsSync(layout(boot).mirror("billing" as RepoId))).toBe(true);

    const again = await runWatchmanTurn(ctx, t.id, `register billing-2 ${origin}`);
    expect(again.problem).toBe(`proposal: ${origin} is already registered as repo billing`);
  });

  it("rejects an existing repo it cannot read, and accepts one without a verify pack, which gets a pack unit later", async () => {
    const t = createThread(db, { title: "t" });
    const missing = await runWatchmanTurn(ctx, t.id, `register ghost ${join(boot.home, "ghost")}`);
    expect(missing.problem).toMatch(/^proposal: repo ghost: cannot read .*ghost as a git repo/);

    const seed = join(boot.home, "..", "bare-seed");
    write(join(seed, "README.md"), "# x\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@localhost" });
    const bare = join(boot.home, "..", "nopack.git");
    await git(["clone", "--quiet", "--bare", seed, bare]);
    const packless = await runWatchmanTurn(ctx, t.id, `register nopack ${bare}`);
    expect(packless.problem).toBeNull();
    await applyProposal(ctx, packless.proposal!.id);
    expect(getRepo(db, "nopack" as RepoId).packStatus).toBe("missing");
  });

  it("waits at a phase gate before starting the next project in a chain", async () => {
    const t = createThread(db, { title: "t" });
    const pack = { provider: "local-process", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] };
    const { proposal } = storeTurn(ctx, t.id, {
      body: "ok",
      turnLog: null,
      records: TurnRecords.parse({
        proposal: {
          summary: "gated",
          repos: [{ id: "gate-repo", verifyPack: pack }],
          projects: [
            { id: "g1", goal: "g", predicate: "p", repos: ["gate-repo"] },
            { id: "g2", goal: "g", predicate: "p", repos: ["gate-repo"], after: ["g1"], phaseGate: true, merge: "auto" },
          ],
        },
      }),
    });
    await applyProposal(ctx, proposal!.id);
    expect(getProject(db, "g2" as ProjectId).state).toBe("framing");
    db.prepare("UPDATE projects SET state = 'closed' WHERE id = 'g1'").run();
    const engine = new Engine(ctx, { projectId: "g2" as ProjectId, tickMs: 50 });
    await engine.runUntilIdle();
    expect(getProject(db, "g2" as ProjectId).state).toBe("framing");
    const gate = listGates(db, "g2" as ProjectId, "open").find((g) => g.kind === "phase")!;
    expect(gate.options).toEqual(["start", "hold"]);
    const { answerGate } = await import("./store.js");
    answerGate(db, gate.id, "start");
    await engine.runUntilIdle();
    expect(getProject(db, "g2" as ProjectId).state).toBe("closed");
  }, 60_000);

  it("proposes environments with values, presets, and templates", async () => {
    const t = createThread(db, { title: "t" });
    const pack = { provider: "local-process", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] };
    const propose = (proposal: unknown) => () => storeTurn(ctx, t.id, { body: "ok", turnLog: null, records: TurnRecords.parse({ proposal }) });
    const box = {
      id: "box",
      notes: "deps in the cluster",
      keep: { policy: "failed", hours: 1 },
      presets: ["kafka"],
      values: [
        { name: "FLAG_URL", value: "http://flag.internal", note: "feature flags" },
        { name: "KAFKA_BOOTSTRAP_LOCAL", value: "box.internal:30092" },
      ],
    };
    expect(propose({ summary: "s", environments: [{ ...box, values: [{ name: "yagura_x", value: "v" }] }] })).toThrow(
      /environment box: yagura_x: names are UPPER_CASE/,
    );
    expect(propose({ summary: "s", environments: [{ id: "kp", provider: "kube-namespace", providerConfig: { mode: "pool" }, capacity: 1 }] })).toThrow(
      /environment kp: /,
    );
    expect(propose({ summary: "s", environments: [{ id: "t", template: "nope" }] })).toThrow(/environment t: no template named nope/);

    const { proposal } = propose({
      summary: "box and a project on it",
      repos: [{ id: "box-repo", verifyPack: pack }],
      environments: [box],
      projects: [{ id: "on-box", goal: "g", predicate: "p", repos: ["box-repo"], environment: "box" }],
    })();
    const { buildWatchmanBrief } = await import("./watchman.js");
    expect(await applyProposal(ctx, proposal!.id)).toEqual({ repos: ["box-repo"], environments: ["box"], projects: ["on-box"], units: {} });
    expect(getProject(db, "on-box" as ProjectId).environmentId).toBe("box");
    const env = getEnvironment(db, "box" as EnvironmentId);
    expect(env.notes).toBe("deps in the cluster");
    expect(listValues(db, "box" as EnvironmentId).map((v) => [v.name, v.source])).toEqual([
      ["FLAG_URL", "watchman"],
      ["KAFKA_BOOTSTRAP_LOCAL", "watchman"],
      ["KAFKA_BOOTSTRAP_CLUSTER", "kafka"],
    ]);
    expect(resolveSetting(db, "lease.keep", { environmentId: "box" as EnvironmentId }).value).toBe("failed");
    const brief = buildWatchmanBrief(ctx, t.id, listMessages(db, t.id).at(-1)!).text;
    expect(brief).toContain("box (local-process, 1 slots, values FLAG_URL KAFKA_BOOTSTRAP_LOCAL KAFKA_BOOTSTRAP_CLUSTER)");

    saveTemplate(db, "box" as EnvironmentId, { name: "box-shape", ask: ["FLAG_URL"] });
    expect(buildWatchmanBrief(ctx, t.id, listMessages(db, t.id).at(-1)!).text).toContain("- environment templates: box-shape (asks FLAG_URL)");
    expect(propose({ summary: "s", environments: [{ id: "box2", template: "box-shape" }] })).toThrow(/needs a value for FLAG_URL/);
    expect(propose({ summary: "s", projects: [{ id: "p2", goal: "g", predicate: "p", repos: ["box-repo"] }], environments: [{ ...box, id: "xx" }] })).toThrow(
      /several environments exist \(box, xx\); name one/,
    );
  });

  it("sets a proposed project's skills and reference repos, refusing a reference that is not registered", async () => {
    const t = createThread(db, { title: "t" });
    addRepo(db, { id: "billing", url: "/billing", defaultBranch: "main" });
    const pack = { provider: "local-process", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] };
    const propose = (references: string[]) => () =>
      storeTurn(ctx, t.id, {
        body: "ok",
        turnLog: null,
        records: TurnRecords.parse({
          proposal: {
            summary: "a service",
            repos: [{ id: "svc", verifyPack: pack }],
            projects: [{ id: "svc", goal: "g", predicate: "p", repos: ["svc"], skills: { scaffold: ["setup-gradle"], work: ["setup-gradle"] }, references }],
          },
        }),
      });
    expect(propose(["ghost"])).toThrow(/svc: reference repo ghost is neither registered nor created by this proposal/);
    const { proposal } = propose(["billing"])();
    await applyProposal(ctx, proposal!.id);
    const at = { projectId: "svc" as ProjectId };
    expect(resolveSetting(db, "skills.scaffold", at)).toMatchObject({ value: ["setup-gradle"], source: "project" });
    expect(resolveSetting(db, "skills.pack", at)).toMatchObject({ value: [], source: "default" });
    expect(resolveSetting(db, "project.reference_repos", at).value).toEqual(["billing"]);
  });

  describe("sessions", () => {
    let seenLog: string;
    const prompts = () =>
      readFileSync(seenLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { sessionId: string; resumed: boolean; prompt: string });
    const sessions = () =>
      db.prepare("SELECT harness_session_id AS id, ended_reason AS reason FROM thread_sessions ORDER BY thread_sessions.id").all() as {
        id: string;
        reason: string | null;
      }[];

    beforeEach(() => {
      seenLog = join(mkdtempSync(join(tmpdir(), "yagura-seen-")), "prompts.jsonl");
      process.env.FAKE_SEEN_LOG = seenLog;
    });
    afterEach(() => {
      delete process.env.FAKE_SEEN_LOG;
      delete process.env.FAKE_RESUME;
    });

    it("resumes the thread's session with only what changed since the last turn", async () => {
      const t = createThread(db, { title: "t" });
      expect((await runWatchmanTurn(ctx, t.id, "prototype a chain")).problem).toBeNull();
      expect((await runWatchmanTurn(ctx, t.id, "ignore timestamps")).problem).toBeNull();

      const [first, second] = prompts();
      expect(first).toMatchObject({ resumed: false });
      expect(second).toMatchObject({ resumed: true, sessionId: first!.sessionId });
      expect(first!.prompt).toContain("## WHAT YAGURA HAS");
      expect(second!.prompt).not.toContain("## WHAT YAGURA HAS");
      expect(second!.prompt).toContain("### Decisions\n- D1: Build proto in a new repo");
      expect(second!.prompt).toContain("### Open questions\n- Q1: Which environment later?");
      expect(second!.prompt).toContain("[human #3]\nignore timestamps");
      expect(second!.prompt).not.toContain("prototype a chain");
      expect(sessions()).toEqual([{ id: first!.sessionId, reason: null }]);
      expect(listDecisions(db, t.id, { activeOnly: true }).map((d) => d.text)).toEqual(["Timestamps are ignored"]);

      await runWatchmanTurn(ctx, t.id, "anything new?");
      const third = prompts()[2]!.prompt;
      expect(third).toContain("- D2: Timestamps are ignored");
      expect(third).toContain("- D1 is no longer active (superseded by D2)");
      expect(third).toContain("- Q1 is closed, answered: local");
    });

    it("starts a full session after a clear, and says so in the thread", async () => {
      const t = createThread(db, { title: "t" });
      await runWatchmanTurn(ctx, t.id, "prototype a chain");
      expect(clearWatchmanSession(db, t.id)).toBe(true);
      expect(clearWatchmanSession(db, t.id)).toBe(false);
      await runWatchmanTurn(ctx, t.id, "where were we?");

      const [first, second] = prompts();
      expect(second).toMatchObject({ resumed: false });
      expect(second!.sessionId).not.toBe(first!.sessionId);
      expect(second!.prompt).toContain("## DECISIONS (active; authoritative over anything in the conversation)\n- D1: Build proto in a new repo");
      expect(sessions().map((x) => x.reason)).toEqual(["cleared", null]);
      expect(listMessages(db, t.id).map((m) => m.role)).toEqual(["human", "watchman", "system", "human", "watchman"]);
      expect(listMessages(db, t.id)[2]!.body).toMatch(/^New session/);
    });

    it("re-runs a turn fresh when its session cannot be resumed, and records it lost", async () => {
      const t = createThread(db, { title: "t" });
      await runWatchmanTurn(ctx, t.id, "prototype a chain");
      process.env.FAKE_RESUME = "missing";
      const turn = await runWatchmanTurn(ctx, t.id, "ignore timestamps");
      expect(turn.problem).toBeNull();
      expect(turn.reply?.body).toBe("Here is the plan.");
      const [, second] = prompts();
      expect(second).toMatchObject({ resumed: false });
      expect(second!.prompt).toContain("## WHAT YAGURA HAS");
      expect(sessions().map((x) => x.reason)).toEqual(["lost", null]);
      expect(listMessages(db, t.id).find((m) => m.role === "system")?.body).toMatch(/could not be resumed/);
    });

    it("rolls to a new session once a turn's context passes the threshold", async () => {
      const t = createThread(db, { title: "t" });
      await runWatchmanTurn(ctx, t.id, "prototype a chain");
      db.prepare("UPDATE watchman_turns SET context_peak = 160000").run();
      await runWatchmanTurn(ctx, t.id, "ignore timestamps");
      expect(prompts()[1]).toMatchObject({ resumed: false });
      expect(sessions().map((x) => x.reason)).toEqual(["rolled", null]);
      expect(listMessages(db, t.id)[2]!.body).toMatch(/^New session: the last one reached 160k tokens of context \(it rolls at 150k\)/);
    });

    it("retries rejected records inside the session with only the reason", async () => {
      const t = createThread(db, { title: "t" });
      expect((await runWatchmanTurn(ctx, t.id, "typo once")).problem).toBeNull();
      const [first, retry] = prompts();
      expect(retry).toMatchObject({ resumed: true, sessionId: first!.sessionId });
      expect(retry!.prompt).toMatch(/^## YOUR PREVIOUS REPLY WAS REJECTED\nyagura stored nothing from it. Reason: Q99 does not exist/);
    });
  });

  it("records each watchman turn, refuses a second one on the same thread while it runs, and can stop it", async () => {
    const t = createThread(db, { title: "t" });
    process.env.FAKE_DELAY_MS = "5000";
    try {
      const turn = runWatchmanTurn(ctx, t.id, "prototype a chain");
      let running = runningTurn(db, t.id);
      for (let i = 0; i < 100 && !running?.pid; i++) {
        await new Promise((r) => setTimeout(r, 50));
        running = runningTurn(db, t.id);
      }
      expect(running).toMatchObject({ threadId: t.id, state: "running", threadTitle: "t" });
      await expect(runWatchmanTurn(ctx, t.id, "again")).rejects.toThrow(TurnBusy);
      expect(stopTurn(db, running!.id)).toBe(true);
      expect((await turn).problem).toBe("you stopped the watchman");
    } finally {
      delete process.env.FAKE_DELAY_MS;
    }
    expect(listTurns(db).map((x) => x.state)).toEqual(["stopped"]);
    expect((await runWatchmanTurn(ctx, t.id, "prototype a chain")).problem).toBeNull();
    expect(listTurns(db).map((x) => x.state)).toEqual(["done", "stopped"]);
  });
});

describe("specs in the store", () => {
  it("moves a spec file into the store once and removes it", async () => {
    const { importSpecFiles } = await import("./spec.js");
    const { addProject, addRepo, openStore } = await import("./store.js");
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "yagura-spec-"));
    const b = { home, packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" };
    const d = openStore(":memory:");
    addRepo(d, { id: "r", url: "file:///x", defaultBranch: "main" });
    addProject(d, { id: "sp" as ProjectId, name: "S", goal: "g", predicate: "p", minTier: "unit-verified", repos: ["r" as never] });
    mkdirSync(join(home, "projects", "sp"), { recursive: true });
    writeFileSync(layout(b).spec("sp" as ProjectId), "# sp\n\n## Goal\n\nship\n");
    expect(importSpecFiles(d, b)).toEqual([layout(b).spec("sp" as ProjectId)]);
    expect(getSpec(d, "sp")).toMatchObject({ text: "# sp\n\n## Goal\n\nship\n", updatedBy: "imported" });
    expect(existsSync(layout(b).spec("sp" as ProjectId))).toBe(false);
  });
});
