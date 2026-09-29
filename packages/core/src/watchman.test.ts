import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "./agent.js";
import type { Bootstrap } from "./config.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { resolveSetting } from "./config.js";
import { listValues } from "./envvalues.js";
import { saveTemplate } from "./templates.js";
import { Engine } from "./engine.js";
import { write } from "./agent.js";
import { commitAll, git } from "./git.js";
import type { HarnessAdapter } from "./harness/adapter.js";
import { parseClaudeLine } from "./harness/claude.js";
import { layout } from "./paths.js";
import { applyProposal } from "./proposal.js";
import { editSpec, parseSpec, relevantSections, renderSpec } from "./spec.js";
import { addProject, addRepo, getEnvironment, getProject, getRepo, listGates, listUnits, openStore, type Db } from "./store.js";
import { createThread, getProposal, getThread, linkThreadProject, listDecisions, listMessages, listProposals, listQuestions } from "./threads.js";
import { assembleContext, parseReply, runWatchmanTurn, storeTurn, TurnRecords, type ContextParts } from "./watchman.js";
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
    expect(readFileSync(layout(boot).spec("linked" as ProjectId), "utf8")).toBe("# linked\n\n## Scope\n\nall of it\n");
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'project.spec_changed'").get()).toEqual({ n: 1 });
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
    expect(readFileSync(layout(boot).spec("proto-a" as ProjectId), "utf8")).toContain("## Scope");

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

  it("proposes environments with values, checks, presets, and templates, and keeps one whose doctor fails without starting its projects", async () => {
    const t = createThread(db, { title: "t" });
    const pack = { provider: "local-process", checks: [{ name: "unit", command: "true", tier: "unit-verified" }] };
    const propose = (proposal: unknown) => () => storeTurn(ctx, t.id, { body: "ok", turnLog: null, records: TurnRecords.parse({ proposal }) });
    const box = {
      id: "box",
      notes: "deps in the cluster",
      keep: { policy: "failed", hours: 1 },
      presets: ["kafka"],
      values: [
        { name: "FLAG_URL", value: "http://flag.internal", note: "feature flags", check: 'test "$FLAG_URL" = http://flag.internal' },
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
    expect([env.doctorStatus, env.notes]).toEqual(["passing", "deps in the cluster"]);
    expect(listValues(db, "box" as EnvironmentId).map((v) => [v.name, v.source, v.last?.ok ?? null])).toEqual([
      ["FLAG_URL", "watchman", true],
      ["KAFKA_BOOTSTRAP_LOCAL", "watchman", null],
      ["KAFKA_BOOTSTRAP_CLUSTER", "kafka", null],
    ]);
    expect(resolveSetting(db, "lease.keep", { environmentId: "box" as EnvironmentId }).value).toBe("failed");
    const brief = buildWatchmanBrief(ctx, t.id, listMessages(db, t.id).at(-1)!).text;
    expect(brief).toContain("box (local-process, 1 slots, doctor passing, values FLAG_URL KAFKA_BOOTSTRAP_LOCAL KAFKA_BOOTSTRAP_CLUSTER)");

    saveTemplate(db, boot, "box" as EnvironmentId, { name: "box-shape", ask: ["FLAG_URL"] });
    expect(buildWatchmanBrief(ctx, t.id, listMessages(db, t.id).at(-1)!).text).toContain("- environment templates: box-shape (asks FLAG_URL)");
    expect(propose({ summary: "s", environments: [{ id: "box2", template: "box-shape" }] })).toThrow(/needs a value for FLAG_URL/);
    expect(propose({ summary: "s", projects: [{ id: "p2", goal: "g", predicate: "p", repos: ["box-repo"] }], environments: [{ ...box, id: "xx" }] })).toThrow(
      /several environments exist \(box, xx\); name one/,
    );

    const broken = propose({
      summary: "a machine whose flag service is down",
      environments: [{ id: "box2", template: "box-shape", answers: { FLAG_URL: "http://elsewhere" } }],
      projects: [{ id: "on-box2", goal: "g", predicate: "p", repos: ["box-repo"], environment: "box2" }],
    })().proposal!;
    await expect(applyProposal(ctx, broken.id)).rejects.toThrow(
      /environment box2 failed its doctor \(value FLAG_URL: exit 1\), so on-box2 did not start\. It was created/,
    );
    expect(getEnvironment(db, "box2" as EnvironmentId).doctorStatus).toBe("failing");
    expect(listValues(db, "box2" as EnvironmentId).map((v) => [v.name, v.value, v.source])).toEqual([
      ["FLAG_URL", "http://elsewhere", "template box-shape"],
      ["KAFKA_BOOTSTRAP_LOCAL", "box.internal:30092", "template box-shape"],
      ["KAFKA_BOOTSTRAP_CLUSTER", "kafka.kafka.svc:9092", "template box-shape"],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'on-box2'").get()).toEqual({ n: 0 });
    expect(getProposal(db, broken.id).state).toBe("failed");
    expect(propose({ summary: "s", projects: [{ id: "p3", goal: "g", predicate: "p", repos: ["box-repo"], environment: "box2" }] })).toThrow(
      /p3: environment box2 failed its doctor/,
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
