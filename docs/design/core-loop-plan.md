# Core loop rebuild plan

This plan builds the core loop agreed in `docs/design/core-loop.md`. It is for the developer, who runs yagura, and for the next engineer, who reads the code as the spec. One fresh judge replaces the verifier, reviewer, and arbiter. Units become goals with one draft pull request each, merged with a merge commit. The rule the program enforces is subtract first, then build, with no second path kept alive. The work runs on the branch `core-loop` in eight steps, CL1 to CL8, merged into `main` with a merge commit at the end. Data is a clean break. Settings, repos, environments, templates, and threads are imported. Projects and units are not.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs as a manually driven session, one step at a time, per `playbooks/babysit.md`'s pattern. One agent does the work, with at most one subagent at a time, because the developer's token budget is limited. The developer merges `core-loop` into `main`. CL7 stops at merge-ready for the developer's review.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the user, then stop. Start execution only on their explicit go.
- [ ] Claude Code has no standing-directive primitive today (see `TODO.md`). Until the execution-playbook redesign lands, run this checklist as a manually-driven session. The user holds the plan and this checklist open for the whole run instead of delegating to a standing coordinator.
- [ ] Re-read these fresh at program start, and again at every tick. Don't rely on memory of an earlier read.
  - [ ] The execution playbook the plan names, or its manually-driven equivalent above.
  - [ ] The **swarm** skill. Skip. One agent only, by the developer's token budget.
  - [ ] The chosen control skill (`control-ui` or `control-cli` from `cursor-team-kit`).
  - [ ] `playbooks/opening-a-pr.md`. Skip. Steps are commits on one branch, not separate PRs.
  - [ ] Each other leaf skill the program uses.
- [ ] On the user's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. Skip. The developer drives each step in chat.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook and this plan. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the user in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the user can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none." Skip. No tick loop runs.
- [ ] On the user's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Skip. One agent owns every step.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] CL1 is first. It branches `core-loop` from `main`.
  - [ ] CL2 after CL1. CL3 after CL2. CL4 after CL3. CL5 after CL4. CL6 after CL5. CL7 after CL4. CL8 after CL6 and CL7.
- [ ] Hold the file boundaries. CL1 only deletes. CL2 to CL6 touch `packages/core/src/**`, `apps/cli/src/**`, `apps/daemon/src/**`, and `plugins/yagura/**`. CL7 touches `apps/web/src/**`.
- [ ] Hold the review gate. CL7 changes an interaction. It waits for the user's review in chat with screenshots before merge.

### PR mechanics, for every PR

- [ ] Open the PR/MR per `playbooks/opening-a-pr.md`, ready and never draft, or with Graphite `gt` for a stack. Skip. Each step is a run of commits on `core-loop`.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run the **deslop** skill before each commit and the **no-comments** skill before review.
- [ ] Triage every automated review bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk. Override. The developer keeps merge commits, so `main` is merged into `core-loop`, never rebased.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the **swarm** skill. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict. Override. One agent runs the gates, the live lanes, and the perf probe in turn.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] A step is done when its gates, lanes, and probe pass at its last commit. CL8 merges `core-loop` into `main` with a merge commit after the developer's go.

### Boot recipe, for every live lane

Each live lane runs against its own isolated checkout, a worktree, or an `Agent` call with `isolation: "remote"` when a lane doesn't need this machine's local state, at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `pnpm -r build`, then `YAGURA_HOME=<scratch> node apps/cli/dist/main.js daemon` with `harness.claude.bin` pointed at a wrapper around `packages/core/src/harness/fixtures/fake-agent.mjs`, `forge.gh_bin` at `fixtures/fake-gh.mjs`, and `caffeinate -is` around the run. Wait for the `yagura daemon on http://127.0.0.1:<port>` log line.
- [ ] Deliver input only through the `yagura` CLI and the dashboard. Read `yagura show`, `yagura trace`, the fake `gh` state file, and `<home>/logs/daemon.log`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Delete the old judging and landing paths (CL1)

**Depends on.** None.

**Files.**

- [x] Delete `packages/core/src/verify.ts`, `verdict.ts`, `review.ts`, `triage.ts`, `amend.ts`, `rebase.ts`, `pack.ts`, `packs.ts`, `packedits.ts`, `envpause.ts`, `handoff.ts`, `investigate.ts`, `sources.ts`, `followups.ts`, and their tests. Done in commit; `git diff --stat main` lists them.
- [x] Delete `plugins/yagura/skills/yagura-verifier`, `yagura-reviewer`, `yagura-review-triage`, `yagura-rebase`, and `yagura-pack`.
- [x] Edit `packages/core/src/engine.ts`, `land.ts`, `schedule.ts`, `story.ts`, `records.ts`, `report.ts`, `followups.ts`, `evidence.ts`, `publish.ts`, and `index.ts` to drop every import of the deleted modules. `land.ts` and `scope.ts` were deleted rather than edited, and the callers also in `agent`, `finish`, `records`, `record-cli`, `repos`, `proposal`, `publish`, `chain`, `manager`, `brief`, `skills`, the CLI and the daemon were cut.

**Build.**

- [x] Remove the deleted modules and every caller branch that reached them. Scope fields, tiers, and the verify pack go with them.
- [x] Leave the engine planning and running workers only. A worker hand-off ends the unit at `handed_off`. That is the planned break this step allows on the branch.

**You see.**

- [x] `pnpm -r typecheck` prints no error, and `git diff --stat main` shows deletions only, apart from the edited callers. Zero errors; diff is 267 insertions, 8608 deletions.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] The remaining suites pass. Run `caffeinate -is pnpm -r test`. core 222, web 34, daemon 23 under `caffeinate -is`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [x] Lane 1. Start a project with the fake agent and watch a worker hand off. Save `cl1-handoff.png`. Pass when the unit shows `handed_off` and the log shows no verify, review, or pack unit. Real daemon and CLI on a scratch home: U2 and U3 `handed_off`, U4 waits; daemon log has no verify, review, or pack line. Screenshot `/tmp/swarm-cl1/worker-1/cl1-handoff.png` (JPEG data).

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Lines in `packages/core/src` without tests.
- [x] Probe. `cat $(ls packages/core/src/*.ts | grep -v test) | wc -l`, at `main` and at the head.
- [x] Baseline. Record the `main` count first. main 16805.
- [x] Rule. The head must be at least 4000 lines smaller, or the step left callers behind. head 11924, 4881 smaller.

**Review gate.** None. CL1 is not review-gated.

**Merge.**

- [x] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Lay the new unit model and schema (CL2)

**Depends on.** CL1.

**Files.**

- [ ] Create `packages/core/src/schema.sql` anew as the one starting schema.
- [ ] Delete every entry in `packages/core/src/migrations.ts` and start it empty.
- [ ] Edit `packages/core/src/domain.ts`, `store.ts`, and `records.ts`.
- [ ] Create `packages/core/src/import.ts` and the CLI command `yagura import <old home>`.

**Build.**

- [ ] Define `Unit` with `goal`, `acceptance`, `context`, `repo`, `base`, `after`, and `refs` in `domain.ts`.
- [ ] Define `UNIT_STATES` as `waiting`, `building`, `judging`, `ready`, `merged`, `stuck`, and `dropped`, with `UNIT_TRANSITIONS` as the only table of allowed moves, enforced by `transitionUnit`.
- [ ] Define the record schemas for `yagura handoff done|stuck`, `yagura judge approve|changes|ask`, and `yagura decide`, checked when called.
- [ ] Copy settings, repos, environments, templates, and threads from an old home in `import.ts`.

**You see.**

- [ ] `yagura import ~/.yagura` prints the counts it copied, and a fresh home starts at schema version 1.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `store.test.ts` gains every allowed and refused transition, read from `UNIT_TRANSITIONS`. `schema.test.ts` still matches the TypeScript enums against the SQL `CHECK` lists. `import.test.ts` imports a copy of the demo home and asserts the copied rows. Run `caffeinate -is pnpm -r test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [ ] Lane 1. Import a copy of `/tmp/yagura-real-gh-demo-npm/home` into a scratch home and open the dashboard's Settings, Repos, and Talk pages. Save `cl2-import.png`. Pass when the demo's repos, environment, and the issue #2 thread show.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time for a fresh `openStore`.
- [ ] Probe. Open a new store 20 times at `main` and at the head, interleaved.
- [ ] Baseline. Record the `main` median first.
- [ ] Rule. The head must not be slower than `main`. Fail at more than 10% slower.

**Review gate.** None. CL2 is not review-gated.

**Merge.**

- [ ] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Give each unit a branch and a draft pull request (CL3)

**Depends on.** CL2.

**Files.**

- [ ] Edit `packages/core/src/git.ts` and `forge.ts`.
- [ ] Create `packages/core/src/branch.ts` and `packages/core/src/relay.ts`.
- [ ] Edit `packages/core/src/harness/fixtures/fake-gh.mjs` and `fake-glab.mjs`.

**Build.**

- [ ] Create the unit branch `yagura/<project>/u<n>` from the unit's base in `branch.ts`.
- [ ] Install a `pre-receive` hook on yagura's mirror in `relay.ts` that accepts a push only to the pushing unit's branch, only when it fast-forwards, and passes it on to the forge.
- [ ] Add `openDraft`, `updateBody`, `markReady`, and `mergeCommit` to `ForgeAdapter` for GitHub and GitLab.
- [ ] Add `mergeWithBase` in `branch.ts` on `git merge-tree --write-tree`, returning clean with the tree or conflict with the files.

**You see.**

- [ ] The fake `gh` state shows one draft pull request per unit, then ready, then merged with two parents.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `relay.test.ts` pushes from a worktree to the mirror and asserts a refused force-push, a refused push to another branch, and an accepted fast-forward. `branch.test.ts` asserts a clean merge-tree result and a conflict with its file list, on real repos. `forge.test.ts` asserts draft, ready, and a merge commit with two parents through fake `gh` and fake `glab`. Run `caffeinate -is pnpm -r test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [ ] Lane 1. Against the scratch GitHub repo `ultish/yagura-demo-app`, open a draft from a test branch, mark it ready, and merge it with `yagura` internals through a test script. Save `cl3-pr.png` from the GitHub page. Pass when GitHub shows the draft, then ready, then a merge commit on `main`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time for `mergeWithBase` on the demo repo.
- [ ] Probe. Run it 20 times against a real checkout.
- [ ] Baseline. Record the time of `git merge --no-commit` in a scratch checkout, the old way, first.
- [ ] Rule. `merge-tree` must not be slower. Fail at more than 10% slower.

**Review gate.** None. CL3 is not review-gated.

**Merge.**

- [ ] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Run workers and the judge to a merge (CL4)

**Depends on.** CL3.

**Files.**

- [ ] Rewrite `packages/core/src/engine.ts`, `runner.ts`, `brief.ts`, and `audit.ts`.
- [ ] Create `packages/core/src/judge.ts`.
- [ ] Create `plugins/yagura/skills/yagura-judge/SKILL.md` and rewrite `plugins/yagura/skills/yagura-worker/SKILL.md`.
- [ ] Edit `packages/core/src/harness/fixtures/fake-agent.mjs`.

**Build.**

- [ ] Drive `waiting`, `building`, `judging`, `ready`, and `merged` from the engine, with every move through `transitionUnit`.
- [ ] Order the judge's brief as goal and diff, its own recorded runs, then the worker's decision log and the last round's list, in `judge.ts`.
- [ ] Mark the pull request ready on a recorded `approve`. Send a recorded `changes` to the resumed worker.
- [ ] Check `mergeWithBase` at the three moments in the design, and send a conflict to the resumed worker.
- [ ] Write the merge commit message in `audit.ts` with the unit, its workers, the judge's verdict, and `Closes #n`.

**You see.**

- [ ] `yagura show demo` lists a unit going `building`, `judging`, `building`, `judging`, `ready`, `merged`, and the fake `gh` state shows one pull request with every commit.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `engine.test.ts` gains a unit right the first time, a unit with one round of changes, a clean merge with the base, and a conflict the worker resolves, each with literal expected states and pull request contents. Run `caffeinate -is pnpm -r test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [ ] Lane 1. Run a two-unit project with the fake agent, one unit set to need a round of changes. Save `cl4-units.png`. Pass when both units reach `merged`, the second after one round, with two pull requests in the fake `gh` state.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Agent sessions per unit on the fake-agent demo project.
- [ ] Probe. `sqlite3 <home>/yagura.db "select count(*) * 1.0 / count(distinct unit_id) from attempts"`, at `main` and at the head, on the same two-unit spec.
- [ ] Baseline. Record the `main` value first.
- [ ] Rule. The head must be at most 2 sessions per unit right first time. Fail at 3 or more.

**Review gate.** None. CL4 is not review-gated.

**Merge.**

- [ ] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Give the unit lead its decisions (CL5)

**Depends on.** CL4.

**Files.**

- [ ] Rewrite `packages/core/src/manager.ts` as `packages/core/src/lead.ts`.
- [ ] Rewrite `plugins/yagura/skills/yagura-manager/SKILL.md` as `yagura-unit-lead/SKILL.md`.
- [ ] Edit `packages/core/src/forge.ts` and `packages/core/src/engine.ts`.

**Build.**

- [ ] Wake the unit lead on each trigger in the design's table, as a `LEAD_TRIGGERS` map from trigger to brief section in `lead.ts`.
- [ ] Read comments on ready pull requests only, and route each to the unit lead.
- [ ] Let `yagura decide` resume the worker, start a fresh one, reply on the pull request, ask the developer, ask the project lead, or drop the unit.

**You see.**

- [ ] A comment on a ready fake pull request wakes the unit lead, and its reply shows on the fake pull request signed as the unit lead.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `lead.test.ts` gains one case per trigger with the decision the fake lead records and the resulting state. Run `caffeinate -is pnpm -r test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [ ] Lane 1. Comment on a ready unit's fake pull request asking for a change. Save `cl5-comment.png`. Pass when the worker commits the fix, the judge approves again, and the unit merges.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Unit lead sessions per unit with no trigger.
- [ ] Probe. Count lead attempts in the CL4 two-unit run.
- [ ] Baseline. Record the CL4 head count, zero, first.
- [ ] Rule. A unit right the first time wakes no unit lead. Fail at one.

**Review gate.** None. CL5 is not review-gated.

**Merge.**

- [ ] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Plan units and answer issues on the new model (CL6)

**Depends on.** CL5.

**Files.**

- [ ] Edit `packages/core/src/plan.ts`, `planner.ts`, `proposal.ts`, `issues.ts`, and `watchman.ts`.
- [ ] Rewrite `plugins/yagura/skills/yagura-planner/SKILL.md` and edit `yagura-watchman/SKILL.md`.

**Build.**

- [ ] Accept units with `goal`, `acceptance`, `context`, `repo`, `base`, `after`, and `refs` in `PlanUnit`, with no scope fields.
- [ ] Ask the project lead in its skill to check that the units fit together before it records the plan.
- [ ] Keep issue refs as `<repo>#<n>` and `Closes #n` in the merge commit for the unit's own repo.

**You see.**

- [ ] A watchman proposal from an issue becomes units that reach `merged`, and the fake issue is closed by its merge.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `plan.test.ts`, `issues.test.ts`, and `watchman.test.ts` assert the new unit fields and an issue closed by a merge. Run `caffeinate -is pnpm -r test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [ ] Lane 1. Open a fake issue from a trusted author asking for a change. Save `cl6-issue.png`. Pass when the issue gets the watchman's reply, the work's pull request, and its close on merge.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Agent sessions from issue to merge.
- [ ] Probe. Count attempts and watchman turns in the lane 1 run.
- [ ] Baseline. Record the CL5 head count for a one-unit project first.
- [ ] Rule. At most one watchman turn, one project lead session, one worker, and one judge. Fail at more.

**Review gate.** None. CL6 is not review-gated.

**Merge.**

- [ ] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Rebuild the unit page on the new events (CL7)

**Depends on.** CL4.

**Files.**

- [ ] Rewrite `packages/core/src/story.ts` and `apps/web/src/pages/Unit.tsx`.
- [ ] Edit `apps/web/src/pages/Project.tsx` and `apps/web/src/lib/units.ts`.

**Build.**

- [ ] Prototype two layouts of the unit page on real CL4 data first, and build the one the developer picks.
- [ ] Show the unit's states, each worker round, each judge verdict with its findings, the unit lead's decisions, and the pull request.

**You see.**

- [ ] The unit page of a unit with one round of changes shows two worker rounds and two judge verdicts in order.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `story.test.ts` asserts the entries of a two-round unit. `apps/web/src/lib/lib.test.ts` asserts the state labels. Run `caffeinate -is pnpm -r test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [ ] Lane 1. Open the unit page of a two-round unit in night and day themes. Save `cl7-night.png` and `cl7-day.png`. Pass when both rounds, both verdicts, and the pull request link show without horizontal scroll.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Unit page load to first paint.
- [ ] Probe. Load the page 10 times through `control-ui`.
- [ ] Baseline. Record the `main` unit page time first.
- [ ] Rule. The head must not be slower. Fail at more than 20% slower.

**Review gate.** The user reviews before merge.

- [ ] Copy lane 1 screenshots into `docs/design/media/cl7-review-night.png` and `cl7-review-day.png`.
- [ ] Record a 30 to 60 second video of the change on the lane's checkout. Save it as `docs/design/media/cl7-review.mp4`. Skip. A screenshot pair stands in, by the developer's one-agent limit.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the user's click.

**Merge.**

- [ ] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Close out the design and merge (CL8)

**Depends on.** CL6 and CL7.

**Files.**

- [ ] Edit `docs/DESIGN.md` and `docs/STATUS.md`.
- [ ] Delete `docs/design/core-loop-plan.md` once every box is checked.

**Build.**

- [ ] Replace the parts of `DESIGN.md` the design supersedes with the agreed text of `docs/design/core-loop.md`.
- [ ] Run a real-model project on the scratch repos and fix what it finds.
- [ ] Merge `core-loop` into `main` with a merge commit on the developer's go.

**You see.**

- [ ] `git log --merges -1 main` shows the merge of `core-loop`, and the real-model run's units are merged on GitHub with merge commits.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The whole suite passes at the merge. Run `caffeinate -is pnpm -r test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. One lane at the step head, per the boot recipe, by the developer's one-agent limit.

- [ ] Lane 1. Run a two-repo real-model project, a library change and the app that uses it, on `ultish/yagura-demo-lib` and `ultish/yagura-demo-app`. Save `cl8-real.png`. Pass when both units merge with merge commits and the issue they answer closes.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Dollars per unit on the real-model run.
- [ ] Probe. `sqlite3 <home>/yagura.db "select sum(cost_usd) / count(distinct unit_id) from attempts"`.
- [ ] Baseline. Record the old demo's value first, $4.08 for four units.
- [ ] Rule. The head must cost at most half per unit. Fail above $0.51 per unit.

**Review gate.** None. CL8 is not review-gated.

**Merge.**

- [ ] The step's gates, lane, and probe pass at its last commit on `core-loop`.
- [ ] Push `core-loop`. The branch merges into `main` only in CL8, with a merge commit.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the user with the report the execution playbook names.

## Appendix A. Prototype evidence

No question in this plan needed a prototype before it was written. The design's open questions were settled by the developer in review on 2026-10-08. The CL7 unit page layout is decided by prototype inside CL7.

## Appendix B. Alternatives rejected

Building the new loop beside the old and switching over lost. It keeps two paths alive until the switch, against the **migrate-callers-then-delete-legacy-apis** principle skill. Deleting first, in CL1, leaves a smaller base and makes CL2 to CL6 smaller, per the **subtract-before-you-add** principle skill. A separate mapping document lost to Appendix E, because the map is an inventory and needs no second review round. Migrating old projects and units lost to a clean break, by the developer's call.

## Appendix C. Risks

- CL1 leaves the branch unable to judge or merge until CL4. That break is planned and holds only on `core-loop`, per the **outcome-oriented-execution** principle skill.
- Snapshot publishing (`publish.ts`, DESIGN §14) hooked into verification and landing. CL1 cuts those hooks and CL4 must reconnect publishing to `ready` and `merged`. The CL8 real-model run proves it, because the app unit needs the library's snapshot.
- The `pre-receive` relay in CL3 is new code on the push path. A bug there loses a worker's backup push. `relay.test.ts` covers each refusal.
- The Mac sleeps in 16-minute stretches. Every test and live run uses `caffeinate -is`.
- A real-model run costs money. Only CL3 lane 1 touches GitHub before CL8, and it uses no model.

## Appendix D. Links and reading list

Read `docs/design/core-loop.md` before every step, and DESIGN §27 (agents record through commands) and §29 (the usage limit) before CL2 and CL4. CL4 gets the **how** skill on `engine.ts` before it is rewritten. The decision trail per the **show-me-your-work** skill lives at `docs/design/core-loop-trail.tsv`, kept local.

## Appendix E. Map of the current code

This is what each module of `packages/core/src` becomes.

- Stays. `agent.ts`, `limits.ts`, `harness/claude.ts`, `config.ts`, `git.ts`, `prompts.ts`, `spec.ts`, `browse.ts`, `find.ts`, `mentions.ts`, `threads.ts`, `turns.ts`, `turncalls.ts`, `watchman.ts`, `watchman-guard.ts`, `proposal.ts`, `issues.ts`, `report.ts`, `evidence.ts`, `record-cli.ts`, `agentcli.ts`, `steer.ts`, `leases.ts`, `envvalues.ts`, `presets.ts`, `templates.ts`, `kube.ts`, `repos.ts`, `route.ts`, `publish.ts`, `retro.ts`, `disagreements.ts`, and `paths.ts`.
- Rewritten. `engine.ts`, `schedule.ts`, `runner.ts`, `brief.ts`, `store.ts`, `domain.ts`, `records.ts`, `forge.ts`, `land.ts`, `audit.ts`, `manager.ts`, `planner.ts`, `plan.ts`, `story.ts`, `status.ts`, `resume.ts`, and `migrations.ts`.
- Deleted. `verify.ts`, `verdict.ts`, `review.ts`, `triage.ts`, `amend.ts`, `rebase.ts`, `pack.ts`, `packs.ts`, `packedits.ts`, `envpause.ts`, `handoff.ts`, `investigate.ts`, `sources.ts`, and `followups.ts`.
