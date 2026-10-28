import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bootstrap } from "./config.js";
import type { ProjectId, RepoId } from "./domain.js";
import { addProject, addRepo, addUnit, openStore, transitionUnit } from "./store.js";
import { sweepWorktrees } from "./worktrees.js";

describe("sweepWorktrees", () => {
  it("removes the checkouts of merged and dropped units, judge checkouts included, and keeps those a unit can still use", async () => {
    const home = mkdtempSync(join(tmpdir(), "yagura-sweep-"));
    const boot = { home, skillsDir: "", bind: "", port: 0, tokenFile: "" } as Bootstrap;
    const db = openStore(":memory:");
    addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
    addProject(db, { id: "my-proj", name: "p", goal: "g", predicate: "x", repos: ["r" as RepoId] });
    const unit = (n: number) =>
      addUnit(db, {
        projectId: "my-proj" as ProjectId,
        type: "work",
        repoId: "r" as RepoId,
        goal: `unit ${n}`,
        acceptance: ["a"],
        timeboxSeconds: 60,
        maxAttempts: 1,
      });
    const [merged, dropped, building, stuck] = [unit(1), unit(2), unit(3), unit(4)];
    db.prepare("UPDATE units SET state = 'merged' WHERE id = ?").run(merged!.id);
    db.prepare("UPDATE units SET state = 'dropped' WHERE id = ?").run(dropped!.id);
    transitionUnit(db, building!.id, "building", { round: { kind: "first" } });
    db.prepare("UPDATE units SET state = 'stuck' WHERE id = ?").run(stuck!.id);

    const dir = join(home, "repos", "r", "worktrees");
    const names = [
      "my-proj-u1",
      "my-proj-u1.judge",
      "my-proj-u1.judge.base",
      "my-proj-u2",
      "my-proj-u3",
      "my-proj-u3.judge",
      "my-proj-u4",
      "my-proj-u2.1",
      "my-proj-plan1",
      "other-u9",
    ];
    for (const n of names) {
      mkdirSync(join(dir, n), { recursive: true });
      writeFileSync(join(dir, n, "file"), "x");
    }

    expect(await sweepWorktrees(db, boot)).toBe(6);
    const left = names.filter((n) => existsSync(join(dir, n)));
    expect(left).toEqual(["my-proj-u3", "my-proj-u3.judge", "my-proj-u4", "my-proj-plan1"]);
  });
});
