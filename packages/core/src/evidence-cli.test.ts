import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptRecorder } from "./agent.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { setValue } from "./envvalues.js";
import { evidenceCli } from "./evidence-cli.js";
import { readArtifact, runEvidence } from "./evidence.js";
import { layout } from "./paths.js";
import { addEnvironment, addProject, addRepo, addUnit, createAttempt, openStore, updateAttempt } from "./store.js";

describe("evidence run", () => {
  it("refuses a caller that does not hold the attempt's token", async () => {
    const home = mkdtempSync(join(tmpdir(), "yagura-evtoken-"));
    const db = openStore(layout({ home, skillsDir: "", bind: "", port: 0, tokenFile: "" }).db);
    addRepo(db, { id: "r", url: "/r", defaultBranch: "main" });
    addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", repos: ["r" as RepoId] });
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      acceptance: [],
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    const attempt = createAttempt(db, unit.id, "claude", null);
    updateAttempt(db, attempt.id, { role: "judge" });
    const { YAGURA_EVIDENCE_TOKEN: token } = attemptRecorder(db, { attempt, unit, projectId: "p" as ProjectId, role: "judge" }).env;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    db.close();
    const run = (t: string | undefined) =>
      evidenceCli(["run", "--", "true"], {
        ...process.env,
        YAGURA_HOME: home,
        YAGURA_ATTEMPT: String(attempt.id),
        YAGURA_EVIDENCE_TOKEN: t,
      });
    const refused = { code: 2, output: "evidence run refused: YAGURA_EVIDENCE_TOKEN does not match this attempt's session\n" };
    expect(await run("0".repeat(48))).toEqual(refused);
    expect(await run(undefined)).toEqual(refused);
    await expect(run(token)).rejects.toThrow(/has no checkout/);
  });

  it("runs a recorded command with the environment's values", async () => {
    const home = mkdtempSync(join(tmpdir(), "yagura-evenv-"));
    const boot = { home, skillsDir: "", bind: "", port: 0, tokenFile: "" };
    const db = openStore(layout(boot).db);
    const checkout = mkdtempSync(join(tmpdir(), "yagura-evenv-checkout-"));
    writeFileSync(join(checkout, "f.txt"), "x");
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "."],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    ])
      execFileSync("git", args, { cwd: checkout });
    addEnvironment(db, { id: "e", name: "e", provider: "local-process", capacity: 1 });
    setValue(db, "e" as EnvironmentId, { name: "NEXUS_URL", value: "file:///maven" });
    addRepo(db, { id: "r", url: "/r", defaultBranch: "main" });
    addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", repos: ["r" as RepoId], environmentId: "e" as EnvironmentId });
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "r" as RepoId,
      goal: "g",
      acceptance: [],
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    const attempt = createAttempt(db, unit.id, "claude", null);
    updateAttempt(db, attempt.id, { role: "worker", worktreePath: checkout });
    const run = await runEvidence(db, boot, { attemptId: attempt.id, at: "head", command: 'printf %s "$NEXUS_URL"' });
    expect(readArtifact(db, boot, run.stdoutArtifactId!).toString()).toBe("file:///maven");
    db.close();
  });
});
