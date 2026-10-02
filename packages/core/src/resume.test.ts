import { describe, expect, it } from "vitest";
import type { Attempt, AttemptId } from "./domain.js";
import { chooseResume } from "./resume.js";

const attempt = (n: number, over: Partial<Attempt> = {}): Attempt =>
  ({
    id: n as AttemptId,
    n,
    harness: "claude",
    model: "claude-opus-5-5",
    state: "handed_off",
    sessionId: `s${n}`,
    worktreePath: "/wt",
    branch: "yg/p/u1-1",
    baseSha: "abc",
    contextPeak: 50_000,
    resumesAttemptId: null,
    rejection: "code-fault",
    ...over,
  }) as Attempt;
const opts = { enabled: true, canResume: true, maxContext: 0.6 };

describe("chooseResume", () => {
  it("resumes a code fault", () => {
    expect(chooseResume([attempt(1)], opts).resume?.n).toBe(1);
  });

  it("resumes a worker rejected for a path outside scope, so it can explain or revert it", () => {
    expect(chooseResume([attempt(1, { rejection: "scope" })], opts).resume?.n).toBe(1);
    expect(chooseResume([attempt(1, { rejection: "scope" }), attempt(2, { rejection: "scope", resumesAttemptId: 1 as never })], opts).fresh).toBe(
      "attempt 2 was already a resumed round",
    );
  });

  it("has nothing to decide when the last attempt was not rejected", () => {
    expect(chooseResume([], opts)).toEqual({ resume: null, fresh: null });
    expect(chooseResume([attempt(1, { rejection: null, state: "failed" })], opts)).toEqual({ resume: null, fresh: null });
  });

  it("starts fresh for rejections the worker cannot fix in place and when it cannot resume", () => {
    const fresh = (attempts: Attempt[], o = opts) => chooseResume(attempts, o).fresh;
    expect(fresh([attempt(1, { rejection: "skills" })])).toBe("attempt 1 was rejected for skipping required skills");
    expect(fresh([attempt(1, { rejection: "conflict" })])).toBe("attempt 1 was rejected for a conflict with the moved trunk");
    expect(fresh([attempt(1)], { ...opts, canResume: false })).toBe("attempt 1 ran on claude, which cannot resume");
    expect(fresh([attempt(1, { sessionId: null })])).toBe("attempt 1 left no session to resume");
    expect(fresh([attempt(1, { model: "claude-opus-5-5[1m]", contextPeak: 700_000 })])).toBe("attempt 1 peaked at 70% of its context window");
    expect(chooseResume([attempt(1, { model: "claude-opus-5-5[1m]", contextPeak: 500_000 })], opts).resume?.n).toBe(1);
  });
});
