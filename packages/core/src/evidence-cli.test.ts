import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptRecorder } from "./agent.js";
import type { ProjectId, RepoId } from "./domain.js";
import { evidenceCli } from "./evidence-cli.js";
import { layout } from "./paths.js";
import { addProject, addRepo, addUnit, createAttempt, openStore } from "./store.js";

describe("evidence run", () => {
  it("refuses a caller that does not hold the attempt's token", async () => {
    const home = mkdtempSync(join(tmpdir(), "yagura-evtoken-"));
    const db = openStore(layout({ home, packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" }).db);
    addRepo(db, { id: "r", url: "/r", defaultBranch: "main" });
    addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", minTier: "unit-verified", repos: ["r" as RepoId] });
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      writeScope: [],
      acceptance: [],
      verify: "v",
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    const attempt = createAttempt(db, unit.id, "claude", null);
    const { YAGURA_EVIDENCE_TOKEN: token } = attemptRecorder(db, { attempt, unit, projectId: "p" as ProjectId, role: "verifier" }).env;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    db.close();
    const run = (t: string | undefined) =>
      evidenceCli(["run", "--at", "head", "--label", "x", "--", "true"], {
        ...process.env,
        YAGURA_HOME: home,
        YAGURA_ATTEMPT: String(attempt.id),
        YAGURA_EVIDENCE_TOKEN: t,
      });
    const refused = { code: 2, output: "evidence run refused: YAGURA_EVIDENCE_TOKEN does not match this attempt's session\n" };
    expect(await run("0".repeat(48))).toEqual(refused);
    expect(await run(undefined)).toEqual(refused);
    await expect(run(token)).rejects.toThrow(/is not a verify attempt/);
  });
});
