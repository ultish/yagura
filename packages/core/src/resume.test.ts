import { describe, expect, it } from "vitest";
import type { Attempt, AttemptId } from "./domain.js";
import { chooseResume } from "./resume.js";

const attempt = (n: number, over: Partial<Attempt> = {}): Attempt =>
  ({
    id: n as AttemptId,
    n,
    role: "worker",
    harness: "claude",
    model: "claude-opus-5-5",
    state: "handed_off",
    sessionId: `s${n}`,
    worktreePath: "/wt",
    branch: "yagura/p/u1",
    baseSha: "abc",
    contextPeak: 50_000,
    resumesAttemptId: null,
    ...over,
  }) as Attempt;
const opts = { enabled: true, canResume: true, maxContext: 0.6 };

describe("chooseResume", () => {
  it("resumes the last worker session, again and again, as long as it can", () => {
    expect(chooseResume([attempt(1)], opts).resume?.n).toBe(1);
    expect(chooseResume([attempt(1), attempt(2, { resumesAttemptId: 1 as never })], opts).resume?.n).toBe(2);
  });

  it("ignores a judge's attempt when it looks for the worker", () => {
    expect(chooseResume([attempt(1), attempt(2, { role: "judge" })], opts).resume?.n).toBe(1);
  });

  it("has nothing to decide before a worker has handed off", () => {
    expect(chooseResume([], opts)).toEqual({ resume: null, fresh: null });
    expect(chooseResume([attempt(1, { state: "failed" })], opts)).toEqual({ resume: null, fresh: null });
  });

  it("starts fresh when the session cannot be resumed, and says why", () => {
    const fresh = (attempts: Attempt[], o = opts) => chooseResume(attempts, o).fresh;
    expect(fresh([attempt(1)], { ...opts, enabled: false })).toBe("attempt 1 is not resumed: resume is off");
    expect(fresh([attempt(1)], { ...opts, canResume: false })).toBe("attempt 1 ran on claude, which cannot resume");
    expect(fresh([attempt(1, { sessionId: null })])).toBe("attempt 1 left no session to resume");
    expect(fresh([attempt(1, { model: "claude-opus-5-5[1m]", contextPeak: 700_000 })])).toBe("attempt 1 peaked at 70% of its context window");
    expect(chooseResume([attempt(1, { model: "claude-opus-5-5[1m]", contextPeak: 500_000 })], opts).resume?.n).toBe(1);
  });
});
