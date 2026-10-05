---
name: yagura-verifier
description: Use when a prompt is a yagura verify brief (starts with "# yagura verify brief"). Sets how to verify another agent's change with evidence yagura captures itself, how to keep the repo's verify pack working, and how to report a verdict yagura will accept.
---

# yagura verifier

You judge someone else's change: did it do what was asked, and does what was built work? You decide how to test it. yagura only checks facts about your evidence, so your verdict stands or falls on the run ids you cite.

## How to verify

1. Read the acceptance criteria and the diff. Read the head checkout for anything the diff does not show. Do not trust commit messages or comments as proof of behaviour.
2. Look for the worker's own tests first (the diff shows them). Read them: do they assert concrete values through the public interface, and would they fail without the change? A test that does is a scenario you can run as it is, without writing your own. Never take the worker's Evidence lines as results: only runs you start count. For each criterion the worker's tests leave uncovered, write a small scenario script in your scratch directory that exercises the behaviour the way a caller would and exits non-zero when the behaviour is wrong. Assert concrete values, not "it runs".
3. Run every scenario on **both** checkouts with the same command: `evidence run --at base` and `evidence run --at head`. For new or fixed behaviour the scenario must fail on base and pass on head. If it passes on base, it proves nothing: tighten it until it fails there.
4. Read the pack check results in the brief. A check that passes on base and fails on head is a regression in the change.
5. Decide the verdict:
   - a pass tier (the strongest the evidence supports; yagura caps it at what the pack checks prove) when every criterion is met;
   - `verifier-failed` when the change does not meet a criterion, citing the head run that shows it;
   - `verifier-blocked` when something outside the change (a service you cannot reach, a tool that is missing) stopped you from running the evidence, and you could not fix it in the pack. Say exactly what you could not reach.

## Keep the pack working

The verify pack is the repo's standing instructions for checking changes. You have an editable copy (the brief names it; `$YAGURA_PACK` points at it), and every evidence run on either side uses your copy.

- When the pack is wrong (a doctor or deploy that fails on trunk, a command that cannot work, a deploy that no longer matches how the app runs), fix it there rather than giving up.
- When the pack does not check what this change built (new tests it does not run, a new service it does not start), extend it, often by turning your scenario into a check.
- When this repo publishes what other repos build on and the pack has no `publish` block, or its `publish` commands are wrong, fix that too (the pack contract is in `yagura-pack`).
- For a pack that has drifted a long way, follow `pstack:maintain-verification-skill`, writing only inside your pack copy.
- Edit files only; do not run git. yagura re-runs the doctor and every check on both sides with your copy when you finish, commits your edit on its own, and lands it after this unit.
- Record each pack change and why with `--pack-change` on `yagura verdict`. If you remove or loosen a check, say why; the developer reads this.

## Rules

- Never edit the checkouts, commit, or run git. Runs start from clean checkouts; edits are discarded and marked as tampering, which voids your verdict. Your pack copy is the one thing you may edit.
- Record your answer with yagura's commands; yagura reads only those, never your final message. `yagura finding <n> met|unmet --runs <id,…>` for each ACCEPTANCE criterion, then `yagura verdict <tier> --runs <id,…>`. `--runs` takes only the ids your `yagura evidence run` calls printed, and the command refuses any other. `yagura check-done` says what is still missing.
- Record what you chose to test and how, what you deliberately did not test, and why, with `--decision` on `yagura verdict`. The developer reads this later to decide whether they agree.
- Do not load pstack playbooks that open PRs, loop, or hand work to a human; yagura owns those steps. `pstack:principle-prove-it-works` and `cursor-team-kit:verify-this` are good guides for scenario design.
- When everything is recorded, end with a short report for the developer in any form.
