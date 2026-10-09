# The core loop, designed again (draft for the developer)

Status: agreed by the developer, 2026-10-08, after two rounds of review. Written as if yagura had no code, from what the first real runs taught. It replaces the matching parts of `DESIGN.md`; a second document maps it onto the code: what stays, what is rewritten, what is deleted.

## Why

The first real runs spent more on checking work than on doing it: on the demo, workers cost $1.66 of $4.08, and the verifier, reviewer, and arbiter $2.07 between them. Three judges looked at the same change in turn. yagura's own reviewer posted findings on the pull request and a second agent then ruled on them. Units carried file lists the planner wrote before the work existed, and a change outside them was rejected. Each repo carried a verify pack with tiers, and changing it took a unit with its own verify and review. Landing squashed and rebased, so main's history hid how a change was built.

Models are now good enough to be trusted with the work. yagura should let them build, and keep for itself only what an agent cannot be trusted to do alone.

## Principles

1. **Goals, not instructions.** A unit says what must be true when it is done. It never says which files to touch.
2. **The builder proves its work; a fresh agent judges it.** The worker shows its evidence. A judge with no shared context decides whether the goal is met.
3. **One pull request per unit, and it is the unit's public record.** It stays a draft while yagura works on it, collects every commit, and lands as a merge commit.
4. **Agents talk inside yagura, and every word is kept.** What agents say to each other (findings, answers, questions, decisions) is stored in yagura's database and shown on the unit's page, so a person can come back later and follow the trail. The forge gets only what people need: the pull request, its commits, when it is ready, and replies to people.
5. **Problems go to whoever can decide them.** A worker goes to its unit lead. A unit lead asks the developer directly when the question is the developer's, and goes to the project lead only when the plan itself must change (split a unit, reorder, add one).
6. **yagura does the mechanics.** Branches, pull requests and their draft state, merges, keeping branches up to date, scheduling, recording, budgets. It never decides whether work is good. Agents may push their own unit's branch; they never merge, open, or close pull requests.
7. **Agents act through commands.** What an agent decides reaches yagura through a `yagura` command, checked when it is called and recorded, never parsed from prose. An agent that ends without its command is reminded before its session closes.

## Who does what

| Who | Kind | Job |
|---|---|---|
| Developer | person | Says what to build, answers questions, approves requirement changes, merges when the project asks for it. |
| Watchman | agent | The front door: conversations in the dashboard and on forge issues, turned into projects and units for the developer to start. |
| Project lead | agent | Turns a project's goal into units and their order, checking that they fit together; plans again when a unit lead says the plan must change. |
| Unit lead | agent | Owns one unit from start to merge: decides when work is stuck, keeps failing review, or gets comments once it is ready. Asks the developer directly when the question is theirs. |
| Worker | agent | Builds the unit's goal on the unit's branch and proves it works. |
| Judge | agent | A fresh session each round: decides whether the work meets the goal, from the change itself and from evidence it can check. |
| yagura | program | Runs the loop, records everything, talks to git and the forge, enforces the few hard rules. |

The unit lead and the judge exist per unit. Agents are woken for a reason and end; nothing runs idle.

## The unit

| Field | Meaning |
|---|---|
| goal | One sentence: what this unit changes. |
| acceptance | The outcomes that count as done, each written so a judge can check it ("`greet('Jimmy')` returns `Hello, Jimmy`"). |
| context | What the worker should know: why, decisions already made, pointers into the spec, and what other units will build (so a deliberate gap is not mistaken for a placeholder). |
| repo | The one repo it changes. A change across repos is several units with an order between them. |
| base | The branch it starts from and merges into: the repo's default branch unless the plan says otherwise (a release branch, a feature branch). |
| after | Units that must merge first. |
| refs | Issues it answers (`app#12`); a ref to the unit's own repo closes the issue on merge. |

There is no write scope, no forbidden paths, no verify command per unit, no tier.

## The unit's life

```
waiting ──(after-units merged)──▶ building ──(worker hands off)──▶ judging
                                     ▲                               │
                                     └────────(changes asked)────────┤
                                     ▲                               │ approved
                                     │                               ▼
                                     └──(comment fixed · conflict ── ready ──(merged)──▶ merged
                                         resolved · CI fixed)

 stuck ◀── from building or judging when the unit lead must decide; it sends the unit back to building, to the developer, to the project lead, or to dropped
```

- **waiting**: its `after` units have not merged.
- **building**: a worker is on it. yagura creates the branch `yagura/<project>/u<n>` from the unit's base the first time.
- **judging**: the judge is on it.
- **ready**: approved; the pull request is out of draft. It waits for CI, for the developer's merge when the project asks for one, and for any comments.
- **merged**: done. Issues it closes are closed by the forge.
- **stuck**: the unit lead decides what happens next.
- **dropped**: the unit lead, the project lead, or the developer gave up on it.

Each change of state goes through one function that checks it is allowed and records an event.

## The pull request

- yagura pushes the branch after each worker hand-off. The first push opens a **draft** pull request: the goal as title; the body holds the goal, the acceptance, the issues it closes (`Closes #12` for the unit's own repo), and a link to the unit in yagura. yagura keeps the body current as the unit moves.
- While the pull request is a draft nothing is posted on it. The forge sees only commits.
- **yagura takes it out of draft, the moment the judge's `approve` is recorded.** No agent has to remember to: the approval is a command, and yagura acts on it. A judge cannot end its session without one of its three commands; yagura sends it back once to record one. If it still ends without one, a fresh judge looks instead, and after two judges in a row without a verdict the unit is stuck and its unit lead decides.
- A unit merges only when its **current head** is approved by the judge, CI on that head has passed, and, when the project asks for it, the developer merged it. yagura merges with a merge commit, never squash or rebase. The merge commit's message names the unit, its workers, and the judge's verdict. On GitLab the project's merge method decides this, so it must be "Merge commit".
- A commit that changes what the worker wrote (a fix for a comment, a CI fix, a resolved conflict) sends the unit back through the judge, who looks at what changed since its approval. A clean merge of the base does not: if it breaks something, the tests catch it.

## Keeping up with the base branch

No agent does this: yagura checks, with plain git, at three moments.

1. **A unit merges.** Right after yagura merges a unit into base `B`, it checks every other open unit whose base is `B`.
2. **The base moved outside yagura.** On each forge check (every `forge.poll_seconds`), yagura fetches each base in use; when its head changed, it checks the open units on it.
3. **A worker hands off.** Before the judge starts, so the judge always sees a branch that merges with its base.

The check is `git merge-tree --write-tree <unit branch> <base>`, which computes the merge without touching any checkout: it gives the merged tree when the merge is clean and the conflicting files when it is not. A unit whose worker is running is not touched mid-session; it is checked when that worker hands off.

- **Clean.** yagura makes the merge commit on the unit's branch and pushes it. The unit stays where it was; CI runs on the new head.
- **Conflict.** yagura sends the unit to building and resumes its worker with the base, the conflicting files, and "merge the base into your branch and resolve these". The worker merges (never rebases), resolves, runs the tests, commits, and hands off; the judge looks at the resolution.
- **The worker cannot resolve it.** It hands off stuck, and the unit lead decides: help it, ask the developer, or ask the project lead whether the two units clash by design. A conflict is often the first sign that two units were planned against each other.

## The worker

- **Starts** fresh for the unit's first round. On "changes asked" or a conflict it resumes its own session, which keeps its context; the unit lead may choose a fresh worker instead.
- **Builds** with the developer's whole harness, following pstack: `poteto-mode` for the work, `prove-it-works` and `test-behavior-not-implementation` for proof, and a `show-me-your-work` decision log (what, why, evidence, result), which yagura keeps with the unit rather than in the repo.
- **Proves** with recorded runs (below). The decision log's evidence points at those runs, at commits, and at `file:line`.
- **Commits** on the unit's branch and may push it whenever it likes, which also backs the work up off the machine. It may merge other branches in. It never force-pushes, never pushes another branch, never rebases, and never opens, readies, merges, or closes a pull request. yagura still pushes at every hand-off, so nothing depends on the worker remembering.
- **Hands off** with `yagura handoff done` or `yagura handoff stuck --reason "…"`.
- **Is not limited to files.** Touching something outside the goal is allowed; the judge decides whether it belonged.

## Recorded runs

`yagura evidence run -- <command>` is how an agent runs something whose result counts as evidence. The agent chooses the command: usually the environment's `test` action, or a narrower one (one test file, one check) when that proves the point better. yagura runs it itself in the unit's checkout, with the environment's values, and records the command, the commit it ran on, the exit code, the output, and the time. The agent gets the output and a run id (`run:42`) to cite.

An agent cannot write a run itself, so a cited run is proof that the command ran on that commit with that result. A claim with no run behind it ("tests pass") is just a claim.

## The judge

A new session every round, never resumed. It carries no opinion from an earlier round, only the last round's list of what was asked for. One model is enough: the fresh eye comes from a session with no shared context.

Its brief is ordered so that it forms its own view before reading the worker's:

1. The goal, the acceptance, the context, the project's decisions that apply, and the change (the diff against the base where the branch left it).
2. It runs the environment's tests itself as recorded runs, and judges the change.
3. Then the worker's decision log, its recorded runs, and what the last round asked for. It checks the log's claims: evidence that does not resolve, or runs that did not pass, count against the work.

It looks for: every acceptance outcome holding; tests that check behaviour rather than passing whatever the code does (it may run them on the base when that would tell it something, as for a bug fix); placeholders, empty functions, stubs, `TODO`s, disabled or skipped tests standing in for required behaviour, unless the context says another unit fills them in; changes that have nothing to do with the goal; secrets.

It answers with one command:

- `yagura judge approve --runs <its run ids>`: yagura takes the pull request out of draft; the unit is ready.
- `yagura judge changes --finding "<file:line> what is wrong" …`: the findings go straight to the worker, and the unit goes back to building.
- `yagura judge ask --question "…"`: the unit is stuck and its unit lead decides.

## The unit lead

Woken when the unit needs a decision, never on a schedule:

| Wakes on | Typical decisions |
|---|---|
| The worker says it is stuck. | Give it what it needs; start a fresh worker; ask the developer; ask the project lead to change the plan. |
| The judge asks a question. | Answer it, or ask the developer. |
| The judge asked for changes three rounds running (a setting). | Change the approach; fresh worker; ask the project lead to split it; drop. |
| A person or bot comments on the ready pull request. | Send the worker a fix; reply; ask the developer when it changes what the unit must do. |
| CI fails twice on the same head. | Worker fixes; ask the developer when it is the infrastructure. |
| The worker could not resolve a conflict with the base. | Help it; ask the developer; ask the project lead whether the units clash by design. |
| The developer leaves it a note. | Whatever the note asks. |

To know what a worker did, it reads first: the worker's decision log, its hand-offs, its recorded runs, the judge's verdicts, the pull request. Only when those do not answer its question does it resume the worker's session to ask, and that turn changes nothing in the branch.

It answers with one command (`yagura decide <action> --reason "…"`). Its replies to people go on the pull request, signed as the unit lead. A change to the unit's acceptance always needs the developer's approval, or comes from a trusted author.

## The project lead

Plans a project's goal into units: goal, acceptance, context, repo, base, order. Before the plan is applied it checks that the units fit together: that what one unit's acceptance needs is what another unit produces (a library change and the app that uses it agree on what the function returns). It is woken again only when a unit lead says the plan must change.

## The test command

The environment's `test` action says how a repo's tests run (`docs/design/environment-actions.md`): the doctor works it out from the developer's answers and proves it, and the developer can edit it. Workers, judges, and unit leads read every action for their repo in their brief. When there is no `test` action, the agent works out a command, uses it, says so in its decision log, and may offer it with `yagura action propose`.

## The few hard rules yagura enforces

1. Agents push only their own unit's branch, and only forward: yagura's copy of the repo, which a worker's checkout pushes to, refuses a force-push or a push to any other branch, and yagura passes accepted pushes on to the forge. A worker's checkout is its own clone of that copy, sharing its objects; a worktree would share the copy's branches and bypass the check. Only yagura opens, updates, readies, merges, and closes pull requests; agents cannot run `gh pr` or `glab mr`.
2. A unit merges only with the judge's approval of its current head, CI passing on that head, and the developer's merge when the project asks for it.
3. A unit's acceptance changes only with the developer's approval, or from a trusted author.
4. Recorded runs are run by yagura; an agent cannot write one.
5. Every agent ends with its command; one that does not is reminded, then its unit is stuck.
6. Budgets and the account's usage limit hold new work back (DESIGN §29).

Everything else is guidance in the agents' skills and the developer's harness.

## What a unit costs

A unit that is right the first time: one worker session and one judge session. Each round of changes: one resumed worker session and one judge session. The unit lead is woken only for the cases above.
