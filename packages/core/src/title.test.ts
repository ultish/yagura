import { describe, expect, it } from "vitest";
import { titleFromGoal } from "./title.js";

describe("titleFromGoal", () => {
  it("keeps a short first sentence whole, without its full stop", () => {
    expect(titleFromGoal("Add discount codes. Then update the docs.")).toBe("Add discount codes");
  });

  it("cuts a long first sentence at a word, never inside one", () => {
    const goal = "In the rakko web UI, the topic view shows a Consumers panel listing consumer groups with their lag and members";
    const title = titleFromGoal(goal);
    expect(title).toBe("In the rakko web UI, the topic view shows a Consumers panel listing consumer…");
    expect(title.length).toBeLessThanOrEqual(80);
  });
});
