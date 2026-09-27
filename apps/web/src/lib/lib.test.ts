import { describe, expect, it } from "vitest";
import type { LogLine, ProjectDetail, ProjectSummary, UnitView } from "../api";
import { duration, modelName } from "./format";
import { mentionHref, mentionQuery } from "./mention";
import { layoutScene, subLabel } from "./scene";
import { buildTimeline } from "./timeline";
import { groupOf, stages, statusLine } from "./units";

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
const attempt = (over: object) => ({ id: 9, unitId: 1, n: 1, state: "handed_off", startedAt: "2026-09-27T00:00:00Z", endedAt: null, ...over }) as never;
const detail = (units: UnitView[], over: Partial<ProjectDetail> = {}): ProjectDetail => ({ units, gates: [], waiting: [], deps: [], ...over }) as ProjectDetail;
const NOW = Date.parse("2026-09-27T00:12:00Z");

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
    const v = unit({ id: 2 as never, seq: 2, type: "verify", targetUnitId: 1 as never, state: "done" });
    const d = detail([u, v], { gates: [{ id: 3, unitId: 1, state: "open", kind: "land", options: ["land", "hold"] }] as never });
    expect(stages(d, u, NOW).map((s) => s.light)).toEqual(["lit", "lit", "lit", "bell"]);
    expect(statusLine(d, u, NOW).text).toBe("Verified by U2 at unit-verified. Ready to land on r.");
    expect(groupOf(d, u)).toBe("bell");
  });

  it("puts the ember where a blocked unit stopped", () => {
    const atWork = unit({ state: "blocked", blockedReason: "used 2 of 2 attempts" });
    const atLand = unit({ state: "blocked", verdict: { id: 1, tier: "unit-verified", headSha: "x" }, attempts: [attempt({})] });
    expect(stages(detail([atWork]), atWork, NOW).map((s) => s.light)).toEqual(["lit", "ember", "off", "off"]);
    expect(stages(detail([atLand]), atLand, NOW).map((s) => s.light)).toEqual(["lit", "lit", "lit", "ember"]);
    expect(statusLine(detail([atWork]), atWork, NOW)).toEqual({ text: "Blocked. used 2 of 2 attempts", tone: "bell" });
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
    expect(["kafka-diff", "kafka-diff/U3", "kafka-diff/U3.2", "thread:4", "repo:jsondiff"].map(mentionHref)).toEqual([
      "/p/kafka-diff",
      "/p/kafka-diff/u/3",
      "/p/kafka-diff/u/3/2",
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
});
