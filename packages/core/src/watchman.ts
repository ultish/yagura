import { getPromptText, promptPlugin } from "./prompts.js";
import { watchmanGuardSettings } from "./watchman-guard.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertThreadFree, beginTurn, currentSession, endSession, endTurn, getTurn, markSeen, runningTurn, turnRecorder } from "./turns.js";
import { z } from "zod";
import { runAgentSession, write, type RunContext, type SessionRecorder } from "./agent.js";
import { resolveSetting } from "./config.js";
import { PASS_TIERS, type Environment, type EnvironmentId, type ProjectId, type RepoId } from "./domain.js";
import { listValues } from "./envvalues.js";
import { PROVIDERS_IMPL } from "./leases.js";
import { PRESETS } from "./presets.js";
import { listTemplates } from "./templates.js";
import { installedSkills } from "./skills.js";
import { describeMention, resolveMentions } from "./mentions.js";
import { missingSkills } from "./pack.js";
import { layout } from "./paths.js";
import { lastDrainEventId, latestDelta } from "./planner.js";
import { WORK_PLAYBOOKS } from "./plan.js";
import {
  applyProposal,
  describeProposal,
  inspectProposalRepos,
  ProposalBody,
  ProposalInvalid,
  validateProposal,
  type ApplyProposalResult,
} from "./proposal.js";
import { editSpec, readSpec, relevantSections, renderSpec, writeSpec, type Spec } from "./spec.js";
import { generateStatus } from "./status.js";
import { getEnvironment, getProject, getRepo, recordEvent, type Db } from "./store.js";
import { describeRoute } from "./route.js";
import {
  addDecision,
  addMessage,
  addProposal,
  addQuestion,
  getDecision,
  getQuestion,
  getThread,
  listDecisions,
  listMessages,
  listProposals,
  listQuestions,
  resolveQuestion,
  type Proposal,
  type ThreadMessage,
} from "./threads.js";

const DecisionRef = z.string().regex(/^D\d+$/, "decision references look like D3");
const QuestionRef = z.string().regex(/^Q\d+$/, "question references look like Q2");

export const TurnRecords = z
  .object({
    title: z.string().min(1).max(80).optional(),
    decisions: z.array(z.object({ text: z.string().min(1), supersedes: DecisionRef.optional() }).strict()).default([]),
    questions: z.array(z.string().min(1)).default([]),
    answered: z.array(z.object({ question: QuestionRef, answer: z.string().min(1) }).strict()).default([]),
    spec: z.array(z.object({ project: z.string(), section: z.string().min(1), body: z.string().nullable() }).strict()).default([]),
    proposal: ProposalBody.nullable().default(null),
  })
  .strict();
export type TurnRecords = z.output<typeof TurnRecords>;

export type ParsedReply = { body: string; records: TurnRecords; error: null } | { body: string; records: null; error: string };

const EMPTY_RECORDS = TurnRecords.parse({});

export function parseReply(text: string): ParsedReply {
  const blocks = [...text.matchAll(/```yagura\s*\n([\s\S]*?)\n```/g)];
  const last = blocks.at(-1);
  if (!last) return { body: text.trim(), records: EMPTY_RECORDS, error: null };
  const body = (text.slice(0, last.index) + text.slice(last.index! + last[0].length)).trim();
  let json: unknown;
  try {
    json = JSON.parse(last[1]!);
  } catch (e) {
    return { body, records: null, error: `the yagura block is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = TurnRecords.safeParse(json);
  if (!parsed.success)
    return {
      body,
      records: null,
      error: `the yagura block does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  return { body, records: parsed.data, error: null };
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface ContextParts {
  fixed: string[];
  statuses: { projectId: string; text: string }[];
  spec: { projectId: string; toc: string[]; whole: string; relevant: { heading: string; body: string }[] }[];
  history: { id: number; role: string; body: string }[];
}

export interface AssembledContext {
  sections: { status: string; spec: string; history: string };
  usedTokens: number;
  dropped: { messages: number; statusTruncated: string[]; specSections: number };
}

function truncateTo(text: string, tokens: number, note: string): string {
  if (estimateTokens(text) <= tokens) return text;
  return `${text.slice(0, Math.max(0, tokens * 4 - note.length - 2))}\n${note}`;
}

export function assembleContext(parts: ContextParts, budgetTokens: number): AssembledContext {
  let left = budgetTokens - parts.fixed.reduce((n, s) => n + estimateTokens(s), 0);
  const dropped: AssembledContext["dropped"] = { messages: 0, statusTruncated: [], specSections: 0 };

  const statusShare = Math.max(0, Math.floor((left * 0.35) / Math.max(1, parts.statuses.length)));
  const statuses = parts.statuses.map((s) => {
    const text = truncateTo(s.text, statusShare, `… (truncated; run \`yagura show ${s.projectId}\` for the rest)`);
    if (text !== s.text) dropped.statusTruncated.push(s.projectId);
    return text;
  });
  const status = statuses.join("\n\n");
  left -= estimateTokens(status);

  const specShare = Math.max(0, Math.floor(left * 0.3));
  const specBlocks: string[] = [];
  let specLeft = specShare;
  for (const s of parts.spec) {
    if (estimateTokens(s.whole) <= specLeft) {
      specBlocks.push(`### spec of ${s.projectId} (whole)\n${s.whole}`);
      specLeft -= estimateTokens(s.whole);
      continue;
    }
    const lines = [`### spec of ${s.projectId}: sections ${s.toc.map((h) => `"${h}"`).join(", ")}`];
    specLeft -= estimateTokens(lines[0]!);
    for (const sec of s.relevant) {
      const block = `#### ${sec.heading}\n${sec.body}`;
      if (estimateTokens(block) > specLeft) {
        dropped.specSections++;
        continue;
      }
      lines.push(block);
      specLeft -= estimateTokens(block);
    }
    specBlocks.push(lines.join("\n"));
  }
  const spec = specBlocks.join("\n\n");
  left -= estimateTokens(spec);

  const kept: string[] = [];
  for (const m of [...parts.history].reverse()) {
    const block = `[${m.role} #${m.id}]\n${m.body}`;
    if (kept.length && estimateTokens(block) > left) {
      dropped.messages = parts.history.length - kept.length;
      break;
    }
    kept.unshift(block);
    left -= estimateTokens(block);
  }
  const history = kept.join("\n\n");
  return { sections: { status, spec, history }, usedTokens: budgetTokens - left, dropped };
}

const EMPTY_CONTEXT: AssembledContext = {
  sections: { status: "", spec: "", history: "" },
  usedTokens: 0,
  dropped: { messages: 0, statusTruncated: [], specSections: 0 },
};

export interface WatchmanBrief {
  thread: { id: number; title: string; autonomy: string };
  decisions: string;
  questions: string;
  proposals: string;
  catalog: string;
  standing: string;
  mentioned: string;
  projectsDir: string;
  context: AssembledContext;
  message: { id: number; body: string };
}

export function renderWatchmanBrief(b: WatchmanBrief): string {
  const { sections, dropped } = b.context;
  return `# yagura watchman brief

You are yagura's watchman: the developer's front door. You turn conversation into projects that yagura's own agents plan, build, verify, and land, and you keep the thread's memory in structured records. You never write code and never touch repos yourself. This brief starts a session: later messages in this thread resume it and bring only what changed. yagura's records, not this session, are the truth: when a session is cleared or lost, the next one starts again from them.

## THREAD
- thread ${b.thread.id}: ${b.thread.title}
- autonomy: ${b.thread.autonomy}${b.thread.autonomy === "go" ? " (your proposal is applied as soon as yagura validates it; ask only for real decisions)" : " (nothing starts until the developer says Go on your proposal)"}

## STANDING ORDERS
${b.standing || "(none)"}

## DECISIONS (active; authoritative over anything in the conversation)
${b.decisions || "(none yet)"}

## OPEN QUESTIONS
${b.questions || "(none)"}

## PROPOSALS
${b.proposals || "(none)"}

## MENTIONED IN THE MESSAGE (generated from records)
${b.mentioned || "(nothing)"}

## PROJECTS IN THIS THREAD (generated from records)
${sections.status || "(none yet)"}

## SPEC
${sections.spec || "(no spec yet)"}${dropped.specSections ? `\n(${dropped.specSections} relevant section(s) did not fit; name the section to see it next turn)` : ""}

## WHAT YAGURA HAS
${b.catalog}

## LOOKING THINGS UP
You can read, never change. Read, Grep, and Glob work in this thread's directory and in \`${b.projectsDir}/<project>/\` for each project in this thread (briefs/, handoffs/, logs/; each project's spec is in this brief). For anything else run \`yagura show <project> [unit#]\`, \`yagura logs\`, \`yagura trace <sha|issue>\`, \`yagura gates\`, \`yagura settings\`, \`yagura thread list|show|search|mentions\`, \`yagura env values|presets|notes\`, \`yagura template list\`, \`yagura project skills\`, or \`yagura git <repo> log|show|ls-tree|diff|grep|blame\` (trunk is \`origin/<default branch>\`). Every other tool and command is refused; look a fact up before you guess it or ask the developer for it.

## CONVERSATION (most recent, oldest first)
${dropped.messages ? `(${dropped.messages} older message(s) omitted; search them with \`yagura thread search --thread ${b.thread.id} "<words>"\`)\n\n` : ""}${sections.history}

## THE MESSAGE TO ANSWER
[human #${b.message.id}]
${b.message.body}

## METHOD
Load the yagura-watchman skill first and follow it.

## REPORT
Reply to the developer in plain prose. Then end your final message with exactly one fenced \`yagura\` block holding this turn's records (omit any key you do not need; \`{}\` is valid):

\`\`\`yagura
{
  "title": "short thread title (first turn only)",
  "decisions": [{ "text": "one settled decision", "supersedes": "D2" }],
  "questions": ["something only the developer can answer"],
  "answered": [{ "question": "Q1", "answer": "what the developer said" }],
  "spec": [{ "project": "kafka-diff", "section": "Ignored fields", "body": "markdown, or null to delete the section" }],
  "proposal": {
    "summary": "what applying this starts and why",
    "repos": [
      { "id": "kafka-diff", "description": "one line", "verifyPack": { "provider": "local-process", "checks": [{ "name": "unit", "command": "python3 -m unittest -v", "tier": "unit-verified" }] } },
      { "id": "billing", "existing": "git@gitlab.internal:team/billing.git", "forge": "glab" }
    ],
    "environments": [
      { "id": "vm", "provider": "kube-namespace", "providerConfig": { "context": "rancher-desktop" }, "capacity": 1, "notes": "dependencies run in the cluster",
        "presets": ["helm"], "values": [{ "name": "REDIS_URL", "value": "redis://vm.internal:6379", "note": "Redis from this machine" }] },
      { "id": "vm2", "template": "spring-kube", "answers": { "REGISTRY_PULL": "vm2.internal:5000" } }
    ],
    "projects": [{
      "id": "kafka-diff", "goal": "…", "predicate": "checkable done condition", "repos": ["kafka-diff"],
      "environment": null, "merge": "auto", "land": "pr", "minTier": "unit-verified", "after": [], "phaseGate": false,
      "spec": "# kafka-diff\\n\\n## Scope\\n…", "units": [],
      "skills": { "scaffold": ["setup-gradle"], "work": [], "pack": [], "verify": [] }, "references": ["billing"]
    }],
    "amend": [{ "project": "kafka-diff", "units": [{ "key": "ignore-ts", "repo": "kafka-diff", "goal": "…", "write": ["src/**"], "accept": ["…"], "verify": "…" }] }]
  }
}
\`\`\`
`;
}

function catalog(db: Db, boot: RunContext["boot"]): string {
  const repos = (db.prepare("SELECT id FROM repos ORDER BY id").all() as { id: RepoId }[]).map((r) => getRepo(db, r.id));
  const envs = (db.prepare("SELECT id FROM environments ORDER BY id").all() as { id: EnvironmentId }[]).map((e) => getEnvironment(db, e.id));
  const projects = db.prepare("SELECT id, state FROM projects ORDER BY created_at").all() as { id: string; state: string }[];
  const envLine = (e: Environment) => {
    const values = listValues(db, e.id).map((v) => v.name);
    return `${e.id} (${e.provider}, ${e.capacity} slots${values.length ? `, values ${values.join(" ")}` : ""})`;
  };
  const templates = listTemplates(db).flatMap((t) =>
    t.template
      ? [
          `${t.template.name}${
            t.template.values.some((v) => v.ask)
              ? ` (asks ${t.template.values
                  .filter((v) => v.ask)
                  .map((v) => v.name)
                  .join(", ")})`
              : ""
          }`,
        ]
      : [],
  );
  return [
    `- registered repos (use them by id in a project's repos; never list them again in the proposal's repos): ${repos.map((r) => `${r.id} (${r.url}, ${r.defaultBranch}, lands ${describeRoute(r)})`).join("; ") || "(none)"}`,
    `- landing: set a project's "land" to "pr" when the developer wants pull or merge requests and "push" when they agree to commits straight on the default branch; yagura rejects a project whose land does not match its repo's route, and a remote repo with no confirmed route. An existing repo you register needs "forge" ("gh" or "glab") or "land": "push" unless its host is github.com or a known GitLab host; ask if unsure`,
    `- environments: ${envs.map(envLine).join("; ") || `(none; a project with environment null gets a new local-process "local")`}`,
    `- environment presets: ${PRESETS.map((p) => `${p.id} (${p.values.map((v) => v.name).join(", ")})`).join("; ")}`,
    `- environment templates: ${templates.join("; ") || "(none)"}`,
    `- environment providers: ${Object.keys(PROVIDERS_IMPL).join(", ")}`,
    `- the developer's own skills (for project skills): ${
      [...installedSkills(boot)]
        .filter((s) => !s.includes(":"))
        .sort()
        .join(", ") || "(none)"
    }`,
    `- existing project ids (taken): ${projects.map((p) => `${p.id} [${p.state}]`).join(", ") || "(none)"}`,
    `- tiers, strongest first: ${PASS_TIERS.join(", ")}`,
    `- unit playbooks: ${WORK_PLAYBOOKS.join(", ")}`,
  ].join("\n");
}

function describeProposalRow(p: Proposal): string {
  const parsed = ProposalBody.safeParse(p.body);
  const text = parsed.success ? describeProposal(parsed.data) : JSON.stringify(p.body);
  const result = p.state === "applied" || p.state === "failed" ? ` → ${JSON.stringify(p.result)}` : "";
  return `### proposal ${p.id} [${p.state}]${result}\n${text}`;
}

interface ThreadState {
  thread: ReturnType<typeof getThread>;
  decisions: { id: number; text: string }[];
  questions: { id: number; text: string }[];
  proposals: Proposal[];
  standing: string;
  catalog: string;
  statuses: { projectId: string; text: string }[];
  specs: { projectId: string; spec: Spec }[];
}

// What a session has been shown, so a resumed turn can be told only what changed.
export interface Seen {
  lastMessageId: number;
  decisions: Record<string, string>;
  questions: Record<string, string>;
  proposals: Record<string, string>;
  specs: Record<string, string>;
  statuses: Record<string, string>;
  standing: string;
  catalog: string;
}

function threadState(ctx: { db: Db; boot: RunContext["boot"] }, threadId: number): ThreadState {
  const { db, boot } = ctx;
  const paths = layout(boot);
  const thread = getThread(db, threadId);
  return {
    thread,
    decisions: listDecisions(db, threadId, { activeOnly: true }).map((d) => ({ id: d.id, text: d.text })),
    questions: listQuestions(db, threadId, { openOnly: true }).map((q) => ({ id: q.id, text: q.text })),
    proposals: listProposals(db, threadId),
    standing: (getPromptText(db, "global", "", "watchman", "notes") ?? "").trim(),
    catalog: catalog(db, boot),
    statuses: thread.projects.map((p) => {
      const project = getProject(db, p);
      const after = project.after.length ? `\n- after: ${project.after.join(", ")}${project.phaseGate ? " (phase gate)" : ""}` : "";
      const summary = latestDelta(db, p)?.summary;
      return {
        projectId: p,
        text: `${generateStatus(db, boot, p, lastDrainEventId(db, p)).replace(/^# /, "### ")}${after}${summary ? `\n- planner's last summary: ${summary}` : ""}`,
      };
    }),
    specs: thread.projects.flatMap((p) => {
      const spec = readSpec(db, p);
      return spec ? [{ projectId: p, spec }] : [];
    }),
  };
}

function seenOf(state: ThreadState, lastMessageId: number): Seen {
  return {
    lastMessageId,
    decisions: Object.fromEntries(state.decisions.map((d) => [d.id, d.text])),
    questions: Object.fromEntries(state.questions.map((q) => [q.id, q.text])),
    proposals: Object.fromEntries(state.proposals.map((p) => [p.id, p.state])),
    specs: Object.fromEntries(state.specs.map((s) => [s.projectId, renderSpec(s.spec)])),
    statuses: Object.fromEntries(state.statuses.map((s) => [s.projectId, s.text])),
    standing: state.standing,
    catalog: state.catalog,
  };
}

function mentionedIn(ctx: { db: Db; boot: RunContext["boot"] }, body: string): string {
  return resolveMentions(ctx.db, body)
    .map((m) => `### @${m.ref}\n${truncateTo(describeMention(ctx.db, ctx.boot, m), 2000, `… (truncated; ask yagura for more)`)}`)
    .join("\n\n");
}

export interface BuiltBrief {
  text: string;
  context: AssembledContext;
  seen: Seen;
}

export function buildWatchmanBrief(ctx: { db: Db; boot: RunContext["boot"] }, threadId: number, message: ThreadMessage): BuiltBrief {
  const { db } = ctx;
  const state = threadState(ctx, threadId);
  const { thread } = state;
  const decisions = state.decisions.map((d) => `- D${d.id}: ${d.text}`).join("\n");
  const questions = state.questions.map((q) => `- Q${q.id}: ${q.text}`).join("\n");
  const proposals = state.proposals
    .filter((p, i) => p.state === "pending" || i === state.proposals.length - 1)
    .slice(-3)
    .map(describeProposalRow)
    .join("\n\n");
  const mentioned = mentionedIn(ctx, message.body);
  const spec = state.specs.map(({ projectId, spec: s }) => ({
    projectId,
    toc: s.sections.map((x) => x.heading),
    whole: renderSpec(s),
    relevant: relevantSections(s, message.body),
  }));
  const history = listMessages(db, threadId).filter((m) => m.id !== message.id);

  const template = renderWatchmanBrief({
    thread,
    decisions: "",
    questions: "",
    proposals: "",
    catalog: "",
    standing: "",
    mentioned: "",
    projectsDir: "",
    context: EMPTY_CONTEXT,
    message: { id: 0, body: "" },
  });
  const fixed = [template, decisions, questions, proposals, state.standing, state.catalog, mentioned, message.body];
  const context = assembleContext({ fixed, statuses: state.statuses, spec, history }, resolveSetting(db, "watchman.context_tokens").value);
  return {
    text: renderWatchmanBrief({
      thread,
      decisions,
      questions,
      proposals,
      catalog: state.catalog,
      standing: state.standing,
      mentioned,
      projectsDir: join(ctx.boot.home, "projects"),
      context,
      message: { id: message.id, body: message.body },
    }),
    context,
    seen: seenOf(state, message.id),
  };
}

export function buildWatchmanUpdate(ctx: { db: Db; boot: RunContext["boot"] }, threadId: number, message: ThreadMessage, seen: Seen): BuiltBrief {
  const { db } = ctx;
  const state = threadState(ctx, threadId);
  const budget = resolveSetting(db, "watchman.context_tokens").value;
  const blocks: string[] = [];
  const section = (title: string, lines: string[]) => lines.length && blocks.push(`### ${title}\n${lines.join("\n")}`);

  const active = new Set(state.decisions.map((d) => String(d.id)));
  section("Decisions", [
    ...state.decisions.filter((d) => seen.decisions[d.id] !== d.text).map((d) => `- D${d.id}: ${d.text}`),
    ...Object.keys(seen.decisions)
      .filter((id) => !active.has(id))
      .map((id) => {
        const by = getDecision(db, Number(id)).supersededBy;
        return `- D${id} is no longer active${by ? ` (superseded by D${by})` : ""}`;
      }),
  ]);
  const open = new Set(state.questions.map((q) => String(q.id)));
  section("Open questions", [
    ...state.questions.filter((q) => seen.questions[q.id] !== q.text).map((q) => `- Q${q.id}: ${q.text}`),
    ...Object.keys(seen.questions)
      .filter((id) => !open.has(id))
      .map((id) => {
        const answer = getQuestion(db, Number(id)).answer;
        return `- Q${id} is closed${answer ? `, answered: ${answer}` : ""}`;
      }),
  ]);
  section(
    "Proposals",
    state.proposals
      .filter((p) => seen.proposals[p.id] !== p.state)
      .map((p) =>
        seen.proposals[p.id]
          ? `- proposal ${p.id} is now ${p.state}${p.state === "applied" || p.state === "failed" ? ` → ${JSON.stringify(p.result)}` : ""}`
          : describeProposalRow(p),
      ),
  );
  for (const s of state.statuses)
    if (seen.statuses[s.projectId] !== s.text)
      blocks.push(truncateTo(s.text, Math.floor(budget * 0.2), `… (truncated; run \`yagura show ${s.projectId}\` for the rest)`));
  for (const s of state.specs) {
    const whole = renderSpec(s.spec);
    if (seen.specs[s.projectId] !== whole)
      blocks.push(`### spec of ${s.projectId} (changed; whole)\n${truncateTo(whole, Math.floor(budget * 0.3), "… (truncated)")}`);
  }
  if (seen.standing !== state.standing) blocks.push(`### Standing orders (changed)\n${state.standing || "(none)"}`);
  if (seen.catalog !== state.catalog) blocks.push(`### What yagura has (changed)\n${state.catalog}`);
  const messages = listMessages(db, threadId).filter((m) => m.id > seen.lastMessageId && m.id !== message.id && m.role !== "watchman");
  section(
    "Messages since your last turn",
    messages.map((m) => `[${m.role} #${m.id}]\n${m.body}`),
  );

  const text = renderWatchmanUpdate({
    changes: blocks.join("\n\n"),
    mentioned: mentionedIn(ctx, message.body),
    message: { id: message.id, body: message.body },
  });
  return {
    text,
    context: { ...EMPTY_CONTEXT, usedTokens: estimateTokens(text) },
    seen: seenOf(state, message.id),
  };
}

export function renderWatchmanUpdate(u: { changes: string; mentioned: string; message: { id: number; body: string } }): string {
  return `# yagura: the next message in this thread

This session continues. Below is only what changed in yagura's records since your last turn, including what yagura recorded from your last reply (with the ids it gave them); everything else you were shown earlier in this session still holds. METHOD and REPORT are unchanged: reply in plain prose, then end with exactly one fenced \`yagura\` block (\`{}\` is valid).

## CHANGED SINCE YOUR LAST TURN
${u.changes || "(nothing)"}

## MENTIONED IN THE MESSAGE (generated from records)
${u.mentioned || "(nothing)"}

## THE MESSAGE TO ANSWER
[human #${u.message.id}]
${u.message.body}
`;
}

export class RecordsRejected extends Error {}

function refId(ref: string): number {
  return Number(ref.slice(1));
}

export function storeTurn(
  ctx: { db: Db; boot: RunContext["boot"] },
  threadId: number,
  reply: { body: string; records: TurnRecords; turnLog: string | null },
): { message: ThreadMessage; proposal: Proposal | null } {
  const { db, boot } = ctx;
  const { records } = reply;
  const thread = getThread(db, threadId);
  const linked = new Set<string>(thread.projects);
  for (const d of records.decisions) {
    if (!d.supersedes) continue;
    const old = (() => {
      try {
        return getDecision(db, refId(d.supersedes));
      } catch {
        throw new RecordsRejected(`${d.supersedes} does not exist`);
      }
    })();
    if (old.threadId !== threadId) throw new RecordsRejected(`${d.supersedes} belongs to another thread`);
    if (old.supersededBy !== null) throw new RecordsRejected(`${d.supersedes} is already superseded by D${old.supersededBy}`);
  }
  for (const a of records.answered) {
    const q = (() => {
      try {
        return getQuestion(db, refId(a.question));
      } catch {
        throw new RecordsRejected(`${a.question} does not exist`);
      }
    })();
    if (q.threadId !== threadId) throw new RecordsRejected(`${a.question} belongs to another thread`);
    if (q.answer !== null) throw new RecordsRejected(`${a.question} is already answered`);
  }
  for (const s of records.spec)
    if (!linked.has(s.project))
      throw new RecordsRejected(`spec edit for ${s.project}, which is not a project of this thread (put a new project's spec in its proposal)`);
  if (records.proposal) {
    try {
      validateProposal(db, boot, threadId, records.proposal);
    } catch (e) {
      if (e instanceof ProposalInvalid) throw new RecordsRejected(`proposal: ${e.message}`);
      throw e;
    }
  }

  const specs = new Map<string, Spec>();
  for (const s of records.spec) {
    const current = specs.get(s.project) ?? readSpec(db, s.project) ?? { preamble: `# ${s.project}`, sections: [] };
    specs.set(s.project, editSpec(current, s.section, s.body));
  }

  const stored = db.transaction(() => {
    const message = addMessage(db, { threadId, role: "watchman", body: reply.body, turnLog: reply.turnLog });
    if (records.title) db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(records.title, threadId);
    for (const d of records.decisions)
      addDecision(db, { threadId, text: d.text, sourceMessageId: message.id, supersedes: d.supersedes ? refId(d.supersedes) : null });
    for (const q of records.questions) addQuestion(db, { threadId, text: q, sourceMessageId: message.id });
    for (const a of records.answered) resolveQuestion(db, refId(a.question), a.answer, message.id);
    for (const [p, spec] of specs) {
      writeSpec(db, p, spec, "watchman");
      recordEvent(db, "project.spec_changed", { projectId: p as ProjectId }, { thread: threadId, message: message.id });
    }
    const proposal = records.proposal ? addProposal(db, { threadId, messageId: message.id, body: records.proposal }) : null;
    return { message, proposal };
  })();
  return stored;
}

// Denied outright so an allow rule in the developer's own settings cannot hand them to the watchman.
export const WATCHMAN_DENIED_TOOLS = ["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];

export interface TurnResult {
  human: ThreadMessage;
  reply: ThreadMessage | null;
  proposal: Proposal | null;
  applied: ApplyProposalResult | null;
  problem: string | null;
}

export function renderRetry(brief: string, reply: string, reason: string): string {
  return `${brief}
## YOUR PREVIOUS REPLY WAS REJECTED
yagura stored nothing from it. Reason: ${reason}

Your previous reply, for reference:

${reply}

Answer the same message again: the same prose, adjusted if the fix changes what you tell the developer, and a corrected \`yagura\` block.
`;
}

export function renderRetryInSession(reason: string): string {
  return `## YOUR PREVIOUS REPLY WAS REJECTED
yagura stored nothing from it. Reason: ${reason}

Answer the same message again: the same prose, adjusted if the fix changes what you tell the developer, and a corrected \`yagura\` block.
`;
}

const k = (n: number) => `${Math.round(n / 1000)}k`;

export function clearWatchmanSession(db: Db, threadId: number): boolean {
  assertThreadFree(db, threadId);
  if (!endSession(db, threadId, "cleared")) return false;
  addMessage(db, {
    threadId,
    role: "system",
    body: "New session. The next message starts the watchman fresh from yagura's records; nothing recorded was lost.",
  });
  return true;
}

// A human message after the thread's latest turn's own message is waiting for its turn (or was sent while one ran).
export function queuedMessages(db: Db, threadId: number): ThreadMessage[] {
  const last = (db.prepare("SELECT MAX(message_id) AS m FROM watchman_turns WHERE thread_id = ?").get(threadId) as { m: number | null }).m ?? 0;
  return listMessages(db, threadId).filter((m) => m.role === "human" && m.id > last);
}

export function queueMessage(db: Db, threadId: number, text: string): ThreadMessage {
  return addMessage(db, { threadId, role: "human", body: text });
}

// Everything sent while a turn ran is answered by one turn, the watchman reading them in order.
export async function runQueuedTurns(ctx: RunContext, threadId: number): Promise<void> {
  for (;;) {
    const queued = queuedMessages(ctx.db, threadId);
    if (queued.length === 0 || runningTurn(ctx.db, threadId)) return;
    const result = await runWatchmanTurn(ctx, threadId, queued.at(-1)!.body, queued.at(-1)!);
    if (!result.reply) return;
  }
}

export async function runWatchmanTurn(ctx: RunContext, threadId: number, text: string, existing?: ThreadMessage): Promise<TurnResult> {
  const { db, boot } = ctx;
  const paths = layout(boot);
  assertThreadFree(db, threadId);
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k).value;
  const harnessId = setting("role.watchman.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);

  let session = adapter.canResume ? currentSession<Seen>(db, threadId) : null;
  const roll = setting("watchman.session_roll_tokens");
  if (session && session.lastContextPeak > roll) {
    endSession(db, threadId, "rolled");
    addMessage(db, {
      threadId,
      role: "system",
      body: `New session: the last one reached ${k(session.lastContextPeak)} tokens of context (it rolls at ${k(roll)}). The watchman starts fresh from yagura's records; nothing recorded was lost.`,
    });
    session = null;
  }
  const human = existing ?? addMessage(db, { threadId, role: "human", body: text });
  const fresh = () => buildWatchmanBrief(ctx, threadId, human);
  let brief = session?.seen ? buildWatchmanUpdate(ctx, threadId, human, session.seen) : fresh();
  write(paths.turnBrief(threadId, human.id), brief.text);
  const logPath = paths.turnLog(threadId, human.id);
  const turnId = beginTurn(db, threadId, human.id, logPath);
  const cwd = paths.thread(threadId);
  mkdirSync(cwd, { recursive: true });
  // With nothing granted beyond these, dontAsk confines reads to the thread's directory and its linked projects' specs, handoffs, and logs.
  const linked = getThread(db, threadId).projects.map((p) => paths.project(p as ProjectId));
  for (const d of linked) mkdirSync(d, { recursive: true });
  recordEvent(
    db,
    "watchman.turn",
    {},
    {
      thread: threadId,
      message: human.id,
      contextTokens: brief.context.usedTokens,
      dropped: brief.context.dropped,
      resumes: session?.harnessSessionId ?? null,
    },
  );

  const ask = async (prompt: string, log: string, resume?: string): Promise<{ text: string | null; problem: string | null; lost: boolean }> => {
    let started = false;
    const recorder = turnRecorder(db, { id: turnId, threadId, messageId: human.id });
    const result = await runAgentSession(ctx, {
      recorder: {
        ...recorder,
        session: (e) => {
          started = true;
          recorder.session(e);
        },
      },
      adapter,
      run: {
        prompt,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.watchman.model"),
        permissionMode: setting("harness.claude.watchman_permission_mode"),
        pluginDirs: [promptPlugin(db, boot, null)],
        addDirs: linked,
        extraArgs: setting("harness.claude.extra_args"),
        resume,
        allowedTools: setting("watchman.allowed_tools"),
        disallowedTools: WATCHMAN_DENIED_TOOLS,
        settings: watchmanGuardSettings(boot, setting("watchman.allowed_tools")),
      },
      cwd,
      env: {},
      timeboxSeconds: setting("timebox.watchman_seconds"),
      logPath: log,
    });
    const stopped = getTurn(db, turnId).state === "stopped";
    if (result.final && !result.final.isError && !result.timedOut) return { text: result.final.text, problem: null, lost: false };
    return {
      text: null,
      lost: Boolean(resume) && !started && !stopped,
      problem: stopped
        ? "you stopped the watchman"
        : result.timedOut
          ? "the watchman ran out of time"
          : `the watchman ended without a reply (exit ${result.exitCode ?? result.signal})`,
    };
  };
  const attemptStore = async (text: string, log: string): Promise<{ stored: ReturnType<typeof storeTurn> | null; body: string; problem: string | null }> => {
    const parsed = parseReply(text);
    if (!parsed.records) return { stored: null, body: parsed.body, problem: parsed.error };
    try {
      if (parsed.records.proposal) await inspectProposalRepos(parsed.records.proposal);
      return { stored: storeTurn(ctx, threadId, { body: parsed.body, records: parsed.records, turnLog: log }), body: parsed.body, problem: null };
    } catch (e) {
      if (e instanceof ProposalInvalid) return { stored: null, body: parsed.body, problem: `proposal: ${e.message}` };
      if (!(e instanceof RecordsRejected)) throw e;
      return { stored: null, body: parsed.body, problem: e.message };
    }
  };

  const out: TurnResult = { human, reply: null, proposal: null, applied: null, problem: null };
  let first = await ask(brief.text, logPath, session?.harnessSessionId);
  if (first.lost) {
    endSession(db, threadId, "lost");
    addMessage(db, { threadId, role: "system", body: "The watchman's session could not be resumed, so this message starts a new one from yagura's records." });
    brief = fresh();
    write(paths.turnBrief(threadId, human.id), brief.text);
    first = await ask(brief.text, logPath);
  }
  if (!first.text) {
    out.problem = first.problem;
    addMessage(db, { threadId, role: "system", body: first.problem!, turnLog: logPath });
    endTurn(db, turnId, "failed");
    return out;
  }
  const live = adapter.canResume ? getTurn(db, turnId).sessionId : null;
  const harnessSession = live ? currentSession<Seen>(db, threadId)?.harnessSessionId : undefined;
  let log = logPath;
  let result = await attemptStore(first.text, log);
  if (!result.stored) {
    recordEvent(db, "watchman.records_rejected", {}, { thread: threadId, message: human.id, reason: result.problem });
    const retryLog = paths.turnLog(threadId, human.id).replace(/\.jsonl$/, ".retry.jsonl");
    const retry = harnessSession
      ? await ask(renderRetryInSession(result.problem!), retryLog, harnessSession)
      : await ask(renderRetry(brief.text, first.text, result.problem!), retryLog);
    if (retry.text) [result, log] = [await attemptStore(retry.text, retryLog), retryLog];
  }
  if (result.stored) {
    out.reply = result.stored.message;
    out.proposal = result.stored.proposal;
  } else {
    out.problem = result.problem;
    out.reply = addMessage(db, { threadId, role: "watchman", body: result.body, turnLog: log });
    addMessage(db, { threadId, role: "system", body: `yagura rejected this turn's records twice, so nothing was stored or proposed: ${out.problem}` });
  }
  const undelivered = queuedMessages(db, threadId).find((m) => m.id > human.id);
  if (live) markSeen(db, live, { ...brief.seen, lastMessageId: undelivered ? undelivered.id - 1 : out.reply.id });

  if (out.proposal && getThread(db, threadId).autonomy === "go") {
    try {
      out.applied = await applyProposal(ctx, out.proposal.id);
      addMessage(db, { threadId, role: "system", body: `Applied proposal ${out.proposal.id} (autonomy go): ${JSON.stringify(out.applied)}` });
    } catch (e) {
      out.problem = `proposal ${out.proposal.id} could not be applied: ${e instanceof Error ? e.message : String(e)}`;
      addMessage(db, { threadId, role: "system", body: out.problem });
    }
  }
  endTurn(db, turnId, out.reply ? "done" : "failed");
  return out;
}
