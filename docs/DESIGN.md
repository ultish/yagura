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
2. **No long-running chat.** The coordinator is a program. The planner is invoked fresh at drain points with a _generated_ state snapshot, never an LLM summary of a summary.
3. **Proof, not narration.** A unit is verified only when the daemon holds artifacts that prove it, from a verifier that did not write the code, at the current head SHA.
4. **One writer per resource.** One unit writes one repo through one worktree; one lease per environment slot; one lander per repo.
5. **The brief is the product.** Workers cannot ask questions. A brief missing a field is not spawnable.
6. **Judgment, then facts.** Agents judge how to test and keep the verify pack current; yagura checks only facts it can check, records everything, and the developer can disagree after the fact (§13 "Judgment, evidence, and the trail"). Up-front checks of packs and environments are gone: a real failure in use says more.

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

| Entity          | Notes                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Environment** | Shared across projects. Created in the dashboard or by the watchman; nothing about it is checked up front (§12). Holds credential _references_, never secrets.                                                                                                                                                                                        |
| **Repo**        | Registered once by URL. Many projects can target it. Holds the forge adapter choice and the qualifier scheme override.                                                                                                                                                                                                                                |
| **Project**     | `goal`, `predicate` (checkable, e.g. "p95 latency ≤ 80% of baseline on dev-kube", "all 12 units landed ≥ deployed-verified"), `min_tier`, `standing_orders` (numbered lines pasted into every brief), `environment`, `repos[]`, `budget` (wall clock, max attempts, max in-flight).                                                                   |
| **Unit**        | Types: `plan`, `work`, `verify`, `land`, `release`, `pack` (create/repair a verify pack), `measure`, and the babysit fix types `rebase`, `ci-fix`, `review-triage` (§15). Exactly one writable repo. Declares `write_scope` globs, `deps[]` with kind `needs-source` or `needs-landed`, `acceptance[]`, `verify` recipe, `measurements[]`, `timebox`. |
| **Attempt**     | One execution of a unit by a harness. Retries create new attempts; the unit keeps its identity.                                                                                                                                                                                                                                                       |
| **Verdict**     | Tier + artifact refs + the SHAs it was produced at. Voided automatically when any keyed SHA changes.                                                                                                                                                                                                                                                  |

### Unit state machine

```
draft → ready → running → handed_off ─┬→ verifying → verified → landing → landed
          ↑         │                 │        │
          │         └→ failed ────────┘        └→ rejected ─→ (new work attempt)
          └──────── blocked (gate open) ──── abandoned
```

Transitions are daemon-only. Agents never set state; they produce handoffs, and the daemon classifies them. A work attempt that skipped a required skill of its role (e.g. `pstack:poteto-mode` for workers) is rejected with a note naming the skills, even if its change is good; `method.enforce_required_skills` switches this off.

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
- **CLI:** `yagura` talks to the daemon API (`yagura project new`, `yagura env add`, `yagura status`). Agents call a restricted subset (`yagura artifact add`, `yagura note`) scoped by a per-attempt token.

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

Core tables: `settings` (layered config, §16), `environments`, `repos`, `projects`, `project_repos`, `units`, `unit_deps`, `attempts` (incl. plugin versions and models used), `leases`, `artifacts`, `verdicts`, `measurements`, `gates`, `mr_state` + `mr_decisions` (§15), `evidence_runs` (one row per command yagura ran for a verifier, with its checkout, SHA, exit, and tamper flag), `events` (append-only; the dashboard's SSE feed and the audit log), and an FTS5 index over handoffs, briefs, and log text (§17).

Schema changes ship as numbered migrations applied on open (`packages/core/src/migrations.ts`); `schema.sql` is the version-1 baseline.

Bootstrap settings (§16) live in `~/.yagura/yagura.yaml` or environment variables, since they are needed before the database opens.

Files that agents read (standing orders, briefs, handoffs, status) are markdown so any harness can read them with no yagura client.

## 6. Project lifecycle

1. **Frame** (human + planner). Goal → predicate, min tier, environment, repos, budget. If one agent could finish it inside one session, the planner says so and the project runs as a single `work` unit (orchestrate's "collapse" rule).
2. **Pack check.** Every repo in the project needs a verify pack that satisfies the environment's provider type and has passed its proof run. Missing or stale → a `pack` unit is the first unit.
3. **Pilot.** One unit end to end: brief → work → verify → land. It falsifies the brief template, verify recipe, and unit size while that costs one agent. Skipped for clone-like units.
4. **Scale.** Rolling window up to the project's in-flight cap; refill as units finish. Never blocking batches.
5. **Drain.** At drain points the daemon classifies new handoffs, then invokes the planner (§8).
6. **Land.** Continuous, from the first verified unit. Stop spawning at ~70% of the wall-clock budget and land what is verified. (As built 2026-09-30: `project.budget_hours`, counted from the project's activation; from 70% (`LANDING_CUTOFF`) the engine starts no new work or pack units while verification, rebases, review triage, and landing continue, and logs it once; at 100% it raises an andon.) Cost budget (built 2026-10-02): `project.budget_usd`, the sum of the project's attempt costs (watchman turns belong to threads and are not counted); the engine logs once at 80%, and once the budget is spent it raises an andon and starts nothing new while running agents finish, so a run can overshoot by what was in flight. Clearing the andon while still over budget raises it again; raising the budget continues. Agent sessions keep the developer's whole harness (plugins, skills, hooks), so cost is controlled by budgets and fewer sessions, not by trimming what agents load.
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

The branch is exactly what the agent committed. Anything left uncommitted at exit (build caches, regenerated files, half-finished edits) is saved as `leftovers/<unit>.<n>.patch`, its paths are recorded in the unit's event, and the worktree is reset; yagura never commits on the agent's behalf.

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

**As built (phase 3).** The delta is the last fenced ```json block of the planner's final message, validated strictly (unknown fields are rejected): `add[]` (`key`, `repo`, `goal`, `write`, `forbid`, `accept`, `verify`, `context`, `playbook`, `timeboxMinutes`, `deps[{on, kind}]` where `on` is a key in the delta or `U<n>`), a work unit's `write` never includes the repo's verify pack (yagura drops it with a warning, and refuses a unit that writes only the pack, since verifiers maintain it; 2026-10-01), `amend[]` (units not started; `deps` replaces the unit's dependencies, after which its scope-overlap order is re-derived), `retry[]` (blocked/failed/rejected units, with a note carried into the next brief and one more attempt), `cancel[]` (idle units; running ones are reported, not killed), `gates[]` (question, options, default), `done`, `summary`. Scope overlap is decided on each glob's static base path, conservatively. A drain is triggered by the first run, a unit blocking or being abandoned (except by the planner itself), a rejected delta, an answered planner or question gate, andon being cleared, or a spec edit; a work unit landing triggers one only when no build unit is left open or its handoff suggests follow-ups (2026-10-01: in the second real run 7 of 9 drains changed nothing, and drains were the largest cost). Land, environment, review, and report gates, and pack units landing, never trigger one: yagura finishes those itself; the trigger window starts when the previous drain started, so nothing that happens while a planner runs is missed. Three rejected deltas in a row raise andon. The project closes when the latest applied delta says `done` and no unit is left except blocked ones.

## 8a. The watchman: talking to yagura

yagura's front door is a conversation. A developer talks to the **watchman** (_bannin_) to start work or evolve it; the watchman turns the conversation into projects, and reports back when they are done. It serves both ways of working: hand it a finished spec ("here is BUILD_SPEC.md, build it") or grow something conversationally ("prototype a Kafka diff service" … "now ignore timestamp fields").

### Flow

1. **Talk.** The watchman asks only what no experiment could settle.
2. **Propose.** A proposal lists projects (one, or a chain with `after` dependencies), their goals and done predicates, repos (existing, or a new repo for a prototype), environment, a starting verify pack, merge policy, minimum tier, and initial units or spec. The developer answers **Go / Edit / Discard**.
3. **Build.** The projects run as usual (plan → work → verify → land).
4. **Report.** When the thread's projects close (or block), the bell rings and the thread gets a report assembled from records: what landed and how it was verified, how to run it (from the verify pack's commands), what is still open, trace links.
5. **Evolve.** Further messages in the same thread propose amendments: new units, spec changes, new projects.

**Autonomy per thread:** `propose` (default; nothing starts without Go) or `go` (prototyping: applies its own proposals and rings only for real decisions and the report). Irreversible actions (creating a GitLab project, deploying beyond dev, force operations) always ask. **Prototype defaults:** new repo, `min_tier` unit-verified, `merge: auto`, a short wall-clock budget.

### Memory: the database, never the conversation

The watchman follows yagura's first principle: no long-lived LLM context. Every message is a fresh harness session whose context is assembled from the store under a fixed token budget (default ~40k tokens, a setting).

| Stored                 | Content                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `threads`              | title, autonomy, linked projects, state                                                                |
| `thread_messages`      | every human and watchman message, verbatim; FTS-indexed                                                |
| `thread_decisions`     | one structured record per decision (text, source message, superseded-by)                               |
| `thread_questions`     | open questions; resolved with the answering message                                                    |
| `proposals`            | the proposed change set, its state (pending, applied, edited, discarded), and what applying it created |
| `projects/<p>/spec.md` | the living spec the watchman maintains, in addressable sections                                        |
| reports                | done/blocked summaries, generated from records                                                         |

**Context assembly, in priority order:** (1) watchman instructions and standing orders; (2) all _active_ decisions and open questions; (3) a generated status of each linked project; (4) the spec sections relevant to the message (by heading), never a whole large spec; (5) the most recent messages verbatim, trimmed oldest-first to fit; (6) nothing older — the watchman can pull an older detail with `yagura thread search`.

**Every turn ends with structured records** alongside the reply: decisions added or superseded, questions opened or resolved, spec section edits, and an optional proposal. yagura validates them (schema, references) and stores them atomically. A decision made 200 messages ago is still exactly in `thread_decisions`; nothing important depends on recalling or summarizing old messages.

Proposals apply through the same validated paths as planner deltas and CLI commands; the watchman never writes to the store directly.

**As built.** A turn is `runWatchmanTurn` (`watchman.ts`): the human message is stored, the brief is assembled from the store under `watchman.context_tokens` (chars/4 estimate): fixed parts first (template, standing orders from `threads/<id>/standing-orders.md`, active decisions `D<n>`, open questions `Q<n>`, recent proposals, a catalog of repos/environments/taken project ids), then linked project statuses (≤35% of what is left, each truncated with a pointer to `yagura show`), then spec (≤30%: a small spec whole, a large one as its heading list plus sections whose heading words appear in the message), then messages newest-first until the budget runs out (the newest is always kept). The session runs in `threads/<id>/` through the same `runAgentSession` as every agent, with a thread recorder instead of an attempt (`SessionRecorder`). The reply's last fenced `yagura` block holds the records (`title`, `decisions[{text, supersedes?}]`, `questions[]`, `answered[{question, answer}]`, `spec[{project, section, body|null}]`, `proposal`); unknown keys, dangling references, spec edits for projects outside the thread, and invalid proposals reject the whole block. The watchman then gets one retry with its reply and the reason appended to the same brief; if that is rejected too, the prose is stored and a system message says why. A reply without a block is plain conversation.

A **proposal** (`proposal.ts`) has `repos[]`, each either a new repo (id, description, a required starting `verifyPack`; created as a bare repo under `~/.yagura/repos/<id>.git` with a README and the pack in one commit) or an existing one (`{ id, existing: "<git URL>" }`). An existing repo is checked before the proposal is stored (`inspectProposalRepos`: a shallow temporary clone reads the default branch from the remote HEAD and the trunk verify pack); an unreadable repo, a local working copy, an id or URL already registered, or a repo without a usable pack that a proposed project would build in rejects the records. Applying it only mirrors the repo (`registerRepo` path), so it needs no extra confirmation, `projects[]` (id, goal, predicate, repos, environment or null for the only/new `local` environment, merge, minTier, after, phaseGate, refs, spec, initial units in the planner's unit schema), and `amend[]` (units for a thread's existing project; a closed one reopens). Applying it validates again, creates repos, then adds projects, links them to the thread, applies units through `applyDelta`, and writes `spec.md`, in one transaction. Spec edits record `project.spec_changed`, which triggers a plan drain; the plan brief points the planner at `spec.md`. The irreversible actions named above are not in the proposal schema, so `go` applies every valid proposal.

The **engine** activates a `framing` project once all its `after` projects are closed; with `phase_gate` it first opens a `phase` gate (`start | hold`). It posts a **report** into each open thread when a linked project closes, raises andon, or is stuck (blocked work, nothing running or ready, no plan due); `threads.reported_json` keeps the last report key per project so each state is reported once. A report is a system message built from records (landed units with SHA, tier, and a `yagura trace` hint; blocked units with reasons; still-open units; how to run each repo from its trunk verify pack; open gates and questions) and rings the bell as a `report` gate (`seen`). Answering a report gate does not trigger planning.

**Mentions.** Any message can point at yagura's records with `@project`, `@project/U3` (unit), `@project/U3.2` (one attempt), `@thread:4`, or `@repo:id`. Every stored message, human or watchman, is scanned; resolved mentions go into `message_refs` (migration 6), so "which conversations discuss U3" is a query (`yagura thread mentions`, `GET /api/mentions/:token/messages`; a project token also finds mentions of its units). Mentioned records are described in the watchman brief (MENTIONED, fixed priority, each capped at ~2k tokens): a project's status, a unit's or attempt's state, attempts, blocked reason, notes, last handoff and log path, a thread's active decisions, a repo's facts. `GET /api/mentions?q=` serves the dashboard's `@` autocomplete (projects and repos by id, units by `project/U…` or goal words, attempts by `project/U3.…`, threads by title).

### Project chains and spec import

Large work is either one long project (units are the small pieces) or a **chain** of projects when parts need their own predicate, repo, environment, or merge policy. A project may declare `after: [projects]` (migration 5: `projects.after_json`; CLI `project new --after`); it stays `framing` (dark tower) until those close, then the engine activates it automatically — yagura is an automated system the developer monitors and steps into, so `phase_gate` is off by default (user, 2026-09-26) and only on request rings the bell for a human review before it starts. A finished spec with phases and exit criteria (e.g. trackplan's BUILD_SPEC §14) is imported by giving it to the watchman: it drafts the chain (project per phase, predicate from the exit criteria, `after`, environment), asks about anything the spec marks OPEN, and applies it only on Go. An LLM program-level planner is deferred until needed.

## 9. Scheduler

A unit is **ready** when: deps satisfied (`needs-source` → upstream has a verdict ≥ its required tier; `needs-landed` → upstream landed), no running unit overlaps its write scope in the same repo, project in-flight cap not hit, no andon on the project.

- **Leases.** Verify units that need a live environment request a lease; they wait in a per-environment queue. Capacity is per environment, shared by all projects. The provider creates the slot (e.g. namespace `yg-<project>-<unit>-<n>`) and returns connection vars; release always tears down, including after crashes (lease reaper on startup).
- **Retries by failure mode** (orchestrate): `timebox | context-exhausted | oom` → planner must split or narrow; `network` → retry as-is; `tool-error | harness-error` → retry with another harness/model if configured; `unknown` → retry once. After 2 failed attempts the unit is `blocked` and surfaces to the planner, not retried blindly.
- **Liveness** is the daemon's own knowledge: it owns the pid, the stream, and the exit code. No "is it alive" guessing. A unit that exceeds its timebox with no side effect (commit, artifact, stream progress) is killed and gets a synthetic handoff.
- **Andon.** A project-level stop (dashboard button or planner gate) halts new spawns; in-flight attempts finish.

**As built (phase 3).** `yagura drive <project>` runs the engine loop in the foreground until nothing is left to do: settle failed/rejected units by the failure policy, land verified units (`merge: auto`, or a `land` gate answered `land` under `merge: human`), plan when triggered, then start ready work and verify units in seq order (verify first) while the global (`max_parallel_agents`), per-harness, and per-project (`project.max_in_flight`) caps have room; leases add the per-environment cap. `needs-source` is treated like `needs-landed` until read-only mounts arrive (phase 6). After a clean work handoff, `git merge-tree --write-tree` against the current trunk rejects work that no longer merges (requires git ≥ 2.38; RHEL9 ships 2.39).

## 10. Harness adapters

```ts
interface HarnessAdapter {
  id: string; // "claude", "codex", "grok", "custom"
  command(brief: RenderedBrief, opts: RunOpts): { argv: string[]; env: Record<string, string>; stdin?: string };
  parse(line: string): HarnessEvent | null; // stream → text/tool/cost/usage events
  finalMessage(events: HarnessEvent[]): string | null;
  permissions: PermissionMapper; // yagura policy → harness flags
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
{
  "name": "pstack-claude",
  "requires": { "pstack@pstack-claude": ">=0.5.0", "cursor-team-kit@pstack-claude": ">=0.1.1" },
  "roles": {
    "worker": {
      "entry": "pstack:poteto-mode",
      "playbooks": [
        "bug-fix",
        "feature",
        "refactoring",
        "perf-issue",
        "hillclimb",
        "prototype",
        "visual-parity",
        "runtime-forensics",
        "trace-forensics",
        "investigation",
        "authoring-a-skill"
      ],
      "skills": ["cursor-team-kit:deslop", "pstack:no-comments"]
    },
    "verifier": {
      "entry": "pstack:poteto-mode",
      "skills": [
        "pstack:principle-prove-it-works",
        "pstack:blast-radius",
        "pstack:interrogate",
        "cursor-team-kit:control-ui",
        "cursor-team-kit:control-cli",
        "cursor-team-kit:verify-this"
      ]
    },
    "planner": { "skills": ["pstack:figure-it-out", "pstack:architect", "pstack:principle-sequence-verifiable-units"], "playbooks": ["multi-phase-plan"] },
    "pack": {
      "skills": ["pstack:create-verification-skill", "pstack:maintain-verification-skill", "cursor-team-kit:control-ui", "cursor-team-kit:control-cli"]
    },
    "rebase": { "skills": ["cursor-team-kit:fix-merge-conflicts"] },
    "ci-fix": { "entry": "pstack:poteto-mode", "playbooks": ["bug-fix"], "skills": ["cursor-team-kit:fix-ci"] },
    "review-triage": { "entry": "pstack:poteto-mode", "references": ["plugins/pstack/skills/poteto-mode/references/bugbot-triage.md"] }
  },
  "replacedByDaemon": [
    "pstack:orchestrate",
    "pstack:autopilot-full",
    "pstack:autopilot-stack",
    "pstack:shipping",
    "pstack:babysit",
    "pstack:opening-a-pr",
    "pstack:autonomous-run",
    "pstack:pause-safely",
    "pstack:session-pickup",
    "pstack:worktree-cleanup",
    "pstack:show-me-your-work",
    "cursor-team-kit:new-branch-and-pr",
    "cursor-team-kit:review-and-ship",
    "cursor-team-kit:get-pr-comments"
  ]
}
```

The planner picks a playbook per unit from the role's allowed list; the daemon renders METHOD from the manifest. Model routing inside pstack's fan-out skills comes from the developer's `pstack-models.md`; yagura only chooses the top-level model per role (§16). Some skills use Claude-only features (the Agent tool for swarm/arena, `/loop`); roles that need them run on the Claude harness, or the overlay for another harness tells the worker to skip fan-out.

### Roles

| Role                                  | pstack it uses                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker                                | poteto-mode work playbooks; all principles; architect, tdd, no-comments, unslop, deslop; swarm/arena inside its own worktree and timebox                                                                            |
| Verifier                              | prove-it-works, blast-radius, interrogate lenses, control-ui / control-cli / verify-this, plus the repo's verify pack                                                                                               |
| Planner                               | figure-it-out, multi-phase-plan, sequence-verifiable-units, architect, principles                                                                                                                                   |
| Pack unit                             | create-verification-skill, maintain-verification-skill, control-ui / control-cli                                                                                                                                    |
| Rebase / CI-fix / review-triage (§15) | fix-merge-conflicts; bug-fix playbook + fix-ci; bugbot-triage rubric                                                                                                                                                |
| **Replaced by the daemon**            | orchestrate, autopilot-*, shipping, babysit, opening-a-pr, autonomous-run, pause-safely, session-pickup, worktree-cleanup, show-me-your-work; cursor-team-kit's new-branch-and-pr, review-and-ship, get-pr-comments |

### Role overlays

pstack playbooks assume the agent is its own orchestrator: poteto-mode ends every playbook with _Opening a PR_, babysit runs a `/loop`, show-me-your-work keeps its own trail. Inside yagura that competes with the daemon. yagura ships small **overlay skills** — `yagura-worker`, `yagura-verifier`, `yagura-planner`, `yagura-pack`, `yagura-ci-fix`, `yagura-review-triage` — as a plugin in `YAGURA_SKILLS_DIR`, loaded alongside the developer's pstack in every session (§10). Each says:

- You are running inside yagura as role X. Use pstack with playbook Y.
- Skip every landing, PR, merge, loop, babysit, and decision-trail step; the daemon owns them.
- Do not spawn long-lived loops or wake mechanisms. Stay inside your timebox.
- End with the yagura handoff format. Where this overlay and pstack disagree, the overlay wins.

pstack itself is never edited, so upstream updates drop in unchanged. Overlays are versioned with yagura, since they encode yagura's contracts.

### Project skills and stack knowledge (decided 2026-09-27)

How to build a kind of project (a Kotlin Spring Boot service with the developer's version catalog, Gradle plugin, helm values, skaffold) is know-how, and its home is **harness skills**, like the developer's own `setup-gradle`. yagura does not reimplement them as templates; it names them, makes sure they are used, gives them the environment's facts, and proves their result.

- **Skills by purpose, as layered settings** (global, repo, project): `skills.scaffold` (the unit that creates a new project skeleton), `skills.work` (every worker), `skills.pack` (writing the verify pack), and optionally `skills.verify`. The watchman fills them from the conversation ("wire this up as a Spring Boot Kotlin service with setup-gradle"); the project's Settings panel edits them. Briefs name them in METHOD, and an attempt that skips one is rejected, the same enforcement as pstack's required skills.
- **Scaffold units.** The first unit of a new project, whose job is the skeleton, run with `skills.scaffold`.
- **Reference repos.** A project can name registered repos that already do it right; briefs point at them (kurukuru's `reference_project`).
- **The doctor checks installed skills.** A project that names a skill not installed where agents run fails its doctor before any agent starts.
- **Skills yagura writes, from examples, never from nothing.** A skill written from scratch is a guess every future agent would follow confidently. yagura writes one only from evidence: repos the developer points at ("make a skill from billing and orders", the way `setup-gradle` itself was made) or a scaffold that yagura already verified and landed. A skill-writing unit reads them and writes `setup-…` with scripts where possible. yagura then proves it: it applies the skill to an empty scratch repo, and the result must build offline, pass its verify pack on the environment, and match the examples where it matters. A proven skill waits at a gate for the developer's approval, because it changes every later agent, then goes into yagura's own skills directory (git-versioned, loaded into every session). Existing skills can be re-proven against the current repos to catch drift.
- **Conventions become checks.** What a skill promises and a machine can check (the catalog exists, the build points at the mirror, `./gradlew --offline assemble` passes) becomes a pack check, so it holds on every change, not just when the skill ran.
- **As built (2026-09-30; `skills.ts`).** Settings `skills.scaffold`, `skills.work`, `skills.pack`, `skills.verify` (lists, global/project/repo) and `project.reference_repos` (project). A unit's required project skills come from its purpose (`requiredProjectSkills`: pack, verify, scaffold when `units.scaffold` is set (migration 10, `"scaffold": true` in a plan unit), else work); METHOD names them after the role's overlay and pstack, and `missingSkills` enforces them with the role's own, so a worker that skips one is rejected (`rejection: skills`) and a verifier's miss is recorded. Workers get a detached trunk checkout of each reference repo (`<worktree>.reference`, kept at the resumed attempt's path on resume), listed under READ-ONLY and passed as `--add-dir`. The doctor (`projectSkillChecks`) resolves every named skill per repo layer against what a session can load: `~/.claude/skills/<name>/SKILL.md` (symlinks count), each plugin in `~/.claude/plugins/installed_plugins.json` as `<plugin>:<name>`, and yagura's overlays (`CLAUDE_CONFIG_DIR` overrides the Claude home). The engine checks it first on every tick of an active project and raises an andon naming what is missing, before mirroring, planning, or starting an agent. The planner brief explains scaffold units and reference repos; the watchman sets `skills` and `references` on proposed projects and sees the developer's own skills in its catalog. CLI: `yagura project skills <id>` (exit 1 when one is missing), `project set --reference`; the project page lists its skills and which are not installed. Not yet: skill capture from example repos (below), and conventions turned into pack checks.
- **Named stacks later.** A stack (e.g. `spring-kotlin`: skills `[setup-gradle]`, needs components `kube`, `registry`, `helm`, `skaffold`) can bundle this once there are several projects to compare; yagura would refuse a project whose environment lacks a component its stack needs.

## 12. Environments and providers

| Provider         | create slot                                                                                                                 | connection vars                                                        | teardown                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `kube-namespace` | `mode: create` → `kubectl create ns yg-…` + labels; `mode: pool` → lease one of a configured list of pre-created namespaces | `YAGURA_NAMESPACE`, `KUBECONTEXT`, `YAGURA_BASE_URL` (ingress pattern) | create: delete namespace · pool: delete only yagura-labelled resources, keep the namespace |
| `docker-compose` | project name `yg-…`, allocated ports                                                                                        | `COMPOSE_PROJECT_NAME`, ports                                          | `compose down -v`                                                                          |
| `local-process`  | allocate ports + data dir                                                                                                   | ports, `YAGURA_DATA_DIR`                                               | kill process group, rm dir                                                                 |
| `ios-sim`        | clone simulator                                                                                                             | `SIM_UDID`                                                             | delete clone                                                                               |

Whether a developer can create namespaces varies, so `kube-namespace` supports both modes per environment. In pool mode capacity = pool size. A pool limits **concurrent live verifications**, not agents: workers, builds, and unit-level checks still run in parallel, and only lease-requiring verify steps queue for a free namespace.

An environment = provider + access refs + capacity + **conventions** + **artifact-version scheme**. yagura checks nothing about it up front (decision 8): a missing registry or an unreachable cluster shows up when a verifier tries to use it, and that pauses verification on the environment until the developer answers (§13 "Judgment, evidence, and the trail"). `profile.md` is the prose for agents.

**As built (`kube-namespace`, 2026-09-27; `kube.ts`).** Settings (`providerConfig`, validated per provider): `context` (default: the current context, pinned into each slot when it is created), `mode` `create` or `pool`, `pool` (namespace names; capacity cannot exceed it), `prefix` (default `yg`), `kubectl` (the binary), `baseUrl` (an ingress pattern with `{namespace}`). Create mode makes `yg-<env>-<lease>` labelled `yagura=1`, `yagura/env`, `yagura/lease`, and on release deletes it only if it still carries `yagura=1`, refusing otherwise. Pool mode leases `pool[slot]` and on release deletes only `yagura=1`-labelled resources in it. A slot's variables are `YAGURA_SLOT`, `YAGURA_LEASE_DIR`, `YAGURA_NAMESPACE`, `KUBECONTEXT`, `YAGURA_LABEL`, and `YAGURA_BASE_URL` when set; the pack contract tells pack writers to pass `--context "$KUBECONTEXT"` and label what they deploy. If yagura cannot create a slot (the cluster is unreachable, the namespace cannot be made), verification fails before any agent runs and pauses the environment like a verifier that could not reach something. The provider doctor, `env doctor`, and doctor-gated selection were removed on 2026-09-30.

### Environment values (decided 2026-09-27)

An environment describes the machine verification runs on, once, for every repo that uses it. yagura cannot know up front what a developer's machine has or which stack a project uses, so the core is **values the developer adds**, each with two parts, both context for agents:

- **name and value**, e.g. `REDIS_URL = redis://hostname:6379`;
- **a note for agents**: how the value is used, sent with it in every brief ("Redis on the dev box; pods reach it at `redis.redis.svc:6379`, so use `REDIS_URL` only from this box");

**Presets** are shortcuts that fill in values and notes for common things: `kube` (context, namespace mode, slots; it also sets the provider), `registry` (`REGISTRY_PUSH` from this box, `REGISTRY_PULL` from the cluster, e.g. `localhost:5000` / `hostname:5000`), `kafka` (`KAFKA_BOOTSTRAP_CLUSTER`, `KAFKA_BOOTSTRAP_LOCAL`), `helm`, `skaffold`, `maven-mirror`. What a preset writes is ordinary values, edited and deleted like any other; presets are buttons the developer chooses, never applied on a guess. yagura does not probe the machine: it cannot know what to look for in an air-gapped setup. The environment also keeps free **notes** for what no single value covers ("dependencies run in the cluster; verify by exec'ing into the app pod").

- **Values reach every command and agent** as real environment variables: pack commands in a slot, and worker, pack-writer, and verifier sessions; the brief lists each with its note. One pack works unchanged on a teammate's machine.
- **Hard-coded values are the verifier's call.** yagura does not scan diffs for values; a verifier that finds `localhost:5000` written into `skaffold.yaml` where `$REGISTRY_PUSH` belongs reports it like any other problem with the work.
- **Set up by form or by conversation.** The Environments page is a values table (name, value, note, where it came from), editable in place, with presets as optional shortcuts. Or the developer describes the setup to the watchman, which proposes an environment with the same values and notes, applied on Go. The watchman fills the table; it does not write scripts.
- **What is enforced and what is advice.** The keep policy and the values reaching processes are enforced by yagura. Values and notes are advice; what makes them safe is that yagura judges results (evidence it captured, pack checks), not whether an agent followed a note.
- **Keep policy.** Per environment, overridable per project: `never` (today), `failed`, or `always`, and an expiry (default 2 hours). A kept slot skips the pack teardown and namespace deletion, leaves the last deployed side running, stops counting against capacity, and is deleted when it expires or from a Delete button; the Environments and agent pages show kept namespaces with a ready `kubectl --context … -n …` line. Suggested default for small clusters: `failed`, 2 hours.
- **Templates.** The same machine needs no copy: every project on it picks the same environment. To reuse the shape on another machine (a teammate's VM, a second cluster) or as the start of a variant, an environment is **saved as a template**: its values with their notes, its presets, its keep policy, and its free notes. Values that are facts about one machine can be marked **ask** (e.g. `REGISTRY_PULL = <hostname>:5000`), so applying the template asks only for those and fills in the rest. Templates are files (YAML, one per template) in `~/.yagura/templates/`, or a git repo a team shares, so they can be reviewed and versioned like code. The Environments page offers "New from template" and "Save as template"; the watchman can apply one ("set up this VM like my dev box"). A template can also carry project settings to apply with it (`skills.scaffold`, `skills.work`, reference repos, a keep override), so "a Spring Boot service on kube" is one choice for a new project.
- **Repos stay separate.** How one repo builds and deploys is its verify pack, written by a pack unit against the environment's values (the brief lists them with their notes) and kept working by the verifiers that use it. Stack skills (§11 "Project skills") guide how.

**As built.** Migration 8 stores values and free environment notes; migration 18 (2026-09-30) dropped value checks, their last results, and the environment doctor's columns. Presets only add names that are not already set. Values are exported into slot commands and agent sessions, and the brief lists each with its note. `lease.keep` (`never` / `failed` / `always`) and `lease.keep_hours` (default 2) are ordinary settings, overridable per environment and per project; a kept kube namespace (create mode) skips teardown so what was deployed stays up; a local-process slot still runs teardown, because deleting it later cannot stop a process, and keeps only its directory; a pool namespace is never kept, because the next lease reuses it. A kept slot is deleted at expiry or from the Environments page. Templates are one YAML file each in `~/.yagura/templates/` (a `check` on a value in a template saved earlier is ignored). The CLI is `env values`, `env value set|rm`, `env preset|presets`, `env notes`, and `template list|save|apply`. The Environments page edits the same table and shows "verification paused" with a link to the gate while one is open. A watchman proposal can carry `environments[]`: each is either a full draft (id, provider, providerConfig, capacity, notes, keep, presets, values with notes) or `{ id, template, answers }`; both go through the same `checkDraft` / `createEnvironment` as the form and `template apply`, so an invalid name, an unknown preset, a bad provider config, or an unanswered ask value rejects the records before they are stored. The watchman's catalog lists each environment with its value names, the presets, the templates with what they ask, and the providers. Values record where they came from (`watchman`, `template <name>`, or the preset). The agent page shows its attempt's kept slot too. Not yet: a shared git repo of templates, and project settings carried on a template.

## 13. Verification

### Judgment, evidence, and the trail (decided 2026-09-30, user; not built yet)

Agents use judgment; yagura records evidence and checks facts; nothing is hidden; the developer can disagree with anything, at any time, after the fact. This replaces the frozen pack, the up-front environment checks, and the rules that tried to stop agents from gaming them. The lesson is kurukuru's: a verifier whose instructions were wrong tried hard, could never pass a test, could not change the frozen slice, and the developer fixed it by hand every time. Retrying with unchanged instructions is not a fix. The first real Sonnet run (2026-09-30, below) hit the same trap: the pack could not run the tests, and nobody could change it.

- **The verifier's job** is to check that the worker did what was asked and to test what was built, however it judges best. The pack, the environment values and notes, the feature docs, and project skills are context that helps it, not rules it must satisfy.
- **The verifier maintains the pack.** When the pack is wrong (a command that cannot work, a deploy that does not match how the app now runs) or misses what was built (no check runs the new tests), the verifier fixes or extends it, and may run pstack's `maintain-verification-skill` when it judges the pack has drifted. Its pack edit applies to this verification at once: yagura re-runs trunk and head with the same edited pack, so the edit makes verification possible without making a bad change look good. The edit lands as its own commit, separate from the unit's squashed commit (its own small PR under `merge: human`).
- **The worker does not edit the pack.** It wants its change to pass, so when its change breaks the pack it says so in its handoff, and the verifier (who does not share that motive) decides. Pack units remain only for a repo with no pack at all (`create-verification-skill`).
- **What yagura checks is facts, never arguments.** yagura is deterministic code and cannot weigh reasoning, so it agrees or disagrees only on what it can check: the runs the verifier cites were run through yagura and recorded untampered; the evidence shows the new behaviour (fails on trunk, passes on head; identical for a refactor); an edited pack runs. A fact that does not hold sends the verifier back once with the reason (the watchman's record-retry pattern); a second failure blocks the unit with both reasons. Disagreement never lands anything. Whether a test really tests the goal is the verifier's judgment and, afterwards, the developer's; a second reviewing agent is left out until a real run shows verifiers approving bad work.
- **No up-front environment checks.** Value checks, the environment doctor, and doctor-gated selection go. A missing registry or an unreachable cluster shows up when a verifier tries to use it, and it cannot verify. The first verifier that reports it cannot reach something pauses verification on that environment and reports it to the watchman and the developer; nothing retries until the developer says it is fixed. When yagura itself cannot create a slot (a kube namespace), it fails before any agent runs and reports the same way. Hard-coded values in a diff are no longer rejected by yagura; the verifier judges them like any other review point.
- **The trail.** Every handoff ends with `## Decisions`: what the agent chose, what it deliberately did not do, and why (hidden thinking is not captured: Claude Code's stream carries empty thinking blocks). The verifier's covers what it tested and how, what it skipped, and each pack edit with its reason. yagura writes its own agree or disagree into the unit's history as a readable line naming the facts ("agreed: r3 fails on trunk, r4 passes on head"). Each attempt records its cost. A unit's page reads top to bottom: goal, worker's decisions, verifier's findings and pack edits, yagura's check, landing, and any later disagreement.
- **Disagree after the fact.** Any recorded decision (a verdict, a pack edit, a plan choice, a dismissed review comment, a watchman decision) has a Disagree action with the developer's reason. yagura records it against that decision and turns it into work that fixes forward (trunk is never rewritten): a follow-up unit for the planner, or a pack fix for the next verifier. Earlier disagreements on a repo go into later verifier briefs as context.

**As built, part 1: the verifier maintains the pack (2026-09-30; `packedits.ts`, migration 16 `pack_edits`).** Each verification opens a pack workspace (`<head>.pack`, a worktree on `<prefix>/<project>/u<target>-pack-v<verify seq>`) starting from the target's latest pending edit, else trunk. `packForAttempt` reads `verify.json` from it, and every evidence run copies its pack directory over the base or head checkout after the tamper check (`overlayPack`), so an edit counts on both sides at once; a pack unit's proof still reads its own head. A failing doctor or deploy no longer ends verification before the verifier: the brief lists the doctor and deploy results, the copy's path (`$YAGURA_PACK`), and earlier verification outcomes for the unit. After the session yagura keeps only changes inside the pack directory (others are dropped, event `pack.edit_outside`); an edit whose `verify.json` does not parse is dropped and the verdict is `invalid` with that reason; otherwise yagura re-runs the doctor and every check on both sides with the edited pack, commits it (`pack.edited`, summary from the handoff's `## Pack changes`), and judges the verdict on the latest runs (`lifecycleProblem` now reads the latest doctor and deploy per side). Each engine tick, `queuePackEdits` turns a landed target's pending edits into one `pack` unit: the edits' combined diff applied with `--3way` onto trunk, recorded as a `yagura-pack-edit` attempt (no try spent), proven by the existing no-agent proof, and landed like any unit (its own PR and land gate under `merge: human`). One such unit per repo is in flight at a time; an edit trunk already has, or that no longer applies, is dropped with the reason; an abandoned target drops its edits. Verifications do not wait for these units. Landing a change that trunk already has now blocks ("nothing left to land") instead of re-verifying forever. The worker's brief says to report pack breakage under Notes. Tests: `verify.test.ts` (fix used at once on both sides, carried to the next verifier, outside changes dropped, unreadable edit dropped, a doctor the verifier leaves broken is env-blocked), `engine.test.ts` (parallel verifiers fix the same broken doctor; the first edit lands after its unit, the duplicate is dropped, trunk's pack is fixed, the project closes), `land.test.ts` (already on trunk).

**As built, part 2: the trail (2026-09-30).** Every handoff template (worker and verifier) ends with `## Decisions`, and the verifier's also has `## Pack changes`; both are parsed (`Handoff.decisions`, `Handoff.packChanges`). Cost comes from the harness's final event and is summed per attempt (`attempts.cost_usd`) and per watchman turn (`watchman_turns.cost_usd`, which includes a retried session), migration 17; `yagura show` prints it per attempt, per unit, and for the project. Each `verify.outcome` event says `check: agreed` or `disagreed` (disagreed is `invalid`: a fact the verifier cited did not hold); an invalid verdict is retried once with the reason in the next verifier's brief (EARLIER VERIFICATIONS), then the unit blocks. The unit page and the Disagree action are part 4.

**As built, part 4: the unit page and Disagree (2026-10-01; `story.ts`, `disagreements.ts`, migration 20, `apps/web/src/pages/Unit.tsx`).** Chosen by the developer from prototypes (A "ledger" with C "claims and checks" folded in, dense; https://claude.ai/artifact/GprrNFaMdmFwENR9KUAKMP). `/p/<project>/u/<n>` is now the unit's story (`GET /api/projects/:id/units/:seq/story`, `unitStory`), and `/p/<project>/u/<n>/<attempt>` the agent page; a running unit links to its live agent. The story is one time-ordered ledger: the planner's drain summary; each worker attempt that handed off (its first "What I did" line, a claimed line "Hands off …, self-reported …" checked against yagura's rejection or the verification of that head, then `## Decisions` as choices and `## Notes` as notes); each verifier (its tier and "N of M criteria met" from `## Findings`, checked against the `verify.outcome` reason, plus a "capped at" check when the claimed tier exceeded what the pack proves; `## Pack changes` with the pack edit's state); a pack proof; each review thread by its author; review triage and rebase (thread decisions checked against whether the reply was posted); gate answers; the landing (checked: the merged patch is the one verified, so the verdict carries); and each disagreement. Tries that did not count fold into the next entry with their reasons and cost. A line with a check shows it inline in green (✓) or vermilion (✗); a line without is judgment, marked "choice" or "note". Each entry that made decisions has a Disagree button; its form asks which line, why, and what should happen: a follow-up (event `disagreement.recorded`, which triggers a plan drain and reopens a closed project; the planner's status lists open disagreements as D-numbers, and a plan unit's `disagreement` field marks it planned and links the unit) or a note (later verifiers of the same repo see it under "WHERE THE DEVELOPER DISAGREED WITH EARLIER WORK ON THIS REPO"). Tests: an engine run's story and a follow-up loop that reopens, plans, lands, and closes again; a note reaching a later verifier's brief; the API. Checked in the browser on the real run's data, night and daybreak.

**As built, part 3: no up-front environment checks (2026-09-30; `envpause.ts`).** Value checks, the provider doctors, `assertSelectable`, `env doctor|suggest|try`, the check-suggestion and try-check API routes, and the hard-coded value rejection are gone (migration 18 drops their columns; the `literals` rejection stays in the enum for old rows). An `env-blocked` verdict (the verifier reports it could not verify, with its first note as the reason; a doctor or trunk deploy the verifier left failing; checks failing on both sides) or a slot yagura cannot create opens one `environment` gate per environment ("Verification on environment X is paused: … until you answer that it works again", option `fixed`) and posts the reason into the project's threads; a second such verdict while it is open joins it (`environment.pause_joined`). While it is open, verify units on every project using that environment wait ("verification on X is paused until gate N is answered"). Once it is answered, each engine tick re-queues a verify unit for every unit left `verifying` with none queued (`resumeVerifications`). `env-blocked` no longer counts toward `verify.max_retries`. Tests: `engine.test.ts` (a verifier that cannot reach the registry pauses the environment, no verifier starts after the pause, answering resumes and everything lands), `verify.test.ts` (the gate, and the wait reason).

### Verify pack (lives in each repo, e.g. `.agents/verify/`)

```
verify.json        provider type, commands, feature map index, tiers each command can prove
bin/doctor         is this instance worth driving? (read-only)
bin/deploy         build + deploy head into the leased slot (reads YAGURA_* vars only)
bin/drive <feat>   exercise a feature through the real user path; write evidence to $YAGURA_EVIDENCE
bin/teardown       remove only what deploy created
features/*.md      one per user-facing feature: how to reach, how to drive, observable end state
```

The pack a verification uses is always read from **trunk** (`origin/<default>`), never from the change being judged, so the worker's change never supplies the checks it is measured by. The verifier works on its own copy and may fix or extend it; its edit applies to both sides at once (§13 "Judgment, evidence, and the trail"). In phase 2 `verify.json` carries `provider`, optional `doctor`/`deploy`/`teardown`, `checks[]` (`name`, `command`, the `tier` a pass proves, `timeoutSeconds`), `features[]`, and `protected` globs.

Generated by a `pack` unit (pstack `create-verification-skill`, adapted to this contract) from the repo + the environment profile. **Not trusted until its proof run passes**: deploy into a leased slot, drive one feature, capture evidence, tear down, evidence still present. After that, the verifiers that use it keep it working (they may follow `maintain-verification-skill`).

**As built (phase 5, local-process):**

- **Lifecycle.** A verification runs the trunk pack's `doctor` once, on trunk, before anything else (`pack:doctor`). When the pack has `deploy`, every evidence run first makes sure its side is the deployed one: if the other side is deployed, yagura runs `teardown` there, then `deploy` on this side (`pack:teardown`, `pack:deploy`; the deployed side is derived from the attempt's runs, so the agent's CLI runs and the daemon's agree). The last deployed side is torn down when the verifier's session ends. `lifecycleProblem` decides before the agent runs and again in the verdict: a failing doctor or a trunk that does not deploy is `env-blocked`; a head that does not deploy while trunk does is a `code-fault`. Lifecycle runs never count as scenarios. The verifier brief says that switching sides redeploys.
- **Pack units.** Each engine tick, for an active project, a repo whose `pack_status` is `missing` is re-read from trunk (`syncPackStatus`); if it still has no usable pack and no pack unit is open or abandoned, `ensurePackUnits` adds a `pack` unit (write scope the pack directory, playbook `pack`, context naming why). Pack units are build units (`BUILD_TYPES`: work and pack) everywhere work units are: scheduling, retries, landing, closing, reports, the dashboard. The worker brief gains the pack contract (`packContract`: verify.json shape, the variables commands get, tiers, how the proof works) and the `yagura-pack` overlay (required skill). While a repo's pack unit is open, verifications on that repo wait (`waiting for the verify pack (U<n>)`), except the pack's own proof.
- **Proof.** A pack unit's verify unit runs no agent (attempt harness `yagura-proof`): it reads the pack from the pack unit's head (`packForAttempt`), runs doctor, deploy, every check, and teardown on head, and `decidePackProof` requires every one to exit 0 and the strongest check tier to meet the project's minimum. Any failure is a `code-fault`, so the note goes back to the pack writer and the unit retries within `max_attempts`. A proven pack lands like any change (a land gate under `merge: human`); landing sets `pack_status` to `proven` with `pack_proven_sha`.
- **Not yet:** a proof run for packs that already exist (`unproven` packs are trusted as before), `stale` detection and maintenance pack units, the environment's own provider doctor, and features driven through `bin/drive`.

### Tiers

`deployed-verified` > `live-local-verified` > `e2e-verified` > `unit-verified` > `build-only` > `verifier-blocked` / `verifier-failed`.

The project's `min_tier` gates landing. `verifier-blocked` is never a pass.

### Verification outcomes → unit state

Only a code fault sends a unit back to work; environment and verifier problems never burn a work attempt.

| Outcome                                                                                                                                                          | Target unit                    | Next                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verifier-failed` with a cited failing head run, or a pack check that passes on trunk and fails on head                                                          | `verifying → rejected → ready` | new work attempt that resumes the rejected worker's session with the verifier's findings (below); counts toward `max_attempts`, then `blocked`               |
| `verifier-blocked` (environment broken)                                                                                                                          | stays `verifying`              | verification on that environment pauses behind one `environment` gate; answering it re-verifies every waiting unit (§13 "Judgment, evidence, and the trail") |
| pass below `min_tier`                                                                                                                                            | stays `verifying`              | a stronger verify unit; if none is possible (no proven pack) → `blocked` + a `pack` unit proposed                                                            |
| verifier attempt died with no verdict, or its verdict is invalid (cites unrecorded or tampered runs, or its scenario also passes on trunk and so proves nothing) | stays `verifying`              | retry the verify unit; after `verify.max_retries` (2) → `blocked`                                                                                            |
| pass ≥ `min_tier`                                                                                                                                                | `verifying → verified`         | waits for the lander; `needs-source` dependents may start                                                                                                    |

**Resume on rejection.** A rejected worker already knows the code, the brief, and why it chose what it did; a fresh attempt spends its first minutes rediscovering that. So the next work attempt resumes the rejected attempt's harness session (Claude: `claude -p --resume <session_id>`, the id the adapter records from the stream) in the same worktree and branch, and its first prompt is the verifier's findings: the failing head runs with their artifact ids, the trunk-vs-head outcome, and the verifier's reasoning. The attempt records `resumes: <attempt>`, and its handoff is verified again by a new verifier, exactly as before; resuming changes what the worker remembers, never what counts as proof. The verifier stays a separate session and never talks to the worker. yagura starts a fresh attempt (findings in the brief, as before) instead when:

- the rejected session's context peak was above `work.resume_max_context` (default 60% of the model's window), because the fix would start near compaction;
- the rejection was not a code fault the worker can fix in place: `rejected: scope`, a merge-tree conflict (that is a rebase unit), a skipped required skill, or a hard-coded environment value twice in a row;
- this would be the second resume in a row (one resumed round, then a clean slate, so a wrong approach is not defended forever);
- the harness cannot resume (custom harnesses), or the resume fails to start; that is a `harness-error` for the resume only, and the fresh attempt it falls back to costs no extra try.

**As built (resume on rejection, 2026-09-29; `resume.ts`).** Migration 9 adds `attempts.session_id` (from the harness's init event), `resumes_attempt_id`, and `rejection` (`code-fault`, `literals`, `scope`, `skills`, `conflict`), set wherever yagura sends a handed-off attempt back. `chooseResume` (pure) resumes only a `code-fault` or a first `literals` rejection, and starts fresh when resume is off (`work.resume_on_rejection`, project and repo), the rejected attempt was itself a resume, the harness cannot resume (`HarnessAdapter.canResume`; each adapter passes the session to its own CLI's resume command, so the codex and grok adapters in phase 7 implement it too, proven against a captured transcript like `claude`'s, and only a custom harness without one starts fresh), no session or worktree is left, or its context peak exceeded `work.resume_max_context` (default 0.6) of the model's window (1M for `[1m]` models, else 200k); each fresh start records `attempt.fresh` with the reason. A resumed attempt runs `claude -p --resume <id>` in the rejected attempt's worktree, branch, and base, and counts the skills its first round loaded toward METHOD. Its prompt (saved as the attempt's brief) holds the verify outcome's reason, each failing head run with the trunk outcome, its command, the text of any script the command runs, and the last 20 lines of output (agents cannot open artifacts, so output is inline), then the verifier's report, the timebox, and the handoff format. A resume that starts no session (real `claude` prints "No conversation found" and exits 1; fixtures `claude-resume*.jsonl`) is recorded as a failed `harness-error` attempt that does not spend a try (`spendsAttempt`), and a fresh attempt starts at once. The agent page shows "resumes try N", a "Resumed" rail with what yagura sent, and each try's rejection in the unit's history.

**No agent-to-agent chat.** Agents never message each other. A worker that could ask a sibling or its verifier questions would make the brief an incomplete contract, let verification be negotiated rather than proven, and duplicate the scope rules that already keep parallel units apart (§8, §9). Interfaces between parallel units belong in both briefs, set by the planner, or in a `needs-source` dependency. Everything that passes between agents goes through the daemon as a record: verifier findings into a resumed or fresh worker, handoff notes and suggested follow-ups to the planner at the next drain. Whether a worker may post a one-way notice to running siblings in the same repo (`yagura note --siblings`, recorded as an event and injected into their streams the way "message the agent" is, §17) is open until a real run shows parallel units drifting in a way a better brief would not have prevented.

`verified` is a distinct state because it is the trigger for `needs-source` dependents, the queue for serialized landing and `merge: human`, and the state a voided verdict falls back from. Daemon-run units (`land`, `release`) pass through `handed_off` like every other unit; the UI labels it "completed" for them.

### Anti-fake rules (enforced by the daemon)

1. **The daemon runs the commands.** Before the verifier starts, yagura runs every pack check on base and head. The verifier then captures evidence only through `yagura evidence run --at base|head --label <l> -- <cmd>`: yagura runs the command in a clean checkout of that SHA inside the lease, restores the checkout afterwards, flags the run as tampered if the checkout had been modified, and stores stdout, stderr, and files written to `$YAGURA_EVIDENCE` as content-addressed artifacts. The verifier writes scenario scripts in a scratch directory outside the repo, designs the scenario, and judges; it cannot supply evidence yagura did not capture.
2. **Verdicts cite artifacts.** A verdict referencing unknown or foreign artifact ids is rejected.
3. **Verifier ≠ author.** Separate attempt, fresh context, sees acceptance + diff + verify recipe, not the worker's narrative.
4. **Trunk vs head.** Every behavioral verdict runs the scenario on the frontier and on the head. Bug fix: must fail on trunk, pass on head. Feature: trunk shows absence. Refactor: identical outcomes. Passing on both for a bug fix → `verifier-failed: scenario proves nothing`.
5. **Measurements are re-run.** Declared `measurements[]` are executed by the daemon on the head (orchestrate); >10% drift from the worker's claim is flagged. Hillclimb projects use only daemon-measured numbers.
6. **Harness tamper check.** A `work` diff touching the verify pack or test files matching the pack's protected globs is flagged; since 2026-09-30 the worker's scope forbids the pack directory outright, and pack changes come from verifiers (§13 "Judgment, evidence, and the trail").
7. **Keyed and voidable.** Verdict key = (repo, head SHA, dep SHAs, artifact versions). Any change voids it.

## 14. Multi-repo projects and artifact versions

- One unit writes exactly one repo. Related repos are mounted **read-only**, pinned to a SHA.
- `needs-source` deps: the consumer builds against the upstream unit's unlanded, verified output. `needs-landed`: waits for land (and release).
- **Qualified versions (default for Gradle/Nexus).** Each unit that publishes gets a unique version from the environment's scheme, default `<base>-yg-<project>-<unit>-SNAPSHOT`. Consumers pin that exact version, so parallel units never overwrite each other's snapshot. The verdict records the resolved timestamped version (`1.4.0-yg-perf-U3-20260926.101500-2`). Builds use `--refresh-dependencies` (or `cacheChangingModulesFor 0`) for yagura-qualified versions.
- Composite build (`includeBuild`) against the read-only worktree is the fallback when publishing is not wanted.
- **Landing order** follows deps: common lands (and its `release` unit publishes the real version) before consumers bump to it. Breaking changes are planned as expand → migrate consumers → contract; the contract unit depends on every consumer landing.
- Qualified snapshots are deleted (or left to a Nexus cleanup policy) when their unit reaches a terminal state.

**As built (needs-source and read-only mounts, 2026-09-30; `sources.ts`).** A `needs-source` dependency is satisfied once the upstream is `verified` (or landing, landed, done). Workers and verifiers get a detached read-only checkout of each needs-source upstream (`<worktree>.source-u<seq>`) at the upstream's landed commit, or else its live verdict's head, listed under READONLY, passed with `--add-dir`, and exported as `YAGURA_SOURCE_<REPO>` to the session and to every pack command the verifier runs, so a composite build can point at it. The mounts are recorded on the attempt (migration 14, `sources_json`) and on the verdict as its dep SHAs (`{"U1": sha}`), the verdict key's dependency part (§13). A consumer lands only after every needs-source upstream has landed, and only on a verdict proven against the upstream as it is now: at landing the engine compares the verdict's dep SHAs with the sources' current SHAs and, when one moved (the upstream landed, or was re-verified at a new head), voids the verdict and queues a fresh verification against the new source (`verdict.voided_by_source`). Not yet: qualified versions and Nexus, release units, and expand/migrate/contract planning.

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

| Event                             | Daemon action                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conflict`                        | Create a `rebase` unit (worker, scope = the MR's own write scope). Never rebases shared history itself unless it is a clean mechanical rebase.                                                                                                                                                                                                                        |
| `new-threads`                     | Create one `review-triage` unit per wave: for each thread, **fix** (red-first proof, in this MR), **dismiss** (concrete disproof posted to the thread), or **ask** (becomes a gate). Replies are posted by the daemon from the handoff, via the API with the body as data. Security / auth / data / migration findings are never dismissed without a gate.            |
| `pipeline-failed`                 | **Classify before retrying.** Failure outside the diff's files and the base is stale (`git merge-base --is-ancestor`) → `rebase` unit, not a retry. Infra/flake signature → one fresh pipeline (not a job retry). Identical second failure → it was never flake → `ci-fix` unit with the failing job logs in CONTEXT. Failure in the diff's own code → `ci-fix` unit. |
| push from any fix unit            | New head SHA → verdict voided → re-verify per the patch-id rule below → watcher re-armed.                                                                                                                                                                                                                                                                             |
| `approved` / human review pending | A wait, not a blocker. Shown on the dashboard; nothing is spawned.                                                                                                                                                                                                                                                                                                    |
| `merged`                          | Advance the frontier; void and re-queue dependent verdicts; start the retro watch.                                                                                                                                                                                                                                                                                    |

Budgets: fix units count against the unit's attempt budget; after 2 failed fix waves on the same MR it becomes a gate.

**As built (GitHub, 2026-09-30; `forge.ts`, `land.ts`).** A repo's forge is its `repos.forge` column (`none`, `gh`, `glab`), set with `yagura repo set <id> --forge gh`; `forge.repo` names the GitHub repo when the URL does not (`[host/]owner/name`), `forge.merge_method` (default `rebase`, which keeps yagura's squashed commit and trailers), `forge.gh_bin`, and `forge.poll_seconds` (default 30). All `gh` calls pass titles, bodies, and comments as arguments or stdin, never through a shell. Landing a verified unit squashes it onto trunk exactly as for `none`, then pushes that commit to `<prefix>/<project>/u<seq>` with `--force-with-lease` against the head yagura last pushed there (or "must not exist" for a new pull request), so a commit anyone else pushed to the branch is never overwritten and the unit blocks instead and opens (or finds, or reuses) one pull request per unit, recorded in `merge_requests` (migration 11). The unit stays `landing`; the engine starts no other lander in that repo while one is. Under `merge: human` the pull request opens at `verified` so it can be reviewed on GitHub, and the land gate decides the merge. The watcher (`watchMergeRequest`, one poll per `forge.poll_seconds`, a failed poll waits the same interval) reads state, mergeability, checks, head, and merge commit, and acts deterministically: merged (by yagura or a person, even from `blocked`) → the unit lands at the merge commit and the verdict carries when that commit's patch-id matches, else it is voided and `pr.merged_unverified` recorded; closed → blocked; head moved outside yagura → blocked (fail closed); behind or conflicting → re-squash onto the new trunk and push the same pull request (a conflict blocks for a rebase unit, a changed patch re-verifies); failing checks → the failed GitHub Actions runs for that head are re-run once (`gh run rerun --failed`, event `pr.checks_failed` with the run ids); failing again on the same head (or with no Actions run to re-run) is a code fault: the failing jobs' last 60 log lines go into a unit note, the verified work attempt gets `rejection: code-fault`, and the unit goes back to `ready` (or `blocked` when its attempts are spent), so the next attempt resumes the worker with the CI logs as its WHY and landing again updates the same pull request; running checks, a forge-side block, or no land approval → wait; clean and approved → `gh pr merge --match-head-commit`. An abandoned unit's open pull request is closed with a comment. Tests drive a fake `gh` (`fixtures/fake-gh.mjs`) over a real bare origin, including GitHub's rewrite of the commit on a rebase merge. **Review triage (as built, `triage.ts`, migration 12 `mr_threads`; replies apart from decisions, migration 19, 2026-10-01).** A triage records its decisions and moves the target on without touching the network; replies are pending rows (`mr_threads.replied_at`) posted at the end of the triage and again on every PR poll until they succeed. Each reply carries a hidden key (`<!-- yagura-reply:<project>/U<n>/w<wave>/<thread> -->`), and yagura reads the PR's comments before posting, so a reply GitHub posted while answering with an error is not posted twice. The watcher reads unresolved review threads, conversation comments, and review bodies through `gh api graphql`, skipping everything yagura posted (every yagura reply and comment ends with `<!-- yagura -->`). A thread is fresh when it is new, when a reviewer added a comment since the last wave, or when the developer answered its ask; order per poll is conflicts, then fresh threads, then an open ask (wait), then CI. Fresh threads queue one `review-triage` unit per wave (at most 3 per unit, then it blocks for the developer), recorded in `mr_threads` as the MR decision log, and the target waits `blocked` (not a plan trigger). The triage worker (overlay `yagura-review-triage`, required) starts at the verified head; CONTEXT quotes each thread as untrusted data with T-labels, the decisions of earlier waves, and the developer's answers; its handoff ends with `## Decisions` (`- T1: fixed | dismissed | asked — …`) for every thread. yagura refuses a handoff that misses a thread, claims a fix with no commit, or leaves the target's scope; turns a dismissal of anything about security, auth, secrets, data, or migrations into an ask unless the developer already said dismiss; posts the replies itself (fixed: the commit and what changed; dismissed: the disproof); opens a `review` gate (`fix | dismiss`) per ask; and records every decision. Fixes become a no-cost attempt on the target that is verified before the pull request is updated; with no change and no ask the target returns to `verified` and lands again; an open ask holds the merge until answered, and the answer starts the next wave with it as a directive.

**GitLab (as built 2026-10-01, `gitlabForge` in `forge.ts`; not yet run against a real GitLab).** `yagura repo set <id> --forge glab` lands through merge requests with the same watcher, rules, and audit trail as GitHub. `forge.repo` is `host/group/…/name` (groups nest, so the first segment is the host), read from the repo URL when unset; `forge.glab_bin` names the CLI. Commands were taken from `glab` 1.120.0's own help: `mr list --source-branch --output json`, `mr create --source-branch --target-branch --title --description-file - --yes`, `mr view --output json`, `mr merge --sha <head> --auto-merge=false --yes` (`glab` sets auto-merge on by default; yagura merges only when it decides to; `--squash` when `forge.merge_method` is squash, otherwise the project's own merge method applies, since yagura's single squashed commit lands the same either way and its patch-id is read from the merged commit's first parent), and `mr close`. The `glab mr note` commands are marked experimental, so comments, discussions, pipelines, job logs, and job retries go through `glab api` against REST v4 (`projects/<url-encoded path>/merge_requests/<iid>/discussions|notes`, `pipelines?sha=`, `pipelines/<id>/jobs?scope[]=failed`, `jobs/<id>/trace`, `jobs/<id>/retry`), with `GITLAB_HOST` and `--hostname` set to the project's host and bodies sent as JSON on stdin. Status maps `detailed_merge_status` (`mergeable` clean, `need_rebase` behind, `conflict`, `checking`/`unchecked`/`preparing` unknown, anything else blocked) and the head pipeline (`failed`/`canceled` failing; not yet done pending); a fast-forward merge has no merge commit, so the head is what landed. Discussions are threads: one of a single note is a comment, the rest are review threads, skipped once resolved; system notes are ignored. Messages say "merge request !4" on GitLab and "pull request #4" on GitHub (`prRef`). Tests drive a fake `glab` (`fixtures/fake-glab.mjs`) over a real bare origin: open and merge with the verdict carried through a merge commit, waiting on `checking`, a running pipeline, and the land gate, a failed job retried once then sent back with its log, discussions triaged with one reply even when GitLab answers 502 after posting, close and abandon, and project paths with nested groups.

**Rebase units (as built, `rebase.ts`).** A conflict at landing (the squash, or a pull request the forge reports conflicting) queues a `rebase` unit targeting the unit, whose own scope, acceptance, and verify it inherits, and blocks the target with the reason (that transition does not trigger a plan drain). A rebase worker (overlay `yagura-rebase`, required, plus cursor-team-kit:fix-merge-conflicts) starts on a branch at the verified head and rebases onto the exact trunk commit its goal names. yagura then aborts any rebase left in progress, discards leftovers, and accepts the result only when the handoff says success, trunk is an ancestor of the new head, and the diff from trunk stays inside the target's scope; the rebased head is recorded on the target as a `yagura-rebase` attempt (no try spent), its verdict is voided, and the target goes `blocked → verifying` with a fresh verify unit. A failed rebase leaves both blocked for the planner. After two rebase units for one target, a further conflict only blocks. A CI rework counts against the unit's attempts; the design's separate `ci-fix` unit is this rework of the unit itself. Not yet: classifying a failure outside the diff on a stale base as a rebase, resolving review threads on GitHub after a fix, GitLab, and the retro watch.

**What yagura rewrites, and why (user question, 2026-09-30).** Trunk is never rewritten: with forge `none` landing is a plain push that git refuses unless it fast-forwards, and on GitHub the merge is the forge's own, guarded by `--match-head-commit`. Rebasing happens only in yagura's private mirror on a unit's own commits: parallel units move trunk while a unit works, so its change is replayed onto the new trunk to land as a fast-forward, and a replay whose patch changed is verified again. The only branch yagura overwrites is the pull request branch it owns, when the pull request's single squashed commit is rebuilt (trunk moved, review fixes); merging trunk into that branch instead would avoid the overwrite but leave merge commits in the pull request and break the one-verified-commit-per-unit audit trail and patch-id rule, so yagura keeps the rebuild and makes it safe with the lease.

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
2. Rebase onto the frontier if needed. **Patch-id rule** (pstack shipping): if the base-to-head `git patch-id` is unchanged, the code verdict holds (the verdict is voided and carried to the rebased head) and only build + CI re-run; if it changed, re-verify. A rebase conflict blocks the unit for a `rebase` unit. (Phase 2 blocks on a changed patch too; re-verifying a rebased head arrives with the babysit units in phase 5.)
   - **As built (phase 5):** when the rebase is clean but the squashed patch-id differs from the verdict's, yagura keeps the rebased commits on `<branch>-rebased-<n>` in the mirror, records them as an attempt with harness `yagura-rebase` (base = the trunk it rebased onto), voids the verdict with the reason, moves the unit `landing → verifying`, and queues a fresh verify unit. That attempt does not count against the unit's attempts (`spendsAttempt`). A conflicting rebase still blocks for a `rebase` unit.
3. Land by the repo's forge adapter: `none` → fast-forward / merge push; `glab` / `gh` → **one MR per unit**: push with MR (`-o merge_request.create` works without API access), babysit as above until the forge reports mergeable, then merge. Whether yagura may click merge is a per-project setting (`merge: auto | human`); `human` stops at merge-ready and raises a gate.
4. `release` units publish real versions after land when a downstream `needs-landed` dep waits on them.
   - **Who merges and who closes.** `merge: auto`: yagura merges the MR once it is verified and CI is green. `merge: human`: a land gate; answering "land" makes yagura merge, or the human merges in GitLab and the watcher sees `merged` and marks the unit landed. yagura **closes** (never merges) the MR of a unit that is abandoned, cancelled by the planner or blocked and dropped, with a comment saying why and linking the unit. This matches pstack: babysit never merges on its own; agents merge only under an explicit operator grant.
5. **Retro watch** (after merge): watch trunk's post-merge pipeline and later reverts. A post-merge break creates a `ci-fix` unit against trunk (or a revert unit if the project allows auto-revert).
   **As built (2026-10-02, `retro.ts`, migration 25 `retro_watches`).** Every landing starts a watch on the landed trunk commit for `retro.watch_minutes` (default 60; 0 turns it off; per project or repo). The engine checks each watch once per `forge.poll_seconds`, for closed projects too. Each look first fetches trunk and looks for a later commit whose message says "This reverts commit <sha>": that ends the watch as `reverted`, notes it on the unit, tells the project's threads, and triggers a plan drain on an active project. With a forge, `commitChecks(sha)` reads CI on the commit (`gh run list --commit`, or GitLab's latest pipeline for the sha): passed ends the watch; none or pending wait until the window ends (`expired`); a failure re-runs the failed jobs once, and a second failure queues ordinary work rather than a separate `ci-fix` type, so it is verified, reviewed, and landed like any unit: "Fix trunk: <jobs> fails on <sha> after U3 landed" (scope and verify from the broken unit, playbook bug-fix, the failing jobs' last log lines in CONTEXT), or with `project.auto_revert` "Revert U3 (<sha>) on trunk" whose acceptance is `git revert --no-edit <sha>` and nothing else. A closed project reopens for it, the unit gets a note, the threads are told, and the story shows an "After landing" entry. Without a forge only reverts are watched. Tests: fake `gh` over a real origin (re-run once, then a fix with the log; passed; auto-revert), and a real revert pushed to a bare origin. The real `gh run list --commit … --json databaseId,name,status,conclusion` was checked against the sandbox (no workflows, so `[]`). Not yet: a real CI failure on a forge; reverts after the watch window ends.

### Audit trail

Every landed unit is **one squashed commit** on trunk (the agent's own commits stay on its `yg/…` branch). Its message is the unit's goal as the subject, the worker's "What I did" as the body, and trailers that lead back to everything behind it:

```
Yagura-Project: orders
Yagura-Unit: U2
Yagura-Attempt: U2.1 (claude-opus-5-5, pstack 0.5.0)
Yagura-Branch: yg/orders/u2-1
Yagura-Verdict: unit-verified by U3 (run:13, run:14)
Yagura-Link: http://devvm:7300/p/orders/u/2
Refs: gitlab#123
```

Squashing leaves the patch-id unchanged, so the verdict carries to the squashed commit. `Yagura-Link` appears when the `yagura.url` setting is set. Issue refs live on projects (`--issue`) and units (planner `refs`, CLI `--issue`); a unit's commit carries both. `yagura trace <sha|ref>` walks back from a commit (landed SHA, verified head, or attempt head) or an issue ref to the project, unit, work attempts (model, pstack version, skills loaded, branch), verification runs, verdicts, and handoffs. With a forge adapter (phase 5) the refs also go into the MR description and yagura comments on the issue when work lands.

## 16. Configuration

Settings are layered; a narrower layer overrides a wider one: **global → environment → repo → project**. The dashboard's **Settings** tab edits the global layer; each environment, repo, and project page has its own settings panel. Every setting shows its **effective value and which layer set it**. Settings live in SQLite, are validated by one schema, and can be exported/imported as YAML (to share a setup with a teammate or rebuild a box).

A few settings must be known before the database opens. They come from environment variables or `~/.yagura/yagura.yaml`, and are shown read-only in the UI:

| Bootstrap                     | Default              | Purpose                                                                                     |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `YAGURA_HOME`                 | `~/.yagura`          | store, worktrees, artifacts, logs                                                           |
| `YAGURA_PACKS_DIR`            | `$YAGURA_HOME/packs` | pack manifests (role mappings); skills themselves come from the harness's installed plugins |
| `YAGURA_SKILLS_DIR`           | bundled with yagura  | yagura's own overlay skills (`yagura-worker`, …); override to develop them                  |
| `YAGURA_BIND` / `YAGURA_PORT` | `127.0.0.1` / `7300` | dashboard + API listener                                                                    |
| `YAGURA_TOKEN_FILE`           | `$YAGURA_HOME/token` | dashboard/API auth when bound beyond localhost                                              |

### Global (Settings tab)

| Group                  | Settings                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Concurrency**        | `max_parallel_agents` (host-wide cap on running harness processes); `max_parallel_per_harness` (endpoint rate limits); `max_parallel_verifies` (heavy local builds); `planner_concurrency`                                  |
| **Harnesses**          | per harness: binary path, extra args, permission mode, env refs (e.g. `ANTHROPIC_BASE_URL`), enabled; **default harness per role** (worker / verifier / planner / …); optional **model per role** (unset = harness default) |
| **Packs**              | active pack manifest; required plugin versions; overlay version; doctor status of the harness setup (plugins installed/enabled, `pstack-models.md` present, its models reachable)                                           |
| **Timeouts & retries** | default timebox per unit type; max attempts per unit; resume on rejection on/off and `work.resume_max_context` (§13); fix-wave cap per MR (§15); stall timeout (no stream progress)                                         |
| **Git**                | agent commit identity (name/email), commit message convention (e.g. Conventional Commits), branch naming (`yg/<project>/<unit>`), mirror refresh interval                                                                   |
| **Forge**              | `glab` / `gh` paths, token refs per host, watcher poll interval, flake signatures (regexes classed as infra)                                                                                                                |
| **Storage**            | worktree retention (delete N days after terminal), artifact and log retention, disk-usage warning threshold                                                                                                                 |
| **Budgets**            | optional daily token/cost ceiling where the harness reports usage; action at ceiling (pause spawns / gate)                                                                                                                  |
| **Notifications**      | optional webhook or email relay inside the network for gates, andon, project done                                                                                                                                           |
| **Security**           | allowed bind addresses, token rotation, secret-ref backends (file, env, OS keychain)                                                                                                                                        |

### Environment

Provider settings, capacity (leases), values with their notes and checks, notes, **artifact-version qualifier scheme**, lease timeout, keep policy (`never` / `failed` / `always` with an expiry; §12 "Environment values").

### Repo

Default branch, forge adapter, verify pack path, protected globs (tamper check), qualifier scheme override, build flags (e.g. `--refresh-dependencies`), required CI jobs, whether direct push to trunk is allowed.

### Project

`max_in_flight` (≤ global cap), `min_tier`, `merge: auto | human`, auto-revert on post-merge break, wall-clock budget and landing cutoff (default 70%), harness per role overrides, pack manifest, planner drain cadence, standing orders, andon.

The scheduler always applies the tightest cap in force: a unit starts only if the global, per-harness, per-environment (leases), and per-project caps all have room.

## 17. Dashboard

- **Projects** list: predicate progress, in-flight, blocked, open gates.
- **Project** view: unit graph (deps, repo lanes, scope overlaps), live attempt logs (SSE), handoffs, verdicts with artifact viewer (screenshots, transcripts, diffs), decisions trail, andon.
- **Gates** inbox: every open human question across projects, with the default that applies on timeout.
  - **As built (2026-09-27):** `/gates` lists open questions, proposals waiting for Go, blocked work, and unread reports (the bell's items, `GET /api/inbox`), each question saying what happens if nobody answers, and the last 20 resolved gates, answered or defaulted. A gate with a default takes it `gates.timeout_hours` (default 24, per project, empty for never) after it opened (`defaultExpiredGates`, run each engine tick; state `defaulted`, event `gate.defaulted`, which triggers planning like an answer). A gate whose default is `hold` (land and phase gates) never times out, because holding is what waiting already does, and a gate without a default waits. The highlighted button is the default when it is a real choice, the held-back action (Land, Start) when the default is hold, and none when there is no default.
- **Environments**: create/edit, a paused environment, lease occupancy and queue.
- **Repos**: verify-pack status (proven / stale / missing), frontier, landing queue.
  - **Add an existing repo** (decided 2026-09-27): a repo can be registered without any project. The form takes a git URL (plus an id, defaulting to the repo name). yagura clones it into its own mirror, detects the default branch from the remote HEAD, and reports whether `.agents/verify/verify.json` exists on trunk and parses. All agent work happens in worktrees of that mirror, and landing pushes to the URL. A local working-copy folder is refused (decided 2026-09-27): landing would push into its checked-out branch, which git refuses, and yagura needs only the URL since it clones anyway. A path to a bare repo still works, as git treats it like a URL; the end-to-end proofs use one. Starting work on an existing repo goes through Talk: the watchman proposes the repo and the project together. A repo without a verify pack can be registered, but verification stays env-blocked until a pack lands (a `pack` unit, phase 5, or a watchman proposal that adds one).
  - **As built** (`repos.ts`, `pages/Repos.tsx`): `registerRepo` runs `git ls-remote --symref` first (unreachable or empty repos fail before anything is written), mirrors into `cache/repos/<id>.git`, reads the pack at the trunk SHA, and stores `pack_status` `unproven` (pack parses) or `missing`. `yagura repo add <git URL> [--id]` and `POST /api/repos {source, id?}` both use it; `GET /api/repos/suggest-id` fills the id placeholder. A working copy is refused before anything is written, naming its `origin` when it has one. Registration returns the missing-pack reason as a note. `GET /api/repos` lists each repo with its mirrored trunk SHA, the pack read live from it, its projects, verified units waiting to land, and the last landing. `@repo:id` links to `/repos#id`.
  - **Browse a repo** (later; prototype first): read-only views of a registered repo's trunk (files, recent commits with their yagura trailers linking to units), so a developer can look before talking to the watchman. The user wants it to feel like VS Code in the browser (2026-09-27): a file tree, tabs, and syntax highlighting. Leading option: the Monaco editor (VS Code's editor component) bundled into `apps/web` by Vite, so it works air-gapped, in read-only mode, fed by daemon endpoints that read the mirror (`git ls-tree`, `git show <sha>:<path>`, `git log`). The same viewer could open any ref: trunk, a unit's branch, or a worktree while an agent runs, plus a diff view of base against head. A full VS Code server (code-server or openvscode-server) was considered: it is heavier, is another binary to install on each VM, and brings editing and a terminal, which yagura does not want here.
  - **As built (repo browser, 2026-10-01; `browse.ts`, `apps/web/src/pages/Repo.tsx`).** Chosen from prototypes (B, "editor, story rail, history": https://claude.ai/artifact/C6n61NvGJaX42ZEkoUxRsH). `/r/<repo>`, linked from the Repos page, reads trunk from yagura's mirror (`GET /api/repos/:id/tree|file?path=|history?path=|change/:sha`; only the tree fetches, so one page stays consistent). Monaco is bundled by Vite (no CDN, workers from the build) in its own chunk that loads only on this page, read-only, with night and day themes read from the dashboard's tokens and following the toggle. Each line's unit comes from `git blame` on trunk, mapped to a unit by yagura's record of the landed SHA, else the commit's `Yagura-Project`/`Yagura-Unit` trailers; the gutter marks each block with its unit (`U3`, or `project/U3` from another project) in that unit's colour. The side panel switches between Explorer and History (what landed, newest first; "only units that touched" the open file); a unit opens its change as a tab beside the files (diff against the first parent; the first commit against the empty tree). The rail shows the unit behind the selected line, or the open change's unit: its goal, verdict, author and landing, its story entries (first sentence each), "Open the full story", "Show this change", and the same Disagree form as the unit page, over every line of its story. Binary files and files over 1 MB are not shown. Checked in the browser on the sandbox repo, night and daybreak.
  - **The unit hub (2026-10-01, from the developer's feedback that the views felt disconnected; prototype https://claude.ai/artifact/NTCdJLxANBL9aVV2TQ9vtk).** The unit page is the hub every view of a unit hangs off: Story (the ledger), Agents (`UnitStory.agents`: every session that worked on it, including the planner run that planned it, marked shared; a triage or rebase session counts only if its unit finished on it), and Code (`GET /api/projects/:id/units/:seq/code` → `unitCode`: the landed commit, or the latest handed-off branch against its base before landing, with per-file counts). The agent page and the editor always link back (breadcrumb, "for U3", "opened from U3's change"); the repo browser takes `?change=&file=&line=&from=`. The Agents page lists sessions across projects, each naming the unit it worked for, with project, role, and outcome filters.
- **Settings**: global configuration (§16) with effective-value/source display, YAML export/import, live counts against each concurrency cap.
- **As built (Environments, Settings; 2026-09-27):** Environments lists each environment with slots in use against capacity, who holds each slot and who waits (linked to the agent), the projects on it, and "verification paused" with a link to the gate while one is open. Create takes an id, name, implemented provider (`local-process` today), and slot count; edit changes name and capacity (`updateEnvironment`, event `environment.updated`); lowering capacity below the slots in use lets them finish and starts no new ones. Settings shows every global value with a plain description (`.describe()` on each `SETTINGS` schema, `describeSettings`), its source and default, Save and Reset (`clearSetting`), and running counts beside each cap (`GET /api/settings/overview`). YAML export holds every explicitly set value by layer (`global`, `environment.<id>`, `repo.<id>`, `project.<id>`); import sets every value in the file, keeps the rest, and applies nothing if any key or value is invalid. CLI: `yagura env set`, `yagura unset`, `yagura settings export|import`. Each setting declares the layers it is read at (`SETTING_LAYERS` in `config.ts`): global only (the global caps and the watchman's settings); project (project cap, planner timebox and role, verify retries, `harness.claude.*`); project and repo (worker timebox and role, max attempts, git author and branch prefix, `yagura.url`, skill enforcement); and project, repo, and environment (verifier timebox and role). `setSetting` and import refuse any other layer, because an override there would never be read; the engine, planner delta, and verify-unit creation resolve with the repo and environment so each declared layer takes effect. The project page has a collapsed Settings section, and environment and repo rows a Settings button, each listing only the settings for that layer with "set here" + Reset or where the value comes from.

**As built (evidence viewer, 2026-09-27).** The agent page's wide column has Log, Diff, and Evidence views. Diff is `git diff --stat --patch base head` read from yagura's mirror (`GET /api/attempts/:id/diff`, capped at 2 MB), so it survives the worktree; added lines are pine, removed lines faint. Clicking a trunk or head cell in the evidence grid opens that run (`GET /api/evidence/:id`): its command, outcome, and duration, stdout and stderr, and every file the run wrote to `$YAGURA_EVIDENCE`. Images (png, jpeg, gif, webp, svg) show inline; other text files preview up to 256 KB; anything else is a download. Because these files come from agents, `GET /api/artifacts/:id` serves only image types by extension, everything else as `text/plain` or `application/octet-stream`, always with `Content-Security-Policy: sandbox` and `nosniff`, so an agent-written HTML or SVG file cannot run script in the dashboard.

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

### Visual design: "the watch" (option F on the design canvas)

Chosen with the user from three rounds of mocks (canvas: https://claude.ai/artifact/AuLG6d7GiuQoSBFfdGeLS5, round 3). A yagura is a fire-watch tower, and the UI uses that literally but only for real state:

- **Palette.** Night (default): indigo sky `#11141f`, ridges `#171b2b`/`#1c2134`, cedar timber `#7a6758`, text `#ece6da`, muted `#a3a7b8`. **Amber `#f0a94a` means alive** (a running agent, a planner thinking, a verified signal). **Vermilion `#e5553a` means the bell: something needs you**, and is used for nothing else. Pine `#8fd1a8` for landed/passing evidence. Daybreak (light) variant with the same semantics.
- **Type.** Shippori Mincho (titles), Zen Kaku Gothic New (body), JetBrains Mono (ids, facts, evidence).
- **Home, "the watch".** One tower per project on a night ridge: lit windows = running agents, lit roof = planner, bell = needs you, dark tower = closed; dotted arcs of light between towers = real cross-project dependencies, fading when satisfied. Below: "The bell · needs you" inbox and "Lanterns lit" (running agents).
- **Project.** Beacon chains per unit across plan → work → verify → land toward the `main` fortress: steady light = passed, flame = current stage (with agent and elapsed), bell = needs you, red ember = blocked, unlit = not reached, dotted signal = waiting on another unit.
- **Rows.** Everything actionable is a full-width row: goal on its own line, a plain-language status line, one flowing line of small mono facts, actions at the right edge. Never table columns inside a row. No cost anywhere.
- **Japanese detail.** Towers are Edo fire-watch towers (hi-no-mi yagura): tapering timber frame with nuki beams and bracing, a front ladder, a railed lookout with **shōji panels** (one per agent slot, lit amber per running agent), a bronze **hanshō** under a plain straight-sloped hip roof (no curved eaves; curves are for the castle keep only), a ridge lamp for the planner. Scene: layered ink-wash ridges, moon (daybreak: pale sun), pines. `main` is a castle keep on an ishigaki stone base.
- **Motion carries meaning, never decoration.** Lit shōji flicker like candles (per-panel offsets) and the lookout glow breathes; the hanshō swings in short bursts with sound rings until the gate is answered or snoozed; the ridge lamp pulses while planning; signal arcs flow toward what is waited on; the current beacon's flame flickers, a blocked unit's ember smoulders. `prefers-reduced-motion` turns all of it off; the lights alone still carry the state.
- **Themes.** Night and daybreak both ship, toggled in the header (☾/☀), remembered per browser.
- Reference geometry and CSS: `docs/design/scene.py` (tower, pine, castle), `docs/design/anim.css`, and the mock artboards `docs/design/Watch-*.dc.html`.
- **What is drawn.** One tower per **project** (not per unit). Shōji panels = the project's agent limit (`project.max_in_flight`), lit per running agent; 3 per row, a second row up to 6, beyond 6 a count beside the lookout (e.g. `9/12`). The drawing never limits concurrency. About 6 towers fit the ridge, ordered by urgency (ringing bell, then busy, then idle); further quiet projects become small silhouettes on the far ridge with a "+N quiet" label; ringing or busy towers are never pushed back. Closed projects stand dark for a day, then leave the scene. A `framing` (not yet started, waiting in a chain) project stands dark.
- **Scene size.** ~290px on a 900px screen; labels drawn unscaled. On scroll it collapses to a slim horizon strip pinned at the top that keeps the lights (user, 2026-09-26).
- **Home also hosts the watchman:** a "Talk to the watch" input and the thread list beside the bell inbox (§8a). Typing `@` in any talk box autocompletes projects, units, attempts, threads, and repos; mentions render as links, and each project, unit, and agent page lists the conversations that mention it.
- The scene is for glancing; every light links to its row.

Bind to localhost by default; token auth when exposed on the LAN.

### As built (`apps/web`)

Vite + React + TypeScript, built to `apps/web/dist` and served by the daemon on the API's port (any non-`/api` path falls back to `index.html`); `pnpm --filter @yagura/web dev` proxies `/api` to the daemon for development. Fonts are bundled from `@fontsource` (Latin subsets for body and mono; Shippori Mincho with full coverage for titles and 櫓), so nothing loads from the network. Every color is a CSS variable with night and daybreak values; the toggle is remembered per browser. Live updates: one SSE connection (`/api/stream?since=latest`) triggers refetches; agent logs stream from `/api/attempts/:id/stream`. A `?token=` in the URL is stored and sent as a bearer token.

Pages: **The watch** (towers from `lib/scene.ts`: urgency order, ~6 on the ridge then "+N quiet", closed for a day then gone, arcs for open `after` chains; a sticky strip replaces the scene on scroll; bell inbox from `GET /api/bell` with the right actions per item; talk box; lanterns; conversations), **Talk** (round-4 option G1: threads | conversation | ledger of projects, decisions with superseded ones struck through, open questions; proposal cards with Go / Edit / Discard; autonomy toggle; `@` autocomplete), **Project** (beacons from `lib/units.ts`, grouped rows with Land / Hold / Retry with a note / Cancel / Watch / Stop, andon, "Add work" opens a conversation prefilled with `@project`), **Agent** (option H1: live timeline with per-step times, a rail with context and timebox meters, brief, trunk-vs-head grid from the verifier's runs, unit history), **Projects** and **Agents** lists. Environments, Repos, and Settings pages are not built yet.

Supporting daemon changes: each agent log line's arrival time is appended to a sidecar `<log>.times` (the raw harness log stays verbatim) and returned as `at`; `GET /api/bell`; `POST /api/projects/:id/units/:seq/retry` (note, one more attempt) and `/cancel`; project summaries carry agent slots, planner state, blocked count, last landing; units carry their live verdict and blocked reason; attempt detail carries the unit's history and its verifications' runs.

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
7. **More harnesses and packs:** codex/grok/custom adapters (each with session resume where its CLI has one, §13), pack manifests for pstack-claude forks, measurement-driven hillclimb projects.

## 20. Decisions log

Answers to the questions this design left open (2026-09-26):

1. **Host:** the daemon runs natively on each developer's RHEL9 VM (Windows host), which already has kube, Nexus, and GitLab access; dashboard reachable from Windows via the VM hostname (§4).
2. **Kube namespaces:** configurable per environment, `create` or `pool` mode; a pool caps concurrent live verifications, not agents (§12).
3. **Models:** the harness default applies unless a model is set per role in yagura (§10, §16).
4. **GitLab:** one MR per unit (§15).
5. **Environments and stack knowledge (2026-09-27, user):** environment values are editable in the UI; environments are values the developer adds, each with a note for agents and an optional check, with presets (kube, registry with push and pull addresses, kafka with cluster and local addresses, …) as shortcuts; they can be set up by form or through the watchman, and saved and applied as templates (values marked ask are filled in per machine); hard-coded values in a diff are rejected; a kept-namespace policy is configurable (`never` / `failed` / `always`). How to build a kind of project lives in harness skills, named per purpose in project settings; yagura writes new skills only from example repos or proven results, proves them, and asks before using them (§11 "Project skills", §12 "Environment values").
6. **Forges (2026-09-27, user):** repos can use GitHub (`gh`) or GitLab (`glab`), configured per repo with its host; GitHub is built and proven first on a private sandbox repo, GitLab on the dev VM.
7. **Agent communication (2026-09-29, user):** no chat between agents. A rejected worker resumes its own session with the verifier's findings instead of starting cold, within the limits in §13 "Resume on rejection"; one-way notices to siblings stay open until a real run needs them.
8. **Judgment over rules (2026-09-30, user):** agents are trusted to know how to test; the verifier checks the worker did what was asked, tests what was built, and keeps the verify pack current (fixing or extending it, or running `maintain-verification-skill`); the worker never edits the pack; yagura agrees or disagrees only on facts it can check; environment values and notes are context, not checks, and failures surface from real use to the watchman and the developer; the audit trail (each agent's decisions and reasons, yagura's checks, cost) lets the developer disagree with any decision after the fact (§13 "Judgment, evidence, and the trail").

## 21. The watchman as a live session (decided 2026-09-30, user; steps 1–3 built 2026-10-02)

Today each watchman message is a fresh harness session whose context yagura rebuilds from the store (§8a). The developer wants the conversation to feel like a Claude Code session: continuous, able to look things up and run read-only commands itself, with a "clear" that starts a new session. This section is the design; steps 1–3 are built (see "As built" below). It replaces §8a's "every message is a fresh harness session" and keeps the rest of §8a (records, mentions, proposals applied on Go).

### Principle, restated

No long-lived LLM _process_, and the store stays the truth. A session is a transcript the harness keeps on disk; yagura stores only its id. If the daemon restarts, a session is lost, or the developer clears it, the next turn rebuilds everything from the store as today. Nothing lives only in a session.

### Session continuity

- A thread has at most one **current session**: `thread_sessions(id, thread_id, harness_session_id, started_at, ended_at, ended_reason)` (`cleared`, `rolled`, `lost`). A turn resumes the current session (`--resume`, as workers do in §13 "Resume on rejection"); with none, it starts one.
- **First turn of a session:** the full brief of §8a (standing orders, decisions, questions, statuses, spec, recent messages). **Resumed turn:** only what changed since the last turn: the new message and, from the store, new or changed decisions and questions (including ones edited in the dashboard), spec edits, project status changes, gates opened or answered, and mentions. The session already holds the rest.
- **Clear** (dashboard button, `yagura thread clear <id>`, or `/clear` typed in the box): ends the current session with reason `cleared`. Decisions, questions, spec, and messages stay; the next message starts a new session with the full brief. The transcript shows a marker where the session changed.
- **Roll:** when a turn's context peak (already recorded per turn) passes `watchman.session_roll_tokens` (a setting, default 150k), the next turn starts a new session and says so in a system message. The harness's own compaction is not relied on, because the developer would not see what it dropped.
- **Lost session:** a resume that fails ("No conversation found", or the session file is gone) ends the session as `lost` and re-runs the same turn as a fresh session with the full brief. Not an error the developer sees, except as a system message.
- The one-turn-per-thread rule across processes (built) stays. Messages sent while a turn runs are queued and delivered together as the next turn, in order.

### Tools

The watchman gets tools, chosen by an allow-list rather than `bypassPermissions`:

- **Read:** `Read`, `Grep`, `Glob` limited to the thread's directory, each linked project's spec and unit handoffs and logs, and read-only mounts of registered repo mirrors' trunk (`--add-dir`, as workers get reference repos in §11).
- **`yagura` read commands** through `Bash(yagura <command>:*)` patterns: `show`, `thread search|show|mentions`, `agents`, `settings get`, `env list`, `project skills`, `doctor`. Read-only `git` (`log`, `show`, `ls-tree`, `diff`) against the mirrors.
- **Nothing else:** no file writes, no `git` writes, no network tools (§18), no other `Bash`.

The rule that writes go through one door does not change: the watchman changes yagura only through its records block and proposals (§8a), validated by yagura and applied on Go. Tools let it look things up (a unit's handoff, a repo's tree, an older thread) instead of guessing from a trimmed brief.

Enforced by yagura, not by the prompt:

- The allow-list is passed to the harness (`HarnessRun.allowedTools`; the claude adapter turns it into `--allowed-tools` and `--disallowed-tools`), and the watchman's permission mode is its own setting (`harness.claude.watchman_permission_mode`, default `default`), not the workers' bypass.
- Every watchman session gets `YAGURA_ROLE=watchman` and a per-turn secret (the same pattern as `YAGURA_EVIDENCE_TOKEN`). The CLI and daemon API refuse any mutating command from that role, so a pattern that is too loose in the allow-list still cannot write.
- A denied tool call is recorded in the turn's log and shown in the transcript.

### Dashboard

The thread page shows a **New session** button, the session marker in the transcript, a context meter (peak against the roll threshold), and the turn's tool calls as they happen (the live log exists). Stop exists. Clearing needs no confirm: it loses nothing.

### Build order

1. Session continuity and clear (`thread_sessions`, resume, delta brief, roll, lost fallback, the button and `/clear`). Useful alone, and the smallest step toward this.
2. Read tools: the allow-list, the watchman permission-mode setting, mirrors as read-only mounts.
3. The role guard on the CLI and API, with the per-turn secret.
4. Dashboard: session markers, context meter, tool calls in the transcript.

### Proof

Real SQLite and git; the fake agent extended to honour `--resume` and to attempt a denied tool. Tests: a second message resumes the first's session and its brief holds only the delta; clear ends the session and the next brief is full; a resume that fails re-runs fresh and records `lost`; a turn over the roll threshold starts a new session; the fake agent's write attempt is refused by the CLI guard even when the allow-list is widened; a read of another project's spec outside the thread's links is refused. Then one real `claude -p --resume` watchman exchange (Haiku) to capture the transcript as a fixture.

### As built (step 1, 2026-10-02)

- Migration 21: `thread_sessions(id, thread_id, harness_session_id, seen_json, started_at, ended_at, ended_reason)` with one open row per thread, and `watchman_turns.session_id`. A row is created when a turn's harness reports a session id it has not seen (`attachSession`), so a turn that never started leaves nothing behind.
- What a session was shown is a snapshot (`Seen`: decision and open-question texts by id, proposal states, each project's rendered spec and status, standing orders, the catalog, and the last message id), stored after every turn that produced a reply. A resumed turn's brief (`buildWatchmanUpdate`) is the diff against it: new or edited decisions and questions, ones no longer active (with what superseded or answered them), proposal state changes, changed statuses and whole changed specs, changed standing orders or catalog, and messages since the last turn other than the watchman's own. The records the last reply created are listed with their ids, since the session wrote them without ids. A session with no snapshot yet is resumed with the full brief.
- A rejected reply's retry resumes the same session with only the reason (`renderRetryInSession`); a harness that cannot resume still gets the full brief and the previous reply.
- Lost: a resume that emits no session event (as `No conversation found` does) ends the session `lost`, adds a system message, and re-runs the turn with the full brief. A stopped turn is not treated as lost.
- Roll: `watchman.session_roll_tokens` (default 150000, global); checked before the turn against the session's last turn's context peak.
- Clear: `clearWatchmanSession` (refused while a turn runs), `POST /api/threads/:id/clear`, `/clear` sent as a message (API and `yagura talk`), `yagura thread clear <id>`. Clear, roll, and lost each add a system message saying why.
- Dashboard: the thread header shows `session · Nk of 150k` and a New session button; the transcript draws a "new session" divider before the first message of each session after the first (`sessionStarts` in the thread view, from the turns, not from message text).
- Not yet: messages sent while a turn runs are still refused (409), not queued.

### As built (steps 2 and 3, 2026-10-02)

- The watchman runs with `harness.claude.watchman_permission_mode` (default `dontAsk`, which refuses every call nothing allows; `default` is not a mode in claude 2.1), `--allowed-tools` from `watchman.allowed_tools` (default: `Skill` and `Bash(yagura <read>:*)` for show, logs, trace, gates, settings, git, thread, env values|presets|notes, template list, project skills), and `--disallowed-tools Write,Edit,NotebookEdit,WebFetch,WebSearch` so an allow rule in the developer's own settings cannot hand those back. A real probe showed why Read, Grep, and Glob are _not_ on the list: a bare `Read` rule allows reading anywhere, while leaving them off lets `dontAsk` confine them (and read-only shell commands such as `cat`) to the working directory and `--add-dir`. The watchman's working directories are its thread directory and `<home>/projects/<id>/` for each project linked to the thread (spec, briefs, handoffs, logs); another project's files are refused.
- Repos are read through `yagura git <repo> log|show|ls-tree|diff|grep|blame`, not checkouts: it runs against the mirror (fetched when older than a minute; a failed fetch says so and reads what is there), refuses `--output`, `--no-index`, `--ext-diff`, `--textconv`, `-O`, and `--exec`, and refuses `HEAD` and the local default branch, which in a bare mirror stay where the clone left them (a real Haiku turn read `HEAD` first); `log` and `show` with no revision read `origin/<default branch>`.
- The role guard (`agentRefusal`, first thing in the CLI): with `YAGURA_ROLE` set, for every agent role and not only the watchman, the CLI runs only reads and `evidence` (which has its own token) and refuses everything else with exit 2, failing closed on anything it does not recognise. No per-turn secret: the guard trips on the role claim, not on proof of it, and dropping the claim (`env -u`, `YAGURA_ROLE= yagura …`) is itself a command outside the allow-list (a real probe: `FOO=1 echo hi` was refused even with `Bash(echo hi:*)` allowed). Workers run under `bypassPermissions`, so for them the guard is the only stop. The daemon API has no role check: agents have no network tool and no Bash beyond the list.
- The brief's LOOKING THINGS UP section says what the watchman can read and run.
- Proof: tests for the guard (every read allowed, every write and unknown command refused, any role), `yagura git` against a real mirror (reads, refused subcommands and options, stale refs, trunk by default), the adapter flags, and the watchman's run options. Real (Haiku, $0.17, fixtures `claude-watchman-tools.jsonl` and `claude-watchman-resume.jsonl`): asked for a word in a registered repo's README, the watchman found it with `yagura git`; `yagura set`, `cat /etc/hosts`, a redirect, `find` outside, and Write were refused and the setting was unchanged; the next message resumed the same session in 8 s and read the trunk log.
- Gaps: a broad `Bash(…)` allow rule in the developer's own settings still applies to the watchman (only the five tools above are denied outright). Step 4 (tool calls and denials in the transcript) is not built.

### Open

- The exact `yagura` and `git` patterns in the allow-list; start narrow and widen from real use.
- Whether the roll threshold should follow the model's context size instead of a fixed number.
- Whether a cleared session's transcript should stay readable in the dashboard (leaning yes, from the harness's log that yagura already records per turn).

## 22. Steering a running agent (decided and built 2026-10-02, user)

The developer watches an agent's log live; when it goes off track they can tell it something without stopping it. Stopping with a note (§17) stays for when the attempt should be thrown away.

### Mechanism

- Every claude session runs with `--input-format stream-json --replay-user-messages`: the prompt is the first stdin line, and stdin stays open. Verified with a real `claude -p` probe (Haiku, 2026-10-02, $0.03, fixture `claude-steer.jsonl`): a message written while a tool call ran was taken in right after that call finished, within the same response; the agent changed course; the CLI echoes every message it takes in as a `user` line with `isReplay: true`, the prompt first. The probe also showed the process stays alive after its `result` until stdin closes.
- A message is a row in `steers` (migration 22: body, state `pending` → `sent` → `delivered` or `undelivered`, reason, the log line it was read at). Each session polls its pending rows every second and writes them to stdin, so steering works whether the agent runs under the daemon or `yagura drive`. The echo marks a message delivered at its log line.
- yagura closes stdin on the session's `result`, even when a message is still unread: answering it would start a new response whose text replaces the handoff. A message the agent never read is marked `undelivered` with the reason ("the agent finished before reading it", "the agent had already finished").
- Any running attempt can be steered (worker, pack writer, verifier, triage, rebase, planner). Steering does not count as a try and does not change the attempt; it is recorded as an event (`attempt.steered`) and in the unit's story ("You told Worker U3.1", with read / not read).
- Interfaces: `POST /api/attempts/:id/steer {message}` (409 when not running, 400 when the harness cannot take messages), `GET /api/attempts/:id/steers`, `yagura steer <project>/U<n> <message>`, and on the agent page a box under the live log that shows each message's state; read messages appear in the timeline as "you" at the point the agent read them (the harness's echo of yagura's own prompt is not shown).

### Other harnesses

Steering is offered only for an adapter that implements `message(text)` (claude today). Before adding it for grok, codex, or any later harness, probe it the same way and record what it does: whether it reads messages from stdin while running, whether a message is taken in between steps or only after the whole response, how (and whether) it echoes a message it took in, and whether it exits on its own after its final result or waits for stdin to close. Capture the transcript as a fixture. Until then those harnesses keep the one-shot prompt and the API refuses to steer them.

### Open

- The watchman still runs one `claude -p --resume` per message (§21); a long-lived watchman on the same stdin mechanism waits on whether the per-message start is slow in real use.

## 23. The landing route is chosen, never defaulted (decided and built 2026-10-02, user)

The third real run landed two projects by pushing squashed commits to the sandbox's `main` although the developer asked for one PR per change: the repo had been registered without `--forge gh`, `none` was the silent default, and nothing showed the route before Go. A repo's landing route must be a deliberate choice that everyone can see, and the server should refuse what yagura must never do.

### Server side: protect trunk

The only hard guarantee is the forge's own rule. On GitHub, a branch protection rule on trunk that requires a pull request; on GitLab, a protected branch with "Allowed to push: No one" and merges through merge requests. A misconfigured yagura then fails loudly (the push is refused, the unit blocks with git's error) instead of landing quietly. This is the developer's to set on their forge; yagura does not check it (there is no `yagura doctor` since decision 8, and the developer chose not to protect the sandbox's `main`).

### yagura side

- **Route is part of registration.** `yagura repo add <url>` sets `forge` from the host: `gh` for `github.com`, `glab` for any host listed in the global setting `forge.glab_hosts` (the air-gapped GitLab hosts have their own names). For any other remote URL it refuses until the developer passes `--forge gh|glab` or `--land push`. Local paths and `file://` bare repos (tests, proofs) may push without asking. The CLI and the Repos page's form both say which route was chosen.
- **Pushing to trunk is explicit.** `repos.forge = 'none'` on a remote URL is only set by an explicit `--land push` (or the Repos page's "pushes to trunk" choice), recorded as an event. Existing remote repos with `none` and no such event are treated as unconfirmed: landing blocks with "how should sbx land: through PRs (gh), merge requests (glab), or by pushing to main?" until answered.
- **Everyone sees the route.** The Repos page shows it per repo ("through PRs (gh)", "through merge requests (glab)", "pushes to main"); the watchman's catalog lists it per registered repo; the proposal card shows it beside each project.
- **A request is checked against the route.** A proposal project carries `land: "pr" | "push"` (the watchman sets it from the conversation; omitted means the repo's route). `validateProposal` rejects `land: "pr"` on a repo that pushes, and `land: "push"` on a repo with a forge, with a reason the watchman relays ("sbx has no forge, so it would push to main; register it with --forge gh or agree to push"). The project stores the chosen route; landing refuses to take any other.

### As built (2026-10-02)

- `route.ts`: `chooseRoute` (github.com → `gh`; a host in `forge.glab_hosts`, global, → `glab`; a local path or `file://` → push without asking; `--land push` → push, confirmed; `forge none` on a remote, or an unknown remote host, → `RouteNeeded`), `describeRoute` ("through pull requests (gh)", "through merge requests (glab)", "by pushing to main", with ", not confirmed" for an unconfirmed remote), and `routeProblem`, which `landUnit` checks before squashing: an unconfirmed remote push repo, a project with `land: "pr"` on a repo without a forge, or `land: "push"` on a repo with one, blocks the unit with the question and the command to answer it.
- Migration 23: `repos.push_confirmed`, `projects.land` (`pr`, `push`, or null to follow the repo). Existing remote repos with forge `none` are unconfirmed until `yagura repo set <id> --land push` or a forge is set.
- CLI: `yagura repo add <url> [--forge gh|glab | --land push]` prints the route; `yagura repo set <id> --forge gh|glab | --land push`; `--forge none` is refused with a pointer to `--land push`. API: `POST /api/repos` takes `forge` and `land` and answers `400 { needsRoute: true }`. Repos page: a "lands:" choice in the add form and the route on every repo, in vermilion with the command when not confirmed.
- Watchman: the catalog lists each registered repo's route and how to use `land`; the proposal schema has `forge`/`land` on an existing repo and `land` on a project; `validateProposal` rejects a mismatch, an unconfirmed registered repo, and an existing repo whose route cannot be worked out, each with a reason the watchman relays; the `yagura-watchman` skill says to name the route in the reply. The proposal card shows each project's route (`proposalRoutes`), in vermilion when it would not land as agreed.
- Checked: in the third run's home the Repos page and the applied proposal card both show `sbx` as "lands by pushing to main, not confirmed"; from the CLI, the sandbox's github.com URL registers as "lands through pull requests (gh)" and an unknown host is refused with the three choices.

### Proof

Tests: `repo add` infers `gh` for a github.com URL and `glab` for a listed host, refuses an unknown remote host without a choice, and accepts a bare path; a proposal with `land: "pr"` on a pushing repo is rejected with that reason; landing blocks on an unconfirmed remote `none` repo; the proposal card and Repos page show the route (browser). (Branch protection on the sandbox was declined by the developer, so no refused-push proof.)

## 24. Code review before landing (decided and built 2026-10-02, user)

Nothing reviews a change's code before it lands. The verifier proves behaviour with evidence yagura captures; review triage answers what people write on a pull request. With `merge: auto`, a change can land that does the right thing badly: wrong place, duplicated logic, a security slip, against the repo's conventions. A reviewer agent reads every verified change before it may land, and its findings go through the review-triage loop that already exists.

### Setting

- `review.enabled` (boolean, default `true`), overridable per project, per repo, and globally, so a project can switch review on or off for itself. The project page's Settings panel shows it like any other setting.
- `role.reviewer.harness`, `role.reviewer.model` (empty: the harness default), and `skills.review` (skills every reviewer must load, enforced like `skills.verify`; for example the developer's own code-review skills). The reviewer gets the developer's whole harness like every agent.
- `review.max_rounds` (default 1): how many times a fixed change is reviewed again before remaining findings go to the developer.

### Flow

1. A work, pack, or ci-fix unit is verified. With review enabled, yagura queues a `review` unit targeting it (new unit type, in `UNIT_TYPES` and the schema `CHECK`; it counts against `project.max_in_flight` and the cost budget). The target waits in `verified`; it may not land until its review is settled.
2. The reviewer runs in a read-only worktree at the verified head with the overlay skill `yagura-reviewer` (required). Its brief holds the unit's goal and acceptance, the project's spec and the thread's active decisions, the diff against the base, the verifier's verdict and cited runs, and the repo's conventions file if there is one. It does not get the worker's handoff, so it judges the code rather than the worker's account of it. Any write is a rejection.
3. Its handoff ends with `## Findings`, one line each: `- F1 [blocking|should|nit] path:line — what is wrong and why, and what would fix it`, or `- none`. yagura refuses a handoff without the section, a finding without a location in the diff, or a severity outside the three.
4. `blocking` and `should` findings become threads in `mr_threads` (author `yagura reviewer`, source `review`). Review happens before the pull request opens; when it opens (and on every later push or poll until it is there), yagura posts one comment per finished review listing each finding and what became of it, so people reviewing on the forge see it. Then the existing loop handles them: a `review-triage` unit fixes or dismisses each, a dismissal of anything about security, auth, secrets, data, or migrations becomes a question for the developer, fixes are verified before the target moves on, and the decisions are recorded.
5. `nit` findings go into the unit's notes and the planner's suggested follow-ups; they never hold a merge.
6. The review is settled when every blocking and should thread is fixed (and verified), dismissed, or answered by the developer. A fixed change is reviewed again, only over the fix, up to `review.max_rounds`; after that, open findings become one question for the developer. Then landing proceeds as today: `merge: auto` merges, `merge: human` waits at its land gate with the findings visible on the PR.

With review disabled for a project, step 1 is skipped and verified units land as today.

### Dashboard

The unit story gets a "Reviewer" entry with each finding (severity, location, and what became of it: fixed in which commit, dismissed with what reason, or asked); the Agents tab lists the reviewer's sessions; the project page shows "reviewing" as a unit's stage between verified and landing.

### Proof

Tests with the fake agent: a review with one blocking finding becomes a triage that fixes it, the fix is verified and reviewed again, and the unit lands; a nit lands as a note without holding the merge; a security dismissal becomes a developer question; `review.enabled` false on one project lands without a reviewer while another project in the same repo is reviewed; a reviewer that writes is rejected. Then one real run on the sandbox with review on, through PRs, including at least one real finding taken through triage.

### As built (2026-10-02)

- Unit type `review` (in `UNIT_TYPES`, both schema `CHECK`s, role `reviewer`). Migration 24 adds it to existing databases by rebuilding `units` from its live definition with foreign keys off, then `foreign_key_check`; the migration runner gained `rebuild` migrations for this. Proven on the second run's database (version 20 → 24, every unit kept, no broken keys). `TERMINAL_STATES` now lives once in `domain.ts`.
- `review.ts`: `reviewStatus(target)` → `settled` (review off, or reviewed with nothing open), `needed` (not reviewed, or fixed since and rounds left), `pending` (a review or its triage is running or queued), `answered` (the developer answered an asked finding: the next triage wave starts with the answer as its directive), `waiting` (blocked, or an open question). The engine's `land` step acts on it before anything lands, and `isIdle` counts only what it would act on. `queueReview` adds the review unit (timebox `timebox.verify_seconds`, 2 tries); a re-review carries `since:<head>` and reviews only `git diff <last reviewed head>..<head>`.
- `runReviewUnit`: a worktree at the verified head; the brief gives the diff command and stat, the verifier's tier, the repo's `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` when present, the project's active decisions, and the spec (first 6000 characters), not the worker's handoff. A handoff without `## Findings`, a malformed or out-of-diff finding, a skipped `yagura-reviewer` or `skills.review` skill, or any change to the worktree is a failed try (back to ready once, then blocked). Blocking and should findings become `mr_threads` rows `review:U<n>:F<k>` by "yagura reviewer" and a `review-triage` wave (`queueTriage` now takes a label, so triage runs with or without a pull request and replies only to a forge's own threads); nits become notes on the target. When a pull request is already open, the findings are also posted on it as one yagura comment.
- Settings: `review.enabled` (default on), `review.max_rounds` (default 1), `role.reviewer.harness`, `role.reviewer.model`, `skills.review` (a new skill purpose), each overridable per project and per repo. Overlay skill `plugins/yagura/skills/yagura-reviewer`.
- Dashboard: the unit story has a Reviewer entry per review (each finding with its fate: fixed in which commit, dismissed and why, asked, or kept as a note; "N to settle" / "N settled" / "nothing to settle"), and "Reviewer (the fixes)" for a re-review; reviewer findings no longer show as people's PR comments or with a reply check; the Agents tab names reviewers with a findings summary; a verified unit under review reads "Verified; code review in U7 before it lands."
- Tests: `review.test.ts` (findings parser), engine tests "code review (§24)" (blocking finding → triage fix → verified → re-reviewed → landed; nit as a note; a security finding asked, answered, fixed; review off for one project; a reviewer that writes rejected twice and blocked), the story test. Checked under the daemon with the fake agent in a scratch home: review U16 raised a blocking finding, triage U17 fixed it, U18 verified the fix, U19 re-reviewed the fixes with nothing found, and U4 landed; the story and Agents tab read as above.
- On the pull request: `postReviewComments` posts one comment per finished review ("yagura's code review (U8): - [nit] `tests/test_csv.py:41` … → kept as a note"; "nothing to raise" when clean), keyed so it is posted once, from `propose` after each push and from every PR poll; `findingFates` gives the same wording to the story. Test: fake `gh` over a real origin shows one comment after landing and a later poll. The fourth real run (before this) showed PR #14 with no comments.
- Not yet: a real blocking or should finding taken through triage on a real run.

### Order

Build §23 first (it is small and stops the harm), then §24.

### As built (header search, 2026-10-02)

The developer chose, from a clickable prototype on real run data (https://claude.ai/artifact/Fmgm89ZWDRWoKCBG5Nj69b): a search box in the header on every page; typing shows results in a drop-down under the box; clicking a result opens its page; "all results" opens a results page. The drop-down closes when the box loses focus or on Escape; `/` focuses the box from anywhere.

- `find.ts` (`GET /api/find?q=&per=`): every word must appear, any case, `%` and `_` taken literally. A commit (via `findUnitsByCommit`), an issue key (via `findByRef`, projects and units), or `U3` / `project/U3` names its units first; then unit goals (build units), projects, decisions, questions (with answers), review threads (people's and the reviewer's), conversation messages, handoffs (the `search` table's bodies), and repos, up to 200 each. `per` caps hits per kind for the drop-down while `counts` stay whole; each hit's text is an excerpt around the first match.
- Web: `ui/SearchBox.tsx` in the header (three per kind, arrow keys, Enter opens the selected result or the results page), `pages/Search.tsx` at `/search?q=` (a summary line, kind filters always visible, a ledger with location links and highlighted matches), `lib/search.ts` (grouping and highlighting, unit-tested).
- Not yet: a conversation result opens its thread at the end rather than at that message.
