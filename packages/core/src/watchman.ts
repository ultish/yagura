import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { runAgentSession, write, type RunContext, type SessionRecorder } from "./agent.js";
import { resolveSetting } from "./config.js";
import { PASS_TIERS, type ProjectId } from "./domain.js";
import { missingSkills } from "./pack.js";
import { layout } from "./paths.js";
import { lastDrainEventId, latestDelta } from "./planner.js";
import { WORK_PLAYBOOKS } from "./plan.js";
import { applyProposal, describeProposal, ProposalBody, ProposalInvalid, validateProposal, type ApplyProposalResult } from "./proposal.js";
import { editSpec, readSpec, relevantSections, renderSpec, writeSpec, type Spec } from "./spec.js";
import { generateStatus } from "./status.js";
import { getProject, recordEvent, type Db } from "./store.js";
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
  if (!parsed.success) return { body, records: null, error: `the yagura block does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
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

const EMPTY_CONTEXT: AssembledContext = { sections: { status: "", spec: "", history: "" }, usedTokens: 0, dropped: { messages: 0, statusTruncated: [], specSections: 0 } };

export interface WatchmanBrief {
  thread: { id: number; title: string; autonomy: string };
  decisions: string;
  questions: string;
  proposals: string;
  catalog: string;
  standing: string;
  context: AssembledContext;
  message: { id: number; body: string };
}

export function renderWatchmanBrief(b: WatchmanBrief): string {
  const { sections, dropped } = b.context;
  return `# yagura watchman brief

You are yagura's watchman: the developer's front door. You turn conversation into projects that yagura's own agents plan, build, verify, and land, and you keep the thread's memory in structured records. You never write code and never touch repos yourself. You have no memory beyond what is below: it is assembled fresh from yagura's database for this one message.

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

## PROJECTS IN THIS THREAD (generated from records)
${sections.status || "(none yet)"}

## SPEC
${sections.spec || "(no spec yet)"}${dropped.specSections ? `\n(${dropped.specSections} relevant section(s) did not fit; name the section to see it next turn)` : ""}

## WHAT YAGURA HAS
${b.catalog}

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
    "repos": [{ "id": "kafka-diff", "description": "one line", "verifyPack": { "provider": "local-process", "checks": [{ "name": "unit", "command": "python3 -m unittest -v", "tier": "unit-verified" }] } }],
    "projects": [{
      "id": "kafka-diff", "goal": "…", "predicate": "checkable done condition", "repos": ["kafka-diff"],
      "environment": null, "merge": "auto", "minTier": "unit-verified", "after": [], "phaseGate": false,
      "spec": "# kafka-diff\\n\\n## Scope\\n…", "units": []
    }],
    "amend": [{ "project": "kafka-diff", "units": [{ "key": "ignore-ts", "repo": "kafka-diff", "goal": "…", "write": ["src/**"], "accept": ["…"], "verify": "…" }] }]
  }
}
\`\`\`
`;
}

function catalog(db: Db): string {
  const repos = db.prepare("SELECT id, url, default_branch FROM repos ORDER BY id").all() as { id: string; url: string; default_branch: string }[];
  const envs = db.prepare("SELECT id, provider, capacity FROM environments ORDER BY id").all() as { id: string; provider: string; capacity: number }[];
  const projects = db.prepare("SELECT id, state FROM projects ORDER BY created_at").all() as { id: string; state: string }[];
  return [
    `- repos: ${repos.map((r) => `${r.id} (${r.url}, ${r.default_branch})`).join("; ") || "(none)"}`,
    `- environments: ${envs.map((e) => `${e.id} (${e.provider}, ${e.capacity} slots)`).join("; ") || `(none; a project with environment null gets a new local-process "local")`}`,
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

export function buildWatchmanBrief(ctx: { db: Db; boot: RunContext["boot"] }, threadId: number, message: ThreadMessage): { text: string; context: AssembledContext } {
  const { db, boot } = ctx;
  const paths = layout(boot);
  const thread = getThread(db, threadId);
  const decisions = listDecisions(db, threadId, { activeOnly: true }).map((d) => `- D${d.id}: ${d.text}`).join("\n");
  const questions = listQuestions(db, threadId, { openOnly: true }).map((q) => `- Q${q.id}: ${q.text}`).join("\n");
  const all = listProposals(db, threadId);
  const proposals = all
    .filter((p, i) => p.state === "pending" || i === all.length - 1)
    .slice(-3)
    .map(describeProposalRow)
    .join("\n\n");
  const standingPath = `${paths.thread(threadId)}/standing-orders.md`;
  const standing = existsSync(standingPath) ? readFileSync(standingPath, "utf8").trim() : "";
  const cat = catalog(db);

  const statuses = thread.projects.map((p) => {
    const project = getProject(db, p);
    const after = project.after.length ? `\n- after: ${project.after.join(", ")}${project.phaseGate ? " (phase gate)" : ""}` : "";
    const summary = latestDelta(db, p)?.summary;
    return { projectId: p, text: `${generateStatus(db, boot, p, lastDrainEventId(db, p)).replace(/^# /, "### ")}${after}${summary ? `\n- planner's last summary: ${summary}` : ""}` };
  });
  const spec = thread.projects.flatMap((p) => {
    const s = readSpec(paths.spec(p));
    if (!s) return [];
    return [{ projectId: p, toc: s.sections.map((x) => x.heading), whole: renderSpec(s), relevant: relevantSections(s, message.body) }];
  });
  const history = listMessages(db, threadId).filter((m) => m.id !== message.id);

  const template = renderWatchmanBrief({ thread, decisions: "", questions: "", proposals: "", catalog: "", standing: "", context: EMPTY_CONTEXT, message: { id: 0, body: "" } });
  const fixed = [template, decisions, questions, proposals, standing, cat, message.body];
  const context = assembleContext({ fixed, statuses, spec, history }, resolveSetting(db, "watchman.context_tokens").value);
  return {
    text: renderWatchmanBrief({ thread, decisions, questions, proposals, catalog: cat, standing, context, message: { id: message.id, body: message.body } }),
    context,
  };
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
  for (const s of records.spec) if (!linked.has(s.project)) throw new RecordsRejected(`spec edit for ${s.project}, which is not a project of this thread (put a new project's spec in its proposal)`);
  if (records.proposal) {
    try {
      validateProposal(db, threadId, records.proposal);
    } catch (e) {
      if (e instanceof ProposalInvalid) throw new RecordsRejected(`proposal: ${e.message}`);
      throw e;
    }
  }

  const specs = new Map<string, Spec>();
  for (const s of records.spec) {
    const path = layout(boot).spec(s.project as ProjectId);
    const current = specs.get(s.project) ?? readSpec(path) ?? { preamble: `# ${s.project}`, sections: [] };
    specs.set(s.project, editSpec(current, s.section, s.body));
  }

  const stored = db.transaction(() => {
    const message = addMessage(db, { threadId, role: "watchman", body: reply.body, turnLog: reply.turnLog });
    if (records.title) db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(records.title, threadId);
    for (const d of records.decisions) addDecision(db, { threadId, text: d.text, sourceMessageId: message.id, supersedes: d.supersedes ? refId(d.supersedes) : null });
    for (const q of records.questions) addQuestion(db, { threadId, text: q, sourceMessageId: message.id });
    for (const a of records.answered) resolveQuestion(db, refId(a.question), a.answer, message.id);
    for (const p of specs.keys()) recordEvent(db, "project.spec_changed", { projectId: p as ProjectId }, { thread: threadId, message: message.id });
    const proposal = records.proposal ? addProposal(db, { threadId, messageId: message.id, body: records.proposal }) : null;
    return { message, proposal };
  })();
  for (const [p, spec] of specs) writeSpec(layout(boot).spec(p as ProjectId), spec);
  return stored;
}

export interface TurnResult {
  human: ThreadMessage;
  reply: ThreadMessage | null;
  proposal: Proposal | null;
  applied: ApplyProposalResult | null;
  problem: string | null;
}

function threadRecorder(db: Db, threadId: number, messageId: number): SessionRecorder {
  return {
    env: { YAGURA_THREAD: String(threadId), YAGURA_ROLE: "watchman" },
    started: (pid) => recordEvent(db, "watchman.started", {}, { thread: threadId, message: messageId, pid }),
    session: () => undefined,
    usage: () => undefined,
    finished: (skills) => {
      const missing = missingSkills("watchman", skills);
      if (missing.length) recordEvent(db, "watchman.method_miss", {}, { thread: threadId, message: messageId, missing, loaded: skills });
      return missing;
    },
  };
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

export async function runWatchmanTurn(ctx: RunContext, threadId: number, text: string): Promise<TurnResult> {
  const { db, boot } = ctx;
  const paths = layout(boot);
  const human = addMessage(db, { threadId, role: "human", body: text });
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k).value;
  const harnessId = setting("role.watchman.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);

  const brief = buildWatchmanBrief(ctx, threadId, human);
  write(paths.turnBrief(threadId, human.id), brief.text);
  const logPath = paths.turnLog(threadId, human.id);
  const cwd = paths.thread(threadId);
  mkdirSync(cwd, { recursive: true });
  recordEvent(db, "watchman.turn", {}, { thread: threadId, message: human.id, contextTokens: brief.context.usedTokens, dropped: brief.context.dropped });

  const ask = async (prompt: string, log: string): Promise<{ text: string | null; problem: string | null }> => {
    const session = await runAgentSession(ctx, {
      recorder: threadRecorder(db, threadId, human.id),
      adapter,
      run: {
        prompt,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.watchman.model"),
        permissionMode: setting("harness.claude.permission_mode"),
        pluginDirs: [boot.skillsDir],
        addDirs: [],
        extraArgs: setting("harness.claude.extra_args"),
      },
      cwd,
      env: {},
      timeboxSeconds: setting("timebox.watchman_seconds"),
      logPath: log,
    });
    if (session.final && !session.final.isError && !session.timedOut) return { text: session.final.text, problem: null };
    return { text: null, problem: session.timedOut ? "the watchman ran out of time" : `the watchman ended without a reply (exit ${session.exitCode ?? session.signal})` };
  };
  const attemptStore = (text: string, log: string): { stored: ReturnType<typeof storeTurn> | null; body: string; problem: string | null } => {
    const parsed = parseReply(text);
    if (!parsed.records) return { stored: null, body: parsed.body, problem: parsed.error };
    try {
      return { stored: storeTurn(ctx, threadId, { body: parsed.body, records: parsed.records, turnLog: log }), body: parsed.body, problem: null };
    } catch (e) {
      if (!(e instanceof RecordsRejected)) throw e;
      return { stored: null, body: parsed.body, problem: e.message };
    }
  };

  const out: TurnResult = { human, reply: null, proposal: null, applied: null, problem: null };
  const first = await ask(brief.text, logPath);
  if (!first.text) {
    out.problem = first.problem;
    addMessage(db, { threadId, role: "system", body: first.problem!, turnLog: logPath });
    return out;
  }
  let log = logPath;
  let result = attemptStore(first.text, log);
  if (!result.stored) {
    recordEvent(db, "watchman.records_rejected", {}, { thread: threadId, message: human.id, reason: result.problem });
    const retryLog = paths.turnLog(threadId, human.id).replace(/\.jsonl$/, ".retry.jsonl");
    const retry = await ask(renderRetry(brief.text, first.text, result.problem!), retryLog);
    if (retry.text) [result, log] = [attemptStore(retry.text, retryLog), retryLog];
  }
  if (result.stored) {
    out.reply = result.stored.message;
    out.proposal = result.stored.proposal;
  } else {
    out.problem = result.problem;
    out.reply = addMessage(db, { threadId, role: "watchman", body: result.body, turnLog: log });
    addMessage(db, { threadId, role: "system", body: `yagura rejected this turn's records twice, so nothing was stored or proposed: ${out.problem}` });
  }

  if (out.proposal && getThread(db, threadId).autonomy === "go") {
    try {
      out.applied = await applyProposal(ctx, out.proposal.id);
      addMessage(db, { threadId, role: "system", body: `Applied proposal ${out.proposal.id} (autonomy go): ${JSON.stringify(out.applied)}` });
    } catch (e) {
      out.problem = `proposal ${out.proposal.id} could not be applied: ${e instanceof Error ? e.message : String(e)}`;
      addMessage(db, { threadId, role: "system", body: out.problem });
    }
  }
  return out;
}
