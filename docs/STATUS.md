# yagura build status

Updated 2026-09-27 (phase 4: daemon, watchman, and web UI core done). Phases are from `DESIGN.md` §19.

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

## Phase 3 — Planning + parallelism: done

- Plan deltas (`plan.ts`): strict schema, extracted from the planner's last ```json block, applied atomically (add/amend/retry/cancel/gates/done); `scope-overlap` deps serialize overlapping write scopes; cycles and unknown references reject the whole delta.
- Planner sessions (`planner.ts`, `yagura-planner` overlay): read-only trunk checkouts of every project repo, a status generated from the store (`status.ts`), drains recorded in `drains`; three rejected deltas in a row raise andon.
- Scheduling (`schedule.ts`): readiness from deps, failure policy by mode (retry network/tool/harness/unknown/scope; block timebox/context/oom for the planner to split; block when attempts run out), running-attempt counts for the caps.
- `git merge-tree` check after a clean work handoff; a conflict rejects the attempt with a note and the retry starts from the new trunk.
- Engine (`engine.ts`) and `yagura drive <project>`: settle failures, land (auto, or a `land` gate under `merge: human`), plan on meaningful events, run ready units in a rolling window under the global, per-harness, and per-project caps, close when the planner reports done. CLI also gained `andon`, `gates`, `gate answer`, and `project set --merge`.
- Migration 3: `gates.kind`.

Proof: project `orders` (PRD requirements 2 and 3), `merge: auto`, driven end to end by `yagura drive orders` with no human steps in 1m42s for $0.92: planner (one unit, reasonable since both requirements touch the same two files) → worker → verifier (scenario fails on base, passes on head) → landed `ff105b8` on the test origin → second planner run reported done → project closed. Trunk passes its tests from a fresh clone. Parallel execution and overlap serialization are proven by the engine test with fake agents; the real run had only one unit.

Found and fixed during phase 3: a plan unit briefly in `ready` was picked up as work (the scheduler now only runs work and verify units); plan triggers were keyed to the end of the previous drain, which would miss events during a planner run; `applyDelta` returned pre-transition unit snapshots.

## Watchman: done (DESIGN §8a "As built")

- Thread store (`threads.ts`): threads, messages (FTS kind `message`), decisions with supersede, questions resolved by a message, proposals; enums in `domain.ts`.
- `runAgentSession` takes a `SessionRecorder` (`attemptRecorder` for units; the watchman records to its thread), so a session need not belong to a unit.
- `watchman.ts`: per-turn context assembled under `watchman.context_tokens` in the §8a priority order (`assembleContext` is pure and tested), the watchman brief, `yagura` records block parsed with zod and stored atomically or not at all (`storeTurn`), autonomy `go` applies the proposal at once.
- `proposal.ts`: proposal schema, validation, apply (new local bare repos with a starting verify pack, projects with `after`/`phaseGate`/merge/min tier/environment, initial units via `applyDelta`, `spec.md`, amendments that reopen closed projects).
- `spec.ts`: `spec.md` in `##` sections; edits trigger a plan drain; the planner brief links the spec.
- Engine: activates `framing` projects when their `after` are closed (phase gate `start | hold` first when set); `report.ts` posts done / andon / stuck reports into threads and rings a `report` gate.
- `plugins/yagura/skills/yagura-watchman` (required skill for the watchman role; a miss is recorded, not enforced).
- CLI: `yagura talk [--thread N] [--go] …`, `thread list|show|search|set --autonomy`, `proposal apply|discard`. API: `GET/POST /api/threads`, `GET /api/threads/:id`, `POST /api/threads/:id/messages` (202; the reply arrives as events; 409 while a turn runs), `POST /api/threads/:id/autonomy`, `GET /api/threads/search`, `POST /api/proposals/:id/apply|discard`; `/api/search` returns `messageId` for message hits.
- Tests: context trimming, spec edits, reply parsing, atomic record rejection, propose vs go, a fake watchman's chain proposal driven by the engine through two projects in a new repo to closed with both reports posted, the phase gate, and the thread API.

Proof (real `claude`, Opus 5.5, scratch `YAGURA_HOME`): `yagura talk "Prototype a tiny Python CLI, jsondiff.py … ignore any field whose name ends in _ts …"` → the watchman loaded its skill, recorded 7 decisions (path syntax, exit codes, list and number rules), and proposed a new `jsondiff` repo with a `python3 -m unittest discover -v` pack, `merge: auto`, a spec, and a checkable predicate. `yagura proposal apply 1` created the repo and project; `yagura drive jsondiff` planned one unit, the worker's first attempt was rejected for skipping `pstack:poteto-mode` (existing enforcement), the second succeeded, the verifier proved it at unit-verified, it landed at `153a90b`, the planner reported done, and the engine posted the report into the thread and rang a `report` gate, in about 4 minutes for about $2. A fresh clone passes its 19 tests and the CLI ignores `*_ts` and exits 0/1 as decided. A follow-up turn ("also ignore `seq`; actually match lists by `id`") read the thread's memory and proposed a `jsondiff-keyed` project on the same repo with 4 new decisions, superseding D5 (positional lists) with D9. (An earlier note here said it did not supersede D5; that was a misreading of the CLI output, which does not print supersedes. The skill's explicit supersede rule stays.)

Rejected records retry once automatically (user, 2026-09-26): the watchman gets its reply back with the reason (`renderRetry`, log `<message>.retry.jsonl`, event `watchman.records_rejected`); only a second rejection stores the prose with a system message.

Answered (user, 2026-09-26): the first real spec-driven project runs on this Mac, when the user is ready.

Decided (user, 2026-09-26): phase gates stay off by default (automation first; the developer steps in when they want or when asked); the home scene collapses to a thin strip on scroll; no "New project" form in the UI — conversation is the front door, and the CLI covers the manual path (`project new --after --phase-gate --merge --env`).

@mentions (DESIGN §8a "Mentions", migration 6 `message_refs`): tokens `@project`, `@project/U3`, `@project/U3.2`, `@thread:4`, `@repo:id` are indexed on every message, described in the watchman brief, searchable (`yagura thread mentions`, `GET /api/mentions/:token/messages`), and completed by `GET /api/mentions?q=`. The `@` autocomplete widget and mention links are `apps/web` work.

## Phase 4 — Dashboard: in progress (web UI core done)

Web UI (`apps/web`, DESIGN §17 "As built"), built 2026-09-27 from option F plus round-4 options G1 (talk: threads | conversation | ledger) and H1 (agent: live timeline + facts rail), chosen by the user from real-data mocks on the canvas: The watch, Talk with `@` autocomplete, Project beacons and rows with actions, Agent page, Projects and Agents lists, night and daybreak, collapse-to-strip on scroll. Daemon additions: log line timestamps (`<log>.times`), `/api/bell`, unit retry/cancel, richer summaries and attempt detail, `since=latest` on the event stream, static serving of `apps/web/dist`.

Proof: the daemon served the real `jsondiff` data (scratch home) and every page rendered it, including the real worker log, the verifier's trunk-vs-head grid, and the thread's decisions with D5 struck through. A live run against the repo's fake agent (`harness.claude.bin` pointed at `fake-agent.mjs` with a delay) went end to end in the browser: typed "prototype a chain" on the home page → the watchman's reply and proposal arrived live → Go → proto-a's tower lit (ridge lamp, then two shōji), proto-b stood dark with a signal arc → beacons showed flames, scope-overlap serialization, landings into the keep → the agent page streamed with `+m:ss` times and a live trunk-vs-head grid → proto-b activated after proto-a closed → both reports rang the bell. Found and fixed during the build: effects returning a React 19 setter's value crashed on re-run; the `@` trigger ignored the uppercase `U` in unit tokens; the catch-all static route shadowed the SSE routes.

Next for the UI: **Repos page with "Add an existing repo"** (path or git URL, no project needed) and the matching watchman proposal field `repos[].existing` (DESIGN §17 Repos, §8a; decided 2026-09-27), Gates inbox page (the bell covers it for now), Environments, Settings (with live cap counts), repo browsing (prototype first), "Message the agent" mid-run (needs `--input-format stream-json`), a watchman turn's live log inside the thread, and the "conversations about this" list on unit and agent pages (`GET /api/mentions/:token/messages` exists).

Daemon/API (earlier in phase 4):
- `apps/daemon` + `yagura daemon`: one always-on process runs the engine for every active project (`Engine.runForever`), recovers attempts orphaned by a previous process, stops running agents on shutdown, and holds a lock (`~/.yagura/daemon.pid`) so `yagura drive` refuses while it runs.
- Hono API (`apps/daemon/src/server.ts`): projects, project detail (units with attempts, deps, gates, waiting reasons), unit trace, events, agents vs caps, attempt detail (brief, handoff, leftovers, runs), agent logs parsed and resumable by line, artifacts, gates (answer), andon, settings (get/set), FTS search, trace; SSE `/api/stream` (events) and `/api/attempts/:id/stream` (live log). Token auth when bound beyond localhost (`Authorization: Bearer` or `?token=`; token at `YAGURA_TOKEN_FILE`).
- Stopping an agent (`POST /api/attempts/:id/stop` with an optional note): work goes back to `ready` with the note, verification retries, a planner run is dropped; stopped runs do not count against attempts, skill checks, or planner rejections.

Visual direction chosen: **option F, "the watch"** (DESIGN §17; mock sources in `docs/design/Watch-*.dc.html`, `scene.py`, `anim.css`; A–E on the canvas were rejected). Earlier rounds, for reference: Three directions (A Lantern: dark/amber, lanes; B Washi: paper/ink/vermilion, grouped reading list; C Blueprint: crisp/cobalt, dense table + dependency strip), each with a project view and a live agent log, are on a private canvas: https://claude.ai/artifact/AuLG6d7GiuQoSBFfdGeLS5. The agent logs replay the real `orders` U3 verifier run; the project views use labelled sample data.

Build order decided 2026-09-26: (1) watchman — done; (2) project chains and repo creation — done; (3) `apps/web` — core pages done; environments, repos, settings next.

## Audit trail and skill enforcement: done (between phases 3 and 4)

- Landing squashes each unit into one commit with yagura trailers (project, unit, attempt with model and pstack version, branch, verdict with cited runs, link when `yagura.url` is set, issue refs). The verdict carries to the squashed commit because the patch-id is unchanged.
- Issue refs on projects and units (migration 4: `refs_json`, `units.landed_sha`); `yagura trace <sha|issue>` walks back to units, attempts, runs, verdicts, and handoffs.
- A work attempt that skipped a required skill is rejected with a note, every time (user decision: pstack is what keeps the principles consistent); the engine retries within `max_attempts`. Setting: `method.enforce_required_skills`.

## Known gaps

- Watchman turns are not attempts, so they do not appear in the Agents view and cannot be stopped from the API; the turn log is at `threads/<id>/turns/<message>.jsonl`. Plan for `apps/web`: show the turn's live log inside the thread. Two turns on one thread are refused only within one daemon process (the CLI does not check).
- A rebase that changes the patch blocks the unit; re-verifying a rebased head arrives with the babysit units (phase 5).
- Landing does not void dependents' verdicts, and `needs-source` behaves like `needs-landed` until read-only mounts arrive (phase 6).
- Pack `doctor`/`deploy`/`teardown` are parsed but not run; deployed verification comes with the `kube-namespace` provider (phase 5).
- `yagura evidence run` trusts `YAGURA_ATTEMPT` plus the attempt being in `running`; a per-attempt token arrives with the daemon API.
- `yagura drive` runs the engine in the foreground for one project; the always-on daemon and API arrive in phase 4.
- No wall-clock budget or landing cutoff yet (DESIGN §6).
- The user's SessionStart hook (codebase-memory-mcp indexing) runs in every agent session; suggested fix is to skip when `YAGURA_ATTEMPT` is set. Not yet applied.
