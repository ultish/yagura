# yagura build status

Updated 2026-10-04 (handoff for a cleared session, end of session 5086f7a4). Older material is in `docs/STATUS-ARCHIVE.md`; read it only when you need the history of something.

**Resume here (handoff, 2026-10-04):**

- **State.** `main` is clean and pushed. `pnpm -r test` passes (core 312, web 27, daemon 20; three concurrent full runs of the core suite also pass) and `pnpm -r typecheck` is clean. Database at migration 38. A demo is still running: `scripts/demo-publish.sh up` made a fresh home in `/tmp/yagura-demo-publish` (daemon on :7300, Reposilite in docker `yg-reposilite` on :8088, fake agents, real Gradle); its project `demo` is closed (U1 and U2 landed). `scripts/demo-publish.sh down` stops both; `status` shows publications and what the repository holds.
- **Built this session (2026-10-04), all pushed.**
  - The manager's four gaps (DESIGN §26 "As built"): it is woken when verification came back invalid `verify.max_retries` times (the unit stays `rejected` instead of `blocked`); its brief lists the other live work units in the repo and marks those whose write scope overlaps; a worker's note wakes it (`wakeOnNote`) and it answers `relay` (to named live sibling units, into their `unit.notes`) or `ignore`; and the `investigate` action queues a new unit type `investigate` (`investigate.ts`: a worker role in a detached worktree at the unit's last head, forbidden to change anything, findings in its handoff) after which the manager is woken once more with the findings. Migrations 37 and 38. The note wake reads only a new `## For other units` handoff section, never ordinary Notes.
  - The manager was proven with a real model (Haiku, about $2.30 in all); see "Tests and proofs left to run" item 1 for what it did. Found and fixed on the way: a manager's third consecutive resumed wake was refused for "skipped required skills" (each resume inherited only the last attempt's skills).
  - Published artifacts are snapshot-only (developer's call; DESIGN §14): a version ending in `-SNAPSHOT` keeps it (`1.5.0-yg-<project>-u<n>-<sha7>-SNAPSHOT`); yagura never waits for, publishes, or asks about a release and never deletes a snapshot (no authority to push to main). The `release` policy, `--release`, the release gate, `publish.release_wait_minutes`, and the pack's `unpublish` are gone; a consumer lands pinned to the snapshot it was proven against and its pull request gets a comment saying so (`postPinNotice`). The `release` publication and gate kinds, `projects.release_policy`, and `base_released` stay in the database unused.
  - Two real bugs behind the flaky engine tests: a verifier waiting for an environment slot now re-checks an environment pause once it has the slot (`verify.paused_in_queue`), and `openStore` makes every `db.transaction` take the write lock first, waits 30 seconds on a locked file (`BUSY_TIMEOUT_MS`), and retries a still-busy transaction four times with growing pauses (a transaction's function must only touch the database or do idempotent work). A wait blocks the Node thread.
- **Next.** Nothing is queued from the developer. Remaining items are under "What's left" below: one optional feature (a `manager.review` gate, only if real runs show poor decisions) and the proofs. Needing the developer: submit a Disagree from the code view and the repo browser's panel in the demo dashboard (http://127.0.0.1:7300/p/demo; fake agents are enough), and a desktop notification with the tab in the background. Needing an environment yagura lacks: an npm round, a container-image round, a real Nexus (does a consumer resolve a `-SNAPSHOT` pin from the snapshots repository?), a trunk CI failure on GitHub, and the RHEL9 air-gapped VM. Worth a cheap real-model check: whether Haiku fills `## For other units` honestly or forgets it.
- **Decided by the developer (keep).** The planner's handoff stays as the raw plan JSON. Agents keep the whole harness. No long-lived watchman process. Steering only for harnesses probed for stdin messages. Review switchable per project. No branch protection on the sandbox. Every forge post is labelled as yagura's. Worktrees: one per attempt, deleted when the unit finishes. UI work: prototype on real data first, dense layouts, controls always visible, views linking both ways; show dates and times on agent runs. Units are slices of work; agents are the processes that finish them. As few local files as possible: what yagura uses lives in its database (logs, briefs, and handoffs stay files). The handoff view on the agent page stays as is. The contract part of a prompt is visible, never editable; guidance is overridable globally and per project. On a forge the PR opens before review. From 2026-10-04: yagura releases nothing and deletes no snapshot; no project-level record of disagreements about code yagura did not write; no re-pinning of lock-file pins; note passing between sibling units through managers and the `investigate` action are wanted (both built).
- **Running a real test.** Fresh home: `export YAGURA_HOME=<scratch>`; `yagura set role.{watchman,planner,worker,verifier,reviewer,manager}.model '"claude-haiku-4-5-20251001"'` (one call each; the developer asked for a cheap model), `yagura set forge.poll_seconds 15`, `yagura set project.budget_usd 4`, `yagura repo add https://github.com/ultish/yagura-sandbox.git --id sbx`, `yagura env add local --provider local-process`, `yagura daemon`, then talk on `/talk` (autonomy go applies the proposal). Clear an andon with `yagura andon <project> --clear`; requeue with `yagura unit requeue <project> <seq> --note …`. For free runs, point `harness.claude.bin` at a wrapper that runs `packages/core/src/harness/fixtures/fake-agent.mjs` with `FAKE_MODE=engine` (plus `FAKE_DELAY_MS`, `FAKE_REVIEW=blocking:<text>|nit:<text>|write`, `FAKE_MANAGER=fresh|resume|split|planner|ask|stop|investigate|relay|ignore|garbage`, `FAKE_WORKER_NOTE=<text>` for a `## For other units` entry); for a forge without the network, `forge.gh_bin` can point at `fixtures/fake-gh.mjs` with `FAKE_GH_STATE` and `FAKE_GH_ORIGIN` (a bare repo). A real manager check without the daemon: a script that imports core (`claudeAdapter`, `runWorkUnit`, `runVerifyUnit`, `managerNeed`, `queueManager`, `runManagerUnit`), builds a small Python repo with a verify pack, and rejects a real worker's unit by hand; the 2026-10-04 scripts were in a session scratchpad and are not kept, so rebuild from `manager.test.ts`'s `rejectedUnit`. To make a real rejection, a pack check must pass on trunk and fail on the head: one that fails on trunk too is reported `env-blocked`, not a rejection, and Haiku workers are good enough to pass a naive trap.
- **Data.** Mocks: watchman tool calls https://claude.ai/artifact/BG64ZkwCWjySEhyQFPkZaK, prompts page https://claude.ai/artifact/LBrRcUuQ5pECgFmgRowUf7, handoff view (declined) https://claude.ai/artifact/Mh2PK4SdwQ9kQJT89VokNr. Scratch homes from earlier sessions (`…/5086f7a4-…/scratchpad/yr`, `yf`) may be gone. The demo's watchman is the fake agent and always answers with the canned "two chained projects" proposal (do not press Go).
- **Built 2026-10-03 and earlier, where to read about it.**
  - Phase 6, published artifacts (DESIGN §14 "Published artifacts", `publish.ts`; snapshot-only since 2026-10-04, above): a pack's `publish` block (`version`, `command`, `suffix`, `available`), test builds for consumers to pin, re-pinning when a source is re-published (`yagura-repin`), `repinIfStale`, `landWait`, `yagura unit add --needs <seq>[:source]`. A project is a goal that can span repos; links between separate projects are not built.
  - Dashboard: Lucide role icons (`ui/RoleIcon.tsx`); Monaco diff editor on the agent page and the unit's Code tab (`DiffPanel`) with Inline / Side by side; the unit page shows its own Land/Hold question; a wait from overlapping write scopes is drawn and explained; the bell rings outside the page (tab title count, favicon lamp, desktop notifications; they need localhost or HTTPS).
  - Watchman: tool calls and refusals as a summary line per reply, a live box during a turn, messages queued while a turn runs, a `PreToolUse` guard that refuses any shell command outside its `yagura` reads (DESIGN §21).
  - Naming: agent runs are `A1, A2, …` per project; verify/review/triage/rebase/plan rows are named by their agent, never as units (below, "Naming and flow").
  - Scope is the planner's estimate: a path outside it needs a reason under `## Outside scope`; the reviewer judges the reasons; the verify pack stays a wall (§6).
  - Prompts: each role's guidance is overridable globally (`/prompts`) and per project (`/p/<id>/prompts`); every run records the guidance version it got (§25). Standing orders, the spec, and environment templates live in the store, not files (§25, §12).
  - Landing and review: on a forge the pull request opens as soon as a unit is verified; yagura's findings go on their lines and triage answers in those threads; nothing merges until review settles (§24). A unit whose moved trunk already does what it was for closes as `done` (§13).
  - Every unit has a `description` (migration 34). Disagree is one control everywhere (`ui/Disagree.tsx`): story entries, the repo browser's panel, and each file row of a diff. Repo chips on the project page.
  - The manager (DESIGN §26): a per-unit agent that decides what happens after a rejection or failure (resume, fresh, split, planner, ask, stop), plus the 2026-10-04 additions above; `manager.enabled` (default on), `manager.max_decisions_per_unit` (4), `role.manager.harness|model`, skill `yagura-manager`.
- **Real runs.** 2026-10-02/03: Haiku for every role on `ultish/yagura-sandbox`, $4.20: a real reviewer raised a blocking and a should finding, real triage fixed both, the feature landed as PR #15; the account's session limit (429) interrupted it once. 2026-10-04: the manager, three actions, about $2.30 (see item 1 of the proofs list).

## What's left (2026-10-04)

Nothing is queued as a task; ask the developer which to take. What was decided not to build is at the end of this section.

### Feature left to build (only if wanted)

- **A `manager.review` gate**: ask the developer before a manager's choice takes effect. Not built because the choices take effect at once and can be Disagreed with afterwards; build it only if real manager runs show poor decisions.

Nothing else is known to be missing from the design.

### Proofs left to run

None of these needs new code unless it finds a bug. The fixed cost of a real agent session is about $0.10. The manager has been proven with a real model (archive), and the demo ran on migration 38 with real Gradle.

**Needing the developer**

- **A Disagree submitted from the code view and the repo browser's side panel.** Checked up to the form; submitting reopens a closed project and runs the planner (fake agents are enough; the demo dashboard at http://127.0.0.1:7300/p/demo will do).
- **A desktop notification.** Grant permission on localhost or HTTPS and let a gate arrive while the tab is in the background; check the click opens the right page and the favicon lamp blinks.
- **Whether Haiku fills in `## For other units`** honestly, or forgets it (a cheap real-model check).

**Needing an environment yagura does not have** (the developer called these "not now" until yagura is ready)

- **An npm round** (a package published with `npm publish --tag yg`, consumer pinned to the yg build).
- **A container-image round** (push and a registry lookup as the availability check).
- **A real Nexus** in place of Reposilite (a snapshots repository; a consumer resolving a `-SNAPSHOT` pin from it).
- **A real agent writing the pack's `publish` block** (pack writer and verifier skills describe it).
- **A trunk CI failure on GitHub**: the sandbox needs an Actions workflow, which changes the developer's repo.
- **The yagura label and the inline review findings on a real GitHub PR** (seen on GitLab; GitHub only with a fake `gh`).
- **The in-session "explain this path" request on a real agent** (fake agent only so far).
- **The watchman's shell-command guard on real agents** (fake agent and script tests only).
- **The session-limit (429) behaviour, watched once.** Today attempts fail and units block; no change is planned (see "Decided not to build" below), but it has not been seen on purpose.
- **A RHEL9 VM in the air-gapped network.** Install (Node, pnpm 11, native `better-sqlite3`), the developer's own `claude`, `glab`, `kubectl`, and skills (DESIGN §4, decision 1), an internal GitLab with its host in `forge.glab_hosts`, the dashboard reached from Windows by the VM's hostname with the token (§4, §17), and the air-gap skills agents need. Notifications need HTTPS or Chrome's `unsafely-treat-insecure-origin-as-secure` flag there. Likely to find problems this Mac cannot.

### Decided not to build (developer, 2026-10-03 and 2026-10-04)

- Skill capture from example repos (§11): can be done outside yagura.
- Other harnesses (codex, grok), pack manifests for pstack-claude forks, and measurement-driven hillclimb projects (phase 7).
- Better handling of the session limit (429).
- A project-level record for disagreements about code yagura did not write, and re-pinning a consumer whose version sits in a generated lock file (developer, 2026-10-04: not relevant).
- Links between separate projects: a project handles several repos, so a library and its consumer are normally one project.
- A readable planner handoff: the raw plan JSON is readable enough.
- A separate `investigate` unit type and "route a twice-rejected unit to the planner" as features: they are manager menu items (§26).
- A separate release unit and expand/migrate/contract machinery; releasing at all, and deleting snapshots (developer, 2026-10-04: yagura has no authority to push to main): breaking changes stay planner guidance enforced by dependencies.

## Known limits

- `yagura drive` (one project, foreground) refuses while the daemon runs; it is for debugging only. Normal use is `yagura daemon`, or `pnpm dev` while developing.
- Watchman turns are not counted against a project's budgets.
- The developer's SessionStart hooks (codebase-memory-mcp indexing, pstack's) run in every agent session by design: agents get the whole harness.
- Steering a running agent works for Claude only; other harnesses need the stdin probe first (DESIGN §22).
- A wait on a locked database blocks the daemon's thread (see the handoff).

## Archive

`docs/STATUS-ARCHIVE.md` holds: the phase checklists (phases 1 to 5, audit trail, resume on rejection), the real runs of 2026-09-30 to 2026-10-04 with their findings, the watchman and steering build notes, the unit-hub check, the first-session decisions, the naming and flow notes, the older "known gaps" entries, and the account of the manager's real-model proof.
