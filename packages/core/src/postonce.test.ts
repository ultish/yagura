import { describe, expect, it } from "vitest";
import type { ProjectId, RepoId } from "./domain.js";
import type { ForgeAdapter } from "./forge.js";
import { postOnce } from "./forge.js";
import { postReplies } from "./triage.js";
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

  it("answers a review thread once when the triage run and the PR watcher both post it at the same moment", async () => {
    const db = openStore(":memory:");
    addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
    addProject(db, { id: "p" as ProjectId, name: "P", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["r" as RepoId] });
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      writeScope: ["a"],
      acceptance: ["a"],
      verify: "true",
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    transitionUnit(db, unit.id, "ready");
    db.prepare(
      "INSERT INTO mr_threads (unit_id, thread_id, kind, author, comments_json, decision, reason, wave_unit_id, state, created_at) VALUES (?, 'PRRT_1', 'review-thread', 'ultish', '[\"hi\"]', 'dismissed', 'the acceptance test forbids it', ?, 'replying', 't')",
    ).run(unit.id, unit.id);
    const replies: string[] = [];
    // A forge whose reply is slow and whose keys lag behind what was just posted.
    const forge = {
      replyKeys: async () => new Set<string>(),
      reply: async (_n: number, _t: unknown, body: string) => {
        await slow(30);
        replies.push(body);
      },
    } as unknown as ForgeAdapter;
    const counts = await Promise.all([postReplies(db, forge, unit, 1), postReplies(db, forge, unit, 1)]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/\*\*No change\*\* — the acceptance test forbids it$/);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await postReplies(db, forge, unit, 1)).toBe(0);
  });
});
