import { afterEach, describe, expect, it } from "vitest";
import { debug, debugOn, setDebug, shellLine, timed } from "./debug.js";

const lines: string[] = [];
afterEach(() => {
  setDebug(null);
  lines.length = 0;
});

describe("debug", () => {
  it("does nothing, and builds nothing, until a sink is set", async () => {
    let built = 0;
    debug(() => (built++, "x"));
    expect(
      await timed(
        () => (built++, "x"),
        async () => 7,
      ),
    ).toBe(7);
    expect(built).toBe(0);
    expect(debugOn()).toBe(false);
  });

  it("marks each line and times the work it wraps", async () => {
    setDebug((l) => lines.push(l));
    debug("hello");
    await timed(
      () => "git status",
      async () => "ok",
    );
    expect(lines[0]).toBe("· hello");
    expect(lines[1]).toMatch(/^· git status \(\d+ ms\)$/);
  });

  it("reports a failure with its first line, and still throws it", async () => {
    setDebug((l) => lines.push(l));
    await expect(
      timed(
        () => "gh issue list",
        async () => Promise.reject(new Error("no answer\nmore")),
      ),
    ).rejects.toThrow("no answer");
    expect(lines[0]).toMatch(/^· gh issue list failed \(\d+ ms\): no answer$/);
  });

  it("keeps a command to one short line", () => {
    const line = shellLine("git", ["log", "--format=%H", "x".repeat(300)]);
    expect(line.length).toBeLessThanOrEqual(110);
    expect(line.startsWith("git log")).toBe(true);
  });
});

describe("quiet calls", () => {
  it("log only when slow or failing", async () => {
    setDebug((l) => lines.push(l));
    await timed(
      () => "git rev-parse",
      async () => "x",
      { quiet: true },
    );
    expect(lines).toEqual([]);
    await timed(
      () => "git rev-parse",
      () => new Promise((r) => setTimeout(r, 170)),
      { quiet: true },
    );
    expect(lines).toHaveLength(1);
  });
});
