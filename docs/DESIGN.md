# yagura 櫓 — design

Status: the core loop (§3, §6–§9, §12–§15, §26) was redesigned on 2026-10-08, built on `core-loop`, and proven with a real model on real GitHub on 2026-10-14 to 10-16. Earlier sections keep the date they were decided; where one disagrees with those, those win.

yagura runs long-lived engineering **projects** with coding agents: it plans work into units, runs many agents in parallel in isolated worktrees, has a fresh judge check each unit against proof it captured itself, and merges what is approved. It runs on one machine in an air-gapped network, drives whatever agent CLI the developer uses, and shows everything in a web dashboard.

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
- Replacing CI. CI results are an input to a merge, never the verdict.

## 2. Principles

1. **The daemon owns the truth; LLMs propose.** Scheduling, state transitions, leases, recorded runs, merging, and publishing are deterministic code. LLMs plan, do work, and judge. The coordinator is a program: no long-running chat, and every agent is woken for a reason and ends.
2. **Goals, not instructions.** A unit says what must be true when it is done. It never says which files to touch.
3. **The builder proves its work; a fresh agent judges it.** The worker shows evidence yagura recorded itself. A judge with no shared context decides whether the goal is met.
4. **One pull request per unit, and it is the unit's public record.** It stays a draft while yagura works on it, collects every commit, and merges as a merge commit.
5. **Agents talk inside yagura, and every word is kept.** What agents say to each other (findings, answers, questions, decisions) is stored in the database and shown on the unit's page. The forge gets only what people need: the pull request, its commits, when it is ready, and replies to people.
6. **Problems go to whoever can decide them.** A worker goes to its unit lead. A unit lead asks the developer directly when the question is the developer's, and goes to the project lead only when the plan itself must change.
7. **yagura does the mechanics.** Branches, pull requests and their draft state, merges, keeping branches current, scheduling, recording, budgets. It never decides whether work is good.
8. **Agents act through commands.** What an agent decides reaches yagura through a `yagura` command, checked when it is called and recorded, never parsed from prose (§27). An agent that ends without its command is reminded before its session closes.
9. **Judgment, then facts.** Agents judge how to test and keep the environment's actions current; yagura checks only facts it can check, records everything, and the developer can disagree after the fact. Up-front checks of environments are gone: a real failure in use says more.

## 3. Domain model

```
Environment ─┐ (shared, top-level)
             │ provider, capacity, values, answers, actions
Repo ────────┤ git URL, default branch, forge adapter (gh | glab | none)
             │
Project ─────┘ goal, done-predicate, merge policy, standing orders, environment, repos[]
  └─ Unit      one repo, goal, acceptance, context, base, after, refs
       ├─ Attempt   one harness session (worker, judge, unit lead, planner): checkout, branch, session, cost
       │    └─ Record    what the agent decided through a command: hand-off, judge verdict, decision, plan
       ├─ MergeRequest   the unit's one pull request
       └─ Evidence run   a command yagura ran in the unit's checkout for an agent, with its output
```

| Entity          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Environment** | Shared across projects. Holds the developer's answers (how tests run, how libraries publish, …), values (`NEXUS_URL` with a note for agents), and actions (§12). Nothing about it is checked up front. Holds credential _references_, never secrets.                                                                                                                                                                                                                                                                                                                          |
| **Repo**        | Registered once by URL. Many projects can target it. Holds the forge adapter and its settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Project**     | `goal`, `predicate` (checkable, e.g. "the app prints HELLO, APP!"), `merge` policy (`auto` or `human`), `standing_orders` (numbered lines pasted into every brief), `environment`, `repos[]`, `budget` (wall clock, dollars, max in flight).                                                                                                                                                                                                                                                                                                                                  |
| **Unit**        | Types `plan` (a planning round) and `work`. Exactly one repo. Fields: `goal` (one sentence), `acceptance[]` (outcomes a judge can check, each with an optional `proof`: the page of the repo's verification guide that proves it, §13a), `context`, `base` (the branch it starts from and merges into; the repo's default branch unless the plan says otherwise), `after[]` (units that must merge first), `refs` (issues it answers; a ref to its own repo closes the issue on merge). There is no write scope, no forbidden paths, no verify command per unit, and no tier. |
| **Attempt**     | One execution of a unit by a harness. Retries create new attempts; the unit keeps its identity. Doctor runs are not units: they are numbered D1, D2 on their own (§12).                                                                                                                                                                                                                                                                                                                                                                                                       |

### Unit state machine

```
waiting ──(after-units merged)──▶ building ──(worker hands off)──▶ judging
                                     ▲                               │
                                     └────────(changes asked)────────┤
                                     ▲                               │ approved
                                     │                               ▼
                                     └──(comment fixed · conflict ── ready ──(merged)──▶ merged
                                         resolved · CI fixed)

 stuck ◀── from building, judging or ready when the unit lead must decide; it sends the unit back to building, to the developer, to the project lead, or to dropped
```

- **waiting**: its `after` units have not merged, or a test build it needs is not yet available (§14).
- **building**: a worker is on it. yagura creates the branch `yagura/<project>/u<n>` from the unit's base the first time.
- **judging**: the judge is on it.
- **ready**: approved; the pull request is out of draft. It waits for CI, for the developer's merge when the project asks for one, and for any comments.
- **merged**: done. Issues it closes are closed by the forge.
- **stuck**: the unit lead decides what happens next.
- **dropped**: the unit lead, the project lead, or the developer gave up on it.

Transitions are daemon-only: every change goes through `transitionUnit`, which checks `UNIT_TRANSITIONS` and records an event. Agents never set state; they run commands, and yagura acts on them. A worker that skipped a required skill of its role (`pstack:poteto-mode`, `pstack:principle-prove-it-works`, `pstack:principle-test-behavior-not-implementation`) is recorded as `attempt.method_miss`, and the unit goes to `stuck` with a note naming the skills, even if the change is good; its unit lead decides. `method.enforce_required_skills` switches this off. Judges and unit leads are told in their brief to load their own skill, and a miss is recorded but does not reject them.

## 4. Architecture

```
┌──────────── yagura daemon (one process) ─────────────┐
│  HTTP API + SSE ── dashboard (React)                 │
│  Scheduler ── readiness, leases, caps        │
│  Runner ───── spawns harness processes, streams logs │
│  Judge ────── fresh session per round; evidence runs │
│               are executed by the daemon             │
│  Merger ───── merge commit per unit, keeps branches  │
│               current, publishes test builds         │
│  Unit lead ── woken per unit when it needs a decision│
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

**Worktree lifetime (2026-10-02, `worktrees.ts`).** A worker works in its own checkout of its unit's branch, a clone of yagura's mirror (so a push is checked by the mirror's relay and a worktree cannot bypass it); judges and doctors get throwaway checkouts. A checkout stays while the unit can still continue (building, judging, ready, stuck) and is deleted once the unit is merged or dropped: evidence is stored as artifacts, diffs come from the mirror, and a rework whose checkout is gone starts fresh. The engine sweeps once a minute.

Core tables: `settings` (layered config, §16), `environments`, `environment_values`, `repos`, `projects`, `project_repos`, `units`, `unit_deps`, `attempts` (incl. plugin versions, models, and skills loaded), `agent_records` (what an agent decided through a command, §27), `leases`, `artifacts`, `evidence_runs` (one row per command yagura ran for an agent, with its checkout, SHA, exit, and output), `gates`, `merge_requests` (§15), `publications` (§14), `actions` and `action_runs`, `doctor_runs` (§12), `disagreements`, `retro_watches`, `events` (append-only; the dashboard's SSE feed and the audit log), and an FTS5 index over briefs, hand-offs, and log text (§17).

Schema changes ship as numbered migrations applied on open (`packages/core/src/migrations.ts`); `schema.sql` is the version-1 baseline.

Bootstrap settings (§16) live in `~/.yagura/yagura.yaml` or environment variables, since they are needed before the database opens.

Files that agents read (standing orders, briefs, handoffs, status) are markdown so any harness can read them with no yagura client.

## 6. Project lifecycle

1. **Frame** (developer + watchman). Goal → predicate, environment, repos, merge policy, budget. The watchman proposes; the developer starts it.
2. **Doctor.** A repo that no doctor has looked at on the project's environment gets one (§12), so the actions agents need exist before they need them. It does not hold the project back.
3. **Plan.** The project lead (a planner session, unit type `plan`) turns the goal into units, checking that they fit together (§8).
4. **Scale.** Units whose `after` units have merged start, up to the project's in-flight cap; refill as units finish. Never blocking batches.
5. **Drain.** When a unit merges, drops, or the lead asks for it, yagura wakes the planner with a generated state snapshot (§8).
6. **Budgets.** `project.budget_hours`, counted from the project's activation: from 70% the engine starts no new work while merging continues, and at 100% it raises an andon. `project.budget_usd`, the sum of the project's attempt costs: one log line at 80%, and once spent it raises an andon and starts nothing new while running agents finish. Clearing the andon while still over budget raises it again; raising the budget continues. Agent sessions keep the developer's whole harness (plugins, skills, hooks), so cost is controlled by budgets and fewer sessions, not by trimming what agents load.
7. **Close.** The planner sets `done` when the predicate is met by merged work; yagura closes the project once the latest delta says `done`, no new planning is due, and nothing is in flight. A planner that cannot confirm the predicate (for example, a build that does not yet resolve on a clean checkout) leaves `done` unset and may ask the developer; the project stays active until it is settled.

## 7. Briefs and handoffs

### Brief (rendered by the daemon, never free-written)

Each role's brief is a markdown file yagura renders from its records, kept at `projects/<slug>/briefs/` exactly as the agent received it. A worker's has:

```
GOAL         one sentence, executable by a stranger
REPO         <repo>, checkout <path>, branch <branch>, started at <sha>
CONTEXT      why this unit exists, decisions already made, pointers into the spec, what other units will build
READONLY     reference repos and pinned test builds ("published as <version>: pin exactly this")
ACCEPTANCE   one checkable outcome per line
ENVIRONMENT  the environment's answers and the actions for this repo, each with its use and state
ENV          the environment's values with their notes, and YAGURA_VERSION_<REPO> for each test build
TIMEBOX      minutes; on expiry commit and hand off stuck
FORBIDDEN    never another branch, never force, never open or merge a pull request
METHOD       "Load the yagura-worker skill first"; pstack skills and playbook
REPORT       the commands that end the session
STANDING     standing-orders.md verbatim
```

A judge's, a unit lead's, and a doctor's briefs follow the same shape, each ending with `## METHOD` naming its own skill (`yagura-judge`, `yagura-unit-lead`, `yagura-doctor`). A unit whose brief cannot fill GOAL, ACCEPTANCE, and REPO is refused at spawn.

### Hand-off

A worker ends with `yagura handoff done` or `yagura handoff stuck --reason "…"`, plus a decision log of what it did, why, and the evidence (recorded runs by id, commits, `file:line`). The hand-off is a typed record (§27), not a parsed message. The branch is exactly what the agent committed; yagura pushes it after each hand-off and never commits on the agent's behalf.

If the process dies or ends without its command, yagura reminds the session once; if that fails, it writes a synthetic failure hand-off with a classified failure mode: `timebox | context-exhausted | oom | network | tool-error | harness-error | unknown`.

## 8. Planning and dynamic parallelism

The planner is the **project lead**: a fresh harness call, not a standing session, recorded as a `plan` unit.

- **Input:** generated `status.md` (unit table, open gates, recent decisions and rejections, the frontier per repo), the spec, standing orders, predicate, and budget. Size-bounded by construction, never an LLM summary of earlier rounds.
- **Output:** a **plan delta** written to a file and recorded with `yagura plan --file <path>`, which validates it the way applying it would and says at once what to fix. The delta has `add[]` (`key`, `repo`, `goal`, `acceptance`, `context`, `playbook`, `after`, `base`, `scaffold`, `disagreement`, `refs`), `amend[]` (units not yet started, including their `after`), `retry[]` (a stuck unit, with a note that changes the next attempt), `cancel[]`, `gates[]` (questions for the developer, with a default), `done`, and `summary`. yagura applies all of it or none of it.
- **Daemon enforcement on apply:** schema-valid and strict (unknown fields are refused), every repo registered, `after` acyclic and never on a dropped unit, an amended unit not yet started, a retried unit stuck. A rejection is recorded and shown to the planner in its next state.
- **Fit before apply.** The planner checks that what one unit's acceptance needs is what another produces (a library change and the app that uses it agree on what the function returns), and that a unit that needs another repo's change comes after it.
- **Woken again** when no unit is left in flight after a merge or a drop, when a merged unit's hand-off suggests follow-ups, when a planner gate is answered, when a delta was rejected, when a unit lead says the plan must change, or when the developer changes the spec or clears an andon; never on a schedule. A planner question to the developer is a gate; it stays open until answered.

Parallelism is dynamic (the planner proposes any shape at any drain) but safe: two units in one repo run together, and the merge-ordering and conflict checks of §15 deal with what they have in common. A unit is one behaviour together with the tests that prove it; the planner looks for parallel work but splits by independent behaviour, never tests from the code they test.

## 8a. The watchman: talking to yagura

yagura's front door is a conversation. A developer talks to the **watchman** (_bannin_) to start work or evolve it; the watchman turns the conversation into projects, and reports back when they are done. It serves both ways of working: hand it a finished spec ("here is BUILD_SPEC.md, build it") or grow something conversationally ("prototype a Kafka diff service" … "now ignore timestamp fields").

### Flow

1. **Talk.** The watchman asks only what no experiment could settle.
2. **Propose.** A proposal lists projects (one, or a chain with `after` dependencies), their goals and done predicates, repos (existing, or a new repo for a prototype), environment, merge policy, and initial units or spec. The developer answers **Go / Edit / Discard**.
3. **Build.** The projects run as usual (plan → work → verify → land).
4. **Report.** When the thread's projects close (or block), the bell rings and the thread gets a report assembled from records: what merged, with `yagura trace` links, what is stuck or still open, the repos and how to get them, and what is waiting on the developer.
5. **Evolve.** Further messages in the same thread propose amendments: new units, spec changes, new projects.

**Autonomy per thread:** `propose` (default; nothing starts without Go) or `go` (prototyping: applies its own proposals and rings only for real decisions and the report). Irreversible actions (creating a GitLab project, deploying beyond dev, force operations) always ask. **Prototype defaults:** new repo, `merge: auto`, a short wall-clock budget.

### Memory: the database, never the conversation

The watchman follows yagura's first principle: no long-lived LLM context. Every message is a fresh harness session whose context is assembled from the store under a fixed token budget (default ~40k tokens, a setting).

| Stored             | Content                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `threads`          | title, autonomy, linked projects, state                                                                |
| `thread_messages`  | every human and watchman message, verbatim; FTS-indexed                                                |
| `thread_decisions` | one structured record per decision (text, source message, superseded-by)                               |
| `thread_questions` | open questions; resolved with the answering message                                                    |
| `proposals`        | the proposed change set, its state (pending, applied, edited, discarded), and what applying it created |
| `project_specs`    | each project's living spec, in addressable sections; edited by the watchman and in the dashboard       |
| reports            | done/blocked summaries, generated from records                                                         |

**Context assembly, in priority order:** (1) watchman instructions and standing orders; (2) all _active_ decisions and open questions; (3) a generated status of each linked project; (4) the spec sections relevant to the message (by heading), never a whole large spec; (5) the most recent messages verbatim, trimmed oldest-first to fit; (6) nothing older — the watchman can pull an older detail with `yagura thread search`.

**Every turn ends with structured records** alongside the reply: decisions added or superseded, questions opened or resolved, spec section edits, and an optional proposal. yagura validates them (schema, references) and stores them atomically. A decision made 200 messages ago is still exactly in `thread_decisions`; nothing important depends on recalling or summarizing old messages.

Proposals apply through the same validated paths as planner deltas and CLI commands; the watchman never writes to the store directly.

**As built.** A turn is `runWatchmanTurn` (`watchman.ts`): the human message is stored, the brief is assembled from the store under `watchman.context_tokens` (chars/4 estimate): fixed parts first (template, standing orders from `threads/<id>/standing-orders.md`, active decisions `D<n>`, open questions `Q<n>`, recent proposals, a catalog of repos/environments/taken project ids), then linked project statuses (≤35% of what is left, each truncated with a pointer to `yagura show`), then spec (≤30%: a small spec whole, a large one as its heading list plus sections whose heading words appear in the message), then messages newest-first until the budget runs out (the newest is always kept). The session runs in `threads/<id>/` through the same `runAgentSession` as every agent, with a thread recorder instead of an attempt (`SessionRecorder`). The reply's last fenced `yagura` block holds the records (`title`, `decisions[{text, supersedes?}]`, `questions[]`, `answered[{question, answer}]`, `spec[{project, section, body|null}]`, `proposal`); unknown keys, dangling references, spec edits for projects outside the thread, and invalid proposals reject the whole block. The watchman then gets one retry with its reply and the reason appended to the same brief; if that is rejected too, the prose is stored and a system message says why. A reply without a block is plain conversation.

A **proposal** (`proposal.ts`) has `repos[]`, each either a new repo (id, description; created as a bare repo under `~/.yagura/repos/<id>.git` with a README) or an existing one (`{ id, existing: "<git URL>" }`). An existing repo is checked before the proposal is stored (`inspectProposalRepos`: a shallow temporary clone reads the default branch from the remote HEAD); an unreadable repo, a local working copy, or an id or URL already registered rejects the records. Applying it only mirrors the repo (`registerRepo` path), so it needs no extra confirmation, `projects[]` (id, goal, predicate, repos, environment or null for the only/new `local` environment, merge, after, phaseGate, refs, spec, initial units in the planner's unit schema), and `amend[]` (units for a thread's existing project; a closed one reopens). Applying it validates again, creates repos, then adds projects, links them to the thread, applies units through `applyDelta`, and stores the spec, in one transaction. Spec edits record `project.spec_changed`, which triggers a plan drain; the plan brief points the planner at `spec.md`. The irreversible actions named above are not in the proposal schema, so `go` applies every valid proposal.

The **engine** activates a `framing` project once all its `after` projects are closed; with `phase_gate` it first opens a `phase` gate (`start | hold`). It posts a **report** into each open thread when a linked project closes, raises andon, or is stuck (blocked work, nothing running or ready, no plan due); `threads.reported_json` keeps the last report key per project so each state is reported once. A report is a system message built from records (merged units with SHA and a `yagura trace` hint; stuck units with reasons; still-open units; the repos and their URLs; open gates and questions) and rings the bell as a `report` gate (`seen`). Answering a report gate does not trigger planning.

**Mentions.** Any message can point at yagura's records with `@project`, `@project/U3` (unit), `@project/A7` (one agent run; `@project/U3.2`, unit 3's second try, still resolves), `@thread:4`, or `@repo:id`. Every stored message, human or watchman, is scanned; resolved mentions go into `message_refs` (migration 6), so "which conversations discuss U3" is a query (`yagura thread mentions`, `GET /api/mentions/:token/messages`; a project token also finds mentions of its units). Mentioned records are described in the watchman brief (MENTIONED, fixed priority, each capped at ~2k tokens): a project's status, a unit's or attempt's state, attempts, blocked reason, notes, last handoff and log path, a thread's active decisions, a repo's facts. `GET /api/mentions?q=` serves the dashboard's `@` autocomplete (projects and repos by id, units by `project/U…` or goal words, attempts by `project/U3.…`, threads by title).

### Project chains and spec import

Large work is either one long project (units are the small pieces) or a **chain** of projects when parts need their own predicate, repo, environment, or merge policy. A project may declare `after: [projects]` (migration 5: `projects.after_json`; CLI `project new --after`); it stays `framing` (dark tower) until those close, then the engine activates it automatically — yagura is an automated system the developer monitors and steps into, so `phase_gate` is off by default (user, 2026-09-26) and only on request rings the bell for a human review before it starts. A finished spec with phases and exit criteria (e.g. trackplan's BUILD_SPEC §14) is imported by giving it to the watchman: it drafts the chain (project per phase, predicate from the exit criteria, `after`, environment), asks about anything the spec marks OPEN, and applies it only on Go. An LLM program-level planner is deferred until needed.

## 9. Scheduler

A unit starts when its `after` units have merged, every test build it needs is available (§14), the project's in-flight cap is not hit, and the project has no andon. Leases and capacity belong to the environment (§12), shared by all projects.

- **Retries by failure mode:** `timebox | context-exhausted | oom` → the unit lead decides whether to split or narrow; `network` → retry as-is; `tool-error | harness-error` → retry with another harness or model if configured; `unknown` → retry once. A unit out of attempts is `stuck` and goes to its unit lead, not retried blindly.
- **Liveness** is the daemon's own knowledge: it owns the pid, the stream, and the exit code. A unit that exceeds its timebox with no side effect is killed and gets a synthetic hand-off.
- **Andon.** A project-level stop (dashboard button or a planner gate) halts new spawns; in-flight attempts finish.
- **Usage limit** (§29) holds new work back for the whole account.

`yagura drive <project>` runs the engine loop in the foreground until nothing is left to do. The daemon runs the same loop continuously.

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
- Pull requests are yagura's alone: every Claude session gets `--disallowed-tools Bash(gh pr:*),Bash(glab mr:*)`, and `Bash(git push:*)` too unless the session may push its own unit's branch (a worker, through the mirror's relay, §13), so a pstack playbook's PR or shipping step cannot reach the forge even though the whole harness is loaded.
- Every spawned process gets `YAGURA_ATTEMPT=<id>` (plus `YAGURA_PROJECT`, `YAGURA_UNIT`, `YAGURA_ROLE`). Sessions inherit the developer's full harness config, including hooks, so hooks that should not run inside yagura (e.g. a SessionStart hook that forces repo indexing) can check `YAGURA_ATTEMPT` and skip.
- **Models:** by default yagura passes no model and the harness uses its own configured default, except for judges, which default to `claude-sonnet-5-5` (`role.judge.model`; set it empty for the harness default, for example when an internal endpoint names models differently). A model can optionally be set per role, globally or per project (`claude --model <name>`); the adapter maps it to the harness's flag.
- A project can set different harnesses per unit type (e.g. work on one, judge on another) to get a second model family where one is available.

## 11. Methodology

**pstack-claude is the default and required methodology, loaded into every session.** Upstream pstack ([cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)) is a Cursor plugin; yagura uses the Claude Code port, [ultish/pstack-claude](https://github.com/ultish/pstack-claude). Its two plugins, `pstack` (poteto-mode, playbooks, principles) and `cursor-team-kit` (the skills poteto-mode calls: `control-ui`, `control-cli`, `deslop`, `fix-ci`, `fix-merge-conflicts`, …), are installed by the developer from the `pstack-claude` marketplace with `/setup-pstack`, exactly as for interactive use.

**yagura uses the developer's own harness setup as-is.** It does not copy, pin, or configure pstack. Harness sessions run as the developer and pick up their installed plugins, `pstack-models.md`, `CLAUDE.md`, and hooks; plugin versions and the model each attempt ran with are recorded, so a mid-project update is visible in agent history. Non-Claude harnesses read skill files by path from the installed plugin directory.

### Roles

| Role                       | Uses                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker                     | `yagura-worker`; poteto-mode work playbooks (bug-fix, feature, refactoring, …); all principles, in particular prove-it-works and test-behavior-not-implementation                                                    |
| Judge                      | `yagura-judge`; the principles on proof and tests                                                                                                                                                                    |
| Unit lead                  | `yagura-unit-lead`                                                                                                                                                                                                   |
| Project lead               | `yagura-planner`; figure-it-out, architect, sequence-verifiable-units                                                                                                                                                |
| Doctor                     | `yagura-doctor`                                                                                                                                                                                                      |
| Watchman                   | `yagura-watchman`                                                                                                                                                                                                    |
| **Replaced by the daemon** | orchestrate, autopilot-\*, shipping, babysit, opening-a-pr, autonomous-run, pause-safely, session-pickup, worktree-cleanup, show-me-your-work; cursor-team-kit's new-branch-and-pr, review-and-ship, get-pr-comments |

### Role overlays

pstack playbooks assume the agent is its own orchestrator: poteto-mode ends every playbook with _Opening a PR_, babysit runs a `/loop`, show-me-your-work keeps its own trail. Inside yagura that competes with the daemon. yagura ships small **overlay skills** (`plugins/yagura/skills/`, loaded into every session with `--plugin-dir`) that say, per role:

- You are running inside yagura as role X. Use pstack with playbook Y.
- Skip every PR, merge, loop, babysit, and decision-trail step; the daemon owns them.
- Do not spawn long-lived loops or wake mechanisms. Stay inside your timebox.
- End with the yagura command for your role. Where this overlay and pstack disagree, the overlay wins.

Every brief names its role's skill under `## METHOD`, and `REQUIRED_SKILLS` (`skills.ts`) lists what each role must have loaded: a miss is recorded as `attempt.method_miss`, and only a worker's miss sends the unit to `stuck`. pstack itself is never edited, so upstream updates drop in unchanged; overlays are versioned with yagura, since they encode yagura's contracts.

### Project skills and stack knowledge (decided 2026-09-27)

How to build a kind of project (a Kotlin Spring Boot service with the developer's version catalog, Gradle plugin, helm values, skaffold) is know-how, and its home is **harness skills**, like the developer's own `setup-gradle`. yagura does not reimplement them as templates; it names them and makes sure the right agents load them.

- **Skills by purpose, as layered settings** (global, repo, project): `skills.scaffold` (the unit that creates a new project skeleton) and `skills.work` (every worker). The watchman fills them from the conversation ("wire this up with `setup-gradle`"). A required skill that an agent did not load is a method miss, as above.
- **Scaffold units.** The first unit of a new project, whose job is the skeleton, run with `skills.scaffold`; the planner marks it `scaffold: true`.
- **Reference repos.** A project can name registered repos that already do it right (`project.reference_repos`); workers get read-only checkouts and their briefs point at them.
- **Skills yagura writes, from examples, never from nothing.** A skill written from scratch is a guess every future agent would follow confidently. yagura writes one only from evidence: repos the developer points at, or repeated corrections in review.

## 12. Environments and providers

| Provider         | create slot                                                                                                                 | connection vars                                                        | teardown                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `kube-namespace` | `mode: create` → `kubectl create ns yg-…` + labels; `mode: pool` → lease one of a configured list of pre-created namespaces | `YAGURA_NAMESPACE`, `KUBECONTEXT`, `YAGURA_BASE_URL` (ingress pattern) | create: delete namespace · pool: delete only yagura-labelled resources, keep the namespace |
| `docker-compose` | project name `yg-…`, allocated ports                                                                                        | `COMPOSE_PROJECT_NAME`, ports                                          | `compose down -v`                                                                          |
| `local-process`  | allocate ports + data dir                                                                                                   | ports, `YAGURA_DATA_DIR`                                               | kill process group, rm dir                                                                 |
| `ios-sim`        | clone simulator                                                                                                             | `SIM_UDID`                                                             | delete clone                                                                               |

Whether a developer can create namespaces varies, so `kube-namespace` supports both modes per environment. In pool mode capacity = pool size. A pool limits **concurrent live leases**, not agents: workers and builds still run in parallel, and only steps that need a slot queue for a free namespace.

An environment = provider + access refs + capacity + **conventions** + **artifact-version scheme**. yagura checks nothing about it up front (decision 8): a missing registry or an unreachable cluster shows up when an agent or the doctor tries to use it, and an action that fails there is marked broken (below). `profile.md` is the prose for agents.

**As built (`kube-namespace`, 2026-09-27; `kube.ts`).** Settings (`providerConfig`, validated per provider): `context` (default: the current context, pinned into each slot when it is created), `mode` `create` or `pool`, `pool` (namespace names; capacity cannot exceed it), `prefix` (default `yg`), `kubectl` (the binary), `baseUrl` (an ingress pattern with `{namespace}`). Create mode makes `yg-<env>-<lease>` labelled `yagura=1`, `yagura/env`, `yagura/lease`, and on release deletes it only if it still carries `yagura=1`, refusing otherwise. Pool mode leases `pool[slot]` and on release deletes only `yagura=1`-labelled resources in it. A slot's variables are `YAGURA_SLOT`, `YAGURA_LEASE_DIR`, `YAGURA_NAMESPACE`, `KUBECONTEXT`, `YAGURA_LABEL`, and `YAGURA_BASE_URL` when set; actions should pass `--context "$KUBECONTEXT"` and label what they deploy. If yagura cannot create a slot (the cluster is unreachable, the namespace cannot be made), the run that needed it fails with that reason. The provider doctor, `env doctor`, and doctor-gated selection were removed on 2026-09-30. Provider settings can be changed after creation (2026-10-03: the environment's Edit panel, `yagura env set <id> --context|--pool|--base-url`, `setProviderConfig`), validated per provider and refused while any slot is in use, queued, or kept, since those slots were made under the old settings.

### Environment values (decided 2026-09-27)

An environment describes the machine agents run on, once, for every repo that uses it. yagura cannot know up front what a developer's machine has or which stack a project uses, so the core is **values the developer adds**, each with two parts, both context for agents:

- **name and value**, e.g. `REDIS_URL = redis://hostname:6379`;
- **a note for agents**: how the value is used, sent with it in every brief ("Redis on the dev box; pods reach it at `redis.redis.svc:6379`, so use `REDIS_URL` only from this box");

**Presets** are shortcuts that fill in values and notes for common things: `kube` (context, namespace mode, slots; it also sets the provider), `registry` (`REGISTRY_PUSH` from this box, `REGISTRY_PULL` from the cluster, e.g. `localhost:5000` / `hostname:5000`), `kafka` (`KAFKA_BOOTSTRAP_CLUSTER`, `KAFKA_BOOTSTRAP_LOCAL`), `helm`, `skaffold`, `maven-mirror`. What a preset writes is ordinary values, edited and deleted like any other; presets are buttons the developer chooses, never applied on a guess. yagura does not probe the machine: it cannot know what to look for in an air-gapped setup. The environment also keeps free **notes** for what no single value covers ("dependencies run in the cluster; verify by exec'ing into the app pod").

- **Values reach every command and agent** as real environment variables: recorded runs, actions, publishing, and worker, judge, lead, and doctor sessions; the brief lists each with its note, so one set of actions works unchanged on a teammate's machine.
- **Hard-coded values are the judge's call.** yagura does not scan diffs for values; a judge that finds `localhost:5000` written into `skaffold.yaml` where `$REGISTRY_PUSH` belongs says so like any other problem with the work.
- **Set up by form or by conversation.** The Environments page is a values table (name, value, note, where it came from), editable in place, with presets as optional shortcuts. Or the developer describes the setup to the watchman, which proposes an environment with the same values and notes, applied on Go. The watchman fills the table; it does not write scripts.
- **What is enforced and what is advice.** The keep policy and the values reaching processes are enforced by yagura. Values and notes are advice; what makes them safe is that yagura judges results (runs it recorded itself), not whether an agent followed a note.
- **Keep policy.** Per environment, overridable per project: `never` (today), `failed`, or `always`, and an expiry (default 2 hours). A kept slot skips teardown and namespace deletion, leaves the last deployed side running, stops counting against capacity, and is deleted when it expires or from a Delete button; the Environments and agent pages show kept namespaces with a ready `kubectl --context … -n …` line. Suggested default for small clusters: `failed`, 2 hours.
- **Templates.** The same machine needs no copy: every project on it picks the same environment. To reuse the shape on another machine (a teammate's VM, a second cluster) or as the start of a variant, an environment is **saved as a template**: its values with their notes, its presets, its keep policy, and its free notes. Values that are facts about one machine can be marked **ask** (e.g. `REGISTRY_PULL = <hostname>:5000`), so applying the template asks only for those and fills in the rest. Templates live in yagura's store (`env_templates`, migration 30; decided 2026-10-03: as few local files as possible) and are shared as YAML: Export on the Environments page (or `yagura template export <name>`) gives the text to send a teammate, who pastes it into Import (`yagura template import <file>`); a template with the same name is replaced. The daemon moves any old `~/.yagura/templates/*.yaml` into the store at start and leaves a file it cannot read, naming the problem in its log. No shared git repo. The Environments page offers "New from template" and "Save as template"; the watchman can apply one ("set up this VM like my dev box"). A template can also carry project settings to apply with it (`skills.scaffold`, `skills.work`, reference repos, a keep override), so "a Spring Boot service on kube" is one choice for a new project.
- **Repos stay separate.** How one repo builds, tests, and deploys is its actions, proposed by the doctor and by agents against the environment's values and kept working by the doctor. Stack skills (§11 "Project skills") guide how.

**As built.** Migration 8 stores values and free environment notes; migration 18 (2026-09-30) dropped value checks, their last results, and the environment doctor's columns. Presets only add names that are not already set. Values are exported into slot commands and agent sessions, and the brief lists each with its note. `lease.keep` (`never` / `failed` / `always`) and `lease.keep_hours` (default 2) are ordinary settings, overridable per environment and per project; a kept kube namespace (create mode) skips teardown so what was deployed stays up; a local-process slot still runs teardown, because deleting it later cannot stop a process, and keeps only its directory; a pool namespace is never kept, because the next lease reuses it. A kept slot is deleted at expiry or from the Environments page. Templates are one YAML file each in `~/.yagura/templates/` (a `check` on a value in a template saved earlier is ignored). The CLI is `env values`, `env value set|rm`, `env preset|presets`, `env notes`, and `template list|save|apply`. The Environments page edits the same table. A watchman proposal can carry `environments[]`: each is either a full draft (id, provider, providerConfig, capacity, notes, keep, presets, values with notes) or `{ id, template, answers }`; both go through the same `checkDraft` / `createEnvironment` as the form and `template apply`, so an invalid name, an unknown preset, a bad provider config, or an unanswered ask value rejects the records before they are stored. The watchman's catalog lists each environment with its value names, the presets, the templates with what they ask, and the providers. Values record where they came from (`watchman`, `template <name>`, or the preset). The agent page shows its attempt's kept slot too. Not yet: a shared git repo of templates, and project settings carried on a template.

### Answers, actions, and the doctor (decided and built 2026-10-10, developer)

Projects use different tools, languages, and build setups, so yagura ships no fixed list of commands, and a command written down once goes stale. The developer knows how their environment works and can say it in plain words; agents turn those words into commands and prove them; yagura keeps what was proven, shows it, and lets the developer change it.

**Answers.** Each environment holds the developer's answers to a few starter questions, each in plain words, plus one free box: how tests run, how libraries are published and where to, how images are built and pushed, how the app is run or deployed, what agents must never do here, and anything else. The questions are prompts, not limits; any answer may be empty. Values (`NEXUS_URL` with its note, presets) stay as above.

**Actions.** An action is a command an agent or yagura can run, saved with what it is for.

| Field   | Meaning                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name    | Short and unique within its scope: `publish-snapshot`, `build-image`, `test-one-file`.                                                                           |
| use     | When to use it, in plain words, and which variables it reads (`$YAGURA_VERSION`, `$TEST_CLASS`).                                                                 |
| command | The shell command, run with the environment's values.                                                                                                            |
| scope   | One repo in this environment, or every repo in it.                                                                                                               |
| proof   | yagura's last run of it: repo, commit, exit code, output tail, time.                                                                                             |
| state   | `proven`, `edited` (changed by the developer, not run since), `unproven` (written by the developer, never run), `broken` (its last run failed, with the reason). |
| author  | `doctor`, `agent` (with its agent number), or `you`.                                                                                                             |

- **The doctor** proposes actions from the answers and the repo. **An agent** can propose one with `yagura action propose --name … --use … -- <command>`: yagura runs it on the agent's repo and saves it only when it passes. **The developer** adds, edits, renames, and deletes actions on the environment page; an edit is saved at once and marked `edited`, and **Run now** proves it. The doctor never overwrites an action the developer wrote or edited; it attaches a suggested change instead.
- **Every worker, judge, and unit lead brief lists the actions for its repo.** Agents run one through `yagura evidence run -- <command>`, so the run is recorded and can be cited. An action becomes `broken` only when yagura's own run of it fails (Run now, a doctor's check, publishing) or an agent reports it with `yagura action broken`; a failing test in a worker's session usually means the code is wrong, not the command. A broken action wakes the doctor. Every run that proves or breaks an action is yagura's own, in a clean checkout of the repo's base; agents' recorded runs never prove an action.
- **Names with a contract**, run by yagura without an agent: `version` (prints the version the checkout would release), `publish-snapshot` (publishes the checkout under `$YAGURA_VERSION`), `snapshot-available` (exits 0 once `$YAGURA_VERSION` can be fetched), all used for published test builds (§14). `test` is not special: the judge and workers read it like any other action. Also by name: `$YAGURA_VERSION` is empty in the doctor's own shell, so it tries `publish-snapshot` with a sample ending in `-SNAPSHOT` and does not call an action broken for an unset variable.
- **The doctor** looks after one repo in one environment. It is not a unit, so it has no unit number: doctor runs are numbered D1, D2 on their own and each has a page (`/d/<n>`). It runs when a project that is not closed is set up on an environment (once per repo no doctor has looked at there yet), whenever the developer asks (`yagura env doctor <env>`), and when an action breaks; one run per repo and environment at a time, counted toward the agent caps and no project's budget. It reads the answers, values, repo, and saved actions; works out each command in a throwaway checkout of the repo's main branch; offers it with `yagura action propose`; and ends with `yagura doctor` (`--works`, `--fails`, `--unknown`). It changes nothing in the repo and pushes nothing.
- **The environment page** (`/e/<id>`) has a status card and tabs: How it works, Actions, Doctor runs, Values, Settings.

## 13. Judgment and recorded runs

The first real runs spent more on checking work than on doing it: on the demo, workers cost $1.66 of $4.08, and the verifier, reviewer, and arbiter $2.07 between them. One fresh judge replaced them. The 2026-10-15 run cost $0.055 per work unit (limit $0.51).

### Recorded runs

`yagura evidence run -- <command>` is how an agent runs something whose result counts as evidence. The agent chooses the command: usually the environment's `test` action, or a narrower one (one test file, one check) when that proves the point better. yagura runs it itself, in the unit's checkout, with the environment's values and the pinned test builds (`YAGURA_VERSION_<REPO>`), and records the command, the commit it ran on, the exit code, the output, and the time. The agent gets the output and a run id (`run:42`) to cite. Output is kept as an artifact, content-addressed.

An agent cannot write a run itself, so a cited run is proof that the command ran on that commit with that result. A claim with no run behind it ("tests pass") is just a claim.

### The judge

A new session every round, never resumed. It carries no opinion from an earlier round, only the last round's list of what was asked for. One model is enough: the fresh eye comes from a session with no shared context. Its brief is ordered so that it forms its own view before reading the worker's:

1. The goal, the acceptance, the context, the project's decisions that apply, and the change (the diff against the base where the branch left it).
2. It runs the environment's tests itself as recorded runs, and judges the change.
3. Then the worker's decision log, its recorded runs, and what the last round asked for. It checks the log's claims: evidence that does not resolve, or runs that did not pass, count against the work.

It looks for: every acceptance outcome holding; tests that check behaviour rather than passing whatever the code does (it may run them on the base when that would tell it something, as for a bug fix); placeholders, empty functions, stubs, `TODO`s, disabled or skipped tests standing in for required behaviour, unless the context says another unit fills them in; changes that have nothing to do with the goal; secrets.

It answers with one command:

- `yagura judge approve --runs <its run ids>`: yagura takes the pull request out of draft; the unit is ready.
- `yagura judge changes --finding "<file:line> what is wrong" …`: the findings go straight to the worker, and the unit goes back to building.
- `yagura judge ask --question "…"`: the unit is stuck and its unit lead decides.

A judge cannot end its session without one of the three; yagura sends it back once to record one. If it still ends without a verdict, a fresh judge looks instead, and after two judges in a row without a verdict the unit is stuck. The judge asking for changes `judge.max_rounds` times in a row (default 3) wakes the unit lead.

### What yagura enforces

1. Agents push only their own unit's branch, and only forward: yagura's mirror of the repo, which a worker's checkout pushes to, refuses a force-push or a push to any other branch (the `pre-receive` relay), and yagura passes accepted pushes on to the forge. Only yagura opens, updates, readies, merges, and closes pull requests; agents cannot run `gh pr` or `glab mr`.
2. A unit merges only with the judge's approval of its **current head**, CI passing on that head, and the developer's merge when the project asks for it.
3. A unit's acceptance changes only with the developer's approval, or from a trusted author.
4. Recorded runs are run by yagura; an agent cannot write one.
5. Every agent ends with its command; one that does not is reminded, then its unit is stuck.
6. Budgets and the account's usage limit hold new work back (§6, §29).

Everything else is guidance in the agents' skills and the developer's harness. The developer can disagree with any decision afterwards; a disagreement becomes a follow-up unit the planner must place.

## 13a. The repo's verification guide (decided 2026-10-18, developer; prototyped the same day)

How to prove behaviour differs by repo and by unit: a unit that scaffolds a skeleton proves something other than one that adds an endpoint. The knowledge lives **in the repo**, as the project skill `pstack:create-verification-skill` writes: `.claude/skills/verify-<app>/`, with a `features/` page per kind of check (how to reach it, how to drive it, what it returns). The developer can run the pages by hand, and every later unit uses and extends them.

- **Proof per acceptance line.** The planner names the page that proves each line: `{ "outcome": "…", "proof": "orders-api" }`, or `"proof": "new shipping-email"` when no page fits and the worker writes it first (a text suffix `(proof: orders-api)` is read the same way). Stored in `units.proof_json` (migration 2), as long as `acceptance_json`; null where no page is named.
- **Create once, then extend.** A repo with no guide gets a first unit that creates it (a scaffold unit for a new app), proven by driving one feature; every other unit in that repo comes after it. A unit writes the pages for what it builds, never for features that do not exist yet.
- **The briefs carry it** (`verify-guide.ts`, a `## VERIFY` section): the guide's pages, the page named for each line, and rules: drive pages through `yagura evidence run`, proof files to `$YAGURA_EVIDENCE`, a free port of the agent's own, and **run a page's commands as written and compare the output with what the page says it returns**. A difference is a stale page or a code defect: the worker fixes it in its branch (with `--decision`); the judge records a finding. The judge's brief includes the named pages' text.
- **Upkeep** (`pstack:maintain-verification-skill`) is not part of a unit: it edits product code never and opens its own pull request, so it would run as its own job whose changes land through yagura. Not built.
- **What the prototype showed** (`docs/design/verification-prototype.md`): left alone, a guide is wrong after one merge; the judge's model decides whether stale pages are caught (Sonnet caught drift in a page the diff never touched; Haiku approved it under both briefs). Judges that verify pages run on Sonnet by default.

## 14. Multi-repo projects and published test builds

- One unit changes exactly one repo. A change across repos is several units with an order between them (`after`).
- Reference repos can be mounted read-only for a worker to follow their shape; they are never written.
- **Breaking changes** are planned as expand → migrate each consumer → contract, enforced by `after`: the contract unit comes after every consumer unit. There is no release unit: the team's CI releases from main.

### Published test builds (decided 2026-10-03/04, developer; rebuilt for the core loop)

Units mostly merge into feature branches, and the team's CI publishes only from main, so nothing else builds a library that an app unit can depend on. yagura publishes it, as the developer does by hand: build the library on a branch, publish it under a new version (Gradle caches snapshots, so a new version is the reliable way), change the consumer's version to match, and rebuild.

1. A unit in a repo that has the environment's `publish-snapshot` action merges into its base.
2. yagura checks out the merge commit, runs `version`, and makes the test version `<version>-yg-<project>-u<seq>-<sha7>`, keeping a trailing `-SNAPSHOT` at the end (`1.5.0-SNAPSHOT` becomes `1.5.0-yg-orders-u3-a1b2c3d-SNAPSHOT`, so a range such as `1.5.+` never resolves it and nothing yagura publishes can pass for a release).
3. yagura runs `publish-snapshot` with `YAGURA_VERSION` set, then polls `snapshot-available`, each as a recorded run, with the output kept as a log (`publications`).
4. A unit whose `after` includes that unit starts only once its test build is available. Its brief names the version, and `YAGURA_VERSION_<REPO>` carries it; the worker pins exactly that version where the consumer declares the dependency. Recorded runs get the same variable.
5. If publishing fails, the waiting unit stays `waiting` with the reason, and the doctor is woken for that repo. A doctor that cannot fix it asks the developer.

Publishing the merged commit means the version never moves under the unit that uses it, so nothing is re-pinned later. yagura never publishes a release, never waits for one, and never deletes a test build: a consumer that merged pinned to one needs it to stay resolvable. The real version exists only after the developer merges to main and CI publishes it, which is outside yagura.

Proven on 2026-10-14 and 10-15 with real Gradle `maven-publish` into a Maven folder standing in for Nexus, and on 2026-10-16 against the developer's real Nexus (the build reads `nexusUsername` and `nexusPassword` from `~/.gradle/gradle.properties`).

## 15. The pull request, keeping current, and merging

yagura does the mechanics of git and the forge; watching is daemon code and costs no tokens. An agent is woken only when something needs judgment (§26).

### The pull request

- yagura pushes the branch after each worker hand-off. The first push opens a **draft** pull request: the goal as title; the body holds the goal, the acceptance, the issues it closes (`Closes #12` for the unit's own repo), and a link to the unit. yagura keeps the body current as the unit moves.
- While the pull request is a draft nothing is posted on it. The forge sees only commits.
- **yagura takes it out of draft the moment the judge's `approve` is recorded.** The approval is a command and yagura acts on it; no agent has to remember to.
- A unit merges only when its current head is approved, CI on that head has passed, and, when the project asks for it (`merge: human`), the developer merged it. yagura merges with a **merge commit**, never squash or rebase. On GitLab the project's merge method decides, so it must be "Merge commit".
- A commit that changes what the worker wrote (a fix for a comment, a CI fix, a resolved conflict) sends the unit back through the judge, who looks at what changed since the approval. A clean merge of the base does not: if it breaks something, the tests catch it.
- An open question from the unit lead to the developer holds a ready unit until it is answered or the lead decides again; the unit page says so.

### The forge watcher

Per open pull request, through the repo's forge adapter (`gh` for GitHub, `glab` for GitLab; forge `none` has no pull request and merges into the mirror directly), every `forge.poll_seconds`:

- reads CI status on the head, mergeability, and new comments and review threads;
- trusts the forge's own merge verdict, not a green check list;
- records typed events, and wakes the unit lead for a comment, for CI that failed twice on the same head, or for a conflict the worker could not resolve;
- treats all comment text as untrusted data: it goes into a brief quoted, never into a shell command.

A comment from anyone on the ready pull request wakes the unit lead. It sends the worker the fix, replies signed as the unit lead, or asks the developer when the comment changes what the unit must do. A change to the unit's acceptance needs the developer's approval, or comes from a trusted author (`forge.trusted_authors`).

### Keeping up with the base branch

No agent does this: yagura checks, with plain git, at three moments.

1. **A unit merges.** Right after yagura merges a unit into base `B`, it checks every other open unit whose base is `B`.
2. **The base moved outside yagura.** On each forge check, yagura fetches each base in use; when its head changed, it checks the open units on it.
3. **A worker hands off.** Before the judge starts, so the judge always sees a branch that merges with its base.

The check is `git merge-tree --write-tree <unit branch> <base>`, which computes the merge without touching any checkout. A unit whose worker is running is not touched mid-session.

- **Clean.** yagura makes the merge commit on the unit's branch and pushes it. The unit stays where it was; CI runs on the new head.
- **Conflict.** yagura sends the unit to building and resumes its worker with the base, the conflicting files, and "merge the base into your branch and resolve these". The worker merges (never rebases), resolves, tests, commits, and hands off; the judge looks at the resolution.
- **The worker cannot resolve it.** It hands off stuck and the unit lead decides: help it, ask the developer, or ask the project lead whether the two units clash by design.

### Who merges and who closes

`merge: auto`: yagura merges once the head is approved and CI is green. `merge: human`: a `land` gate; answering "land" makes yagura merge, or the developer merges on the forge and the watcher sees it. yagura closes (never merges) the pull request of a unit that is dropped, with a comment saying why. The merge commit's message names the unit and the project, its workers and their models, the judge's approval with the head and the run ids it cited, `Closes #<issue>` lines, and a link to the unit when `yagura.url` is set:

```
orders/U2: Add Greeter.shout(name) (#21)

Workers: A2 (claude-haiku-5-5)
Judge: A3 approved ba27e6d326, on run:5
Closes #20
yagura: http://devvm:7300/p/orders/u/2
```

`yagura trace <sha|ref>` walks back from a commit or an issue ref to the project, unit, attempts (model, plugin versions, skills loaded), recorded runs, and hand-off files.

### After the merge

After a library unit merges, yagura publishes its test build (§14). Every merge starts a **retro watch** on the merged trunk commit for `retro.watch_minutes` (default 60; 0 turns it off), and a scan notices a later commit that reverts any merged unit. The watch reads CI on the commit: passed ends it; a failure re-runs the failed jobs once; a second failure queues an ordinary work unit (judged and merged like any other) that fixes trunk, or reverts the change when `project.auto_revert` is set, and tells the project's threads. A revert wakes the planner.

## 16. Configuration

Settings are layered; a narrower layer overrides a wider one: **global → environment → repo → project**. The dashboard's **Settings** tab edits the global layer; each environment, repo, and project page has its own settings panel. Every setting shows its **effective value and which layer set it**. Settings live in SQLite, are validated by one schema, and can be exported/imported as YAML (to share a setup with a teammate or rebuild a box).

A few settings must be known before the database opens. They come from environment variables or `~/.yagura/yagura.yaml`, and are shown read-only in the UI:

| Bootstrap                     | Default              | Purpose                                                                    |
| ----------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `YAGURA_HOME`                 | `~/.yagura`          | store, worktrees, artifacts, logs                                          |
| `YAGURA_SKILLS_DIR`           | bundled with yagura  | yagura's own overlay skills (`yagura-worker`, …); override to develop them |
| `YAGURA_BIND` / `YAGURA_PORT` | `127.0.0.1` / `7300` | dashboard + API listener                                                   |
| `YAGURA_TOKEN_FILE`           | `$YAGURA_HOME/token` | dashboard/API auth when bound beyond localhost                             |

### Global (Settings tab)

| Group                  | Settings                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Concurrency**        | `max_parallel_agents` (host-wide cap on running harness processes); `max_parallel_per_harness` (endpoint rate limits); `max_parallel_verifies` (heavy local builds); `planner_concurrency`                                      |
| **Harnesses**          | per harness: binary path, extra args, permission mode, env refs (e.g. `ANTHROPIC_BASE_URL`), enabled; **default harness per role** (worker / judge / lead / planner / …); optional **model per role** (unset = harness default) |
| **Methodology**        | required plugin versions; overlay version; doctor status of the harness setup (plugins installed/enabled, `pstack-models.md` present, its models reachable)                                                                     |
| **Timeouts & retries** | default timebox per unit type; max attempts per unit; resume on rejection on/off and `work.resume_max_context` (§13); stall timeout (no stream progress)                                                                        |
| **Git**                | agent commit identity (name/email), commit message convention (e.g. Conventional Commits), branch naming (`yg/<project>/<unit>`), mirror refresh interval                                                                       |
| **Forge**              | `glab` / `gh` paths, token refs per host, watcher poll interval, flake signatures (regexes classed as infra)                                                                                                                    |
| **Storage**            | worktree retention (delete N days after terminal), artifact and log retention, disk-usage warning threshold                                                                                                                     |
| **Budgets**            | optional daily token/cost ceiling where the harness reports usage; action at ceiling (pause spawns / gate)                                                                                                                      |
| **Notifications**      | optional webhook or email relay inside the network for gates, andon, project done                                                                                                                                               |
| **Security**           | allowed bind addresses, token rotation, secret-ref backends (file, env, OS keychain)                                                                                                                                            |

### Environment

Provider settings, capacity (leases), values with their notes and checks, notes, **artifact-version qualifier scheme**, lease timeout, keep policy (`never` / `failed` / `always` with an expiry; §12 "Environment values").

### Repo

Default branch, forge adapter, forge repo and merge settings, build flags, required CI jobs, whether direct push to trunk is allowed.

### Project

`max_in_flight` (≤ global cap), `merge: auto | human`, auto-revert on post-merge break, wall-clock and dollar budgets (the wall-clock cutoff defaults to 70%), harness per role overrides, planner drain cadence, standing orders, andon, `judge.max_rounds`, `lead.max_decisions_per_unit`.

The scheduler always applies the tightest cap in force: a unit starts only if the global, per-harness, per-environment (leases), and per-project caps all have room.

## 17. Dashboard

- **Projects** list: predicate progress, in-flight, blocked, open gates.
- **Project** view: unit graph (`after` edges, repo lanes), live attempt logs (SSE), decision logs, the judge's verdicts with the recorded runs they cite, decisions trail, andon.
- **Gates** inbox: every open human question across projects, with the default that applies on timeout.
  - **As built (2026-09-27):** `/gates` lists open questions, proposals waiting for Go, blocked work, and unread reports (the bell's items, `GET /api/inbox`), each question saying what happens if nobody answers, and the last 20 resolved gates, answered or defaulted. A gate with a default takes it `gates.timeout_hours` (default 24, per project, empty for never) after it opened (`defaultExpiredGates`, run each engine tick; state `defaulted`, event `gate.defaulted`, which triggers planning like an answer). A gate whose default is `hold` (land and phase gates) never times out, because holding is what waiting already does, and a gate without a default waits. The highlighted button is the default when it is a real choice, the held-back action (Land, Start) when the default is hold, and none when there is no default.
- **Environments**: create/edit, a paused environment, lease occupancy and queue.
- **Repos**: the forge route, the default branch, and the units that changed each repo.
  - **Add an existing repo** (decided 2026-09-27): a repo can be registered without any project. The form takes a git URL (plus an id, defaulting to the repo name). yagura clones it into its own mirror, detects the default branch from the remote HEAD, and reports whether `.agents/verify/verify.json` exists on trunk and parses. All agent work happens in worktrees of that mirror, and landing pushes to the URL. A local working-copy folder is refused (decided 2026-09-27): landing would push into its checked-out branch, which git refuses, and yagura needs only the URL since it clones anyway. A path to a bare repo still works, as git treats it like a URL; the end-to-end proofs use one. Starting work on an existing repo goes through Talk: the watchman proposes the repo and the project together. A repo without a verify pack can be registered, but verification stays env-blocked until a pack lands (a `pack` unit, phase 5, or a watchman proposal that adds one).
  - **As built** (`repos.ts`, `pages/Repos.tsx`): `registerRepo` runs `git ls-remote --symref` first (unreachable or empty repos fail before anything is written), mirrors into `cache/repos/<id>.git`. `yagura repo add <git URL> [--id]` and `POST /api/repos {source, id?}` both use it; `GET /api/repos/suggest-id` fills the id placeholder. A working copy is refused before anything is written, naming its `origin` when it has one. `GET /api/repos` lists each repo with its mirrored trunk SHA, its projects. `@repo:id` links to `/repos#id`.
  - **Browse a repo** (later; prototype first): read-only views of a registered repo's trunk (files, recent commits with their yagura trailers linking to units), so a developer can look before talking to the watchman. The user wants it to feel like VS Code in the browser (2026-09-27): a file tree, tabs, and syntax highlighting. Leading option: the Monaco editor (VS Code's editor component) bundled into `apps/web` by Vite, so it works air-gapped, in read-only mode, fed by daemon endpoints that read the mirror (`git ls-tree`, `git show <sha>:<path>`, `git log`). The same viewer could open any ref: trunk, a unit's branch, or a worktree while an agent runs, plus a diff view of base against head. A full VS Code server (code-server or openvscode-server) was considered: it is heavier, is another binary to install on each VM, and brings editing and a terminal, which yagura does not want here.
  - **As built (repo browser, 2026-10-01; `browse.ts`, `apps/web/src/pages/Repo.tsx`).** Chosen from prototypes (B, "editor, story rail, history": https://claude.ai/artifact/C6n61NvGJaX42ZEkoUxRsH). `/r/<repo>`, linked from the Repos page, reads trunk from yagura's mirror (`GET /api/repos/:id/tree|file?path=|history?path=|change/:sha`; only the tree fetches, so one page stays consistent). Monaco is bundled by Vite (no CDN, workers from the build) in its own chunk that loads only on this page, read-only, with night and day themes read from the dashboard's tokens and following the toggle. Each line's unit comes from `git blame` on trunk, mapped to a unit by yagura's record of the landed SHA, else the commit's `Yagura-Project`/`Yagura-Unit` trailers; the gutter marks each block with its unit (`U3`, or `project/U3` from another project) in that unit's colour. The side panel switches between Explorer and History (what landed, newest first; "only units that touched" the open file); a unit opens its change as a tab beside the files (diff against the first parent; the first commit against the empty tree). The rail shows the unit behind the selected line, or the open change's unit: its goal, verdict, author and landing, its story entries (first sentence each), "Open the full story", "Show this change", and the same Disagree form as the unit page, over every line of its story. Binary files and files over 1 MB are not shown. Checked in the browser on the sandbox repo, night and daybreak.
  - **The unit hub (2026-10-01, from the developer's feedback that the views felt disconnected; prototype https://claude.ai/artifact/NTCdJLxANBL9aVV2TQ9vtk).** The unit page is the hub every view of a unit hangs off: Story (the ledger), Agents (`UnitStory.agents`: every session that worked on it, including the planner run that planned it, marked shared), and Code (`GET /api/projects/:id/units/:seq/code` → `unitCode`: the landed commit, or the latest handed-off branch against its base before landing, with per-file counts). The agent page and the editor always link back (breadcrumb, "for U3", "opened from U3's change"); the repo browser takes `?change=&file=&line=&from=`. The Agents page lists sessions across projects, each naming the unit it worked for, with project, role, and outcome filters.
- **Settings**: global configuration (§16) with effective-value/source display, YAML export/import, live counts against each concurrency cap.
- **As built (Environments, Settings; 2026-09-27):** Environments lists each environment with slots in use against capacity, who holds each slot and who waits (linked to the agent), the projects on it. Create takes an id, name, implemented provider (`local-process` today), and slot count; edit changes name and capacity (`updateEnvironment`, event `environment.updated`); lowering capacity below the slots in use lets them finish and starts no new ones. Settings shows every global value with a plain description (`.describe()` on each `SETTINGS` schema, `describeSettings`), its source and default, Save and Reset (`clearSetting`), and running counts beside each cap (`GET /api/settings/overview`). YAML export holds every explicitly set value by layer (`global`, `environment.<id>`, `repo.<id>`, `project.<id>`); import sets every value in the file, keeps the rest, and applies nothing if any key or value is invalid. CLI: `yagura env set`, `yagura unset`, `yagura settings export|import`. Each setting declares the layers it is read at (`SETTING_LAYERS` in `config.ts`): global only (the global caps and the watchman's settings); project (project cap, planner timebox and role, verify retries, `harness.claude.*`); project and repo (worker timebox and role, max attempts, git author and branch prefix, `yagura.url`, skill enforcement); and project, repo, and environment (verifier timebox and role). `setSetting` and import refuse any other layer, because an override there would never be read; the engine, planner delta, and verify-unit creation resolve with the repo and environment so each declared layer takes effect. The project page has a collapsed Settings section, and environment and repo rows a Settings button, each listing only the settings for that layer with "set here" + Reset or where the value comes from.

**As built (evidence viewer, 2026-09-27).** The agent page's wide column has Log, Diff, and Evidence views. Diff is `git diff --stat --patch base head` read from yagura's mirror (`GET /api/attempts/:id/diff`, capped at 2 MB), so it survives the worktree; added lines are pine, removed lines faint. Clicking a trunk or head cell in the evidence grid opens that run (`GET /api/evidence/:id`): its command, outcome, and duration, stdout and stderr, and every file the run wrote to `$YAGURA_EVIDENCE`. Images (png, jpeg, gif, webp, svg) show inline; other text files preview up to 256 KB; anything else is a download. Because these files come from agents, `GET /api/artifacts/:id` serves only image types by extension, everything else as `text/plain` or `application/octet-stream`, always with `Content-Security-Policy: sandbox` and `nosniff`, so an agent-written HTML or SVG file cannot run script in the dashboard.

### Agents: the portal's core

The dashboard is the developer's window into every agent yagura has ever run. Every attempt is a row in `attempts` (never deleted; only its bulky log/artifact files age out per retention), so live and historical agents are the same query.

- **Project → Agents tab**: every attempt in the project, live ones pinned on top. Columns: unit, role (worker / judge / lead / planner), state (queued · running · handed off · failed · stopped), harness/model, started, duration, tokens/context peak, outcome (hand-off status, verdict, decision, failure mode). Filter by role, state, unit, repo, harness; sort by time.
- **Agent detail** (one attempt): tabs for **Log** (timeline below), **Brief** (exactly what it received), **Record** (what it decided through its command), **Diff** (its branch vs base), **Evidence** (the recorded runs it made or cited), **Lease** (environment slot, namespace, timings). Header shows lineage: which planner drain created the unit and the previous and next attempts of the same unit.
- **Unit history**: all attempts of one unit in order (work → verify → rejected → work → verify → land), so a developer sees why it took three tries.
- **Project activity feed**: the `events` table rendered as a timeline — spawns, hand-offs, verdicts, decisions, gates, merges, pull request events, andon — filterable, each linking to its agent or unit.
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

Pages: **The watch** (towers from `lib/scene.ts`: urgency order, ~6 on the ridge then "+N quiet", closed for a day then gone, arcs for open `after` chains; a sticky strip replaces the scene on scroll; bell inbox from `GET /api/bell` with the right actions per item; talk box; lanterns; conversations), **Talk** (round-4 option G1: threads | conversation | ledger of projects, decisions with superseded ones struck through, open questions; proposal cards with Go / Edit / Discard; autonomy toggle; `@` autocomplete), **Project** (beacons from `lib/units.ts`, grouped rows with Land / Hold / Retry with a note / Cancel / Watch / Stop, andon, "Add work" opens a conversation prefilled with `@project`), **Agent** (option H1: live timeline with per-step times, a rail with context and timebox meters, brief, trunk-vs-head grid from the verifier's runs, unit history), **Projects** and **Agents** lists. (The Environments, Repos, and Settings pages were built later; see §17 and §12.)

Supporting daemon changes: each agent log line's arrival time is appended to a sidecar `<log>.times` (the raw harness log stays verbatim) and returned as `at`; `GET /api/bell`; `POST /api/projects/:id/units/:seq/retry` (note, one more attempt) and `/cancel`; project summaries carry agent slots, planner state, blocked count, last landing; units carry their live verdict and blocked reason; attempt detail carries the unit's history and its verifications' runs.

## 18. Security and air-gap

- Agents run with the harness's permission policy mapped from yagura's policy: a worker may push its own unit's branch (checked by the mirror's relay, §13) and no agent may open or merge a pull request.
- Credentials are references resolved by the daemon at lease time and injected only into verify subprocesses, never into briefs or logs.
- No outbound network is required by yagura itself.

## 19. Build order

Each phase ended in something demonstrably working on a real repo.

1. **Core:** store + schema, layered config + bootstrap vars, repo mirror + worktrees, `claude` adapter, a single `work` unit with rendered brief, CLI.
2. **Planning + parallelism:** planner drains with plan deltas, rolling window, retries by failure mode, andon.
3. **Dashboard:** projects, unit graph, live logs, gates, Settings tab.
4. **Environments and the forge:** providers, GitHub and GitLab adapters, forge watcher, retro watch.
5. **Multi-repo:** published test builds, expand/migrate/contract.
6. **The core loop (2026-10, steps CL1 to CL8, branch `core-loop`):** the old judging and landing paths deleted (verifier, reviewer, arbiter, verify packs, tiers, write scopes, squash and rebase landing); units as goals with one pull request each (CL2, CL3); recorded runs, the judge, the unit lead, merging with a merge commit, and keeping branches current (CL4, CL5); environment answers, actions, the doctor, and published test builds (CL6); the unit page and the new loop's dashboard (CL7); this document, a real-model run on GitHub, and the merge into `main` (CL8).
7. **Still to do:** more harnesses (codex, grok, custom, each with session resume where its CLI has one), measurement-driven hillclimb projects.

## 20. Decisions log

Answers to the questions this design left open (2026-09-26):

1. **Host:** the daemon runs natively on each developer's RHEL9 VM (Windows host), which already has kube, Nexus, and GitLab access; dashboard reachable from Windows via the VM hostname (§4).
2. **Kube namespaces:** configurable per environment, `create` or `pool` mode; a pool caps concurrent live verifications, not agents (§12).
3. **Models:** the harness default applies unless a model is set per role in yagura (§10, §16).
4. **GitLab:** one MR per unit (§15).
5. **Environments and stack knowledge (2026-09-27, user):** environment values are editable in the UI; environments are values the developer adds, each with a note for agents and an optional check, with presets (kube, registry with push and pull addresses, kafka with cluster and local addresses, …) as shortcuts; they can be set up by form or through the watchman, and saved and applied as templates (values marked ask are filled in per machine); hard-coded values in a diff are rejected; a kept-namespace policy is configurable (`never` / `failed` / `always`). How to build a kind of project lives in harness skills, named per purpose in project settings; yagura writes new skills only from example repos or proven results, proves them, and asks before using them (§11 "Project skills", §12 "Environment values").
6. **Forges (2026-09-27, user):** repos can use GitHub (`gh`) or GitLab (`glab`), configured per repo with its host; GitHub is built and proven first on a private sandbox repo, GitLab on the dev VM.
7. **Agent communication (2026-09-29, user):** no chat between agents. A worker sent back resumes its own session with the judge's findings instead of starting cold; the unit lead may choose a fresh worker instead (§26).
8. **Judgment over rules (2026-09-30, user):** agents are trusted to know how to test; the judge checks the worker did what was asked and tests what was built; yagura agrees or disagrees only on facts it can check; environment values and notes are context, not checks, and failures surface from real use to the watchman and the developer; the trail (each agent's decisions and reasons, yagura's records, cost) lets the developer disagree with any decision after the fact (§13).

## 21. The watchman as a live session (decided 2026-09-30, user; steps 1–4 built 2026-10-02)

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
- Queueing (2026-10-02): see "As built (queue)" below.

### As built (steps 2 and 3, 2026-10-02)

- The watchman runs with `harness.claude.watchman_permission_mode` (default `dontAsk`, which refuses every call nothing allows; `default` is not a mode in claude 2.1), `--allowed-tools` from `watchman.allowed_tools` (default: `Skill` and `Bash(yagura <read>:*)` for show, logs, trace, gates, settings, git, thread, env values|presets|notes, template list, project skills), and `--disallowed-tools Write,Edit,NotebookEdit,WebFetch,WebSearch` so an allow rule in the developer's own settings cannot hand those back. A real probe showed why Read, Grep, and Glob are _not_ on the list: a bare `Read` rule allows reading anywhere, while leaving them off lets `dontAsk` confine them (and read-only shell commands such as `cat`) to the working directory and `--add-dir`. The watchman's working directories are its thread directory and `<home>/projects/<id>/` for each project linked to the thread (spec, briefs, handoffs, logs); another project's files are refused.
- Repos are read through `yagura git <repo> log|show|ls-tree|diff|grep|blame`, not checkouts: it runs against the mirror (fetched when older than a minute; a failed fetch says so and reads what is there), refuses `--output`, `--no-index`, `--ext-diff`, `--textconv`, `-O`, and `--exec`, and refuses `HEAD` and the local default branch, which in a bare mirror stay where the clone left them (a real Haiku turn read `HEAD` first); `log` and `show` with no revision read `origin/<default branch>`.
- The role guard (`agentRefusal`, first thing in the CLI): with `YAGURA_ROLE` set, for every agent role and not only the watchman, the CLI runs only reads and `evidence` (which has its own token) and refuses everything else with exit 2, failing closed on anything it does not recognise. No per-turn secret: the guard trips on the role claim, not on proof of it, and dropping the claim (`env -u`, `YAGURA_ROLE= yagura …`) is itself a command outside the allow-list (a real probe: `FOO=1 echo hi` was refused even with `Bash(echo hi:*)` allowed). Workers run under `bypassPermissions`, so for them the guard is the only stop. The daemon API has no role check: agents have no network tool and no Bash beyond the list.
- The brief's LOOKING THINGS UP section says what the watchman can read and run.
- Proof: tests for the guard (every read allowed, every write and unknown command refused, any role), `yagura git` against a real mirror (reads, refused subcommands and options, stale refs, trunk by default), the adapter flags, and the watchman's run options. Real (Haiku, $0.17, fixtures `claude-watchman-tools.jsonl` and `claude-watchman-resume.jsonl`): asked for a word in a registered repo's README, the watchman found it with `yagura git`; `yagura set`, `cat /etc/hosts`, a redirect, `find` outside, and Write were refused and the setting was unchanged; the next message resumed the same session in 8 s and read the trunk log.
- A broad `Bash(…)` allow rule in the developer's own settings would still apply to the watchman, and deny rules cannot carve exceptions out of it. So (2026-10-03) every watchman session also gets a `PreToolUse` hook through `--settings` (`watchman-guard.ts`, the script written to `<home>/bin/watchman-guard.mjs`) that refuses any shell command other than the `Bash(yagura …)` reads in `watchman.allowed_tools`, optionally piped into grep, head, tail, wc, sort, uniq, or cut; chained commands, redirects (other than `2>&1`), and substitutions are refused. A hook that refuses wins over any allow rule. Tested by running the script itself; a real watchman probe is in the later-testing bucket.

### As built (queue, 2026-10-02)

- A message sent while a turn runs is saved at once (`queueMessage`), shown in the transcript with a `queued` tag, and answered by the next turn: when a turn ends with a reply, `runQueuedTurns` runs one turn for everything sent meanwhile, the last message as the turn's own and the earlier ones in "Messages since your last turn" (or the recent-messages section of a fresh brief), so the watchman reads them in order. A queued message is a human message after the thread's latest turn's message (`queuedMessages`); no new table.
- A turn's end marks as seen only up to the message before the first undelivered one, so a queued message is never skipped by the next delta.
- A stopped or failed turn leaves its queue alone; the next message you send carries it. `/clear` is still refused while a turn runs. The CLI's `yagura talk` still refuses a busy thread. The composer stays usable while the watchman replies.

### As built (step 4, 2026-10-02)

- Chosen from three mocks on real data (summary line, steps between the words, a side rail): the summary line. Each watchman reply with a turn log gets one line above its words, `10 tool calls · 3 allowed · 1 errored · 6 refused` (refused in red), that opens to the list: time into the turn, the call (`yagura git …` shown without `Bash`), a pill, why it was refused, and its output on click. While a turn runs, a live box under the last message shows the calls so far and the latest one.
- `readTurnCalls` (`turncalls.ts`) pairs `tool_call` and `tool_result` events from the turn's log (the retry log too, when records were rejected) and classes a result `refused` (the harness's permission denial, a disabled tool, or the CLI role guard), `error` (it ran and failed), or `ok`. API: `GET /api/messages/:id/calls`, `GET /api/threads/:id/live-calls`.
- Tested against the real Haiku transcript `claude-watchman-tools.jsonl` (ten calls, six refused) and checked in the browser.
- The context meter and session divider were already in the header and transcript (step 1).

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
- Any running attempt can be steered (worker, judge, unit lead, planner, doctor). Steering does not count as a try and does not change the attempt; it is recorded as an event (`attempt.steered`) and in the unit's story ("You told Worker U3.1", with read / not read).
- Interfaces: `POST /api/attempts/:id/steer {message}` (409 when not running, 400 when the harness cannot take messages), `GET /api/attempts/:id/steers`, `yagura steer <project>/U<n> <message>`, and on the agent page a box under the live log that shows each message's state; read messages appear in the timeline as "you" at the point the agent read them (the harness's echo of yagura's own prompt is not shown).

### Other harnesses

Steering is offered only for an adapter that implements `message(text)` (claude today). Before adding it for grok, codex, or any later harness, probe it the same way and record what it does: whether it reads messages from stdin while running, whether a message is taken in between steps or only after the whole response, how (and whether) it echoes a message it took in, and whether it exits on its own after its final result or waits for stdin to close. Capture the transcript as a fixture. Until then those harnesses keep the one-shot prompt and the API refuses to steer them.

### Open

- The watchman still runs one `claude -p --resume` per message (§21); a long-lived watchman on the same stdin mechanism waits on whether the per-message start is slow in real use.

## 23. The landing route is chosen, never defaulted (decided and built 2026-10-02, user)

The third real run landed two projects by pushing commits straight to the sandbox's `main` although the developer asked for one PR per change: the repo had been registered without `--forge gh`, `none` was the silent default, and nothing showed the route before Go. A repo's landing route must be a deliberate choice that everyone can see, and the server should refuse what yagura must never do.

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

## 24. Header search (decided and built 2026-10-02, developer)

The developer chose, from a clickable prototype on real run data (https://claude.ai/artifact/Fmgm89ZWDRWoKCBG5Nj69b): a search box in the header on every page; typing shows results in a drop-down under the box; clicking a result opens its page; "all results" opens a results page. The drop-down closes when the box loses focus or on Escape; `/` focuses the box from anywhere.

- `find.ts` (`GET /api/find?q=&per=`): every word must appear, any case, `%` and `_` taken literally. A commit (via `findUnitsByCommit`), an issue key (via `findByRef`, projects and units), or `U3` / `project/U3` names its units first; then unit goals (build units), projects, decisions, questions (with answers), review threads (people's and the reviewer's), conversation messages, handoffs (the `search` table's bodies), and repos, up to 200 each. `per` caps hits per kind for the drop-down while `counts` stay whole; each hit's text is an excerpt around the first match.
- Web: `ui/SearchBox.tsx` in the header (three per kind, arrow keys, Enter opens the selected result or the results page), `pages/Search.tsx` at `/search?q=` (a summary line, kind filters always visible, a ledger with location links and highlighted matches), `lib/search.ts` (grouping and highlighting, unit-tested).
- A conversation result opens its thread at that message (built 2026-10-03).

## 25. Role prompts are visible and editable (decided 2026-10-03, user; storage, runs, API, and CLI built 2026-10-03)

Every agent's prompt has two parts. The **contract** is the brief yagura writes: goal, scope, acceptance, the handoff format, evidence and scope rules. yagura parses and enforces it, so it is shown but never editable. The **guidance** is how to do the job: the body of the role's overlay skill (`yagura-planner`, `yagura-worker`, …). The developer may override it **globally** or **per project**; a project shows whether each role uses yagura's default, the global override, or its own. The watchman serves threads, not projects, so its guidance is global only. **Notes** are standing orders: one text for every role plus one per role, per project; they fill the brief's STANDING ORDERS section. The watchman's notes are global (every conversation). Standing orders used to be hand-edited files (`projects/<id>/standing-orders.md`, `threads/<id>/standing-orders.md`); the daemon moves any it finds into the store at start and removes them (developer, 2026-10-03: as few local files as possible; what yagura uses lives in its database, visible or editable in the dashboard). Each role's page also shows, read-only, the **follow-ups** yagura may send after the brief (a resumed worker's rejection, the request to explain a path outside scope, the watchman's update and retry turns, a developer's steering message), rendered by the same functions that send them.

As built: `prompt_texts(scope, scope_id, role, kind, text)` (migration 27); `effectiveGuidance` resolves project → global → default. Each session loads `promptPlugin`: yagura's own plugin when nothing is overridden, otherwise a copy under `<home>/plugins/<content hash>/` whose skills carry the effective guidance with their original frontmatter (named by content, so concurrent sessions never see a half-written copy). Every agent run records the guidance it got (`attempts.guidance_sha`, text in `prompt_versions`). Edits apply to the next run. API: `GET /api/prompts?project=`, `PUT /api/prompts` (`text: null` resets). CLI: `yagura prompt show|set|reset`. Dashboard (layout A, chosen from three mocks on real data, https://claude.ai/artifact/LBrRcUuQ5pECgFmgRowUf7): `/p/<project>/prompts`, linked from the project page; notes for every role on top; a role list with each role's source (yagura default, your global, this project); the selected role's guidance editor with its version, Save for this project, Save for all projects, and Reset to the next layer; its changes from yagura's default; its notes; and the contract, which is the brief its last agent got, read-only and linked to that agent. `/prompts` (linked from Settings and from each project's prompts page) is the same page without a project: the global guidance of every role, the watchman's included.

**The spec lives in the store** (2026-10-03, user: it is yagura's, not a repo's, so it is not committed anywhere). `project_specs(project_id, text, updated_by, updated_at)` (migration 28); the watchman edits it a section at a time, the developer edits the whole text at `/p/<project>/spec` in the same Monaco editor as the repo browser (markdown, saved with a check that nobody changed it since it was opened, 409 otherwise) or with `yagura spec <project> [--set <file>]`. Every save records `project.spec_changed`, so the planner looks again. The planner's brief carries the spec's text (it no longer reads a file); the watchman's already did. The daemon moves any old `projects/<id>/spec.md` into the store at start and removes it.

Default planner guidance (changed the same day, user): a unit is one behaviour together with the tests that prove it, because its worker has to prove to itself that the change works; the planner looks for parallel work but splits by independent behaviour, never tests from the code they test.

## 26. The unit lead: one agent per unit that decides what happens next (decided 2026-10-03, user; redesigned 2026-10-08)

yagura's rules cannot tell a flaky run from a unit that is the wrong size, or notice that two attempts failed for the same reason. A **unit lead** is an agent with judgment over what happens next, for one unit, from its start to its merge.

- **Woken** for a reason, never on a schedule:

  | Wakes on                                                      | Typical decisions                                                                                        |
  | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
  | The worker says it is stuck.                                  | Give it what it needs; start a fresh worker; ask the developer; ask the project lead to change the plan. |
  | The judge asks a question.                                    | Answer it, or ask the developer.                                                                         |
  | The judge asked for changes `judge.max_rounds` times running. | Change the approach; fresh worker; ask the project lead to split it; drop.                               |
  | A person or bot comments on the ready pull request.           | Send the worker a fix; reply; ask the developer when it changes what the unit must do.                   |
  | CI fails twice on the same head.                              | Worker fixes; ask the developer when it is the infrastructure.                                           |
  | The worker could not resolve a conflict with the base.        | Help it; ask the developer; ask the project lead whether the units clash by design.                      |
  | The developer leaves it a note, or answers its question.      | Whatever the note asks.                                                                                  |

- **Reads first** to know what a worker did: the decision log, hand-offs, recorded runs, the judge's verdicts, the pull request. Only when those do not answer its question does it resume the worker's session to ask, and that turn changes nothing in the branch.
- **Answers with one command**, `yagura decide <action> --reason "…"`, checked when called: `resume` (the worker, with a note), `fresh` (a new worker), `answer` (the judge's question), `ask` (the developer), `replan` (the project lead), `reply` (on the pull request, signed as the unit lead), `drop`. A question to the developer is a gate; if the developer answers with a note on the unit instead, the lead decides again and its old question is closed. Leaving `stuck` closes the lead's open question too, so a stale one cannot hold a merge unseen.
- **Settings:** `lead.max_decisions_per_unit` (default 4, after which the unit waits for the developer), `role.lead.harness`, `role.lead.model`. Guidance is overridable like every role's (§25). Its brief ends with `## METHOD`, naming the `yagura-unit-lead` skill.
- **Visible in full:** every wake is an agent run on the unit (`attempts` row, role `lead`, numbered like any agent), so the Agents tab shows the brief exactly as sent, the live log, and the decision.
- **Where it sits:** the developer talks to one front door, the watchman (§21). Below it the project lead (the planner) sees every unit at each drain and changes the plan; the unit lead is the unit-level manager; workers and judges do the work.
- **Approval:** the lead's choices take effect at once and are recorded for the developer to disagree with afterwards, as with every other decision (§2 principle 9).

## 27. Agents act through commands; the final message is never parsed (decided 2026-10-05, developer; rebuilt for the core loop 2026-10-08)

**The problem.** An agent's final message is two things at once: a report for the developer and the input the engine acts on. Parsing it for the second job broke in real runs four ways in two days (a criterion in backticks never matched, a command came back with an explanation after it, rulings written ahead of a heading were discarded, a plan delta carried an unknown key), each time fixed by loosening one regex. The fix is structural: what the engine acts on never comes from prose.

**The design.** Everything the engine acts on is a `yagura` subcommand the agent calls during its session, authenticated by a per-attempt token (so an agent can write only its own records) and written to `agent_records` as it happens. Each command's arguments are a Zod schema checked at the call: a wrong value returns a specific error and a non-zero exit, so the agent fixes it in the same session, and a failed call writes only a `command.rejected` event. The final message stays a report for people; yagura reads its records, never it.

| Role      | Command                                                                                                            | What yagura does                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Worker    | `yagura handoff done` or `handoff stuck --reason …` (`--did`, `--evidence`, `--decision`, `--note`, `--follow-up`) | Pushes and judges, or sends the unit to its lead                           |
| Judge     | `yagura judge approve --runs …`, `judge changes --finding …`, `judge ask --question …`                             | Readies the pull request, sends the worker the findings, or wakes the lead |
| Unit lead | `yagura decide <resume\|fresh\|answer\|ask\|replan\|reply\|drop> --reason …` (§26)                                 | Acts on the decision                                                       |
| Planner   | `yagura plan --file <path>` (`--json` inline for a role that cannot write files)                                   | Validates and applies the delta (§8)                                       |
| Any agent | `yagura evidence run -- <command>` (§13), `yagura action propose` and `action broken` (§12)                        | Runs the command itself and records it                                     |
| Doctor    | `yagura doctor --works … --fails … --unknown …` (§12)                                                              | Shows the report                                                           |

**When the record is still missing.** `missingRecords(db, attempt, role)` holds each role's short list of what must exist when it finishes ("no verdict: run `yagura judge approve …`"). A session that ends without its record is resumed once in the same session with that message (the `check-done` hook runs it before the session closes); if it still ends without, the role's rule applies: a judge is replaced by a fresh one and, after two in a row, the unit is stuck; a worker's unit is stuck for its lead; a planner round is rejected and recorded.

**Records are the ledger.** The unit's story (`story.ts`) is built from the recorded commands, not from a parsed message, and every cited run id must exist in `evidence_runs` for that unit.

## 29. The account's usage limit pauses yagura; it is not a failure (decided and built 2026-10-07, developer)

A Claude subscription allows so much use per window (five hours, seven days). When a session hits it, `claude` refuses the request at once with "You've hit your session limit · resets …". Before this, yagura read that as a failed attempt: the unit retried, failed again in seconds, and used up `max_attempts`, and a planner hit counted toward the planner's three rejections.

- **Reading it.** In stream-json the refusal is an assistant message with `error: "rate_limit"`; a usage limit adds `api_error: "usage_limit_reached"` and `api_error_params.rate_limit_info` with `status`, `resetsAt` (epoch seconds), and `rateLimitType`, the same fields as `rate_limit_event`. The claude adapter turns both into a `limit` event; `rejected` (or the assistant error) is a refusal. The shape was read from claude 2.1.292's own stream-json writer, since no session had been captured hitting it (`fixtures/claude-usage-limit.from-source.jsonl`); replace it with a real transcript once a yagura log has one.
- **One hold per harness.** The limit is the account's, shared by every session, so one refusal records a hold (`usage_holds`, migration 43) until `resetsAt`; with no reset time (an API key's or a gateway's rate limit) it is 15 minutes, and a session refused again extends it. While a hold is active the engine starts no planner and no unit, and logs it once; landing, publishing, forge polling, and retro watches carry on.
- **The session waits and resumes.** `runAgentSession` keeps the refused attempt running with `limited_until` set (event `attempt.limited`), polls until the hold ends, then resumes the same session with "The account's usage limit has reset. Carry on from where you stopped." (or reruns it when the harness cannot resume), appending to the same log. Every role that runs through `attemptRecorder` gets this without its own code. `spendsAttempt` excludes an attempt with `limited_until`, so a daemon restart during the wait does not cost a try. A stop during the wait ends the attempt as stopped. The watchman's chat turn does not wait; it fails as before, so the developer sees the message.
- **The developer.** `yagura limit` shows the hold, its reason, and until when; `yagura limit --clear` ends it early (after buying extra usage, say). The dashboard does not show it yet.
- **Not counted.** Wall-clock budgets (`project.budget_hours`) keep running during a hold; timeboxes do not, since each resumed run gets its own.

## 30. Issues on the forge are conversations with the watchman (decided 2026-10-07, developer)

The developer wants to work from a phone: file an issue on GitHub or GitLab, and have yagura read it, decide, reply on the issue, and build what was agreed, with approval given by replying on the issue rather than in the dashboard.

- **An issue is a watchman thread.** The watchman already holds a conversation, decides, keeps decisions and questions, and turns agreement into a proposal (new project, or units on the thread's project) that `autonomy: go` applies at once and `propose` holds for approval. A watched issue gets its own thread (`#12 <title>`), linked at creation to the newest active project that includes the repo (otherwise none, and the watchman proposes a new project). The issue's body and each new comment become thread messages, attributed to their forge login and quoted as data; a watchman reply is posted on the issue only when its turn answered at least one of those (the ids are kept in `forge_issues.issue_messages_json`, migration 45). The developer can also talk to the watchman in the dashboard's thread: those messages and the replies to them stay in yagura (found in the first real run, 2026-10-07, where every dashboard reply had been posted). The dashboard's Talk page shows the thread like any other.
- **What is watched.** `forge.watch_issues` (per repo, default off). Only issues opened after watching began for that repo are taken up (the watermark is stored when watching first runs); older issues are left alone. Every author is read; only trusted authors can make work start.
- **Never twice.** `forge_issues` records each taken issue, its thread, the comment ids already read, and the last thread message posted. Every post carries a key (`<!-- yagura-reply:issue-… -->`) that yagura reads back from the issue before posting, so a restart, a lost row, or a post the forge reported as failed never posts the same reply again. Comments carrying yagura's mark are never read as new.
- **Trusted authors.** `forge.trusted_authors` (replaces `review.trusted_authors`, migration 44 renames stored values) lists forge logins whose word is the developer's. An issue a trusted author opens runs its thread with `autonomy: go`. Anyone else's runs with `propose`: the watchman's proposal is posted with "A trusted user can reply **yes** to go ahead, or **no** to decline." yagura itself (not an agent) reads the next comments: from a trusted login, a reply whose first word is yes, go, approve, or lgtm applies the pending proposal; no or decline discards it; anything else is a message for the watchman, who may revise. The proposal is also answerable in the dashboard.
- **Updates without asking (2026-10-07).** Besides replies, yagura itself posts on the issue each decision its thread records (`Decided: …`, whether made on the issue or in the dashboard), each pull or merge request opened for its work, each landing, and each time that work blocks for the developer. `forge_issues.announced_json` keeps what was told (migration 46); an issue answered before this existed starts from what had already happened and posts only what comes after.
- **Replies, not closes.** The watchman may reply anything it needs to decide: a question, a refusal with its reason, a plan. yagura never closes an issue by itself; work it builds closes the issue when it merges, because every unit and project created from an issue thread carries the issue as a ref naming its repo (`app#12`: a project spans repos, and `#12` alone names a different issue in each), and a ref to a watched issue adds a `Closes #12` line to a commit in that same repo only, so the PR or MR closes it on merge (auto-merge projects included).
- **Cost.** Each new comment from anyone runs a watchman turn. `issues.max_turns_per_day` (per repo, default 10) caps turns per issue per day; past it the comments wait in the thread until the next day. Watchman turns are not counted against project budgets (a known limit), and none are set by default.
- **A forge call has a time limit (2026-10-08).** Every `gh` and `glab` call gives up after `forge.timeout_seconds` (default 120) and the next check tries again. Found in the first real run: one review-thread query hung 52 minutes on a connection dropped while the Mac slept, which held that pull request's watcher and the daemon's shutdown.
- **Not built.** Labels or assignment as filters, closing a declined issue, editing comments (an edited comment is not read again), issues on repos without a forge.
