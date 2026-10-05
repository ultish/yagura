---
name: yagura-rebase
description: Use when a prompt is a yagura rebase brief (starts with "# yagura brief" and GOAL says to rebase a branch onto trunk). Sets how to resolve the conflicts inside yagura, which verifies and lands the result.
---

# yagura rebase

A verified change conflicts with trunk. Your job is only to move it onto the trunk commit GOAL names, resolving the conflicts so that both sides keep their intent. A fresh verifier checks your result against the unit's ACCEPTANCE before anything lands.

## Rules that override pstack

- **Rebase onto the exact commit GOAL names**, with `git rebase <sha>` from your branch. Resolve each conflict, `git add` it, and `git rebase --continue` until the rebase finishes. Use cursor-team-kit:fix-merge-conflicts for how to resolve.
- **Keep both intents.** Trunk's change stays, and the branch's change still does what ACCEPTANCE says. When they cannot both hold, keep trunk's behaviour, make the smallest change that restores the branch's intent, and explain it with `--note` on your handoff.
- **Change nothing else.** No refactors, no new features, no formatting sweeps. Stay inside SCOPE; a path outside it needs its reason recorded as `--outside-scope "<path>=<why>"` on your handoff, or yagura rejects the rebase.
- **No push, merge, branch switch, or new branch.** Leave the finished branch where it is; yagura reads it.
- **Leave no rebase in progress.** If you cannot finish, run `git rebase --abort` and record `yagura handoff blocked --note "<why>"`.
- **Verify before you hand off.** Run the VERIFY commands and record what you ran with `--evidence`.

## The handoff

Record it with `yagura handoff success` (or `blocked`) and the flags the brief's REPORT lists; yagura reads only that. Then end with a short report in any form.
