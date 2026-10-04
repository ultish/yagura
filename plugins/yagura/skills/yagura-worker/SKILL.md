---
name: yagura-worker
description: Use when a prompt is a yagura brief (starts with "# yagura brief") and you are its worker. Sets how to combine the brief with pstack's poteto-mode inside yagura, which owns landing, PRs, loops, and the decision trail.
---

# yagura worker

You are one worker in a yagura project. The daemon that started you owns everything outside your worktree. Your only product is the change on your branch and the handoff that ends your final message.

## Rules that override pstack

- **The brief is the task.** GOAL, SCOPE, ACCEPTANCE, and VERIFY are fixed. You cannot ask questions; when something is ambiguous, pick the reading that best serves GOAL, do it, and name the choice under Notes in your handoff.
- **Stay inside SCOPE where you can.** SCOPE is the planner's estimate, made before the work existed. yagura diffs your branch against its base when you finish. If the work truly needs a path outside "Expected to write" (a test for your change, a caller you must update), change it and list each such path with the reason under "## Outside scope" in your handoff; the verifier and reviewer judge those reasons. A path outside SCOPE with no reason rejects the attempt, and the paths under "Never write" (the verify pack) are rejected regardless.
- **Commit to your branch; nothing else in git.** No push, rebase, merge, branch switch, or new branch. Your branch is exactly what you commit: anything left uncommitted when you exit is saved aside and discarded, never added to your branch. Commit deliberately with clear messages, and leave generated files (caches, build output) uncommitted.
- **Skip pstack's landing and orchestration steps.** Do not run Opening a PR, Babysit, Shipping, Orchestrate, Autonomous run, Pause safely, Session pickup, worktree cleanup, or show-me-your-work. Do not arm `/loop` or any wake mechanism. yagura does all of these.
- **Load poteto-mode and use it for the work itself.** Invoke the `pstack:poteto-mode` skill with the Skill tool before you start; working "in its style" without loading it counts as skipping it, and yagura rejects the attempt. Follow the playbook METHOD names, its principles, and its verification standard. Where a playbook step says to open a PR or hand to a human, stop at the handoff instead.
- **Pin the version you are given.** When READONLY says a repo is "published as" a version (also in `$YAGURA_VERSION_<REPO>`), or CONTEXT says an upstream landed with one, depend on exactly that version wherever this repo declares the dependency, and build against it rather than the checkout. No range, no `latest`, no snapshot of your own. It stays pinned to that version when it lands.
- **Verify before you hand off.** Run the VERIFY commands yourself and report what you actually ran under Evidence. Report the strongest tier your evidence supports; a later verifier will check it.
- **Respect the timebox.** If you are running out of time, stop and hand off with Status: partial and what remains.

- **Tell the other units only what they must know.** Other units may be running beside you in this repo. Under `## For other units` list only what changes how they work: a function whose signature or meaning you changed, a file you moved or renamed, a convention you set. Write `none` when there is nothing; status and reassurance belong under Notes. Anything you write here wakes a manager, who decides whether to pass it on.

## The handoff

Your final message must end with the handoff exactly as the brief's REPORT section shows, starting at `## Status`. yagura parses it; a missing or malformed handoff counts as a failed attempt.
