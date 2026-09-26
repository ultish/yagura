# yagura build status

Updated 2026-09-26. Phases are from `DESIGN.md` §19.

## Phase 1 — Core: done

- Schema for the full model (every table in DESIGN §5) with CHECK constraints mirrored by the TS enums; unit state machine as a transition table; tier ranking.
- Store: audited unit transitions, units/attempts/repos/projects CRUD.
- Config: bootstrap (`YAGURA_*` env > `~/.yagura/yagura.yaml` > defaults) and layered settings (global → environment → repo → project) with zod validation and effective-value/source lookup.
- Git: bare mirror with `origin/*` remote refs (unit branches survive fetches), per-attempt worktrees, changed paths, leftover capture.
- Claude adapter: stream-json parser tested against a real captured transcript (`harness/fixtures/claude-basic.jsonl`); records model and plugin versions from the `init` event.
- Brief renderer (refuses unfillable briefs), handoff parser, failure classifier, synthetic failure handoffs.
- Runner (`runWorkUnit`): mirror → worktree → brief → spawn with `YAGURA_*` env → stream log → timebox kill → discard leftovers into a patch → parse handoff → scope check → unit/attempt states.
- CLI: `repo add`, `project new`, `unit add`, `run`, `show`, `logs`, `settings`, `set`.
- `plugins/yagura/skills/yagura-worker`.

Proof: project `discounts`, unit U1 in `~/Developer/kuru-testbed` (implement `apply_discount`). Attempt 1 succeeded ($0.33, Opus 5.5, pstack 0.5.0 loaded, yagura-worker then poteto-mode feature playbook; 7/7 tests pass when re-run independently) and exposed the leftover-commit bug, now fixed. Attempt 1 was rejected for that reason. Attempt 2 on the fixed runner ($0.25): one agent commit touching only `app/orders.py` and `tests/test_orders.py`, clean worktree, 6/6 tests pass when re-run independently. U1 is `handed_off`, waiting for phase 2. Attempt 2 loaded `yagura-worker` but skipped `pstack:poteto-mode` despite METHOD naming it (see phase 2 task 10).

## Phase 2 — Verification: next

Goal: U1 reaches `verified` on evidence the daemon captured, then `landed`, with no forge.

Tasks, in order:

1. **Verify pack contract.** zod schema for `.agents/verify/verify.json` (provider type, `doctor`/`deploy`/`drive`/`teardown` commands, feature list, tier each command can prove, protected globs); loader that reads it from a worktree at a given SHA. Write a pack for kuru-testbed by hand first (unittest-level, `local-process`), then generating packs is phase 5.
2. **`local-process` provider.** Create a slot (free ports, `~/.yagura/leases/<id>/` data dir, `YAGURA_EVIDENCE` dir), connection vars, teardown by killing the process group it started, and a startup reaper for leases whose owner is gone.
3. **Leases.** Acquire against environment capacity (queue when full), release, reap. The `leases` table and its one-active-lease-per-slot index already exist.
4. **Evidence capture.** The daemon runs pack commands as subprocesses inside the lease; stdout/stderr/exit code and files written to `$YAGURA_EVIDENCE` become content-addressed artifacts (`projects/<p>/artifacts/<sha256>` + `artifacts` rows, `source = 'daemon'`).
5. **Verify units.** When a work unit hands off `success` or `partial`, create a `verify` unit targeting it and move the target `handed_off → verifying`. Add `yagura-verifier` overlay. The verifier sees acceptance, the diff, and the verify recipe, not the worker's narrative.
6. **Trunk vs head.** Run the scenario on the base SHA and the head SHA; record `trunk_outcome`/`head_outcome` on the verdict; apply the DESIGN §13 rules (a bug-fix/feature scenario that passes on trunk proves nothing).
7. **Verdicts.** Parse the verifier's tier and evidence ids; reject ids the daemon did not capture for this unit; write `verdicts` + `verdict_artifacts`; apply the DESIGN §13 "Verification outcomes → unit state" table (only a code fault goes to `rejected`).
8. **Landing, forge `none`.** One lander per repo: rebase onto `origin/<default>`, patch-id rule, fast-forward push, `landing → landed`, void dependents' verdicts.
9. **CLI.** `yagura verify <p> <unit#>`, `yagura land <p> <unit#>`, `yagura unit reject|requeue <p> <unit#> --note` (today requeueing needs a node one-liner against the core API).

10. **METHOD compliance.** The log records every `Skill` call. After an attempt, check that the role's required skills (from the pack manifest, e.g. `pstack:poteto-mode` for workers) were loaded; record the result on the attempt and flag misses in the handoff classification. Attempt 2 of U1 skipped poteto-mode, so instructions alone are not enough.

Decide at the start of phase 2 (not settled in DESIGN):

- **How the verifier asks the daemon to run things.** Proposal: a restricted `yagura evidence run --label <l> -- <cmd>` that the verifier calls; it authenticates by `YAGURA_ATTEMPT`, runs inside the verifier's lease, and returns artifact ids. The CLI is in-process until the daemon exists, and SQLite WAL handles the concurrent writer.
- **What "the scenario" is for trunk vs head.** Proposal: the verifier commits a scenario script on its own branch; the daemon runs that script against a worktree at the base SHA and at the head SHA.

Gotcha for landing proofs: `git push` into a non-bare repo's checked-out branch is refused. Land into a bare clone of kuru-testbed (for example `~/.yagura/test-origins/kuru-testbed.git`) and point the repo's URL at it, rather than pushing into the working copy.

## Known gaps

- `git.author_name` / `git.author_email` settings are unused until landing writes commits.
- The runner handles `work` units only; other unit types arrive with their phases.
- The CLI runs in-process; there is no daemon, API, or scheduler loop yet (phases 3–4).
- The user's SessionStart hook (codebase-memory-mcp indexing) runs in every agent session; suggested fix is to skip when `YAGURA_ATTEMPT` is set. Not yet applied.
