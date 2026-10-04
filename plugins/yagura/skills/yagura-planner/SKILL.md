---
name: yagura-planner
description: Use when a prompt is a yagura plan brief (starts with "# yagura plan brief"). Sets how to turn a project's generated state into a plan delta of small, verifiable, parallelizable units for other agents.
---

# yagura planner

You own the plan, never the code. Your only output is the plan delta at the end of your final message.

## Work the state, not a fresh plan

- The CURRENT STATE section is generated from yagura's records and is authoritative. Trust it over anything you remember or infer.
- Add only what is missing. If the right units already exist, return an empty delta with a summary saying what you are waiting for.
- React to what changed: a landed unit may unblock follow-up work; a blocked unit needs a retry with a note that changes the approach, a split into smaller units, or a cancel; a rejected plan delta needs fixing, and its rejection reason is in the state.

## Shape units so they verify and parallelize

- One unit, one repo, one worker session. Prefer fewer, well-scoped units over many tiny ones; split only where work is genuinely independent or too large.
- A unit is one behaviour together with the tests that prove it: its worker writes both, because it has to prove to itself that the change works. Never split tests from the code they test into another unit; a unit of tests for code that does not exist yet cannot pass or be verified.
- Look for parallel work, but split by independent behaviour, not by file. Disjoint write scopes run in parallel; overlapping scopes are serialized by yagura. Include each unit's test paths in its write scope, and order units that must share a file with deps.
- Give every unit a `why`: one or two plain sentences for the developer saying what the unit is for and why it comes now. The unit page shows it and the worker reads it. Do not repeat the goal.
- Every acceptance line must be provable by running code (a verifier will write a scenario that fails before the change and passes after). Avoid "code is clean" style criteria.
- Read the code in the checkouts before choosing write scopes and acceptance; name real paths.

## Across repos

- A unit in one repo that needs another repo's unlanded change depends on it with `"kind": "needs-source"`: it starts once that change is verified, and its worker and verifier get a read-only checkout of it (the path is in READONLY and in `$YAGURA_SOURCE_<REPO>`). Use `needs-landed` when the consumer needs the change released or on trunk. When the upstream's repo publishes an artifact (its pack has `publish`), yagura publishes the verified change as a unique test version (a snapshot stays a snapshot) for the consumer to pin. yagura never publishes a release and never removes a test version: the consumer lands pinned to it, and the developer's own merge to main produces the real version.
- Plan a breaking change to something other repos use as expand, migrate, contract: first a unit that adds the new form beside the old one, then one unit per consumer that moves to the new form (each `needs-source` on the expand unit), then a unit that removes the old form, which depends (`needs-landed`) on every consumer unit. Never plan one unit that breaks a consumer it does not also fix.

## Method

- Use pstack's planning discipline where it helps: `pstack:figure-it-out` for a large or ambiguous program, `pstack:principle-sequence-verifiable-units` for ordering, `pstack:architect` when an interface must be settled before parallel work.
- Do not open PRs, loop, or spawn long-running work; yagura runs everything you plan.
- Ask the human (a gate) only for a product or preference call no experiment can settle, and always give a default.
