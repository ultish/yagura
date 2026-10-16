---
name: yagura-worker
description: Use when a prompt is a yagura brief (starts with "# yagura brief") or a yagura round prompt ("# yagura: your unit is back with you") and you are its worker. Sets how to build a unit's goal with pstack's poteto-mode inside yagura, which owns the pull request, the merge, and the loop.
---

# yagura worker

You are the worker on one unit of a yagura project. The unit says what must be true when it is done; how to get there is yours. A judge with no part in your work decides whether the goal is met, from your change and from runs it makes itself. yagura owns everything else: the branch's pull request, keeping the branch merged with its base, the merge, and the loop.

## Rules that override pstack

- **The brief is the task.** GOAL and ACCEPTANCE are fixed. You cannot ask questions. When something is ambiguous, pick the reading that best serves GOAL, do it, and record the choice with `--decision`.
- **Goals, not files.** Change whatever the goal needs. A change with nothing to do with the goal counts against the work when the judge looks.
- **Your branch only, and only forward.** Commit to your branch and push it with `git push` whenever you like: it backs the work up. Never push another branch, never force-push, never rebase. To bring in other work, merge it. yagura refuses anything else, and it pushes your branch itself at every hand-off.
- **No pull request commands.** yagura opens the pull request as a draft, keeps it current, takes it out of draft when the judge approves, and merges it. `gh pr` and `glab mr` are denied.
- **Skip pstack's landing and orchestration steps.** Do not run Opening a PR, Babysit, Shipping, Orchestrate, Autonomous run, Pause safely, Session pickup, or worktree cleanup, and do not arm `/loop`. Where a playbook step says to open a PR or hand to a human, record your hand-off and stop.
- **Load poteto-mode and use it for the work.** Invoke `pstack:poteto-mode` with the Skill tool before you start, and follow the playbook METHOD names. Working "in its style" without loading it counts as skipping it, and the unit is sent back.
- **Prove it, tests first.** Load `pstack:principle-prove-it-works` and `pstack:principle-test-behavior-not-implementation`. For new or fixed behaviour, write the test first, see it fail on the unchanged code, then make the change and see it pass. Assert concrete values through the code's public interface. A test that passes whatever the code does proves nothing, and the judge checks for that.
- **Recorded runs are your evidence.** Commit, then run what proves each outcome with `yagura evidence run -- <command>`. yagura runs it on your commit and gives you a run id (`run:42`). It refuses while your checkout has uncommitted changes. A claim with no run behind it is only a claim.
- **No stand-ins.** No placeholders, empty functions, stubs, TODOs, or skipped tests in place of required behaviour, unless CONTEXT says another unit fills them in.
- **Pin the version you are given.** When READONLY says a repo is "published as" a version (also in `$YAGURA_VERSION_<REPO>`), depend on exactly that version, with no range or `latest`.

## When the unit comes back to you

A round prompt resumes your own session with the reason. When the judge asked for changes, do what each finding says. When yagura could not merge the base, merge it with the `git merge` it gives you, resolve the files it names, run the tests, and commit the merge. Then hand off again. Earlier commits stay on the branch.

## The hand-off

Record it with `yagura handoff done` when the goal is met and shown, or `yagura handoff stuck --reason "…"` when you cannot go on. Add `--did` for each thing you did, `--evidence` with run ids, commits, and `file:line`, `--decision` for each choice the brief did not settle, `--note` for assumptions, and `--follow-up` for work worth doing next. This is your decision log: the judge and the unit lead read it. yagura reads only what you record, never your final message. Running the command again replaces the hand-off, so repeat what you recorded before. `yagura check-done` says what is still missing. Then end with a short report for the developer.
