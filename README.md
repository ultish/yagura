<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="yagura-dark.png" />
    <img src="yagura-light.png" alt="yagura 櫓" width="120" />
  </picture>
</p>

# yagura 櫓

Agent orchestration for long-running engineering projects. A deterministic daemon plans work into units, runs coding agents (`claude -p` and others) on them in isolated git worktrees, checks their output with evidence it captures itself, and lands only what is proven.

It runs on one machine, one daemon per developer, with no cloud services. The target is a developer's own RHEL 9 VM in an air-gapped network. A web dashboard shows everything.

## How it works

- **The daemon owns the truth; agents propose.** Scheduling, state changes, environment leases, verdicts, and landing are plain code. Agents plan, write, review, and judge evidence, and each call starts fresh with a bounded brief. No agent holds a long conversation.
- **A project is a goal.** The project lead (the planner) splits it into units, each with a scope, acceptance criteria, and a verify command. Units that do not touch the same files run in parallel.
- **Proof, not narration.** A worker's claim is not evidence. A different agent, the verifier, runs the unit's checks against the worker's head and trunk. Yagura records the output itself, and a unit counts as verified only at the commit it checked.
- **Landing goes through the forge.** On GitHub or GitLab, each unit becomes one pull or merge request. Under `merge: human`, you answer a Merge gate. Yagura merges the exact commit it verified, or sees you merge it yourself.
- **Review comments are handled.** Comments on a PR go to an arbiter, which rules fix, dismiss, or ask you. A worker makes any fix it rules necessary. A comment that would change what the unit must do becomes an amendment, which applies only when you approve it.
- **Stuck units have a unit lead.** After repeated failures it decides whether to retry, split, investigate, or ask you.
- **Multi-repo work is supported.** A library and its consumer can be separate repos. The consumer is verified against the library's test build (npm and Maven snapshots) and lands pinned to it. Yagura never releases or deletes anything.

The full spec is [`docs/DESIGN.md`](docs/DESIGN.md). Where the build stands, with the handoff for the next session, is [`docs/STATUS.md`](docs/STATUS.md).

## Requirements

- **Node 26.** `.nvmrc` pins it. The database module, `better-sqlite3` 13, needs Node 22 or newer and segfaults on Node 23.5. After switching Node, run `pnpm install` or `pnpm rebuild better-sqlite3`.
- **pnpm 11.**
- **git 2.38 or newer** (RHEL 9 ships 2.39).
- **A harness CLI**, `claude` by default, logged in. Agents load your whole harness: plugins, skills, hooks. Yagura assumes the [pstack](https://github.com/ultish/pstack-claude) plugin is installed and set up in the harness.
- `gh` or `glab` for landing through pull or merge requests.

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

### End-to-end demo

`scripts/demo-publish-npm.sh` sets up a library and an app in two repos, publishes test builds to your own Nexus, and lands through pull requests on two scratch GitHub repos:

```sh
NEXUS_USER=admin NEXUS_PASSWORD=... scripts/demo-publish-npm.sh up      # fake agents
GITHUB=1 REAL=1 NEXUS_USER=... NEXUS_PASSWORD=... scripts/demo-publish-npm.sh up   # real Haiku agents, a few dollars
scripts/demo-publish-npm.sh status
scripts/demo-publish-npm.sh down
```

`scripts/demo-publish.sh` is the Gradle and Reposilite version.

## Layout

| Path             | What it holds                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`  | Domain types, SQLite schema and store, config, git, scope checks, briefs and handoffs, harness adapters, runner, engine. Everything testable lives here. |
| `apps/daemon`    | The engine, a Hono API with server-sent events, and the static dashboard.                                                                                |
| `apps/cli`       | The `yagura` command line, which talks to the daemon.                                                                                                    |
| `apps/web`       | The dashboard (Vite and React). Pure logic is in `src/lib`, pages in `src/pages`, the tower and beacon drawings in `src/scene`.                          |
| `plugins/yagura` | Role skills loaded into every agent session: worker, verifier, reviewer, arbiter, planner, unit lead, and others.                                        |
| `docs`           | `DESIGN.md` (the spec), `STATUS.md` (current state), `STATUS-ARCHIVE.md` (history).                                                                      |

## Development

```sh
pnpm -r build        # core copies schema.sql into dist
pnpm -r test         # real SQLite, real git repos in temp dirs, a fake agent
pnpm -r typecheck
pnpm format          # Prettier; format:check verifies
```

Tests run against real SQLite and real git. The runner is tested with the fake agent. A change to a harness parser needs a captured real transcript as a fixture, scrubbed of personal paths and emails. Unit state changes go through `transitionUnit` only, and the TypeScript enum lists in `domain.ts` must match the SQL `CHECK` lists in `schema.sql`. [`CLAUDE.md`](CLAUDE.md) has the rest of the conventions.

## Status

Built through the planning, verification, forge landing (GitHub and GitLab), review, and publishing phases, and proven with real agents on a local GitLab, GitHub, and Nexus. Still unproven: a container-image round, a Maven snapshots round, and the air-gapped VM itself. See [`docs/STATUS.md`](docs/STATUS.md) for the list.
