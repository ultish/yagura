import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  actionsFor,
  adoptProposal,
  answerLines,
  answerSuggestion,
  deleteAction,
  getAction,
  listActions,
  recordActionRun,
  reportBroken,
  saveAction,
  setAnswers,
} from "./actions.js";
import type { AttemptId, EnvironmentId, RepoId, Sha } from "./domain.js";
import { addEnvironment, addRepo, getEnvironment, openStore, type Db } from "./store.js";

let db: Db;
const env = "dev" as EnvironmentId;
const lib = "lib" as RepoId;
const app = "app" as RepoId;
const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" as Sha;
const agent = null as unknown as AttemptId;

beforeEach(() => {
  db = openStore(join(mkdtempSync(join(tmpdir(), "yagura-actions-")), "y.db"));
  addEnvironment(db, { id: env, name: "dev", provider: "local-process", capacity: 1 });
  addRepo(db, { id: lib, url: "file:///lib", defaultBranch: "main" });
  addRepo(db, { id: app, url: "file:///app", defaultBranch: "main" });
});

const run = (actionId: number | null, command: string, exitCode: number, output = "") =>
  recordActionRun(db, { actionId, environmentId: env, repoId: lib, sha, command, exitCode, timedOut: false, durationMs: 5, output, by: "you" });

describe("the environment's answers", () => {
  it("keeps each answer in the developer's words and shows the answered ones as brief lines", () => {
    setAnswers(db, env, { publish: "maven publish to nexus at localhost:8801; use gradle, not gradlew" });
    setAnswers(db, env, { tests: " gradle test " });
    expect(getEnvironment(db, env).answers).toEqual({
      tests: "gradle test",
      publish: "maven publish to nexus at localhost:8801; use gradle, not gradlew",
      images: "",
      run: "",
      never: "",
      other: "",
    });
    expect(answerLines(getEnvironment(db, env).answers)).toEqual([
      "How are tests run? gradle test",
      "How are libraries published, and where to? maven publish to nexus at localhost:8801; use gradle, not gradlew",
    ]);
    expect(() => setAnswers(db, env, { deploy: "x" } as never)).toThrow('no question "deploy"');
  });
});

describe("actions", () => {
  it("is unproven when you write it, proven by a passing run, edited when you change its command, broken by a failing run", () => {
    const test = saveAction(db, { environmentId: env, repoId: null, name: "test", use: "Runs the whole suite.", command: "gradle test" });
    expect([test.state, test.author]).toEqual(["unproven", "you"]);
    run(test.id, "gradle test", 0);
    expect(getAction(db, test.id).state).toBe("proven");
    expect(saveAction(db, { ...test, use: "Runs every test in the repo." }).state).toBe("proven");
    expect(saveAction(db, { ...test, use: "Runs every test in the repo.", command: "gradle test --offline" }).state).toBe("edited");
    run(test.id, "gradle test --offline", 1, "compiling\nCould not resolve com.acme:lib:1.5.0\n");
    expect(getAction(db, test.id)).toMatchObject({ state: "broken", reason: "exit 1 on a1b2c3d: Could not resolve com.acme:lib:1.5.0" });
  });

  it("gives a repo its own actions and the environment-wide ones it does not override by name", () => {
    saveAction(db, { environmentId: env, repoId: null, name: "test", use: "Runs the suite.", command: "gradle test" });
    saveAction(db, { environmentId: env, repoId: app, name: "test", use: "Runs the web tests.", command: "npm test" });
    saveAction(db, { environmentId: env, repoId: lib, name: "publish-snapshot", use: "Publishes the library.", command: "gradle publish" });
    expect(actionsFor(db, env, app).map((a) => [a.name, a.command])).toEqual([["test", "npm test"]]);
    expect(actionsFor(db, env, lib).map((a) => [a.name, a.command])).toEqual([
      ["publish-snapshot", "gradle publish"],
      ["test", "gradle test"],
    ]);
  });

  it("saves a doctor's proposal only on a passing run, and never overwrites yours: it suggests beside it instead", () => {
    expect(() =>
      adoptProposal(db, {
        environmentId: env,
        repoId: lib,
        name: "version",
        use: "Prints the version.",
        author: "doctor",
        attemptId: agent,
        run: run(null, "cat VERSION", 1),
      }),
    ).toThrow("the run did not pass (exit 1 on a1b2c3d); nothing was saved");
    const doctor = adoptProposal(db, {
      environmentId: env,
      repoId: lib,
      name: "version",
      use: "Prints the version.",
      author: "doctor",
      attemptId: agent,
      run: run(null, "sed -n 's/^version=//p' gradle.properties", 0),
    });
    expect([doctor.action.state, doctor.action.author, doctor.suggested]).toEqual(["proven", "doctor", false]);

    const mine = saveAction(db, { environmentId: env, repoId: lib, name: "publish-snapshot", use: "Publishes it.", command: "gradle publish" });
    const proposal = adoptProposal(db, {
      environmentId: env,
      repoId: lib,
      name: "publish-snapshot",
      use: "needs the version passed in",
      author: "doctor",
      attemptId: agent,
      run: run(null, "gradle publish -Pversion=$YAGURA_VERSION", 0),
    });
    expect(proposal.suggested).toBe(true);
    expect(getAction(db, mine.id)).toMatchObject({
      command: "gradle publish",
      suggestion: { command: "gradle publish -Pversion=$YAGURA_VERSION", why: "needs the version passed in" },
    });
    expect(answerSuggestion(db, mine.id, true)).toMatchObject({ command: "gradle publish -Pversion=$YAGURA_VERSION", state: "edited", suggestion: null });
  });

  it("is broken when an agent reports it, until a run passes, and can be deleted", () => {
    const a = saveAction(db, { environmentId: env, repoId: null, name: "build-image", use: "Builds the image.", command: "gradle jib" });
    expect(reportBroken(db, a.id, "jib: unauthorized at localhost:8802", agent)).toMatchObject({
      state: "broken",
      reason: "jib: unauthorized at localhost:8802",
    });
    run(a.id, "gradle jib", 0);
    expect(getAction(db, a.id)).toMatchObject({ state: "proven", reason: null });
    deleteAction(db, a.id);
    expect(listActions(db, env)).toEqual([]);
  });

  it("refuses a name that is not lower-case words, an empty use, or an empty command", () => {
    const base = { environmentId: env, repoId: null, name: "test", use: "Runs it.", command: "gradle test" };
    expect(() => saveAction(db, { ...base, name: "Run Tests" })).toThrow('action name "Run Tests" must be lower case letters, digits and dashes');
    expect(() => saveAction(db, { ...base, use: " " })).toThrow("say when to use the action");
    expect(() => saveAction(db, { ...base, command: "" })).toThrow("the action needs a command");
  });
});
