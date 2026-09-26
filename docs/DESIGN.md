# yagura 櫓 — design

Status: agreed design, ready for phase 1 · 2026-09-26

yagura runs long-lived engineering **projects** with coding agents: it plans work into units, runs many agents in parallel in isolated worktrees, verifies their output against real deployed systems, and lands what is proven. It runs on one machine in an air-gapped network, drives whatever agent CLI the developer uses, and shows everything in a web dashboard.

It succeeds kurukuru and borrows heavily from upstream pstack (`poteto-mode` playbooks: orchestrate, autopilot-full, shipping) and Cursor's `orchestrate` plugin.

## 1. Goals and non-goals

**Goals**

- Run many projects at once; a project is a goal, not a repo.
- Parallel agents with dynamic, LLM-proposed decomposition, enforced mechanically.
- Verification that cannot be faked: evidence from running systems, recorded by the daemon.
- No long-lived LLM context. Every LLM call is fresh and bounded; state lives in the store.
- Harness-agnostic (claude / codex / grok / any CLI) and methodology-agnostic (pstack by default).
- Works air-gapped: no cloud services, internal GitLab, Nexus, dev kube.

**Non-goals (for v1)**

- Multi-user / multi-machine scheduling. One daemon, one box.
- A raw-LLM-API agent loop. yagura drives harnesses; it does not re-implement one.
- Replacing CI. CI results are an input to a verdict, never the verdict.

## 2. Principles

1. **The daemon owns the truth; LLMs propose.** Scheduling, state transitions, leases, verdict acceptance, and landing are deterministic code. LLMs plan, write briefs, do work, and judge evidence. (kurukuru's engine lesson; orchestrate's "a script with a JSON state file keeps its footing".)
2. **No long-running chat.** The coordinator is a program. The planner is invoked fresh at drain points with a *generated* state snapshot, never an LLM summary of a summary.
3. **Proof, not narration.** A unit is verified only when the daemon holds artifacts that prove it, from a verifier that did not write the code, at the current head SHA.
4. **One writer per resource.** One unit writes one repo through one worktree; one lease per environment slot; one lander per repo.
5. **The brief is the product.** Workers cannot ask questions. A brief missing a field is not spawnable.
6. **Generate, then prove.** Verify packs and environments are generated or configured, then must pass a real end-to-end run before they are trusted.

## 3. Domain model

```
Environment ─┐ (shared, top-level)
             │ provider: kube-namespace | docker-compose | local-process | ios-sim | …
             │ capacity, access refs, conventions, artifact-version scheme
Repo ────────┤ git URL, default branch, forge adapter (glab | gh | none), verify pack path
             │
Project ─────┘ goal, done-predicate, min verdict tier, standing orders, env, repos[]
  └─ Unit      one repo, write scope, deps, brief, type
       └─ Attempt   one harness process: worktree, branch, pid, log, handoff, exit
            ├─ Lease      environment slot held during live verification
            ├─ Artifact   evidence file (screenshot, transcript, log, response) with hash
            └─ Verdict    tier + evidence refs, keyed by (repo, head SHA, dep SHAs)
```

| Entity | Notes |
|---|---|
| **Environment** | Shared across projects. Created in the dashboard, validated by the provider's `doctor` probe before it is selectable. Holds credential *references*, never secrets. |
| **Repo** | Registered once by URL. Many projects can target it. Holds the forge adapter choice and the qualifier scheme override. |
| **Project** | `goal`, `predicate` (checkable, e.g. "p95 latency ≤ 80% of baseline on dev-kube", "all 12 units landed ≥ deployed-verified"), `min_tier`, `standing_orders` (numbered lines pasted into every brief), `environment`, `repos[]`, `budget` (wall clock, max attempts, max in-flight). |
| **Unit** | Types: `plan`, `work`, `verify`, `land`, `release`, `pack` (create/repair a verify pack), `measure`, and the babysit fix types `rebase`, `ci-fix`, `review-triage` (§15). Exactly one writable repo. Declares `write_scope` globs, `deps[]` with kind `needs-source` or `needs-landed`, `acceptance[]`, `verify` recipe, `measurements[]`, `timebox`. |
| **Attempt** | One execution of a unit by a harness. Retries create new attempts; the unit keeps its identity. |
| **Verdict** | Tier + artifact refs + the SHAs it was produced at. Voided automatically when any keyed SHA changes. |

### Unit state machine

```
draft → ready → running → handed_off ─┬→ verifying → verified → landing → landed
          ↑         │                 │        │
          │         └→ failed ────────┘        └→ rejected ─→ (new work attempt)
          └──────── blocked (gate open) ──── abandoned
```

Transitions are daemon-only. Agents never set state; they produce handoffs, and the daemon classifies them.

## 4. Architecture

```
┌──────────── yagura daemon (one process) ─────────────┐
│  HTTP API + SSE ── dashboard (React)                 │
│  Scheduler ── readiness, scopes, leases, caps        │
│  Runner ───── spawns harness processes, streams logs │
│  Verifier ─── runs verify-pack commands, stores      │
│               artifacts, trunk-vs-head comparisons   │
│  Lander ───── merge / publish / MR per repo, serial  │
│  Planner ──── invokes fresh planner LLM at drains    │
└───────┬───────────────┬───────────────┬──────────────┘
   SQLite store     worktrees/       harness CLIs, git,
   + files          (disposable)     kubectl, gradle, glab
```

- **Target:** each developer's own RHEL9 VM in the air-gapped network (Windows host), plus macOS for developing yagura. The VM already reaches kube, Nexus, and GitLab with the developer's `glab`, certificates, and proxies; npm packages and container images are available.
- **One daemon per developer**, on their VM. The daemon serves the dashboard's static assets itself (one process, one port); no container is needed for the UI.
- **Access from the Windows host:** bind to the VM's hostname (`YAGURA_BIND=<vm-hostname>` or `0.0.0.0`), open the port in the VM firewall, and token auth is required whenever the bind is not localhost.
- **Stack:** TypeScript on Node 20+, pnpm monorepo (`apps/daemon`, `apps/web`, `packages/core`), Hono API + SSE, better-sqlite3 (WAL), React + Vite dashboard. The hana apps (e.g. risu) are the reference for UI and API conventions.
- **Runs natively on the host**, not in a container, for v1: the daemon spawns host tools (`claude`/`codex`, `git`, `gradle`, `kubectl`, `glab`) with the developer's own logins and kubeconfig. A container image that bundles those tools and mounts credentials is a later packaging option.
- **CLI:** `yagura` talks to the daemon API (`yagura project new`, `yagura env doctor`, `yagura status`). Agents call a restricted subset (`yagura artifact add`, `yagura note`) scoped by a per-attempt token.

## 5. Store

The store is **outside every git repo**, owned by the daemon, the only writer. This removes kurukuru's cross-worktree locking problem.

```
~/.yagura/
  yagura.db                 SQLite (WAL): all tables below
  environments/<env>/       profile.md (prose for agents), provider.json
  projects/<slug>/
    standing-orders.md      numbered lines, pasted verbatim into every brief
    status.md               GENERATED from tables at each drain; never hand-edited
    decisions.tsv           show-me-your-work trail (planner + daemon decisions)
    gates.md                GENERATED view of open human gates
    briefs/<unit>.md        rendered brief, exactly what the agent received
    handoffs/<unit>.<n>.md  verbatim final message per attempt (+ synthetic failure handoffs)
    artifacts/<sha256>      evidence blobs, content-addressed
    logs/<unit>.<n>.jsonl   harness stream
  worktrees/<repo>/<unit>.<n>/
  cache/repos/<repo>.git    bare mirror; worktrees are added from it
```

Core tables: `settings` (layered config, §16), `environments`, `repos`, `projects`, `project_repos`, `units`, `unit_deps`, `attempts` (incl. plugin versions and models used), `leases`, `artifacts`, `verdicts`, `measurements`, `gates`, `mr_state` + `mr_decisions` (§15), `events` (append-only; the dashboard's SSE feed and the audit log), and an FTS5 index over handoffs, briefs, and log text (§17).

Bootstrap settings (§16) live in `~/.yagura/yagura.yaml` or environment variables, since they are needed before the database opens.

Files that agents read (standing orders, briefs, handoffs, status) are markdown so any harness can read them with no yagura client.

## 6. Project lifecycle

1. **Frame** (human + planner). Goal → predicate, min tier, environment, repos, budget. If one agent could finish it inside one session, the planner says so and the project runs as a single `work` unit (orchestrate's "collapse" rule).
2. **Pack check.** Every repo in the project needs a verify pack that satisfies the environment's provider type and has passed its proof run. Missing or stale → a `pack` unit is the first unit.
3. **Pilot.** One unit end to end: brief → work → verify → land. It falsifies the brief template, verify recipe, and unit size while that costs one agent. Skipped for clone-like units.
4. **Scale.** Rolling window up to the project's in-flight cap; refill as units finish. Never blocking batches.
5. **Drain.** At drain points the daemon classifies new handoffs, then invokes the planner (§8).
6. **Land.** Continuous, from the first verified unit. Stop spawning at ~70% of the wall-clock budget and land what is verified.
7. **Close.** Predicate checked on the real artifact by a final `verify`/`measure` unit; every unit reconciled to a terminal state; lessons appended to standing orders or the pack.

## 7. Briefs and handoffs

### Brief (rendered by the daemon, never free-written)

```
GOAL         one sentence, executable by a stranger
REPO         <repo>, worktree <path>, branch <branch>, starts at <sha>
SCOPE        may write: <globs>   may not write: <globs>
CONTEXT      files/paths to read; upstream handoffs pasted verbatim (deps are context relays)
READONLY     related repos mounted read-only at <path> @ <sha>
ACCEPTANCE   one checkable criterion per line
VERIFY       verify-pack commands + tier required + gotchas
ENV          (verify units) lease vars: YAGURA_NAMESPACE, YAGURA_BASE_URL, ports, artifact version
TIMEBOX      minutes; on expiry return partial handoff
FORBIDDEN    no rebase/force-push/merge; nothing outside SCOPE; do not edit the verify pack (unless a pack unit)
METHOD       role overlay + pack instructions, e.g. "use yagura-worker; pstack:poteto-mode, playbook: bug-fix"
REPORT       handoff format (below)
STANDING     standing-orders.md verbatim
```

A unit whose brief cannot fill GOAL, SCOPE, ACCEPTANCE, and VERIFY is refused at spawn.

### Handoff (the agent's final message; saved verbatim)

Adopted from orchestrate: `## Status` (success | partial | blocked) · `## Branch` · `## What I did` · `## Measurements` · `## Verification` (self-reported tier) · `## Evidence` (artifact ids) · `## Notes, concerns, deviations` · `## Suggested follow-ups`.

If the process dies or ends without the structure, the daemon writes a **synthetic failure handoff** with a classified failure mode: `timebox | context-exhausted | oom | network | tool-error | harness-error | unknown`.

## 8. Planning and dynamic parallelism

The planner is a fresh harness call, not a standing session.

- **Input:** generated `status.md` (unit table, verdicts, open gates, frontier per repo), new handoffs since the last drain, standing orders, predicate, and budget. Size-bounded by construction.
- **Output:** a **plan delta** JSON validated against a schema: `add[]` units, `amend[]` (brief fields of not-yet-started units), `cancel[]`, `gates[]` (questions for the human with a default), `predicate_check` (optional measure unit).
- **Daemon enforcement on apply:**
  - schema-valid, every new unit has a fillable brief, deps acyclic;
  - `write_scope` overlap within a repo → the later unit gets an implicit dependency (serialized), never concurrent;
  - budget and in-flight caps respected;
  - decision recorded in `decisions.tsv`.
- **After work:** the diff's touched paths must be inside `write_scope` (else `rejected: scope`); `git merge-tree` against the repo frontier must be clean (else the daemon creates a rebase `work` unit).

Parallelism is therefore dynamic (the planner proposes any shape at any drain) but safe (the daemon decides what actually runs together).

## 9. Scheduler

A unit is **ready** when: deps satisfied (`needs-source` → upstream has a verdict ≥ its required tier; `needs-landed` → upstream landed), no running unit overlaps its write scope in the same repo, project in-flight cap not hit, no andon on the project.

- **Leases.** Verify units that need a live environment request a lease; they wait in a per-environment queue. Capacity is per environment, shared by all projects. The provider creates the slot (e.g. namespace `yg-<project>-<unit>-<n>`) and returns connection vars; release always tears down, including after crashes (lease reaper on startup).
- **Retries by failure mode** (orchestrate): `timebox | context-exhausted | oom` → planner must split or narrow; `network` → retry as-is; `tool-error | harness-error` → retry with another harness/model if configured; `unknown` → retry once. After 2 failed attempts the unit is `blocked` and surfaces to the planner, not retried blindly.
- **Liveness** is the daemon's own knowledge: it owns the pid, the stream, and the exit code. No "is it alive" guessing. A unit that exceeds its timebox with no side effect (commit, artifact, stream progress) is killed and gets a synthetic handoff.
- **Andon.** A project-level stop (dashboard button or planner gate) halts new spawns; in-flight attempts finish.

## 10. Harness adapters

```ts
interface HarnessAdapter {
  id: string                               // "claude", "codex", "grok", "custom"
  command(brief: RenderedBrief, opts: RunOpts): { argv: string[]; env: Record<string,string>; stdin?: string }
  parse(line: string): HarnessEvent | null // stream → text/tool/cost/usage events
  finalMessage(events: HarnessEvent[]): string | null
  permissions: PermissionMapper            // yagura policy → harness flags
}
```

- Built-ins: `claude -p --output-format stream-json`, `codex exec --json`, grok CLI. `custom` takes an argv template and treats stdout as the final message.
- The LLM endpoint is harness config (e.g. `ANTHROPIC_BASE_URL` for the internal endpoint); yagura never sees it.
- Skill loading: Claude sessions use the developer's installed plugins (pstack, cursor-team-kit) and get yagura's overlays via `--plugin-dir <YAGURA_SKILLS_DIR>`; other harnesses get METHOD lines that point at skill files on disk.
- Every spawned process gets `YAGURA_ATTEMPT=<id>` (plus `YAGURA_PROJECT`, `YAGURA_UNIT`, `YAGURA_ROLE`). Sessions inherit the developer's full harness config, including hooks, so hooks that should not run inside yagura (e.g. a SessionStart hook that forces repo indexing) can check `YAGURA_ATTEMPT` and skip.
- **Models:** by default yagura passes no model and the harness uses its own configured default. A model can optionally be set per role, globally or per project (`claude --model <name>`); the adapter maps it to the harness's flag.
- A project can set different harnesses per unit type (e.g. work on one, verify on another) to get a second model family where one is available.

## 11. Methodology packs

**pstack-claude is the default and required pack, loaded into every session.** Upstream pstack ([cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)) is a Cursor plugin; yagura uses the Claude Code port, [ultish/pstack-claude](https://github.com/ultish/pstack-claude). In this doc "pstack" means that port unless it says "upstream".

**yagura uses the developer's own harness setup as-is.** The pstack-claude repo holds two Claude Code plugins, and both are required:

- `plugins/pstack` — poteto-mode, playbooks, principles, swarm/arena/interrogate, create/maintain-verification-skill (plugin 0.5.0 at time of writing);
- `plugins/cursor-team-kit` (plugin 0.1.1) — the skills poteto-mode calls out to: `control-ui`, `control-cli`, `verify-this`, `deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, and PR/ship helpers.

The developer installs them from the `pstack-claude` marketplace and runs `/setup-pstack` once, exactly as for interactive use. yagura does not copy, pin, or configure pstack; harness sessions run as the developer and pick up their installed plugins, `pstack-models.md`, and `CLAUDE.md`. Updates flow upstream pstack → pstack-claude (its `docs/upstream-sync.md`) → the developer's `/plugin update`, with no yagura release. The port's gaps versus upstream (orchestrate, autopilot, shipping, Graphite-based landing) do not matter: those are the playbooks yagura's daemon replaces.

What yagura does own:

- **Doctor, not setup.** Settings and `yagura doctor` check that both plugins are installed and enabled at or above a minimum version, that `pstack-models.md` exists, and that each model it names answers on the endpoint. Failures show as warnings with the fix ("run `/setup-pstack`"); yagura never edits the harness config.
- **Provenance.** Each attempt records the plugin versions and models it ran with, so a mid-project pstack update is visible in agent history.
- **Role mapping** (the manifest below) and the role overlays.
- **Non-Claude harnesses** read skill files by path from the installed plugin directory (or a configured checkout); nothing is copied.

### Manifest

```json
{ "name": "pstack-claude",
  "requires": { "pstack@pstack-claude": ">=0.5.0", "cursor-team-kit@pstack-claude": ">=0.1.1" },
  "roles": {
    "worker":   { "entry": "pstack:poteto-mode",
                  "playbooks": ["bug-fix", "feature", "refactoring", "perf-issue", "hillclimb",
                                "prototype", "visual-parity", "runtime-forensics", "trace-forensics",
                                "investigation", "authoring-a-skill"],
                  "skills": ["cursor-team-kit:deslop", "pstack:no-comments"] },
    "verifier": { "entry": "pstack:poteto-mode",
                  "skills": ["pstack:principle-prove-it-works", "pstack:blast-radius", "pstack:interrogate",
                             "cursor-team-kit:control-ui", "cursor-team-kit:control-cli",
                             "cursor-team-kit:verify-this"] },
    "planner":  { "skills": ["pstack:figure-it-out", "pstack:architect",
                             "pstack:principle-sequence-verifiable-units"],
                  "playbooks": ["multi-phase-plan"] },
    "pack":     { "skills": ["pstack:create-verification-skill", "pstack:maintain-verification-skill",
                             "cursor-team-kit:control-ui", "cursor-team-kit:control-cli"] },
    "rebase":   { "skills": ["cursor-team-kit:fix-merge-conflicts"] },
    "ci-fix":   { "entry": "pstack:poteto-mode", "playbooks": ["bug-fix"],
                  "skills": ["cursor-team-kit:fix-ci"] },
    "review-triage": { "entry": "pstack:poteto-mode",
                       "references": ["plugins/pstack/skills/poteto-mode/references/bugbot-triage.md"] }
  },
  "replacedByDaemon": ["pstack:orchestrate", "pstack:autopilot-full", "pstack:autopilot-stack",
                       "pstack:shipping", "pstack:babysit", "pstack:opening-a-pr",
                       "pstack:autonomous-run", "pstack:pause-safely", "pstack:session-pickup",
                       "pstack:worktree-cleanup", "pstack:show-me-your-work",
                       "cursor-team-kit:new-branch-and-pr", "cursor-team-kit:review-and-ship",
                       "cursor-team-kit:get-pr-comments"] }
```

The planner picks a playbook per unit from the role's allowed list; the daemon renders METHOD from the manifest. Model routing inside pstack's fan-out skills comes from the developer's `pstack-models.md`; yagura only chooses the top-level model per role (§16). Some skills use Claude-only features (the Agent tool for swarm/arena, `/loop`); roles that need them run on the Claude harness, or the overlay for another harness tells the worker to skip fan-out.

### Roles

| Role | pstack it uses |
|---|---|
| Worker | poteto-mode work playbooks; all principles; architect, tdd, no-comments, unslop, deslop; swarm/arena inside its own worktree and timebox |
| Verifier | prove-it-works, blast-radius, interrogate lenses, control-ui / control-cli / verify-this, plus the repo's verify pack |
| Planner | figure-it-out, multi-phase-plan, sequence-verifiable-units, architect, principles |
| Pack unit | create-verification-skill, maintain-verification-skill, control-ui / control-cli |
| Rebase / CI-fix / review-triage (§15) | fix-merge-conflicts; bug-fix playbook + fix-ci; bugbot-triage rubric |
| **Replaced by the daemon** | orchestrate, autopilot-*, shipping, babysit, opening-a-pr, autonomous-run, pause-safely, session-pickup, worktree-cleanup, show-me-your-work; cursor-team-kit's new-branch-and-pr, review-and-ship, get-pr-comments |

### Role overlays

pstack playbooks assume the agent is its own orchestrator: poteto-mode ends every playbook with *Opening a PR*, babysit runs a `/loop`, show-me-your-work keeps its own trail. Inside yagura that competes with the daemon. yagura ships small **overlay skills** — `yagura-worker`, `yagura-verifier`, `yagura-planner`, `yagura-pack`, `yagura-ci-fix`, `yagura-review-triage` — as a plugin in `YAGURA_SKILLS_DIR`, loaded alongside the developer's pstack in every session (§10). Each says:

- You are running inside yagura as role X. Use pstack with playbook Y.
- Skip every landing, PR, merge, loop, babysit, and decision-trail step; the daemon owns them.
- Do not spawn long-lived loops or wake mechanisms. Stay inside your timebox.
- End with the yagura handoff format. Where this overlay and pstack disagree, the overlay wins.

pstack itself is never edited, so upstream updates drop in unchanged. Overlays are versioned with yagura, since they encode yagura's contracts.

## 12. Environments and providers

| Provider | create slot | connection vars | teardown |
|---|---|---|---|
| `kube-namespace` | `mode: create` → `kubectl create ns yg-…` + labels; `mode: pool` → lease one of a configured list of pre-created namespaces | `YAGURA_NAMESPACE`, `KUBECONTEXT`, `YAGURA_BASE_URL` (ingress pattern) | create: delete namespace · pool: delete only yagura-labelled resources, keep the namespace |
| `docker-compose` | project name `yg-…`, allocated ports | `COMPOSE_PROJECT_NAME`, ports | `compose down -v` |
| `local-process` | allocate ports + data dir | ports, `YAGURA_DATA_DIR` | kill process group, rm dir |
| `ios-sim` | clone simulator | `SIM_UDID` | delete clone |

Whether a developer can create namespaces varies, so `kube-namespace` supports both modes per environment. In pool mode capacity = pool size. A pool limits **concurrent live verifications**, not agents: workers, builds, and unit-level checks still run in parallel, and only lease-requiring verify steps queue for a free namespace.

An environment = provider + access refs + capacity + **conventions** + **artifact-version scheme**. Creating one runs the provider `doctor` (reach cluster, create+delete a probe namespace, pull from the registry); an environment that never passed `doctor` is not selectable. Editing a shared environment lists dependent projects and re-runs `doctor`. `profile.md` is the prose for agents; checkable conventions compile into `doctor` assertions (kurukuru's `setup-conformance` idea).

## 13. Verification

### Verify pack (lives in each repo, e.g. `.agents/verify/`)

```
verify.json        provider type, commands, feature map index, tiers each command can prove
bin/doctor         is this instance worth driving? (read-only)
bin/deploy         build + deploy head into the leased slot (reads YAGURA_* vars only)
bin/drive <feat>   exercise a feature through the real user path; write evidence to $YAGURA_EVIDENCE
bin/teardown       remove only what deploy created
features/*.md      one per user-facing feature: how to reach, how to drive, observable end state
```

Generated by a `pack` unit (pstack `create-verification-skill`, adapted to this contract) from the repo + the environment profile. **Not trusted until its proof run passes**: deploy into a leased slot, drive one feature, capture evidence, tear down, evidence still present. Maintained by periodic `pack` units (`maintain-verification-skill`).

### Tiers

`deployed-verified` > `live-local-verified` > `e2e-verified` > `unit-verified` > `build-only` > `verifier-blocked` / `verifier-failed`.

The project's `min_tier` gates landing. `verifier-blocked` is never a pass.

### Verification outcomes → unit state

Only a code fault sends a unit back to work; environment and verifier problems never burn a work attempt.

| Outcome | Target unit | Next |
|---|---|---|
| `verifier-failed` (code wrong, or scenario passes on trunk too) | `verifying → rejected → ready` | new work attempt with the verifier's findings in its brief; counts toward `max_attempts`, then `blocked` |
| `verifier-blocked` (environment broken) | stays `verifying` | re-verify when the environment's doctor passes; repeated → `blocked` + gate |
| pass below `min_tier` | stays `verifying` | a stronger verify unit; if none is possible (no proven pack) → `blocked` + a `pack` unit proposed |
| verifier attempt died with no verdict | stays `verifying` | retry the verify unit; after 2 → `blocked` |
| pass ≥ `min_tier` | `verifying → verified` | waits for the lander; `needs-source` dependents may start |

`verified` is a distinct state because it is the trigger for `needs-source` dependents, the queue for serialized landing and `merge: human`, and the state a voided verdict falls back from. Daemon-run units (`land`, `release`) pass through `handed_off` like every other unit; the UI labels it "completed" for them.

### Anti-fake rules (enforced by the daemon)

1. **The daemon runs the commands.** `deploy`/`drive` run as daemon subprocesses inside the lease; outputs become content-addressed artifacts. The verifier LLM designs the scenario and judges evidence; it cannot supply evidence the daemon did not capture.
2. **Verdicts cite artifacts.** A verdict referencing unknown or foreign artifact ids is rejected.
3. **Verifier ≠ author.** Separate attempt, fresh context, sees acceptance + diff + verify recipe, not the worker's narrative.
4. **Trunk vs head.** Every behavioral verdict runs the scenario on the frontier and on the head. Bug fix: must fail on trunk, pass on head. Feature: trunk shows absence. Refactor: identical outcomes. Passing on both for a bug fix → `verifier-failed: scenario proves nothing`.
5. **Measurements are re-run.** Declared `measurements[]` are executed by the daemon on the head (orchestrate); >10% drift from the worker's claim is flagged. Hillclimb projects use only daemon-measured numbers.
6. **Harness tamper check.** A `work` diff touching the verify pack or test files matching the pack's protected globs is flagged; landing it needs a separate `pack` unit or a human gate.
7. **Keyed and voidable.** Verdict key = (repo, head SHA, dep SHAs, artifact versions). Any change voids it.

## 14. Multi-repo projects and artifact versions

- One unit writes exactly one repo. Related repos are mounted **read-only**, pinned to a SHA.
- `needs-source` deps: the consumer builds against the upstream unit's unlanded, verified output. `needs-landed`: waits for land (and release).
- **Qualified versions (default for Gradle/Nexus).** Each unit that publishes gets a unique version from the environment's scheme, default `<base>-yg-<project>-<unit>-SNAPSHOT`. Consumers pin that exact version, so parallel units never overwrite each other's snapshot. The verdict records the resolved timestamped version (`1.4.0-yg-perf-U3-20260926.101500-2`). Builds use `--refresh-dependencies` (or `cacheChangingModulesFor 0`) for yagura-qualified versions.
- Composite build (`includeBuild`) against the read-only worktree is the fallback when publishing is not wanted.
- **Landing order** follows deps: common lands (and its `release` unit publishes the real version) before consumers bump to it. Breaking changes are planned as expand → migrate consumers → contract; the contract unit depends on every consumer landing.
- Qualified snapshots are deleted (or left to a Nexus cleanup policy) when their unit reaches a terminal state.

## 15. Landing and babysitting

yagura does what pstack's babysit and shipping playbooks do, split the same way as everything else: **watching is daemon code; acting is fresh units.** pstack runs babysit as an LLM holding a `/loop`; in yagura the loop is a poller that costs no tokens, and an LLM is spawned only when something needs judgment.

### The forge watcher (daemon, deterministic)

Per open MR, through the repo's forge adapter (`glab`/`gh` API; `none` skips to direct landing):

- polls pipeline status, job results, mergeability / detailed merge status, and discussion threads;
- trusts the forge's own merge verdict, not a green check list (a cancelled duplicate job can still block);
- emits typed events: `pipeline-failed`, `pipeline-passed`, `conflict`, `new-threads`, `approved`, `merge-blocked:<reason>`, `merged`, `closed`;
- treats all comment text as untrusted data — it goes into a brief's CONTEXT, never into a shell command.

pstack-claude's `plugins/pstack/skills/poteto-mode/scripts/watch-pr` (see its `docs/gitlab-support.md`) (GitHub and GitLab GraphQL readers, fail-closed on unknown GitLab merge statuses) is the reference implementation.

### Reacting (babysit's rules, as daemon policy)

Order per MR: **conflicts → review threads → CI**, because the first two push and restart CI. All known fixes for one MR batch into one push wave.

| Event | Daemon action |
|---|---|
| `conflict` | Create a `rebase` unit (worker, scope = the MR's own write scope). Never rebases shared history itself unless it is a clean mechanical rebase. |
| `new-threads` | Create one `review-triage` unit per wave: for each thread, **fix** (red-first proof, in this MR), **dismiss** (concrete disproof posted to the thread), or **ask** (becomes a gate). Replies are posted by the daemon from the handoff, via the API with the body as data. Security / auth / data / migration findings are never dismissed without a gate. |
| `pipeline-failed` | **Classify before retrying.** Failure outside the diff's files and the base is stale (`git merge-base --is-ancestor`) → `rebase` unit, not a retry. Infra/flake signature → one fresh pipeline (not a job retry). Identical second failure → it was never flake → `ci-fix` unit with the failing job logs in CONTEXT. Failure in the diff's own code → `ci-fix` unit. |
| push from any fix unit | New head SHA → verdict voided → re-verify per the patch-id rule below → watcher re-armed. |
| `approved` / human review pending | A wait, not a blocker. Shown on the dashboard; nothing is spawned. |
| `merged` | Advance the frontier; void and re-queue dependent verdicts; start the retro watch. |

Budgets: fix units count against the unit's attempt budget; after 2 failed fix waves on the same MR it becomes a gate.

### MR state and the dossier

No LLM holds a PR's context between polls. The watcher's memory is an `mr_state` row per MR: head SHA, last pipeline id, processed thread ids, fix-wave count, and an **MR decision log** (`thread id → fixed | dismissed | asked, reason, commit`). It acts only on deltas, so an old thread never triggers a second triage.

Each fix unit starts fresh with a **dossier** the daemon assembles from the store:

- the unit's original brief and acceptance (what this MR is for);
- the current diff against its base;
- prior handoffs and the current verdict;
- the MR decision log — so a new wave does not re-litigate a dismissed thread or undo an earlier fix ("thread 41 dismissed in wave 1: X; do not reopen unless the reviewer added new evidence");
- for CI: only the failing jobs, trimmed to the error region.

The dossier is built from rows, never from an LLM summary of earlier waves, and it is size-bounded (resolved threads collapse to one line; logs are trimmed), so the tenth fix wave has the same small, accurate context as the first.

### Landing sequence

Per repo, one lander, serialized:

1. Unit is `verified` at ≥ `min_tier` and the verdict key still matches the current head.
2. Rebase onto the frontier if needed. **Patch-id rule** (pstack shipping): if the base-to-head `git patch-id` is unchanged, the code verdict holds and only build + CI re-run; if it changed, re-verify.
3. Land by the repo's forge adapter: `none` → fast-forward / merge push; `glab` / `gh` → **one MR per unit**: push with MR (`-o merge_request.create` works without API access), babysit as above until the forge reports mergeable, then merge. Whether yagura may click merge is a per-project setting (`merge: auto | human`); `human` stops at merge-ready and raises a gate.
4. `release` units publish real versions after land when a downstream `needs-landed` dep waits on them.
5. **Retro watch** (after merge): watch trunk's post-merge pipeline and later reverts. A post-merge break creates a `ci-fix` unit against trunk (or a revert unit if the project allows auto-revert).

## 16. Configuration

Settings are layered; a narrower layer overrides a wider one: **global → environment → repo → project**. The dashboard's **Settings** tab edits the global layer; each environment, repo, and project page has its own settings panel. Every setting shows its **effective value and which layer set it**. Settings live in SQLite, are validated by one schema, and can be exported/imported as YAML (to share a setup with a teammate or rebuild a box).

A few settings must be known before the database opens. They come from environment variables or `~/.yagura/yagura.yaml`, and are shown read-only in the UI:

| Bootstrap | Default | Purpose |
|---|---|---|
| `YAGURA_HOME` | `~/.yagura` | store, worktrees, artifacts, logs |
| `YAGURA_PACKS_DIR` | `$YAGURA_HOME/packs` | pack manifests (role mappings); skills themselves come from the harness's installed plugins |
| `YAGURA_SKILLS_DIR` | bundled with yagura | yagura's own overlay skills (`yagura-worker`, …); override to develop them |
| `YAGURA_BIND` / `YAGURA_PORT` | `127.0.0.1` / `7300` | dashboard + API listener |
| `YAGURA_TOKEN_FILE` | `$YAGURA_HOME/token` | dashboard/API auth when bound beyond localhost |

### Global (Settings tab)

| Group | Settings |
|---|---|
| **Concurrency** | `max_parallel_agents` (host-wide cap on running harness processes); `max_parallel_per_harness` (endpoint rate limits); `max_parallel_verifies` (heavy local builds); `planner_concurrency` |
| **Harnesses** | per harness: binary path, extra args, permission mode, env refs (e.g. `ANTHROPIC_BASE_URL`), enabled; **default harness per role** (worker / verifier / planner / …); optional **model per role** (unset = harness default) |
| **Packs** | active pack manifest; required plugin versions; overlay version; doctor status of the harness setup (plugins installed/enabled, `pstack-models.md` present, its models reachable) |
| **Timeouts & retries** | default timebox per unit type; max attempts per unit; fix-wave cap per MR (§15); stall timeout (no stream progress) |
| **Git** | agent commit identity (name/email), commit message convention (e.g. Conventional Commits), branch naming (`yg/<project>/<unit>`), mirror refresh interval |
| **Forge** | `glab` / `gh` paths, token refs per host, watcher poll interval, flake signatures (regexes classed as infra) |
| **Storage** | worktree retention (delete N days after terminal), artifact and log retention, disk-usage warning threshold |
| **Budgets** | optional daily token/cost ceiling where the harness reports usage; action at ceiling (pause spawns / gate) |
| **Notifications** | optional webhook or email relay inside the network for gates, andon, project done |
| **Security** | allowed bind addresses, token rotation, secret-ref backends (file, env, OS keychain) |

### Environment

Provider settings, capacity (leases), access refs, conventions, **artifact-version qualifier scheme**, lease timeout, teardown policy (always / keep on failure for debugging).

### Repo

Default branch, forge adapter, verify pack path, protected globs (tamper check), qualifier scheme override, build flags (e.g. `--refresh-dependencies`), required CI jobs, whether direct push to trunk is allowed.

### Project

`max_in_flight` (≤ global cap), `min_tier`, `merge: auto | human`, auto-revert on post-merge break, wall-clock budget and landing cutoff (default 70%), harness per role overrides, pack manifest, planner drain cadence, standing orders, andon.

The scheduler always applies the tightest cap in force: a unit starts only if the global, per-harness, per-environment (leases), and per-project caps all have room.

## 17. Dashboard

- **Projects** list: predicate progress, in-flight, blocked, open gates.
- **Project** view: unit graph (deps, repo lanes, scope overlaps), live attempt logs (SSE), handoffs, verdicts with artifact viewer (screenshots, transcripts, diffs), decisions trail, andon.
- **Gates** inbox: every open human question across projects, with the default that applies on timeout.
- **Environments**: create/edit, doctor results, lease occupancy and queue.
- **Repos**: verify-pack status (proven / stale / missing), frontier, landing queue.
- **Settings**: global configuration (§16) with effective-value/source display, YAML export/import, live counts against each concurrency cap.

### Agents: the portal's core

The dashboard is the developer's window into every agent yagura has ever run. Every attempt is a row in `attempts` (never deleted; only its bulky log/artifact files age out per retention), so live and historical agents are the same query.

- **Project → Agents tab**: every attempt in the project, live ones pinned on top. Columns: unit, role (worker / verifier / planner / ci-fix / …), state (queued · running · handed off · failed · stopped), harness/model, started, duration, tokens/context peak, outcome (handoff status, verdict tier, failure mode). Filter by role, state, unit, repo, harness; sort by time.
- **Agent detail** (one attempt): tabs for **Log** (timeline below), **Brief** (exactly what it received), **Handoff** (verbatim), **Diff** (its branch vs base), **Evidence** (artifacts it or the daemon captured), **Verdict**, **Lease** (environment slot, namespace, timings). Header shows lineage: which planner drain created the unit, previous and next attempts of the same unit, and the unit it verifies or fixes.
- **Unit history**: all attempts of one unit in order (work → verify → rejected → work → verify → land), so a developer sees why it took three tries.
- **Project activity feed**: the `events` table rendered as a timeline — spawns, handoffs, verdicts, scope rejections, gates, landings, MR events, andon — filterable, each linking to its agent or unit.
- **Global Agents view**: what is running right now across all projects, against each concurrency cap (host, harness, environment leases), with queued units and why they wait (cap, lease, scope overlap, dependency).
- **Search**: full-text search over handoffs, briefs, and log text (SQLite FTS5), scoped to a project or global — e.g. "which agent touched `PaymentService`".

### Live agent logs

The daemon owns every harness process, so logs need no extra plumbing: the adapter parses the harness stream (`stream-json`, `--json`) into normalized events (assistant text, tool call, tool result, subagent start/end, usage, final message), appends them to `logs/<unit>.<n>.jsonl`, and pushes them over SSE. Replaying a finished attempt uses the same file, so live and past logs render identically.

The log view is a structured timeline, not a terminal dump:

- assistant messages as prose; tool calls as collapsible rows (`Bash` → command with folded output, `Edit` → inline mini-diff, `Read` → path only);
- subagents (swarm/arena) nested under the call that spawned them;
- a pinned header: unit, role, harness/model, elapsed vs timebox, current step;
- a **context meter** per attempt (tokens used vs the model's window), to see an agent nearing compaction;
- a raw toggle showing the exact JSONL lines, for debugging adapters.

Controls on a running attempt: **stop**; **stop and respawn with a note** (the note is appended to the next attempt's brief); and, where the harness accepts streaming input (Claude's `--input-format stream-json`), **message the agent** mid-run.

### Visual design

"Clean, modern, elegant" is decided with the user before it is built: 2–3 styled prototypes of the core screens (projects overview, unit graph, live agent log), compared side by side, one picked. The hana apps are the reference for components and conventions.

Bind to localhost by default; token auth when exposed on the LAN.

## 18. Security and air-gap

- Agents run with the harness's permission policy mapped from yagura's per-unit policy (write scope → allowed paths where the harness supports it; otherwise enforced post-hoc by the scope check).
- Credentials are references resolved by the daemon at lease time and injected only into verify subprocesses, never into briefs or logs.
- No outbound network is required by yagura itself.

## 19. Build order

Each phase ends in something demonstrably working on a real repo; schemas are designed for the full model from phase 1.

1. **Core:** store + schema, layered config + bootstrap vars, repo mirror + worktrees, `claude` adapter, single `work` unit with rendered brief and verbatim handoff, synthetic failure handoffs, CLI. Proof: run one real unit on a real repo.
2. **Verification:** verify-pack contract, `local-process` provider, leases, daemon-run evidence, verdicts with artifact refs, trunk-vs-head, tiers, landing with forge `none`.
3. **Planning + parallelism:** planner drains with plan deltas, scope enforcement, merge-tree check, rolling window, retries by failure mode, andon.
4. **Dashboard:** projects, units graph, live logs, gates, artifacts, Settings tab.
5. **Environments:** `kube-namespace` provider, environment CRUD + doctor, `pack` units (generate + prove), glab adapter, forge watcher with `rebase` / `ci-fix` / `review-triage` units, retro watch.
6. **Multi-repo:** read-only mounts, `needs-source`/`needs-landed`, qualified versions + Nexus, release units, expand/migrate/contract.
7. **More harnesses and packs:** codex/grok/custom adapters, pack manifests for pstack-claude forks, measurement-driven hillclimb projects.

## 20. Decisions log

Answers to the questions this design left open (2026-09-26):

1. **Host:** the daemon runs natively on each developer's RHEL9 VM (Windows host), which already has kube, Nexus, and GitLab access; dashboard reachable from Windows via the VM hostname (§4).
2. **Kube namespaces:** configurable per environment, `create` or `pool` mode; a pool caps concurrent live verifications, not agents (§12).
3. **Models:** the harness default applies unless a model is set per role in yagura (§10, §16).
4. **GitLab:** one MR per unit (§15).
