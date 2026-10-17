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
scripts/setup.sh
```

This checks Node, pnpm and git, runs `pnpm install` and the build, links `yagura` into `~/.local/bin`, adds one marked block to your `~/.zshrc` or `~/.bashrc` that puts that directory on your PATH, and reports whether `claude`, `gh` and `glab` are installed and logged in. Run it again any time; `--no-rc` leaves your rc files alone and prints the line instead, `--bin <dir>` changes where the link goes, and `--uninstall` removes the link and the block (it never touches `~/.yagura`). To build by hand instead: `pnpm install && pnpm -r build && pnpm -r test`, then link `apps/cli/dist/main.js` yourself.

Runtime state lives in `~/.yagura`, or wherever `YAGURA_HOME` points, and never in the repo. Every `yagura` command opens that home's database and migrates it, so set a scratch home before you try anything. Never run a command without one while experimenting.

### Your first project

Start the daemon first. It is the one step that needs a terminal; everything after it can be done in the dashboard at `http://127.0.0.1:7300`.

```sh
export YAGURA_HOME=$(mktemp -d)      # drop this line for your real home
yagura daemon                        # engine, API, and dashboard on one port
```

**In the dashboard**

1. **Repos**: paste the git URL, optionally pick how it lands (pull requests with `gh`, merge requests with `glab`, or a push to the default branch), and press Add repo.
2. **Environments**: add one (provider `local-process` to start). Open it, and on the Answers tab describe in your own words how tests run and how publishing works, then press Save and run the doctor. On the Values tab add values such as `NEXUS_URL`. The Actions tab shows what the doctor proved.
3. **Projects → New project**: fill in the goal and how anyone can tell it is done, tick one or more registered repos (or add one on the spot), pick the environment, and choose whether you approve each merge (the default) or merge when CI passes. Or use **Talk**: describe the goal to the watchman and press Go on its proposal.
4. **Projects**, **Gates**, and **Agents**: watch it run, answer the questions it asks you, steer or stop a running agent, retry or cancel a unit, and pull the andon cord. **Settings** holds models, budget, and the GitLab hosts.

**The same from the CLI**, in another terminal with the same `YAGURA_HOME`:

```sh
yagura repo add <git URL> --id app   # github.com goes through pull requests; see below for GitLab
yagura env add local --provider local-process
yagura env answer local tests --text "run the tests with gradle test"
yagura env answer local publish --text "snapshots go to our Nexus; never release"
yagura env value set local NEXUS_URL http://nexus.internal:8081
yagura env doctor local              # a doctor agent turns your answers into proven actions
yagura env actions local             # check that `test` (and the publish actions) are proven
yagura project new demo --goal "<what you want done>" --predicate "<how anyone can tell it is done>" --repo app --env local
yagura show demo
```

Questions for you show up as gates (`yagura gates`) or on the Gates page.

What only the CLI does: install the binary, start the daemon, and log in (`claude`, `gh`, `glab`). Changing a project's merge mode or environment later (`yagura project set`), checking its skills (`yagura project skills`), and putting a stuck unit back or dropping it (`yagura unit requeue|drop`) have no dashboard control yet.

Models default to the harness default. To pick them per role and cap spend: `yagura set role.worker.model '"claude-haiku-4-5-20251001"'` (same for `judge`, `lead`, `planner`, `doctor`) and `yagura set project.budget_usd 5 --scope project --id demo`.

### Setting it up on a work VM

- **Install without internet.** `scripts/setup.sh` runs `pnpm install`, which needs a registry; run it with `--no-build` after building elsewhere. Point pnpm at your internal mirror, or copy a populated pnpm store to the VM. `better-sqlite3` builds natively, so the VM needs `gcc`, `make` and Python; after any Node switch run `pnpm rebuild better-sqlite3`.
- **Harness.** Install and log in `claude` on the VM, with your plugins and skills, including pstack. Yagura starts `claude` as a program, not through your shell, so a `claude` that is a function or alias in your rc file is invisible to it. `scripts/setup.sh` detects that and writes `~/.local/bin/yagura-claude`, a wrapper that runs your function in an interactive shell; set `harness.claude.bin` to it (Settings, or `yagura set`). If your rc file prints anything at startup, it mixes into the agent's output, so copy what the function does (env vars, proxy, the real binary) into the wrapper instead. `yagura project skills <id>` checks a project's required skills are installed where agents run.
- **Internal GitLab.** Log in with `glab auth login --hostname <host>`, then add the host to `forge.glab_hosts` (Settings, or `yagura set forge.glab_hosts '["<host>"]'`). A repo from that host registers through merge requests with `yagura repo add <url> --id <id>`; any other remote needs `--forge gh|glab` or `--land push`. If the repo path on the forge differs from the URL, `yagura repo set <id>` and `yagura set forge.repo '"group/name"' --scope repo --id <id>`.
- **Reaching the dashboard from another machine.** The daemon binds to localhost on port 7300. For access from a Windows host, start it with `YAGURA_BIND=<vm-hostname>` (or `0.0.0.0`) and `YAGURA_PORT`, and open that port in the VM firewall. Beyond localhost the dashboard asks for the token in `$YAGURA_HOME/token` (`YAGURA_TOKEN_FILE` moves it). Browser notifications need HTTPS, or Chrome's `unsafely-treat-insecure-origin-as-secure` flag for that origin.
- **Keep it alive.** Run the daemon under `tmux` or a systemd user service. On a Mac use `caffeinate -is`.

The air-gapped VM setup has not been run end to end yet; treat this list as a checklist, not a proven recipe.

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
