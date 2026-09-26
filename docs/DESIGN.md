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

**As built (phase 3).** The delta is the last fenced ```json block of the planner's final message, validated strictly (unknown fields are rejected): `add[]` (`key`, `repo`, `goal`, `write`, `forbid`, `accept`, `verify`, `context`, `playbook`, `timeboxMinutes`, `deps[{on, kind}]` where `on` is a key in the delta or `U<n>`), `amend[]` (units not started), `retry[]` (blocked/failed/rejected units, with a note carried into the next brief and one more attempt), `cancel[]` (idle units; running ones are reported, not killed), `gates[]` (question, options, default), `done`, `summary`. Scope overlap is decided on each glob's static base path, conservatively. A drain is triggered by the first run, a unit landing, blocking, or being abandoned (except by the planner itself), a rejected delta, an answered gate, or andon being cleared; the trigger window starts when the previous drain started, so nothing that happens while a planner runs is missed. Three rejected deltas in a row raise andon. The project closes when the latest applied delta says `done` and no unit is left except blocked ones.

## 8a. The watchman: talking to yagura

yagura's front door is a conversation. A developer talks to the **watchman** (*bannin*) to start work or evolve it; the watchman turns the conversation into projects, and reports back when they are done. It serves both ways of working: hand it a finished spec ("here is BUILD_SPEC.md, build it") or grow something conversationally ("prototype a Kafka diff service" … "now ignore timestamp fields").

### Flow

1. **Talk.** The watchman asks only what no experiment could settle.
2. **Propose.** A proposal lists projects (one, or a chain with `after` dependencies), their goals and done predicates, repos (existing, or a new repo for a prototype), environment, a starting verify pack, merge policy, minimum tier, and initial units or spec. The developer answers **Go / Edit / Discard**.
3. **Build.** The projects run as usual (plan → work → verify → land).
4. **Report.** When the thread's projects close (or block), the bell rings and the thread gets a report assembled from records: what landed and how it was verified, how to run it (from the verify pack's commands), what is still open, trace links.
5. **Evolve.** Further messages in the same thread propose amendments: new units, spec changes, new projects.

**Autonomy per thread:** `propose` (default; nothing starts without Go) or `go` (prototyping: applies its own proposals and rings only for real decisions and the report). Irreversible actions (creating a GitLab project, deploying beyond dev, force operations) always ask. **Prototype defaults:** new repo, `min_tier` unit-verified, `merge: auto`, a short wall-clock budget.

### Memory: the database, never the conversation

The watchman follows yagura's first principle: no long-lived LLM context. Every message is a fresh harness session whose context is assembled from the store under a fixed token budget (default ~40k tokens, a setting).

| Stored | Content |
|---|---|
| `threads` | title, autonomy, linked projects, state |
| `thread_messages` | every human and watchman message, verbatim; FTS-indexed |
| `thread_decisions` | one structured record per decision (text, source message, superseded-by) |
| `thread_questions` | open questions; resolved with the answering message |
| `proposals` | the proposed change set, its state (pending, applied, edited, discarded), and what applying it created |
| `projects/<p>/spec.md` | the living spec the watchman maintains, in addressable sections |
| reports | done/blocked summaries, generated from records |

**Context assembly, in priority order:** (1) watchman instructions and standing orders; (2) all *active* decisions and open questions; (3) a generated status of each linked project; (4) the spec sections relevant to the message (by heading), never a whole large spec; (5) the most recent messages verbatim, trimmed oldest-first to fit; (6) nothing older — the watchman can pull an older detail with `yagura thread search`.

**Every turn ends with structured records** alongside the reply: decisions added or superseded, questions opened or resolved, spec section edits, and an optional proposal. yagura validates them (schema, references) and stores them atomically. A decision made 200 messages ago is still exactly in `thread_decisions`; nothing important depends on recalling or summarizing old messages.

Proposals apply through the same validated paths as planner deltas and CLI commands; the watchman never writes to the store directly.

**As built.** A turn is `runWatchmanTurn` (`watchman.ts`): the human message is stored, the brief is assembled from the store under `watchman.context_tokens` (chars/4 estimate): fixed parts first (template, standing orders from `threads/<id>/standing-orders.md`, active decisions `D<n>`, open questions `Q<n>`, recent proposals, a catalog of repos/environments/taken project ids), then linked project statuses (≤35% of what is left, each truncated with a pointer to `yagura show`), then spec (≤30%: a small spec whole, a large one as its heading list plus sections whose heading words appear in the message), then messages newest-first until the budget runs out (the newest is always kept). The session runs in `threads/<id>/` through the same `runAgentSession` as every agent, with a thread recorder instead of an attempt (`SessionRecorder`). The reply's last fenced `yagura` block holds the records (`title`, `decisions[{text, supersedes?}]`, `questions[]`, `answered[{question, answer}]`, `spec[{project, section, body|null}]`, `proposal`); unknown keys, dangling references, spec edits for projects outside the thread, and invalid proposals reject the whole block. The watchman then gets one retry with its reply and the reason appended to the same brief; if that is rejected too, the prose is stored and a system message says why. A reply without a block is plain conversation.

A **proposal** (`proposal.ts`) has `repos[]` (new local repos: id, description, a required starting `verifyPack`; created as a bare repo under `~/.yagura/repos/<id>.git` with a README and the pack in one commit), `projects[]` (id, goal, predicate, repos, environment or null for the only/new `local` environment, merge, minTier, after, phaseGate, refs, spec, initial units in the planner's unit schema), and `amend[]` (units for a thread's existing project; a closed one reopens). Applying it validates again, creates repos, then adds projects, links them to the thread, applies units through `applyDelta`, and writes `spec.md`, in one transaction. Spec edits record `project.spec_changed`, which triggers a plan drain; the plan brief points the planner at `spec.md`. The irreversible actions named above are not in the proposal schema, so `go` applies every valid proposal.

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

The pack a verification uses is always read from **trunk** (`origin/<default>`), never from the change being judged, so a change cannot weaken the checks it is measured by. In phase 2 `verify.json` carries `provider`, optional `doctor`/`deploy`/`teardown`, `checks[]` (`name`, `command`, the `tier` a pass proves, `timeoutSeconds`), `features[]`, and `protected` globs.

Generated by a `pack` unit (pstack `create-verification-skill`, adapted to this contract) from the repo + the environment profile. **Not trusted until its proof run passes**: deploy into a leased slot, drive one feature, capture evidence, tear down, evidence still present. Maintained by periodic `pack` units (`maintain-verification-skill`).

### Tiers

`deployed-verified` > `live-local-verified` > `e2e-verified` > `unit-verified` > `build-only` > `verifier-blocked` / `verifier-failed`.

The project's `min_tier` gates landing. `verifier-blocked` is never a pass.

### Verification outcomes → unit state

Only a code fault sends a unit back to work; environment and verifier problems never burn a work attempt.

| Outcome | Target unit | Next |
|---|---|---|
| `verifier-failed` with a cited failing head run, or a pack check that passes on trunk and fails on head | `verifying → rejected → ready` | new work attempt with the verifier's findings in its brief; counts toward `max_attempts`, then `blocked` |
| `verifier-blocked` (environment broken) | stays `verifying` | re-verify when the environment's doctor passes; repeated → `blocked` + gate |
| pass below `min_tier` | stays `verifying` | a stronger verify unit; if none is possible (no proven pack) → `blocked` + a `pack` unit proposed |
| verifier attempt died with no verdict, or its verdict is invalid (cites unrecorded or tampered runs, or its scenario also passes on trunk and so proves nothing) | stays `verifying` | retry the verify unit; after `verify.max_retries` (2) → `blocked` |
| pass ≥ `min_tier` | `verifying → verified` | waits for the lander; `needs-source` dependents may start |

`verified` is a distinct state because it is the trigger for `needs-source` dependents, the queue for serialized landing and `merge: human`, and the state a voided verdict falls back from. Daemon-run units (`land`, `release`) pass through `handed_off` like every other unit; the UI labels it "completed" for them.

### Anti-fake rules (enforced by the daemon)

1. **The daemon runs the commands.** Before the verifier starts, yagura runs every pack check on base and head. The verifier then captures evidence only through `yagura evidence run --at base|head --label <l> -- <cmd>`: yagura runs the command in a clean checkout of that SHA inside the lease, restores the checkout afterwards, flags the run as tampered if the checkout had been modified, and stores stdout, stderr, and files written to `$YAGURA_EVIDENCE` as content-addressed artifacts. The verifier writes scenario scripts in a scratch directory outside the repo, designs the scenario, and judges; it cannot supply evidence yagura did not capture.
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
2. Rebase onto the frontier if needed. **Patch-id rule** (pstack shipping): if the base-to-head `git patch-id` is unchanged, the code verdict holds (the verdict is voided and carried to the rebased head) and only build + CI re-run; if it changed, re-verify. A rebase conflict blocks the unit for a `rebase` unit. (Phase 2 blocks on a changed patch too; re-verifying a rebased head arrives with the babysit units in phase 5.)
3. Land by the repo's forge adapter: `none` → fast-forward / merge push; `glab` / `gh` → **one MR per unit**: push with MR (`-o merge_request.create` works without API access), babysit as above until the forge reports mergeable, then merge. Whether yagura may click merge is a per-project setting (`merge: auto | human`); `human` stops at merge-ready and raises a gate.
4. `release` units publish real versions after land when a downstream `needs-landed` dep waits on them.
   - **Who merges and who closes.** `merge: auto`: yagura merges the MR once it is verified and CI is green. `merge: human`: a land gate; answering "land" makes yagura merge, or the human merges in GitLab and the watcher sees `merged` and marks the unit landed. yagura **closes** (never merges) the MR of a unit that is abandoned, cancelled by the planner or blocked and dropped, with a comment saying why and linking the unit. This matches pstack: babysit never merges on its own; agents merge only under an explicit operator grant.
5. **Retro watch** (after merge): watch trunk's post-merge pipeline and later reverts. A post-merge break creates a `ci-fix` unit against trunk (or a revert unit if the project allows auto-revert).

### Audit trail

Every landed unit is **one squashed commit** on trunk (the agent's own commits stay on its `yg/…` branch). Its message is the unit's goal as the subject, the worker's "What I did" as the body, and trailers that lead back to everything behind it:

```
Yagura-Project: orders
Yagura-Unit: U2
Yagura-Attempt: 5 (claude-opus-5-5, pstack 0.5.0)
Yagura-Branch: yg/orders/u2-1
Yagura-Verdict: unit-verified by U3 (run:13, run:14)
Yagura-Link: http://devvm:7300/p/orders/u/2
Refs: gitlab#123
```

Squashing leaves the patch-id unchanged, so the verdict carries to the squashed commit. `Yagura-Link` appears when the `yagura.url` setting is set. Issue refs live on projects (`--issue`) and units (planner `refs`, CLI `--issue`); a unit's commit carries both. `yagura trace <sha|ref>` walks back from a commit (landed SHA, verified head, or attempt head) or an issue ref to the project, unit, work attempts (model, pstack version, skills loaded, branch), verification runs, verdicts, and handoffs. With a forge adapter (phase 5) the refs also go into the MR description and yagura comments on the issue when work lands.

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
