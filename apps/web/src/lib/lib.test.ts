import { describe, expect, it } from "vitest";
import type { BellItem, LogLine, ProjectDetail, ProjectSummary, UnitView } from "../api";
import { lineDiff } from "./linediff";
import { clip, clock, duration, modelName, when } from "./format";
import { announce, faviconHref, newItems, tabTitle } from "./bellalert";
import { ifUnanswered } from "./gates";
import { groupHits, highlight } from "./search";
import { mentionHref, mentionQuery } from "./mention";
import { layoutScene, subLabel } from "./scene";
import { buildTimeline } from "./timeline";
import { groupOf, isBuild, roleOf, stages, statusLine } from "./units";

const line = (n: number, at: number, events: LogLine["events"]): LogLine => ({ line: n, at, raw: "", events });

describe("buildTimeline", () => {
  it("attaches results to calls, nests subagent steps, and drops the text the final message repeats", () => {
    const t = buildTimeline([
      line(0, 1000, [{ kind: "session", sessionId: "s", model: "claude-opus-5-5", plugins: { pstack: "0.5.0" } }]),
      line(1, 2000, [{ kind: "tool_call", id: "k", name: "Skill", input: { skill: "yagura:yagura-worker" }, parentId: null }]),
      line(2, 2500, [{ kind: "tool_result", id: "k", output: "Launching", isError: false, parentId: null }]),
      line(3, 3000, [
        { kind: "tool_call", id: "b", name: "Bash", input: { command: "python3 -m unittest\necho done" }, parentId: null },
        { kind: "usage", outputTokens: 10, contextTokens: 41000 },
      ]),
      line(4, 4000, [{ kind: "tool_result", id: "b", output: "OK", isError: false, parentId: null }]),
      line(5, 4500, [{ kind: "tool_call", id: "a", name: "Agent", input: { description: "scan tests" }, parentId: null }]),
      line(6, 4600, [{ kind: "tool_call", id: "r", name: "Read", input: { file_path: "/home/u/.yagura/worktrees/repo/p-u2.1/app/x.py" }, parentId: "a" }]),
      line(7, 5000, [{ kind: "text", text: "## Status\nsuccess", parentId: null }]),
      line(8, 5000, [{ kind: "final", text: "## Status\nsuccess", isError: false, stopReason: "end_turn", costUsd: 0.2 }]),
    ]);
    expect(t.model).toBe("claude-opus-5-5");
    expect(t.contextPeak).toBe(41000);
    expect(t.startedAt).toBe(1000);
    expect(t.steps.map((s) => s.kind)).toEqual(["skill", "tool", "tool", "final"]);
    expect(t.steps[1]).toMatchObject({ name: "Bash", summary: "python3 -m unittest …", output: "OK", at: 3000 });
    const agent = t.steps[2] as Extract<(typeof t.steps)[number], { kind: "tool" }>;
    expect(agent.children.map((c) => (c.kind === "tool" ? c.summary : c.kind))).toEqual(["app/x.py"]);
    expect(t.lastActivity).toBe("Read app/x.py");
  });
});

const unit = (over: Partial<UnitView>): UnitView =>
  ({
    id: 1 as never,
    projectId: "p",
    seq: 1,
    type: "work",
    state: "ready",
    repoId: "r",
    targetUnitId: null,
    goal: "g",
    writeScope: [],
    forbidScope: [],
    acceptance: [],
    verify: null,
    context: [],
    measurements: [],
    notes: [],
    refs: [],
    landedSha: null,
    playbook: null,
    timeboxSeconds: 1800,
    maxAttempts: 2,
    createdByDrainId: null,
    createdAt: "",
    updatedAt: "",
    attempts: [],
    verdict: null,
    blockedReason: null,
    ...over,
  }) as UnitView;
const attempt = (over: object) =>
  ({ id: 9, unitId: 1, n: 1, agentNo: 9, state: "handed_off", startedAt: "2026-09-27T00:00:00Z", endedAt: null, ...over }) as never;
const detail = (units: UnitView[], over: Partial<ProjectDetail> = {}): ProjectDetail =>
  ({ project: { id: "p" }, units, gates: [], waiting: [], deps: [], ...over }) as ProjectDetail;
const NOW = Date.parse("2026-09-27T00:12:00Z");

describe("search", () => {
  it("highlights every word of the query, in any case", () => {
    expect(highlight("Discounts round half up", "round discount")).toEqual([
      { text: "Discount", match: true },
      { text: "s ", match: false },
      { text: "round", match: true },
      { text: " half up", match: false },
    ]);
    expect(highlight("costs 100% (a+b)", "(a+b)")).toEqual([
      { text: "costs 100% ", match: false },
      { text: "(a+b)", match: true },
    ]);
  });

  it("groups hits by kind in a fixed order, with each kind's full count", () => {
    const hit = (kind: string, ref: string) => ({ kind, ref, href: "", title: "", meta: "", text: "" });
    const groups = groupHits({ query: "x", total: 5, counts: { message: 3, unit: 2 }, hits: [hit("message", "m1"), hit("unit", "u1"), hit("unit", "u2")] });
    expect(groups.map((g) => [g.label, g.count, g.hits.map((h) => h.ref)])).toEqual([
      ["Units", 2, ["u1", "u2"]],
      ["Conversations", 3, ["m1"]],
    ]);
  });
});

describe("steering in the timeline", () => {
  it("shows the developer's messages but not yagura's own prompt, which the harness echoes first", () => {
    const t = buildTimeline([
      line(0, 1, [{ kind: "session", sessionId: "s", model: "m", plugins: {} }]),
      line(1, 2, [{ kind: "user_text", text: "# yagura brief" }]),
      line(2, 3, [{ kind: "tool_call", id: "a", name: "Bash", input: { command: "sleep 4" }, parentId: null }]),
      line(3, 4, [{ kind: "user_text", text: "use lib/parse.py instead" }]),
      line(4, 5, [{ kind: "final", text: "done", isError: false, stopReason: null, costUsd: 0 }]),
    ]);
    expect(t.steps.map((s) => (s.kind === "you" ? `you: ${s.text}` : s.kind))).toEqual(["tool", "you: use lib/parse.py instead", "final"]);
  });
});

describe("unit stages and status", () => {
  it("lights every stage of a landed unit", () => {
    const u = unit({ state: "landed", landedSha: "153a90b04b" as never, verdict: { id: 1, tier: "unit-verified", headSha: "x" } });
    expect(stages(detail([u]), u, NOW).map((s) => s.light)).toEqual(["lit", "lit", "lit", "lit"]);
    expect(statusLine(detail([u]), u, NOW)).toEqual({ text: "Landed 153a90b on r at unit-verified.", tone: "pine" });
  });

  it("puts a flame on the work stage while a worker runs", () => {
    const u = unit({ state: "running", attempts: [attempt({ state: "running" })] });
    expect(stages(detail([u]), u, NOW).map((s) => [s.light, s.label])).toEqual([
      ["lit", null],
      ["flame", "worker · 12m"],
      ["off", null],
      ["off", null],
    ]);
    expect(statusLine(detail([u]), u, NOW)).toEqual({ text: "Worker running for 12m (try 1 of 2).", tone: "lamp" });
  });

  it("rings the land bell when a verified unit waits on a gate, and groups it with the bell", () => {
    const u = unit({ state: "verified", verdict: { id: 1, tier: "unit-verified", headSha: "x" } });
    const v = unit({ id: 2 as never, seq: 2, type: "verify", targetUnitId: 1 as never, state: "done", attempts: [attempt({ id: 20, agentNo: 4 })] });
    const d = detail([u, v], { gates: [{ id: 3, unitId: 1, state: "open", kind: "land", options: ["land", "hold"] }] as never });
    expect(stages(d, u, NOW).map((s) => s.light)).toEqual(["lit", "lit", "lit", "bell"]);
    expect(statusLine(d, u, NOW).text).toBe("Verified by A4 at unit-verified. Ready to land on r.");
    expect(groupOf(d, u)).toBe("bell");
  });

  it("puts the ember where a blocked unit stopped", () => {
    const atWork = unit({ state: "blocked", blockedReason: "used 2 of 2 attempts" });
    const atLand = unit({ state: "blocked", verdict: { id: 1, tier: "unit-verified", headSha: "x" }, attempts: [attempt({})] });
    expect(stages(detail([atWork]), atWork, NOW).map((s) => s.light)).toEqual(["lit", "ember", "off", "off"]);
    expect(stages(detail([atLand]), atLand, NOW).map((s) => s.light)).toEqual(["lit", "lit", "lit", "ember"]);
    expect(statusLine(detail([atWork]), atWork, NOW)).toEqual({ text: "Blocked. used 2 of 2 attempts", tone: "bell" });
  });

  it("links the work and verify beacons to their agent runs, and the others to the unit", () => {
    const u = unit({
      state: "verified",
      attempts: [attempt({ id: 4, n: 1 }), attempt({ id: 7, n: 2 })],
      verdict: { id: 1, tier: "unit-verified", headSha: "x" },
    });
    const v = unit({ id: 2 as never, seq: 5, type: "verify", targetUnitId: 1 as never, state: "done", attempts: [attempt({ id: 8 })] });
    const fresh = unit({ state: "ready" });
    expect(stages(detail([u, v]), u, NOW).map((s) => s.href)).toEqual(["/p/p/u/1", "/a/7", "/a/8", null]);
    expect(stages(detail([fresh]), fresh, NOW).map((s) => s.href)).toEqual(["/p/p/u/1", null, null, null]);
  });

  it("shows a waiting unit with a dotted beacon and its reason", () => {
    const u = unit({ state: "ready" });
    const d = detail([u], { waiting: [{ unitId: 1, reason: "waiting for U3 (needs-landed, now running)" }] });
    expect(stages(d, u, NOW)[1]!.light).toBe("wait");
    expect(statusLine(d, u, NOW).text).toBe("Waiting: waiting for U3 (needs-landed, now running).");
  });
});

const summary = (id: string, over: Partial<ProjectSummary> & { state?: string; after?: string[]; closedAt?: string | null } = {}): ProjectSummary =>
  ({
    project: {
      id,
      state: over.state ?? "active",
      after: over.after ?? [],
      closedAt: over.closedAt ?? null,
      andonReason: null,
      createdAt: `2026-09-2${id.length}`,
    },
    workCounts: {},
    running: 0,
    planning: false,
    maxInFlight: 3,
    openGates: 0,
    blocked: 0,
    lastLanded: null,
    summary: null,
    ...over,
  }) as ProjectSummary;

describe("layoutScene", () => {
  it("orders towers by urgency, drops projects closed over a day ago, and labels them", () => {
    const all = [
      summary("idle"),
      summary("busy", { running: 2, planning: true }),
      summary("ringing", { openGates: 1, blocked: 1 }),
      summary("old", { state: "closed", closedAt: "2026-09-20T00:00:00Z" }),
      summary("fresh", { state: "closed", closedAt: "2026-09-26T20:00:00Z" }),
    ];
    const { towers, quiet } = layoutScene(all, NOW);
    expect(towers.map((t) => [t.s.project.id, t.sub, t.ringing, t.dim])).toEqual([
      ["ringing", "2 need you", true, false],
      ["busy", "2 agents · planning", false, false],
      ["idle", "idle", false, false],
      ["fresh", "closed", false, true],
    ]);
    expect(quiet).toBe(0);
  });

  it("keeps six towers and counts the rest as quiet, never hiding urgent ones", () => {
    const all = Array.from({ length: 9 }, (_, i) => summary(`p${i}`, i === 8 ? { openGates: 1 } : {}));
    const { towers, quiet } = layoutScene(all, NOW);
    expect(towers).toHaveLength(6);
    expect(towers[0]!.s.project.id).toBe("p8");
    expect(quiet).toBe(3);
  });

  it("draws a signal arc only while the upstream project is open", () => {
    const a = summary("a", { running: 1 });
    const b = summary("b", { state: "framing", after: ["a"] });
    expect(layoutScene([a, b], NOW).arcs.map((x) => x.label)).toEqual(["b waits on a"]);
    expect(subLabel(b, [a, b])).toBe("after a");
    const closed = summary("a", { state: "closed", closedAt: "2026-09-26T23:00:00Z" });
    expect(layoutScene([closed, b], NOW).arcs).toEqual([]);
    expect(subLabel(b, [closed, b])).toBe("ready to start");
  });
});

describe("mentions and formatting", () => {
  it("maps mention tokens to pages", () => {
    expect(["kafka-diff", "kafka-diff/U3", "kafka-diff/U3.2", "kafka-diff/A7", "thread:4", "repo:jsondiff"].map(mentionHref)).toEqual([
      "/p/kafka-diff",
      "/p/kafka-diff/u/3",
      "/p/kafka-diff/u/3/2",
      "/p/kafka-diff/a/7",
      "/talk/4",
      "/repos#jsondiff",
    ]);
  });

  it("finds the mention being typed at the caret", () => {
    expect(mentionQuery("Why did @jsondiff/U", 19)).toEqual({ start: 8, query: "jsondiff/U" });
    expect(mentionQuery("mail me@host", 12)).toBeNull();
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("formats durations and model names", () => {
    expect([duration(54_000), duration(12 * 60_000), duration(63 * 60_000)]).toEqual(["54s", "12m", "1h 3m"]);
    expect(modelName("claude-opus-5-5")).toBe("opus-5.5");
  });

  it("dates a time by the local day, not the UTC one", () => {
    expect([clock(new Date(2026, 9, 1, 0, 13).toISOString()), clock(new Date(2026, 8, 30, 23, 59).toISOString())]).toEqual(["10-01 00:13", "09-30 23:59"]);
  });

  it("clips a long line at a word and marks the cut", () => {
    expect(clip("the three code units all edit wordstat.py, so they run in order", 40)).toBe("the three code units all edit…");
    expect(clip("short", 40)).toBe("short");
  });

  it("says what happens to a gate nobody answers", () => {
    const now = Date.parse("2026-09-27T10:00:00Z");
    const g = (defaultOption: string | null, deadline: string | null, kind = "planner") => ifUnanswered({ kind, defaultOption, deadline }, now);
    expect([
      g("sqlite", "2026-09-27T15:30:00Z"),
      g("sqlite", "2026-09-27T09:00:00Z"),
      g("sqlite", null),
      g("hold", null, "land"),
      g(null, null),
      g("seen", null, "report"),
    ]).toEqual([
      "Takes sqlite in 5h 30m if nobody answers.",
      "Taking sqlite now.",
      "Waits for you; the default is sqlite.",
      "Holds until you answer.",
      "Waits for your answer.",
      null,
    ]);
  });

  it("names each agent's role, including yagura's own proof and rebase runs", () => {
    expect([roleOf("work"), roleOf("pack"), roleOf("verify"), roleOf("verify", "yagura-proof"), roleOf("work", "yagura-rebase"), roleOf("plan")]).toEqual([
      "worker",
      "pack writer",
      "verifier",
      "pack proof",
      "rebase",
      "planner",
    ]);
    expect(["work", "pack", "verify", "plan"].map((type) => isBuild({ type }))).toEqual([true, true, false, false]);
  });
});

describe("when", () => {
  const at = (h: number, m: number, s: number, day = 2) => new Date(2026, 9, day, h, m, s).toISOString();
  it("always shows the date, and the end's date only when it is another day", () => {
    expect(when(at(12, 7, 22), at(12, 8, 35))).toBe("2 Oct 12:07:22 → 12:08:35");
    expect(when(at(23, 58, 0), at(0, 2, 0, 3), false)).toBe("2 Oct 23:58 → 3 Oct 00:02");
    expect(when(at(12, 7, 22), null)).toBe("2 Oct 12:07:22");
    expect(when(null, null)).toBe("");
  });
});

describe("lineDiff", () => {
  it("keeps common lines and marks what was removed and added, in order", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });
});

describe("the bell outside the page", () => {
  const gate: BellItem = {
    kind: "gate",
    id: "gate:2",
    projectId: "demo",
    unit: { seq: 2, goal: "write app" },
    gate: { id: 2, kind: "land", question: "U2 is verified. Land it on app?", options: ["land", "hold"], defaultOption: "hold", deadline: null },
    at: "2026-10-03T09:00:00Z",
  };
  const blocked: BellItem = {
    kind: "blocked",
    id: "blocked:3",
    projectId: "demo",
    unit: { seq: 3, goal: "write docs" },
    reason: null,
    attempts: 2,
    maxAttempts: 2,
    at: "x",
  };
  const proposal: BellItem = {
    kind: "proposal",
    id: "proposal:5",
    threadId: 4,
    threadTitle: "t",
    proposalId: 5,
    summary: "Two projects on lib and app",
    at: "x",
  };

  it("puts the count in the tab title only while something needs you", () => {
    expect([tabTitle(0), tabTitle(3)]).toEqual(["yagura", "(3) yagura"]);
  });

  it("finds only the items it has not shown before", () => {
    expect(newItems(new Set(["gate:2"]), [gate, blocked]).map((i) => i.id)).toEqual(["blocked:3"]);
    expect(newItems(new Set(), [])).toEqual([]);
  });

  it("says what each kind of item needs and where clicking it goes", () => {
    expect(announce(gate)).toEqual({ title: "yagura · needs your answer", body: "U2 write app: U2 is verified. Land it on app?", href: "/p/demo/u/2" });
    expect(announce(blocked)).toEqual({ title: "yagura · blocked", body: "U3 write docs: no reason recorded", href: "/p/demo/u/3" });
    expect(announce(proposal)).toEqual({ title: "yagura · proposal ready", body: "Two projects on lib and app", href: "/talk/4" });
    expect(announce({ ...gate, unit: null }).href).toBe("/gates");
  });

  it("adds a vermilion lamp to the icon only when ringing", () => {
    expect(faviconHref(true)).toContain("%23e5553a");
    expect(faviconHref(false)).not.toContain("%23e5553a");
  });
});
