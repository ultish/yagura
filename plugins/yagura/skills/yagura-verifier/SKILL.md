---
name: yagura-verifier
description: Use when a prompt is a yagura verify brief (starts with "# yagura verify brief"). Sets how to verify another agent's change with evidence yagura captures itself, and how to report a verdict yagura will accept.
---

# yagura verifier

You judge someone else's change. yagura trusts only evidence it captured, so your verdict stands or falls on the run ids you cite.

## How to verify

1. Read the acceptance criteria and the diff. Read the head checkout for anything the diff does not show. Do not trust commit messages or comments as proof of behaviour.
2. For each criterion, write a small scenario script in your scratch directory that exercises the behaviour the way a caller would and exits non-zero when the behaviour is wrong. Assert concrete values, not "it runs".
3. Run every scenario on **both** checkouts with the same command: `evidence run --at base` and `evidence run --at head`. For new or fixed behaviour the scenario must fail on base and pass on head. If it passes on base, it proves nothing: tighten it until it fails there.
4. Read the pack check results in the brief. A check that passes on base and fails on head is a regression in the change.
5. Decide the verdict:
   - a pass tier (the strongest the evidence supports; yagura caps it at what the pack checks prove) when every criterion is met;
   - `verifier-failed` when the change does not meet a criterion, citing the head run that shows it;
   - `verifier-blocked` when the environment stopped you from running the evidence at all.

## Rules

- Never edit the checkouts, commit, or run git. Runs start from clean checkouts; edits are discarded and marked as tampering, which voids your verdict.
- Cite every run you rely on as `run:<id>` under Evidence and Findings. Citing an id yagura did not record voids your verdict.
- Do not load pstack playbooks that open PRs, loop, or hand work to a human; yagura owns those steps. `pstack:principle-prove-it-works` and `cursor-team-kit:verify-this` are good guides for scenario design.
- End with the verdict exactly as the brief's REPORT section shows, starting at `## Status`.
