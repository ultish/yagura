import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionAgentCli } from "./action-cli.js";
import { listActions, saveAction } from "./actions.js";
import { attemptRecorder } from "./agent.js";
import type { EnvironmentId, ProjectId, RepoId } from "./domain.js";
import { commitAll, git } from "./git.js";
import { layout } from "./paths.js";
import { addEnvironment, addProject, addRepo, addUnit, createAttempt, openStore, setProjectEnvironment, updateAttempt } from "./store.js";

describe("yagura action propose and broken, from an agent's session", () => {
  it("keeps a proposed command only when yagura's own run passes, and marks a saved one broken when the agent reports it", async () => {
    const root = mkdtempSync(join(tmpdir(), "yagura-actioncli-"));
    const seed = join(root, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "build.gradle"), "plugins {}\n");
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, "init", { name: "t", email: "t@t" });
    const origin = join(root, "lib.git");
    await git(["clone", "--quiet", "--bare", seed, origin]);
    const home = join(root, "home");
    const db = openStore(layout({ home, packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" }).db);
    addRepo(db, { id: "lib", url: origin, defaultBranch: "main" });
    addEnvironment(db, { id: "dev", name: "dev", provider: "local-process", capacity: 1 });
    addProject(db, { id: "p", name: "p", goal: "g", predicate: "x", repos: ["lib" as RepoId] });
    setProjectEnvironment(db, "p" as ProjectId, "dev" as EnvironmentId);
    const unit = addUnit(db, {
      projectId: "p" as ProjectId,
      type: "work",
      repoId: "lib" as RepoId,
      goal: "g",
      acceptance: ["a"],
      timeboxSeconds: 60,
      maxAttempts: 1,
    });
    const attempt = createAttempt(db, unit.id, "claude", null);
    updateAttempt(db, attempt.id, { role: "worker" });
    const { YAGURA_EVIDENCE_TOKEN: token } = attemptRecorder(db, { attempt, unit, projectId: "p" as ProjectId, role: "worker" }).env;
    saveAction(db, { environmentId: "dev" as EnvironmentId, repoId: null, name: "build-image", use: "Builds the image.", command: "gradle jib" });
    db.close();
    const cli = (argv: string[]) =>
      actionAgentCli(argv, { ...process.env, YAGURA_HOME: home, YAGURA_ATTEMPT: String(attempt.id), YAGURA_EVIDENCE_TOKEN: token });

    const failing = await cli(["propose", "--name", "lint", "--use", "Checks the style.", "--", "test", "-f", "missing.cfg"]);
    expect(failing.code).toBe(1);
    expect(failing.output).toMatch(/^yagura ran it on a clean checkout of lib@[0-9a-f]{10}: exit 1\. Nothing was saved\.\n/);

    expect(await cli(["propose", "--name", "has-gradle", "--use", "Checks this is a Gradle build.", "--", "test", "-f", "build.gradle"])).toMatchObject({
      code: 0,
      output: expect.stringMatching(/^has-gradle saved and proven by yagura's run on lib@[0-9a-f]{10}\n$/),
    });
    expect(await cli(["broken", "--name", "build-image", "--reason", "jib: unauthorized at localhost:8802"])).toEqual({
      code: 0,
      output: "build-image marked broken; the doctor looks at it next\n",
    });

    const after = openStore(layout({ home, packsDir: "", skillsDir: "", bind: "", port: 0, tokenFile: "" }).db);
    expect(listActions(after, "dev" as EnvironmentId).map((a) => [a.name, a.repoId, a.state, a.author, a.reason])).toEqual([
      ["build-image", null, "broken", "you", "jib: unauthorized at localhost:8802"],
      ["has-gradle", "lib", "proven", "agent", null],
    ]);
  });
});
