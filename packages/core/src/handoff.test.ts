import { describe, expect, it } from "vitest";
import { HANDOFF_TEMPLATE, missingBriefFields, renderBrief, UnfillableBrief } from "./brief.js";
import { classifyFailure, parseHandoff, syntheticFailureHandoff } from "./handoff.js";
import type { RenderedBrief, RepoId, Sha } from "./domain.js";

const brief: RenderedBrief = {
  goal: "Implement apply_discount",
  repo: { id: "testbed" as RepoId, worktree: "/wt/u1.1", branch: "yg/p/u1-1", baseSha: "abc123" as Sha },
  scope: { write: ["app/**", "tests/**"], forbid: [".agents/verify/**"] },
  context: ["app/orders.py"],
  readonly: [],
  acceptance: ["SAVE10 takes 10% off", "unknown code raises ValueError"],
  verify: "python3 -m unittest -v",
  env: {},
  timeboxMinutes: 20,
  forbidden: ["no push, rebase, or merge"],
  method: "use yagura-worker; pstack:poteto-mode, playbook: feature",
  report: HANDOFF_TEMPLATE,
  standing: "1. Keep the stdlib-only constraint.",
};

describe("brief", () => {
  it("renders every section a worker needs", () => {
    const text = renderBrief(brief);
    for (const h of ["GOAL", "REPO", "SCOPE", "CONTEXT", "READONLY", "ACCEPTANCE", "VERIFY", "ENV", "TIMEBOX", "FORBIDDEN", "METHOD", "REPORT", "STANDING ORDERS"])
      expect(text).toContain(`## ${h}\n`);
    expect(text).toContain("- app/**");
    expect(text).toContain("1. Keep the stdlib-only constraint.");
  });

  it("refuses to render a brief missing a required field", () => {
    expect(missingBriefFields({ ...brief, goal: " ", acceptance: [] })).toEqual(["GOAL", "ACCEPTANCE"]);
    expect(() => renderBrief({ ...brief, verify: "" })).toThrow(UnfillableBrief);
  });
});

const handoff = `Done. Here's my handoff.

## Status
success

## Branch
\`yg/p/u1-1\`

## What I did
- app/orders.py: implemented apply_discount with a code table

## Measurements
(none)

## Verification
unit-verified

## Evidence
- python3 -m unittest -v -> 6 passed

## Notes, concerns, deviations
- codes are case-insensitive

## Suggested follow-ups
- persist codes`;

describe("handoff parser", () => {
  it("parses a well-formed handoff, ignoring text before it", () => {
    expect(parseHandoff(handoff)).toMatchObject({
      status: "success",
      branch: "yg/p/u1-1",
      verification: "unit-verified",
      evidence: ["python3 -m unittest -v -> 6 passed"],
      notes: "- codes are case-insensitive",
    });
  });

  it("round-trips the template the brief asks for", () => {
    const filled = HANDOFF_TEMPLATE.replace("success | partial | blocked", "partial").replace(/<one of:[^>]*>/, "build-only");
    expect(parseHandoff(filled)).toMatchObject({ status: "partial", verification: "build-only" });
  });

  it("rejects messages without a valid status", () => {
    expect(parseHandoff("DONE")).toBeNull();
    expect(parseHandoff("## Status\nfinished")).toBeNull();
  });

  it("treats an unknown tier as unreported rather than trusting it", () => {
    expect(parseHandoff(handoff.replace("unit-verified", "totally-verified"))?.verification).toBeNull();
  });
});

describe("failure classification", () => {
  const base = { timedOut: false, exitCode: 1, signal: null, finalText: null, finalIsError: true, stderrTail: "" };
  it.each([
    [{ timedOut: true }, "timebox"],
    [{ exitCode: 137 }, "oom"],
    [{ finalText: "Prompt is too long" }, "context-exhausted"],
    [{ stderrTail: "TypeError: fetch failed" }, "network"],
    [{}, "harness-error"],
    [{ exitCode: 0, finalIsError: false }, "unknown"],
  ] as const)("%o -> %s", (overrides, mode) => {
    expect(classifyFailure({ ...base, ...overrides })).toBe(mode);
  });

  it("writes a synthetic handoff the parser reads as blocked", () => {
    const text = syntheticFailureHandoff({
      unit: "p/U1",
      attempt: 2,
      mode: "timebox",
      branch: "yg/p/u1-2",
      startedAt: "t0",
      endedAt: "t1",
      lastActivity: "Bash: python3 -m unittest",
      facts: { ...base, timedOut: true },
    });
    expect(parseHandoff(text)).toMatchObject({ status: "blocked", branch: "yg/p/u1-2" });
    expect(text).toContain("mode: timebox");
  });
});
