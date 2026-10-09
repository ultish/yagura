# Environment answers, actions, and the doctor (draft for the developer)

Status: agreed and built 2026-10-10 (layout B, tabs). Extends `core-loop.md` for CL8.

## Why

Projects use different tools, languages, and build setups, so yagura cannot ship a fixed list of commands, and a command written down once goes stale (kurukuru's frozen pack). The developer knows how their environment works and can say it in plain words. Agents can turn those words into commands and prove them. yagura keeps what was proven, shows it, and lets the developer change it.

yagura also has to publish test builds itself. Units mostly merge into feature branches, and the team's CI publishes only from main, so nothing else builds a library that an app unit can depend on.

## The environment's answers

Each environment holds the developer's answers to a few starter questions, each in plain words, plus one free box:

- How are tests run?
- How are libraries published, and where to?
- How are images built and pushed?
- How is the app run or deployed?
- What must agents never do here?
- Anything else about this environment.

The questions are prompts, not limits. Any answer may be empty. An example answer: "I use jib to create images via its Gradle plugin, wired to maven publish to my Nexus at localhost:8801. Use `gradle publish`, not `./gradlew`."

The answers replace today's single "Notes for agents" box; its text moves into "Anything else". Values (names like `NEXUS_URL`, with their notes and presets) stay as they are.

## Actions

An action is a command an agent or yagura can run, saved with what it is for.

| Field | Meaning |
|---|---|
| name | Short and unique within its scope: `publish-snapshot`, `build-image`, `test-one-file`. |
| use | When to use it, in plain words: "publishes this library to Nexus as a snapshot; run after a change other repos need". |
| command | The shell command, run with the environment's values. It may read inputs such as `$YAGURA_VERSION` or `$TEST_CLASS`, named in its use text. |
| scope | One repo in this environment, or every repo in it. |
| proof | yagura's last run of it: the repo, commit, exit code, output, and time. |
| state | `proven`, `edited` (changed by the developer, not run since), `unproven` (written by the developer, never run), `broken` (its last run failed, with the reason). |
| author | `doctor`, `agent` (with its agent number), or `you`. |

### Who writes them

- **The doctor** proposes actions from the answers and the repo, whatever it finds worth having. Nothing limits the kinds.
- **An agent** that works out a useful command can propose one with `yagura action propose --name … --use … -- <command>`. yagura runs the command itself on the agent's repo and saves the action only when that run passes; a failing run is shown to the agent and nothing is saved.
- **The developer** adds, edits, renames, rewords, and deletes actions on the environment page. An edit is saved at once and marked `edited`; **Run now** proves it as a recorded run.
- The doctor never overwrites an action the developer edited or wrote. When it thinks one is wrong, it attaches a suggested change that the developer accepts or dismisses.

### Who uses them

- Every worker, judge, and unit lead brief lists the actions that apply to its repo: name, use, command, inputs, and state. Agents run one through `yagura evidence run -- <command>`, so the run is recorded and can be cited.
- An action becomes `broken` only when one of yagura's own runs of it fails (Run now, a doctor's check, publishing), or when an agent reports it with `yagura action broken --name … --reason "…"`. A failing test inside a worker's session usually means the code is wrong, not the command, so it changes nothing. A broken action wakes the doctor.

### Proof

Every run that proves or breaks an action is yagura's own, kept in the action's run log: the repo, commit, command, exit code, the tail of its output, and how long it took. yagura runs it in a clean checkout of the repo's base with the environment's values. Agents' recorded runs stay what they are (evidence for the judge); they never prove an action.

### Actions yagura runs itself

A few names carry a contract, because yagura runs them without an agent:

- **`publish-snapshot`**: reads `$YAGURA_VERSION` and publishes the checkout under it. Has a companion **`snapshot-available`**: exits 0 once `$YAGURA_VERSION` can be fetched.
- **`version`**: prints the version the checkout would release (`1.5.0-SNAPSHOT`), from which yagura makes the snapshot version.

Every other action is help for agents only. `test` is not special: the judge and workers read the test action like any other.

## Publishing a test build

1. A unit in a repo that has `publish-snapshot` merges into its base (usually a feature branch).
2. yagura checks out the merge commit, runs `version`, and makes the test version `<version>-yg-<project>-u<seq>-<sha7>` (a version ending in `-SNAPSHOT` keeps it at the end), as decided 2026-10-04.
3. yagura runs `publish-snapshot`, then polls `snapshot-available`, each as a recorded run.
4. A unit whose `after` includes that unit starts only once its test build is available. Its brief names the version, and `$YAGURA_VERSION_<REPO>` carries it.
5. If publishing fails, the waiting unit stays `waiting` with the reason, and the doctor is woken for that repo. A doctor that cannot fix it asks the developer.

Publishing the merged commit means the version never moves under the unit that uses it, so the old re-pinning goes away. yagura never publishes a release and never deletes a test build.

## The doctor

An agent session per repo, per project, in the project's environment.

- **Runs** when a project starts on an environment, when the developer presses **Run doctor**, when a saved action breaks, and when yagura needs a contract action a repo does not have.
- **Reads** the environment's answers and values, the repo, and the actions already saved.
- **Does**, for each thing the answers or the repo call for: works out the command, runs it in a scratch checkout as a recorded run, and proposes the action with that run as its proof. A failing command is reported, not saved.
- **Reports** per action: works (with the command and run), fails (with why), or cannot tell (the environment does not say). The report shows on the environment page and the project page.
- **Asks** the developer, through a gate with a free-text answer, when an answer is missing and yagura needs it (a library repo with no way to publish).
- **Changes** nothing in the repo, and pushes nothing.

## The environment page

Each environment gets its own page, `/e/<id>`, with sections in this order: Answers, Actions, the last doctor report, Values, Settings. The list at `/environments` links to it. A mock is linked from `docs/STATUS.md`.

## What goes away

`repos.publish_json` and the publish block, `needs-source`, read-only source mounts, re-pinning (`moveConsumer`), and the "Verification runs inside a slot" copy on the Environments page.

## Open questions

- Whether the doctor's report also goes to the project page's bell when something fails, or only to the environment page.
- Whether actions saved on one environment should be offered to a new environment as a starting point (a template already does this for values).
