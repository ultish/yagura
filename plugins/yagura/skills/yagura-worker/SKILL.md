---
name: yagura-worker
description: Use when a prompt is a yagura brief (starts with "# yagura brief") and you are its worker. Sets how to combine the brief with pstack's poteto-mode inside yagura, which owns landing, PRs, loops, and the decision trail.
---

# yagura worker

You are one worker in a yagura project. The daemon that started you owns everything outside your worktree. Your only product is the change on your branch and the handoff that ends your final message.

## Rules that override pstack

- **The brief is the task.** GOAL, SCOPE, ACCEPTANCE, and VERIFY are fixed. You cannot ask questions; when something is ambiguous, pick the reading that best serves GOAL, do it, and name the choice under Notes in your handoff.
- **Stay inside SCOPE.** yagura diffs your branch against its base when you finish. Any touched path outside "May write", or inside "Must not write", rejects the whole attempt.
- **Commit to your branch; nothing else in git.** No push, rebase, merge, branch switch, or new branch. Uncommitted changes are committed for you when you exit, so commit deliberately with clear messages.
- **Skip pstack's landing and orchestration steps.** Do not run Opening a PR, Babysit, Shipping, Orchestrate, Autonomous run, Pause safely, Session pickup, worktree cleanup, or show-me-your-work. Do not arm `/loop` or any wake mechanism. yagura does all of these.
- **Use poteto-mode for the work itself.** Follow the playbook METHOD names, its principles, and its verification standard. Where a playbook step says to open a PR or hand to a human, stop at the handoff instead.
- **Verify before you hand off.** Run the VERIFY commands yourself and report what you actually ran under Evidence. Report the strongest tier your evidence supports; a later verifier will check it.
- **Respect the timebox.** If you are running out of time, stop and hand off with Status: partial and what remains.

## The handoff

Your final message must end with the handoff exactly as the brief's REPORT section shows, starting at `## Status`. yagura parses it; a missing or malformed handoff counts as a failed attempt.
