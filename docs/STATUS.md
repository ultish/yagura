# yagura build status

Updated 2026-10-04 (handoff for a cleared session, end of session 5086f7a4). Older material is in `docs/STATUS-ARCHIVE.md`; read it only when you need the history of something.

**Resume here (handoff, 2026-10-04, end of session 5086f7a4):**

- **State.** `main` is clean and pushed. `pnpm -r test` passes (core 328, web 33, daemon 23) and `pnpm -r typecheck` is clean, **on Node 26.7** (`.nvmrc` says 26; nvm has it at `~/.nvm/versions/node/v26.7.0`). Database at migration 39. `better-sqlite3` was upgraded from 11.10 to **13.0.3** because 11.x cannot be compiled against Node 26 (V8 API errors), which is why `pnpm rebuild better-sqlite3` could never fix the developer's "compiled against a different Node.js version" error; 13.0.3 needs Node 22 or newer but **segfaults when loaded on Node 23.5**, so use Node 26 for everything (`PATH=$HOME/.nvm/versions/node/v26.7.0/bin:$PATH`). A mismatch still shows as that error or exit 139; after switching Node run `pnpm install` or `pnpm rebuild better-sqlite3`. `scripts/demo-publish-npm.sh up` checks that the module loads first. Nothing is queued from the developer.
- **What is running.** A real-model GitHub run I started on :7303 (`/tmp/yagura-real-gh-demo-npm`, project `demo`, U1 worker running, no gate answered); the developer will rebuild and re-run it themselves, and `up` stops and replaces it (same folder). Leftovers: a closed Gradle demo on :7300, a local-repo real run on :7302, all on builds older than today's fixes. The developer's Nexus is on :8081 (docker, user `admin`, hosted repos `npm`, `maven-releases`, `maven-snapshots`, `docker`; it keeps no data across a restart); the scratch GitHub repos are private `ultish/yagura-demo-lib` and `ultish/yagura-demo-app`, reset by the script on each `up`.
- **Built this session (all in DESIGN; details in the archive, "The 2026-10-04 session's build notes").**
  - **Manager (now "unit lead"), §26:** wakes on two invalid verifications; sibling list in its brief; a worker's `## For other units` note wakes it (`relay`/`ignore`); `investigate` (unit type `investigate`); the developer can wake it with a note on a blocked, failed, or rejected unit (button on the project page and unit page, `POST …/wake`, `yagura unit wake`). Proven with a real model (Haiku) for decisions, relay, and investigate; its answer parser reads the last `## Decision`.
  - **Publishing, §14, snapshot-only (developer's call):** `-SNAPSHOT` stays on every test build; yagura never releases or deletes; a consumer lands pinned to the snapshot and its PR gets a comment saying so; a publishing library waits to land until its test build exists (`testBuildWait`).
  - **Review, §15:** the arbiter (was review triage) rules and changes nothing, then a worker makes any change it ruled necessary; a comment that would change what the unit must do is held as an amendment, shown in the review gate, and applied to the unit's acceptance only when the developer answers Fix (or at once for `review.trusted_authors`); every brief then carries the amended acceptance and the developer's quoted words. Forge comments open with one signed line and a role emoji; an overlapping-post guard stops duplicate replies.
  - **Dashboard:** display names project lead, unit lead, arbiter; dependency chain (header strip, Dependencies tab, story entry, persistent state-coloured lines on the project page, stage-header icons); sort control on the unit page; role emoji and Lucide icons paired by a test; the daemon's engine log is also written to `<home>/logs/daemon.log`.
  - **Infrastructure fixes:** every database transaction takes the write lock first, waits 30 s, and retries when busy; a verifier waiting for an environment slot re-checks the pause; a manager's third resumed wake no longer loses its skills. I once pushed a commit with a test red (a real race, fixed in `eb39deb`): run the whole suite and wait for it before committing.
- **Not yet proven with a real model or a browser.** The arbiter split, amendments, trusted authors, the wake button, and the signed PR headers on real GitHub have only run with fake agents; the dependency lines and icons on the project page were drawn from fixed coordinates and never viewed. The developer will exercise them in the redo: comment on U1's PR asking for emojis, expect the arbiter's question with "Approving also changes U1's acceptance: …", click Fix, and watch the worker and verifier build to the amended criteria.
- **Open.** Only the proofs and small spec items under "What's left" below (container-image round, GitHub CI failure, the air-gapped VM, and a few spec "not yet" items). Decided against: the `manager.review` gate, the project lead drafting criteria, links between projects, lock-file re-pinning, a project-level disagreement record, releasing or deleting snapshots.
- **Decided by the developer (keep).** The planner's handoff stays as the raw plan JSON. Agents keep the whole harness. No long-lived watchman process; the watchman is read-only and cannot act on units. Review switchable per project. Every forge post is labelled as yagura's. Worktrees: one per attempt, deleted when the unit finishes. UI work: prototype on real data first, dense layouts, controls always visible, views linking both ways; show dates and times on agent runs. Units are slices of work; agents are the processes that finish them. As few local files as possible: what yagura uses lives in its database or `YAGURA_HOME` (logs, briefs, and handoffs stay files). Generic role names (project lead, unit lead, arbiter), not the watchtower set. Hierarchy: you, the watchman, the project lead (plan and acceptance), a unit lead per unit, then the workers, verifiers, reviewers, arbiter, and the rest; yagura the daemon is not an agent and records evidence and applies decisions. Requirement changes need a human's approval (or a trusted author's setting).
- **Running a real test.** Fresh home: `export YAGURA_HOME=<scratch>`; `yagura set role.{watchman,planner,worker,verifier,reviewer,manager}.model '"claude-haiku-4-5-20251001"'`, `yagura set forge.poll_seconds 15`, `yagura set project.budget_usd 4`, `yagura repo add <git URL> --id <id>`, `yagura env add local --provider local-process`, `yagura daemon`. The scripted version is `GITHUB=1 REAL=1 NEXUS_USER=… NEXUS_PASSWORD=… scripts/demo-publish-npm.sh up|status|down` (library and app, npm packages in the developer's Nexus, PRs on the two scratch repos, merge by hand; without `REAL=1` it uses fake agents; `scripts/demo-publish.sh` is the Gradle and Reposilite version). Free runs: point `harness.claude.bin` at a wrapper around `packages/core/src/harness/fixtures/fake-agent.mjs` with `FAKE_MODE=engine` (plus `FAKE_DELAY_MS`, `FAKE_REVIEW=blocking:<text>|nit:<text>|write`, `FAKE_MANAGER=fresh|resume|split|planner|ask|stop|investigate|relay|ignore|garbage`, `FAKE_WORKER_NOTE`, `FAKE_TRIAGE_AMEND=1`, `FAKE_TRIAGE_OUTSIDE=1`); `forge.gh_bin` can point at `fixtures/fake-gh.mjs`. To make a real rejection in a manager check, a pack check must pass on trunk and fail on the head: one that fails on trunk too is reported `env-blocked`, and Haiku workers pass naive traps.
- **Data.** Mocks: watchman tool calls https://claude.ai/artifact/BG64ZkwCWjySEhyQFPkZaK, prompts page https://claude.ai/artifact/LBrRcUuQ5pECgFmgRowUf7, handoff view (declined) https://claude.ai/artifact/Mh2PK4SdwQ9kQJT89VokNr, dependency chain options (chosen: A and C) https://claude.ai/artifact/EWjj7VPkyQieYnvUvjBaxB.
- **Real runs.** 2026-10-02/03: Haiku on `ultish/yagura-sandbox`, $4.20 (a real reviewer, real triage, PR #15). 2026-10-04: the unit lead with a real model, about $2.30; a real npm round against the developer's Nexus with fake and real agents (each run about $1).

## What's left (2026-10-04)

Nothing is queued as a task; ask the developer which to take. What was decided not to build is at the end of this section.

### Features left to build

None queued. (The `manager.review` gate, which would ask the developer before a unit lead's choice takes effect, was decided against by the developer; the choices take effect at once and can be Disagreed with afterwards.)

### Small items the spec marks "not yet" (never decided either way)

- **Classify a failure outside the diff, on a stale base, as a rebase** (DESIGN §15 "Rebase units"): today only a conflict at landing queues a rebase.
- **Resolve review threads on GitHub after a fix** (§15): yagura replies in the thread, but the thread stays open.
- **Turn the repo's conventions into pack checks** (§11).
- **A shared git repo of templates** (§12): templates move by hand with Export and Import YAML today.

### Proofs left to run

None of these needs new code unless it finds a bug. The fixed cost of a real agent session is about $0.10. The unit lead (manager) has been proven with a real model, snapshot publishing ran with real Gradle (Reposilite) and with npm against the developer's Nexus, and the GitHub pull-request flow ran with real agents on the scratch repos (up to U1's PR and one comment round).

**Needing the developer**

- **A Disagree submitted from the code view and the repo browser's side panel.** Checked up to the form; submitting reopens a closed project and runs the planner (fake agents are enough; the demo dashboard at http://127.0.0.1:7300/p/demo will do).
- **A desktop notification.** Grant permission on localhost or HTTPS and let a gate arrive while the tab is in the background; check the click opens the right page and the favicon lamp blinks.
- **The redo with a real arbiter** (the developer's plan): comment on U1's PR asking for emojis and check the gate's question and the amendment, then the worker and verifier building to the amended criteria; also the pull-request headers and role emoji on real GitHub, the "Ask the unit lead" button, and a look at the project page's dependency lines and stage icons in a browser.
- **Whether Haiku fills in `## For other units`** honestly, or forgets it (a cheap real-model check).

**Needing an environment yagura does not have** (the developer called these "not now" until yagura is ready)

- **A container-image round** (push and a registry lookup as the availability check).
- **A Maven snapshots round against the developer's Nexus** (its `maven-snapshots` repo exists; the npm round is done).
- **A real agent writing the pack's `publish` block** (pack writer and verifier skills describe it).
- **A trunk CI failure on GitHub**: the sandbox needs an Actions workflow, which changes the developer's repo.
- **The yagura label and the inline review findings on a real GitHub PR** (seen on GitLab; GitHub only with a fake `gh`).
- **The in-session "explain this path" request on a real agent** (fake agent only so far).
- **The watchman's shell-command guard on real agents** (fake agent and script tests only).
- **The session-limit (429) behaviour, watched once.** Today attempts fail and units block; no change is planned (see "Decided not to build" below), but it has not been seen on purpose.
- **A RHEL9 VM in the air-gapped network.** Install (Node, pnpm 11, native `better-sqlite3`), the developer's own `claude`, `glab`, `kubectl`, and skills (DESIGN §4, decision 1), an internal GitLab with its host in `forge.glab_hosts`, the dashboard reached from Windows by the VM's hostname with the token (§4, §17), and the air-gap skills agents need. Notifications need HTTPS or Chrome's `unsafely-treat-insecure-origin-as-secure` flag there. Likely to find problems this Mac cannot.

### Decided not to build (developer, 2026-10-03 and 2026-10-04)

- A `manager.review` gate before a unit lead's choice takes effect.

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
