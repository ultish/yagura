<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="yagura-dark.png" />
    <img src="yagura-light.png" alt="yagura 櫓" width="120" />
  </picture>
</p>

# yagura 櫓

Agent orchestration for long-running engineering projects. A deterministic daemon plans work into units, runs coding agents (`claude -p` and others) on them in isolated git worktrees, has a fresh judge check each unit against evidence it captures itself, and merges only what is approved.

It runs on one machine, one daemon per developer, with no cloud services. The target is a developer's own RHEL 9 VM in an air-gapped network. A web dashboard shows everything.

## How it works

- **The daemon owns the truth; agents propose.** Scheduling, state changes, recorded runs, merging, and publishing are plain code. Agents plan, build, and judge, and each call starts fresh with a bounded brief. No agent holds a long conversation.
- **A project is a goal.** The project lead (the planner) splits it into units. A unit is a goal with acceptance criteria, in one repo, with the units it comes after. It never lists files to touch. Units that do not depend on each other run in parallel.
- **The builder proves its work; a fresh judge decides.** A worker runs its tests through `yagura evidence run`, which the daemon executes and records itself, so a claim of "tests pass" cannot be forged. A judge with no shared context runs the tests again, reads the change, and approves, asks for changes, or asks a question.
- **One pull request per unit.** It opens as a draft, takes every commit, and comes out of draft the moment the judge approves. Yagura merges that exact commit with a merge commit once CI passes (and, under `merge: human`, once you say so), keeps the branch current with its base, and closes the issues the unit answers.
- **Stuck units have a unit lead.** Woken only when the unit needs a decision (a stuck worker, a judge's question, a comment on the pull request, failing CI, a conflict), it decides whether to retry, answer, split, drop, or ask you.
- **Environments hold how things run.** You describe tests, publishing, and deployment in plain words and add values like `NEXUS_URL`. A doctor agent turns that into commands (actions), proves them, and keeps them current; agents and yagura run them.
- **Multi-repo work is supported.** A library and its consumer can be separate repos. After the library merges, yagura publishes a test build under a version no release can be confused with, and the consumer's worker pins exactly that version. Yagura never releases or deletes anything.

The full spec is [`docs/DESIGN.md`](docs/DESIGN.md). Where the build stands, with the handoff for the next session, is [`docs/STATUS.md`](docs/STATUS.md).

## Requirements

- **Node 26.** `.nvmrc` pins it. The database module, `better-sqlite3` 13, needs Node 22 or newer and segfaults on Node 23.5. After switching Node, run `pnpm install` or `pnpm rebuild better-sqlite3`.
- **pnpm 11.**
- **git 2.38 or newer** (RHEL 9 ships 2.39).
- **A harness CLI**, `claude` by default, logged in. Agents load your whole harness: plugins, skills, hooks. Yagura assumes the [pstack](https://github.com/ultish/pstack-claude) plugin is installed and set up in the harness.
- `gh` or `glab` for pull or merge requests.

## Quick start

```sh
pnpm install
pnpm -r build
pnpm -r test
```

`yagura daemon` starts the engine, the API, and the dashboard on one port. Runtime state lives in `~/.yagura`, or wherever `YAGURA_HOME` points, and never in the repo. Every `yagura` command opens that home's database and migrates it, so set a scratch home before you try anything:

```sh
export YAGURA_HOME=$(mktemp -d)
yagura set role.worker.model '"claude-haiku-4-5-20251001"'
yagura repo add <git URL> --id <id>
yagura env add local --provider local-process
yagura daemon
```

For development, `pnpm dev` rebuilds on change, restarts the daemon, and runs Vite with hot reload on `:5173`. Its home is `~/.yagura-dev`.

### Trying it without spending money

Point `harness.claude.bin` at a wrapper around `packages/core/src/harness/fixtures/fake-agent.mjs` with `FAKE_MODE=engine`. The fake agent emits real Claude stream-json, so the whole pipeline runs for free. Add `FAKE_DELAY_MS` to watch it work.

### A real run

The core loop was proven on 2026-10-15 with Claude Haiku 5.5 on every role, real GitHub, and real Gradle: a library repo and an app repo, one issue, two units. The library unit added a function and merged; yagura published its test build; the app unit pinned that exact build, printed the result, and merged; the issue closed and the project closed itself, in about nine minutes for $0.11. Set `role.<role>.model` for each role, `project.budget_usd`, register both repos with `yagura repo add`, describe the environment with `yagura env answer`, and start the daemon under `caffeinate -is` on a Mac that must not sleep.

## Layout

| Path             | What it holds                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`  | Domain types, SQLite schema and store, config, git, briefs and hand-offs, harness adapters, runner, judge, unit lead, merge, engine. Everything testable lives here. |
| `apps/daemon`    | The engine, a Hono API with server-sent events, and the static dashboard.                                                                                            |
| `apps/cli`       | The `yagura` command line, which talks to the daemon.                                                                                                                |
| `apps/web`       | The dashboard (Vite and React). Pure logic is in `src/lib`, pages in `src/pages`, the tower and beacon drawings in `src/scene`.                                      |
| `plugins/yagura` | Role skills loaded into every agent session: worker, judge, unit lead, planner, doctor, watchman.                                                                    |
| `docs`           | `DESIGN.md` (the spec), `STATUS.md` (current state), `STATUS-ARCHIVE.md` (history).                                                                                  |

## Development

```sh
pnpm -r build        # core copies schema.sql into dist
pnpm -r test         # real SQLite, real git repos in temp dirs, a fake agent
pnpm -r typecheck
pnpm format          # Prettier; format:check verifies
```

Tests run against real SQLite and real git. The runner is tested with the fake agent. A change to a harness parser needs a captured real transcript as a fixture, scrubbed of personal paths and emails. Unit state changes go through `transitionUnit` only, and the TypeScript enum lists in `domain.ts` must match the SQL `CHECK` lists in `schema.sql`. [`CLAUDE.md`](CLAUDE.md) has the rest of the conventions.

## Status

The core loop (goals, one pull request per unit, a fresh judge, recorded runs, a unit lead, merge commits, published test builds, environment actions and the doctor) is built and proven with real agents on real GitHub, and the publish path on the developer's own Nexus. Still unproven: a container-image round, GitLab on the new loop, and the air-gapped VM itself. See [`docs/STATUS.md`](docs/STATUS.md).
