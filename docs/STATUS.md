# yagura build status

Updated 2026-09-26 (phase 2 done). Phases are from `DESIGN.md` §19.

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

## Phase 2 — Verification: done

- Migrations (`migrations.ts`, schema v2): `evidence_runs`, attempt skills, unit notes, and a fixed lease CHECK (only active leases need a slot).
- Verify pack contract (`pack.ts`): `verify.json` with provider, checks (command + tier), features, protected globs. Always read from trunk, never from the change being judged.
- Leases (`leases.ts`): capacity-bound slots with a queue, `local-process` provider (private dir + free port), release, and a reaper for leases whose attempt ended.
- Evidence (`evidence.ts`, `evidence-cli.ts`): yagura runs each command in a clean checkout of base or head inside the lease, restores the checkout, flags tampering, and stores stdout/stderr/`$YAGURA_EVIDENCE` files as content-addressed artifacts. Agents call it as `yagura evidence run --at base|head --label <l> -- <cmd>` through a shim yagura writes to `~/.yagura/bin` and puts on the agent's PATH.
- Verdicts (`verdict.ts`, pure and unit-tested): only cited, recorded, untampered runs count; a scenario must fail on trunk and pass on head (match, for refactors); tiers are capped at what pack checks prove; only a code fault rejects the work; invalid or env-blocked verdicts queue a fresh verify unit, up to `verify.max_retries`.
- Verify runner (`verify.ts`) with the `yagura-verifier` overlay; work handoffs queue a verify unit automatically.
- METHOD compliance: each attempt records the skills it loaded and the required ones it skipped (`attempt.method_miss` event).
- Landing, forge `none` (`land.ts`): one lander per repo, fast-forward or rebase, patch-id rule carries the verdict, blocks on conflict or a changed patch, pushes the default branch.
- CLI: `env add`, `project set --env`, `repo set --url`, `unit reject|requeue --note`, `verify`, `land`, `evidence run`; `show` lists runs, skipped skills, and verdicts.

Proof: `discounts`/U1 on a bare test origin (`~/.yagura/test-origins/kuru-testbed.git`, with a verify pack on trunk; the user's working copy is untouched). A real verifier ($0.30, Opus 5.5) wrote four scenarios, ran each on base and head through yagura (10 runs), and U1 was verified at `unit-verified`: every scenario fails on trunk and passes on head, and the unit check passes on both. Landing rebased U1 onto the moved trunk, confirmed the patch-id was unchanged, carried the verdict to `b28d025`, and pushed; a fresh clone of trunk passes its tests.

Found and fixed during the proof: the verifier's shell (zsh) did not word-split `$YAGURA_CLI`, so yagura now installs a real `yagura` executable on the agent's PATH; a `repo set --url` did not reach the cached mirror; a verification retry had no verify unit to run.

## Phase 3 — Planning + parallelism: next

From DESIGN §8, §9: planner drains that return a plan delta (schema-validated), scope-overlap serialization, `git merge-tree` check after work, a rolling window of attempts up to the concurrency caps, retries by failure mode, and andon. This is also where yagura gets a long-running process that drives units on its own instead of one CLI command per step.

## Known gaps

- A rebase that changes the patch blocks the unit; re-verifying a rebased head arrives with the babysit units (phase 5).
- Landing does not yet void dependents' verdicts; dependencies between units arrive in phase 3.
- Pack `doctor`/`deploy`/`teardown` are parsed but not run; deployed verification comes with the `kube-namespace` provider (phase 5).
- METHOD compliance is recorded and shown, not enforced; the planner (phase 3) should act on it. U1's worker attempt 2 skipped `pstack:poteto-mode`.
- `yagura evidence run` trusts `YAGURA_ATTEMPT` plus the attempt being in `running`; a per-attempt token arrives with the daemon API.
- The CLI runs in-process; there is no daemon, API, or scheduler loop yet (phases 3–4).
- The user's SessionStart hook (codebase-memory-mcp indexing) runs in every agent session; suggested fix is to skip when `YAGURA_ATTEMPT` is set. Not yet applied.
