# yagura 櫓

Agent orchestration for long-running engineering projects: a deterministic daemon plans work into units, runs harness agents (`claude -p`, …) in isolated worktrees, verifies their output with evidence it captures itself, and lands what is proven. Target: each developer's RHEL9 VM in an air-gapped network.

## Read first

- `docs/DESIGN.md` is the agreed spec. Build to it; if the code needs to diverge, update the design in the same change.
- `docs/STATUS.md` is where the build is: finished phases, the next phase's task list, open decisions, and known gaps. Update it whenever a phase or task lands.

## Layout

- `packages/core` — domain types, SQLite schema, store, config, git, scope, brief/handoff, harness adapters, runner. Everything testable lives here.
- `apps/cli` — the `yagura` CLI (in-process for now; the daemon/API arrives with the dashboard phase).
- `plugins/yagura` — role overlay skills loaded into every agent session via `--plugin-dir` (`yagura-worker`, more per role later).
- Runtime state lives in `~/.yagura` (override with `YAGURA_HOME`), never in the repo.

## Commands

```sh
pnpm install                  # pnpm 11; native builds allowed via allowBuilds in pnpm-workspace.yaml
pnpm -r build                 # core copies schema.sql into dist
pnpm -r test                  # vitest; real SQLite, real git, fake agent
pnpm -r typecheck
node apps/cli/dist/main.js    # the CLI (chmod +x dist/main.js after a build if needed)
```

## Conventions

- Verify for real, not by reading code: tests hit real SQLite and real git repos in temp dirs; the runner is tested with `packages/core/src/harness/fixtures/fake-agent.mjs`, which emits real Claude stream-json. Changes to a harness parser need a captured real transcript as a fixture, scrubbed of personal paths and emails.
- TS enum lists in `domain.ts` and SQL `CHECK` lists in `schema.sql` must match; `schema.test.ts` enforces it.
- Unit state changes go through `transitionUnit` only (it checks `UNIT_TRANSITIONS` and writes an event).
- No narrative comments; comment only a non-obvious why.
- Commits: Conventional Commits, author Jimmy <ultish@gmail.com>, no attribution trailers. Push to `origin main` (github.com/ultish/yagura).
- UI work: discuss subjective design choices with the user and prototype options before building.

## Related repos

- `~/Developer/pstack-claude` — the user's Claude Code port of pstack (plugins `pstack` and `cursor-team-kit`); yagura assumes it is installed and set up in the harness.
- `~/Developer/kuru-testbed` — small Python repo used for end-to-end proofs (`yagura` project `discounts`).
- `~/Developer/kurukuru` — the predecessor; lessons only, no code reuse.
