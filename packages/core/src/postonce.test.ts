import { describe, expect, it } from "vitest";
import type { ProjectId, RepoId } from "./domain.js";
import type { ForgeAdapter } from "./forge.js";
import { postOnce } from "./forge.js";
import { addProject, addRepo, addUnit, openStore, transitionUnit } from "./store.js";

const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("posting to a forge once", () => {
  it("lets only one of two overlapping callers post a key, and skips the other", async () => {
    const sent: string[] = [];
    const first = postOnce("k", async () => {
      await slow(20);
      sent.push("a");
      return "a";
    });
    const second = postOnce("k", async () => {
      sent.push("b");
      return "b";
    });
    expect(await first).toEqual({ posted: "a" });
    expect(await second).toBeNull();
    expect(sent).toEqual(["a"]);
    expect(await postOnce("k", async () => "later")).toEqual({ posted: "later" });
  });
});
