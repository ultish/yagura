# Prototype plan: a verification guide per repo

Status: plan, 2026-10-18. Not built. When the prototype answers the questions below, the result is written into `docs/DESIGN.md` as a design section, reviewed with a diagram, and only then built properly.

## The idea in one paragraph

Each repo keeps one guide to testing the app, made with `pstack:create-verification-skill`: `.claude/skills/verify-<app>/`, with one page per feature under `features/` saying how to reach it, drive it, and what proves it works. The planner names, for each acceptance line, which page proves it, or says a new page is needed. The worker uses those pages: it writes a missing page first, drives it on the unchanged code and sees it fail, builds the change, and drives it again to pass. The judge drives the same pages itself. The pages merge with the unit, so the guide grows with the project. A wrong step is fixed on the unit's branch like code. `pstack:maintain-verification-skill` runs now and then as its own job, not inside units.

## What the prototype must answer

1. Does `create-verification-skill` produce a usable guide when run inside a yagura worker (timebox, cost, isolation, no pull request of its own)?
2. Does `claude -p` in a worker's and a judge's checkout pick up the repo's `.claude/skills/verify-*` without being told?
3. Can the planner choose the right page per acceptance line from the guide's index alone?
4. Does red then green work as evidence: a recorded run with `--at base` that fails, and one on the head that passes?
5. Does the judge drive the page itself, and does it catch a page that would pass whatever the code does?
6. Does a later unit reuse a page instead of working it out again, and does a worker fix a planted wrong step?
7. What does it cost per unit compared with today (the rule: at most $0.51 per work unit)?

## Shortcuts the prototype takes on purpose

These keep the prototype small. The design section decides the real shape.

- **Proof per line is text, not a type.** An acceptance line ends with `(proof: orders-api)` or `(proof: new orders-api)`. No schema or migration change; `acceptance` stays `string[]`.
- **"Create first, others wait" is the planner's rule, not the engine's.** The planner makes the guide-creating unit first and puts it in every other unit's `after` for that repo.
- **No upkeep job.** `maintain-verification-skill` is tried once by hand at the end, not wired into yagura.
- **Real model, small.** Haiku on every role, as in the 2026-10-14 to 10-16 runs. The fake agent cannot tell us whether the skills work.

## Steps

Each step ends with something to look at. Run everything under `caffeinate -is` with a scratch `YAGURA_HOME`.

### 1. By hand, outside yagura (no code)

- Run `/pstack:create-verification-skill` interactively on `~/Developer/kuru-testbed` and on `yagura-demo-app`. Note what it writes, how long it takes, what it costs, and what it assumes about ports and data folders.
- Check question 2: in a fresh `claude -p` in a clone of that repo, ask it to list its skills.
- **Look at:** the two generated guides. Decide whether the page shape (Sub-features, How to get to it, Driving it, Gotchas) is enough for a judge to work from, or needs an "Evidence" line per page.

### 2. Overlay skills (text only)

- `yagura-planner`: read `.claude/skills/verify-*/features/README.md` in the checkout; end each acceptance line with its proof page or `new <name>`; when a repo has no guide, the first unit in it creates one (`create-verification-skill`, proven on one feature) and every other unit in that repo comes after it.
- `yagura-worker`: load the repo's verify skill first; for `new`, write the page before the code; run the drive with `yagura evidence run --at base` (should fail) and then on the head (should pass); drive in the unit's slot (`YAGURA_*` ports, namespace, data folder); write proof files to `$YAGURA_EVIDENCE`; skip the skills' own pull request step; fix a wrong step on the branch and say so with `--decision`.
- `yagura-judge`: load the same skill and drive every named page itself as recorded runs; for a new page, check it fails on the base; a page that would pass whatever the code does is a finding, the same as such a test.

### 3. Brief (small code change)

- In the worker and judge briefs, add a `VERIFY` section: the guide's location in the checkout, its page index, and the proof page named on each acceptance line. Read from the checkout, so a page the unit adds shows up in the judge's brief.
- Tests: a brief test with a checkout that has a guide, and one without.

### 4. Real run A: new app, scaffold creates the guide

- A watchman project on a new repo: a small HTTP service (stack to pick in step 1), three units: the scaffold, which creates the guide; a feature with an API change; and a feature that needs a new page.
- **Look at:** the guide after the scaffold merges; the planner's proof lines; the red and green runs on each unit; the judge's own runs; the cost per unit.

### 5. Real run B: existing repo, then a wrong step

- `kuru-testbed` (`discounts`): the first unit creates the guide; two later units reuse its pages.
- Before the third unit, plant one wrong step in a page (an old port or path) on the base.
- **Look at:** whether the worker or the judge notices, fixes the page on the branch, and says so.

### 6. Upkeep, once by hand

- Run `/pstack:maintain-verification-skill` on run B's repo after the merges. Note what it finds, what it costs, and what it would need to run as a yagura job (its own pull request goes through yagura; it must not touch app code).

## What comes out

- A short findings note in this file, one line per question, with the run ids.
- Then the design section in `docs/DESIGN.md` (where the guide lives, proof per acceptance line as a real field, scaffold versus feature proof, who creates and who maintains, the engine's rule for "create first"), with a diagram for review, before it is built properly.

## Open, to settle during the prototype

- A guide in the repo is seen by teammates and their own tools. Is that wanted on every repo, or should a repo be able to say no?
- Several apps in one repo: one guide each (`verify-<app>`), or one guide with sections?
- Two units adding pages at once can conflict on `features/README.md`. One index line each should merge cleanly; check it does.

## Findings (2026-10-18)

- **Step 1, `create-verification-skill` with Haiku on a 60-line HTTP service:** $0.16, 76 seconds, 20 turns. It wrote `.claude/skills/verify-orders-api/` with a launch, doctor, drive, evidence and cleanup section and three feature pages (health, order fetch, 404), and drove all three. It does not need the user.
- **Question 2 (auto-pickup): yes.** A fresh `claude -p` in a clone of that repo lists `verify-orders-api` as a project skill with no prompting.
- **Two flaws in what it generated, both fixed by yagura's rules, not by the skill:** it hard-codes port 9999 (two units driving side by side would collide), and it writes `./verification-evidence.txt` into the checkout (it would dirty the unit's branch). The VERIFY section now tells agents to pick a free port and write proof to `$YAGURA_EVIDENCE`.
- **Built (steps 2 and 3):** `packages/core/src/verify-guide.ts` (read a checkout's `verify-*` skills and their pages, parse `(proof: page)` and `(proof: new page)` off acceptance lines, render the VERIFY section), wired into the worker brief, the judge brief, and the plan brief (VERIFICATION GUIDES); the worker, judge and planner overlay skills say what to do with it. 10 new tests; all 260 core tests pass, typecheck clean.
- **Question 3 (planner picks pages), run A:** with no guide yet, Haiku planned U2 = skeleton + guide (`proof: new health-check`), and U3, U4 after it, each acceptance line ending `(proof: orders-api)` / `(proof: receipts)`, pages that do not exist yet. It put the guide first and the rest after, as asked. Weakness: it tagged "unit tests for X pass" lines with a page too, which is a different kind of proof.
- **Step 4, U2 (scaffold + guide), worker:** loaded `pstack:create-verification-skill` itself and wrote `verify-shop` with a page each for health, orders and receipts, for $0.22 in under two minutes. The VERIFY rule worked on evidence (the guide says proof goes in `$YAGURA_EVIDENCE`) but a launch example still hard-codes `PORT=9999`. The `orders-api` and `receipts` pages are stubs ("To be implemented in a future unit") because the planner's acceptance asked for pages of features that did not exist yet. Lesson for the planner skill: a unit creates pages for what it builds; later units add their own pages.
- **Step 4, U2 merged ($0.37: worker $0.22, judge $0.15).** The judge drove the health check as its own recorded runs and approved, stub pages included. It did not flag them.
- **Step 4, U3 worker ($0.17):** red then green on its unit test (run 7 exit 1, run 8 exit 0) and drove the live server on its own port (`PORT=9902`), but left the `orders-api` page as the stub and did not use `--at base`. Haiku follows "drive it on a free port, proof to $YAGURA_EVIDENCE" but skips "fill in the page".
- **Step 4, U3 merged ($0.29: worker $0.17, judge $0.12).** The judge drove the endpoint with its own script and ran the unit tests on the base (`run:17 -- @base exit 1`), so the red check happened, in the judge. The stub page was not noticed by the judge either.
- **Step 4, U4 merged ($0.93: it cost a second worker round and a second judge round).** U3 and U4 were planned in parallel and invented different order shapes; after U3 merged, yagura's conflict check sent U4's worker back to merge `main`, and the judge approved the result. The whole run: planner $0.10, doctor, three units, **$1.69 in about ten minutes**, all merged, 10 unit tests passing.
- **The landed guide is wrong about the landed code (the main finding).** `orders-api.md` says order 42 returns `{"id": 42, "item": "Widget", "status": "shipped"}`; the code returns an `items` array and `"status": "completed"`. `receipts.md` says `Widget` / `shipped`; the code returns `Widget A` / `completed`. Nothing noticed: the unit tests pass, and neither the U4 worker (after its merge) nor the judge re-drove the page and compared. Both drove their own scripts instead of the page's commands. A guide that nobody compares against the live app goes stale in one merge.
- **Judge missed its skill** on U4's first round (`skipped required skills: yagura:yagura-judge`); recorded, not rejected, as designed.
- **Rule added after run A:** drive a page's own commands as written and compare the output with what the page says it returns; a difference is a stale page or a code defect, fixed by the worker in its branch (with `--decision`) or raised as a finding by the judge. Also: a unit writes the pages for what it builds, never pages for features that do not exist yet.
- **Run B (same repo, stale pages, new rules), worker $0.34:** the planner made one unit (total on order, list endpoint, all under `orders-api`). The worker drove the page, found it stale, and rewrote `orders-api.md` to the real response shape, with the new `total` and `GET /orders` sections. Question 6 (does a worker fix a wrong step) is yes once the rule is stated. The `receipts` page, which this unit does not touch, is still stale: that is what the occasional maintain pass is for.
- **Run B finished:** one unit, planner $0.11 + worker $0.34 + judge $0.21; project closed itself; 15 unit tests pass; the landed `orders-api` page matches the landed code.
- **Step 6, `maintain-verification-skill` by hand ($0.14, 72 seconds, Haiku):** found the stale `receipts` page and corrected it to the real output (`Widget A` / `completed`, plus order 43), as uncommitted edits. It would need a way to run as a yagura job: its own pull request has to go through yagura.

## Answers to the seven questions

| #   | Question                                                                    | Answer                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does `create-verification-skill` work inside a worker?                      | Yes. The scaffold worker loaded it, wrote the guide, no pull request of its own, $0.22. It left stub pages for features that did not exist (planner's fault, now a planner rule).                                                                                                                                                  |
| 2   | Do sessions pick up the repo's guide without being told?                    | Yes.                                                                                                                                                                                                                                                                                                                                |
| 3   | Can the planner name the right page per acceptance line?                    | Yes, from the page index; it put the guide-creating unit first and the rest after it. It also tagged "unit tests pass" lines with a page.                                                                                                                                                                                           |
| 4   | Does red then green work as evidence?                                       | Partly. Workers went red then green on unit tests; the judge ran `--at base` on U3. No worker used `--at base` on a page.                                                                                                                                                                                                           |
| 5   | Does the judge drive the pages and catch a hollow one?                      | Not shown. Judges drove their own scripts, not the page's commands, and approved stub pages and a page that disagreed with the code. After the compare-output rule, run B's judge approved a correct page; a deliberately wrong page was not tried on the judge.                                                                  |
| 6   | Does a later unit reuse a page, and does a worker fix a planted wrong step? | Reuse yes. Fixing: only after the rule "run the page's commands and compare with what it says". Before it, the guide was wrong after one merge (run A). After it, the worker fixed the page unprompted (run B).                                                                                                                    |
| 7   | Cost per unit                                                               | Run A: U2 $0.37, U3 $0.29, U4 $0.93 (a conflict round with U3); planner $0.10 and $0.05. Run B: $0.56 for one unit. Two of four units are over the $0.51 rule. No baseline run of the same project without the guide was made, so the extra cost of the guide itself is not measured.                                              |

## What this says about the design

- **It works with the pstack skills as they are.** No change to `create-verification-skill` or `maintain-verification-skill` was needed. The extra rules live in yagura's briefs and overlay skills.
- **The guide goes stale the moment two units overlap.** Parallel units each invented their own response shape, a conflict resolution kept one, and the page for the other was wrong. A guide needs a check against the live app after a merge. The compare-output rule fixes it for the pages a unit touches; the rest needs the periodic maintain pass.
- **The judge is the weak spot.** It approved stubs and drift, and skipped its own skill in two of its five rounds. Cheap options: make the judge's brief say which pages to run and what each says it returns; or have yagura itself run the named pages and diff the output with the page (the daemon's own check, not an agent's).
- **Order of work matters.** The planner's "guide first, then the rest" rule held, but parallel feature units in the same area should share the data shape in their context, or be ordered.

## Not decided yet (one-way doors, for the developer)

1. **The guide lives in the user's repo** (`.claude/skills/verify-<app>/`). The prototype assumed it; teammates and other tools will see it on their branches.
2. **A `proof` field in the plan schema** instead of text on the end of a line. Needs a migration.
3. **Whether yagura, not an agent, runs the named pages and compares** (a new kind of recorded run). This is the strongest fix for the judge weakness and is real engine work.
4. **How `maintain-verification-skill` runs:** as a job after every N merges, as a doctor task, or on request, and how its changes land through yagura's pull request.

## Update 2026-10-18 (after the developer's answers)

Decisions: the guide lives in the repo; `proof` becomes a real field. Built: migration 2 (`units.proof_json`), `Unit.proof`, the plan schema takes `{ outcome, proof }` or the text suffix, the planner brief and skill describe it, `yagura show` prints it. 264 core tests pass.

**Judge test on Sonnet** (stand-in `yagura` shim, the real judge brief and `yagura-judge` skill, a checkout with one planted problem each, about $0.12 per verdict):

| Planted problem                                              | Sonnet, new brief                  | Sonnet, old brief | Haiku, new brief | Haiku, old brief |
| ------------------------------------------------------------ | ---------------------------------- | ----------------- | ---------------- | ---------------- |
| none (correct page)                                          | approve                            | not run           | not run          | not run          |
| page says `shipped`, code returns `completed` (in the diff)  | changes                            | changes           | changes          | changes          |
| page is a stub ("to be implemented")                         | changes                            | not run           | not run          | not run          |
| page curls `/health` and claims it proves the new endpoint   | changes                            | changes           | changes          | changes          |
| `/health` gains a field; its page is stale and not in the diff | changes                          | changes           | **approve**      | **approve**      |

Reading: the new brief (named pages' text in the brief, run the page's commands and compare) cut the turns and cost of Haiku's catches by about a third, but did not make Haiku catch drift outside the diff. The model decided it. So the judge improvement is: run it on Sonnet. The daemon-side comparison (decision 3 earlier) is not needed for now; revisit if a Sonnet judge misses something real.

**Not yet done:** make Sonnet the default `role.judge.model` (left as a setting; a real engine run with a Sonnet judge on a project with planted drift is the next check); the web page for a unit does not show `proof`; the upkeep job.

**Real engine run with the Sonnet default (run C, 2026-10-18).** A stale `health-check` page was planted in the repo (it claimed `{"status": "up", "uptime": 0}`); the project asked for `/health` to report a version, one unit, `proof: health-check` on both lines (the planner named the page). The Haiku worker drove the page, found the planted drift, and fixed both stale lines in its branch ($0.25). The judge ran as `claude-sonnet-5-5` by the new default, ran the unit tests and drove the page on its own free ports (19431 to 19433), approved, and the unit merged ($0.22). So the engine path works end to end with a Sonnet judge. What it did not test is a judge catching drift through the engine, because the worker had already fixed it; that case is covered by the stand-in tests above.

## Proposal: guide upkeep (2026-10-18, for review; not built)

**What it is.** `pstack:maintain-verification-skill` as a yagura job: drive every page of a repo's guide against the live app, correct the pages that are stale, and report behaviour that is really broken (a product gap) without touching product code. By hand it took 72 seconds and $0.14 on a three-page guide, and it found the stale page the units missed.

```
 trigger ──▶ upkeep job ──▶ branch yagura/<project>/u<n>  (edits only .claude/skills/verify-*)
   │            │                       │
   │            │ drives each page      ▼
   │            │ against the app    judge (Sonnet): did it only touch the guide,
   │            ▼                    did it re-drive what it changed?
   │         product gaps ──▶ listed in the hand-off, never fixed here
   │                                   │
   └─ every N merges · a judge finding  ▼
      on a stale page · "Run upkeep"   merge through the usual pull request
```

**Triggers (derived, like the doctor's wakes; never a schedule).** After `verify.upkeep_every_merges` merges (default 10, 0 turns it off) to a repo's base since its last upkeep; when a judge records a finding about a stale page; and on request (`yagura verify upkeep <repo>`, a button on the repo page).

**Two shapes, one decision (asked below).**

- _A work unit in a project._ yagura creates a normal `work` unit (playbook `maintain-verification-skill`, acceptance "every page was driven and matches; only the guide changed") in the newest open project that uses the repo. It reuses the branch, pull request, judge, merge, cost, and story with no new machinery. It needs an open project, so a repo whose projects are all closed cannot be tended.
- _Its own numbered run, like the doctor_ (K1, K2, a page of its own). It works for closed projects and keeps project budgets clean, but a run that changes files needs a branch and a pull request, and today those belong to units; the merge request machinery would have to be generalised.

## Update 2026-10-18 (later): option 3 built, and what the runs showed

**Built (the developer chose option 3, the Proof row).** `evidence run --page <page>` tags a run with the page it drove (migration 3); `proof.ts` summarises each named page from the judge's own runs; `yagura judge approve` is refused unless the judge drove every named page on the head, and a new page also on the base where it must fail; the unit page shows a Proof row (`UnitStory.proof`). A page the guide does not have when the worker starts is marked new whatever the planner wrote. 273 core, 40 web, 24 daemon tests pass.

**Run D (real engine, Haiku worker, Sonnet judge by default).** New page `order-count`: the worker wrote and drove it ($0.26); the judge drove it on the base (run 63, exit 1) and on the head (run 64, exit 0), approved ($0.16), and the dashboard shows "new order-count · fails on base · passes on head" with those runs.

**What the earlier run (shop4, before the new-page rule) showed.** The planner declared `order-total` as an existing page, so nothing required it to fail on the base; the judge ran it on the base twice and it passed both times (a drive script that succeeds without the change proves nothing), and the approval went through. That is why unmarked pages are now new automatically, and why the rules say a drive must exit non-zero on any difference.

**Two things I did not plan for.**

1. _A worker cannot run on the base_ (the engine refuses: "only the judge runs commands on the base"). My first worker instructions said to use `--at base`; they now say: commit the page, drive it while the code is still unchanged, then build.
2. _The judge found a stale page that was not the worker's fault_ (in run D it drove the other pages as a regression sweep; `health-check` failed because the app now returns a version) and correctly did not count it against the unit. It said so only in its final message, which yagura never reads, so the finding is lost. A way to report it (`yagura judge approve --stale-page health-check`, say) would feed the upkeep job's trigger "a judge reports a stale page" and gives the "pre-existing" category the Anthropic review article uses. Not built: it belongs with the upkeep decisions.

**Polish left.** The Proof row sits in the unit page's facts grid beside Acceptance; its runs line wraps in the narrow column.
