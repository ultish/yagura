---
name: yagura-pack
description: Use when a prompt is a yagura brief (starts with "# yagura brief") for a pack unit, whose CONTEXT says "This is a pack unit". Sets how to write a verify pack that yagura can run and prove, adapting pstack's create-verification-skill to yagura's pack contract.
---

# yagura pack

You write the verify pack that yagura uses to judge every later change to this repo. The pack is the only thing you change. yagura proves it on your branch head with no agent involved, then lands it on trunk, where every verifier reads it from.

## What to build

- Read pstack's `create-verification-skill` for how to interview a repo: surface, run, drive, observe, isolate. Answer from the codebase; you cannot ask anyone.
- Write the result to the pack directory in SCOPE, not to `.claude/skills/`: `verify.json`, scripts under `bin/`, and one feature doc per user-facing feature under `features/` (what it is, how to reach it, how to drive it, what end state proves it).
- `verify.json` follows the contract in CONTEXT exactly. Unknown fields or a wrong provider fail the proof.
- `doctor` is read-only and fast. `deploy` builds and starts the checkout in the slot, using only the slot's variables for ports and directories, so two slots never collide. `teardown` removes only what `deploy` created and never kills by process name.
- Each check proves one tier. Prefer the repo's own test command for `unit-verified`; add a check that drives the running app for a stronger tier only when `deploy` starts one.
- If this repo publishes something other repos depend on (a library to Nexus with `gradle publish`, a package with `npm publish`, an image to a registry), add the `publish` block from CONTEXT. `command` must publish under `$YAGURA_VERSION` and nothing else (pass it as the version, e.g. `-Pversion=$YAGURA_VERSION`, or `npm version --no-git-tag-version "$YAGURA_VERSION" && npm publish --tag yg`, never to `latest`); `available` must fetch that exact version from the repository, not from a local cache. Use the environment's values for repository addresses; credentials come from the developer's own config.
- A check must pass on the repo as it is today. yagura later runs the same checks on trunk and on each change, and a check that already fails on trunk blocks every verification.

## Prove it before you hand off

- Run the pack the way yagura will: from a clean checkout, with `YAGURA_AT=head`, `YAGURA_SHA`, an empty `YAGURA_EVIDENCE` directory, and stand-in slot variables (a fresh private directory and a free port). Run `doctor`, `deploy`, every check, then `teardown`, and check each exits 0.
- Run `teardown` after every failed try too, so a broken deploy does not strand a process or a port.
- Confirm that files written to `$YAGURA_EVIDENCE` survive the teardown.

## Rules

- Change nothing outside the pack directory. Code that the pack verifies is not yours to fix; if the repo does not build or its tests fail as it is, say so precisely under Notes and hand off with Status: blocked.
- Commit to your branch only; no push, rebase, merge, or branch switch. yagura lands the pack after the proof passes.
- Record your handoff with `yagura handoff` and the flags the brief's REPORT lists, with one `--evidence` per pack command you ran and its exit code. yagura reads only that; then end with a short report in any form.
