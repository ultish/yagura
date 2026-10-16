# yagura 櫓

Agent orchestration for long-running engineering projects: a deterministic daemon plans work into units, runs harness agents (`claude -p`, …) in isolated worktrees, verifies their output with evidence it captures itself, and lands what is proven. Target: each developer's RHEL9 VM in an air-gapped network.

## Read first

- `docs/DESIGN.md` is the agreed spec. Build to it; if the code needs to diverge, update the design in the same change.
- `docs/STATUS.md` is where the build is: a handoff block, what is left, what was decided not to build, and known limits. Keep it short: when something is finished and no longer needed to act, move it to `docs/STATUS-ARCHIVE.md` (phase checklists, real-run findings, build notes), which is read only for history. Update STATUS whenever a phase or task lands.

## Layout

- `packages/core` — domain types, SQLite schema, store, config, git, scope, brief/handoff, harness adapters, runner. Everything testable lives here.
- `apps/cli` — the `yagura` CLI; `yagura daemon` runs `apps/daemon` (engine + Hono API + SSE), which also serves `apps/web/dist`.
- `apps/web` — the dashboard (Vite + React); pure logic in `src/lib` is unit-tested, pages in `src/pages`, the tower/beacon drawings in `src/scene`.
- `plugins/yagura` — role overlay skills loaded into every agent session via `--plugin-dir` (`yagura-worker`, more per role later).
- Runtime state lives in `~/.yagura` (override with `YAGURA_HOME`), never in the repo.

## Commands

```sh
pnpm install                  # pnpm 11; native builds allowed via allowBuilds in pnpm-workspace.yaml
pnpm -r build                 # core copies schema.sql into dist
pnpm -r test                  # vitest; real SQLite, real git, fake agent
pnpm -r typecheck
pnpm format                   # prettier (.prettierrc.json); format:check verifies; a project hook formats every file Claude edits
node apps/cli/dist/main.js    # the CLI (chmod +x dist/main.js after a build if needed)
pnpm dev                      # dev mode: rebuilds core/daemon/cli on change, restarts the daemon, Vite with hot reload on :5173; home ~/.yagura-dev unless YAGURA_HOME is set
```

## Conventions

- Verify for real, not by reading code: tests hit real SQLite and real git repos in temp dirs; the runner is tested with `packages/core/src/harness/fixtures/fake-agent.mjs`, which emits real Claude stream-json. Changes to a harness parser need a captured real transcript as a fixture, scrubbed of personal paths and emails.
- TS enum lists in `domain.ts` and SQL `CHECK` lists in `schema.sql` must match; `schema.test.ts` enforces it.
- Unit state changes go through `transitionUnit` only (it checks `UNIT_TRANSITIONS` and writes an event).
- No narrative comments; comment only a non-obvious why.
- Formatting is Prettier's job (`.claude/settings.json` runs it after each edit); never align or wrap by hand.
- Commits: Conventional Commits, author Jimmy <ultish@gmail.com>, no attribution trailers. Push to `origin main` (github.com/ultish/yagura).
- UI work: discuss subjective design choices with the user and prototype options before building. Colors only through the CSS variables in `apps/web/src/theme.css` (amber = alive, vermilion = needs you, pine = merged).
- To try the whole system without spending money, point `harness.claude.bin` at a wrapper that runs `packages/core/src/harness/fixtures/fake-agent.mjs` with `FAKE_MODE=engine` (and `FAKE_DELAY_MS` to watch it) in a scratch `YAGURA_HOME`.

## Related repos

- `~/Developer/pstack-claude` — the user's Claude Code port of pstack (plugins `pstack` and `cursor-team-kit`); yagura assumes it is installed and set up in the harness.
- `~/Developer/kuru-testbed` — small Python repo used for end-to-end proofs (`yagura` project `discounts`).
- `~/Developer/kurukuru` — the predecessor; lessons only, no code reuse.
