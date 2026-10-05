import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadBootstrap } from "./config.js";
import type { AttemptId, RecordKind, Role } from "./domain.js";
import { layout } from "./paths.js";
import { RECORD_SCHEMAS, ROLE_RECORDS, issuesOf, listRecords, missingRecords, putRecord, recordProblem, type RecordData } from "./records.js";
import { getAttempt, getUnit, openStore, recordEvent, type Db } from "./store.js";

// The commands an agent records its work with (§27). Each one is checked when it is called, so a wrong value comes back to the
// agent at once with what to fix; the engine reads the records, never the agent's final message.
export const RECORD_COMMANDS = ["handoff", "verdict", "finding", "rule", "amend", "review-finding", "decide", "plan", "check-done"] as const;
export type RecordCommand = (typeof RECORD_COMMANDS)[number];

const KIND: Record<Exclude<RecordCommand, "check-done">, RecordKind> = {
  handoff: "handoff",
  verdict: "verdict",
  finding: "finding",
  rule: "ruling",
  amend: "amendment",
  "review-finding": "review-finding",
  decide: "decision",
  plan: "plan",
};

export const RECORD_USAGE: Record<RecordCommand, string> = {
  handoff:
    'yagura handoff <success|partial|blocked> [--tier <tier>] --did "…" [--did "…"] [--evidence "…"] [--outside-scope "<path>=<why>"] [--for-others "…"] [--decision "…"] [--note "…"] [--follow-up "…"] [--finding "…"]',
  verdict: 'yagura verdict <tier> --runs <id,…> [--pack-change "…"] [--decision "…"] [--note "…"]',
  finding: 'yagura finding <criterion number> <met|unmet> --runs <id,…> [--note "…"]',
  rule: 'yagura rule T<n> <fix|dismiss|ask> --reason "…"',
  amend:
    'yagura amend T<n> replace --from "<criterion exactly as ACCEPTANCE words it>" --to "…" | add --text "…" | remove --text "…" | verify --command "…" | clear',
  "review-finding": 'yagura review-finding <blocking|should|nit> <path>[:<line>] --text "…"',
  decide: 'yagura decide <action> --reason "…" [--note "…"] [--question "…"] [--to "…"]',
  plan: "yagura plan --file <delta.json>   (or --file - to read it from stdin)",
  "check-done": "yagura check-done   (says what you still have to record)",
};

const OPTIONS = {
  tier: { type: "string" },
  did: { type: "string", multiple: true },
  evidence: { type: "string", multiple: true },
  "outside-scope": { type: "string", multiple: true },
  "for-others": { type: "string", multiple: true },
  decision: { type: "string", multiple: true },
  note: { type: "string", multiple: true },
  "follow-up": { type: "string", multiple: true },
  finding: { type: "string", multiple: true },
  runs: { type: "string" },
  "pack-change": { type: "string", multiple: true },
  reason: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  text: { type: "string" },
  command: { type: "string" },
  question: { type: "string" },
  file: { type: "string" },
  hook: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true; args: string[] }>>["values"];
type Built = { key: string; data: unknown } | { problem: string };

const runList = (s: string | undefined): number[] | string =>
  !s
    ? []
    : s
          .split(/[,\s]+/)
          .filter(Boolean)
          .every((x) => /^(run:)?\d+$/.test(x))
      ? s
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((x) => Number(x.replace(/^run:/, "")))
      : `--runs takes run ids like 12,14, not "${s}"`;
const threadOf = (s: string | undefined): number | null => (s && /^T\d+$/i.test(s) ? Number(s.slice(1)) : null);

function build(db: Db, attemptId: AttemptId, command: Exclude<RecordCommand, "check-done">, pos: string[], v: Values, stdin: () => string): Built {
  const one = (xs: string[] | undefined) => xs?.at(-1) ?? null;
  switch (command) {
    case "handoff": {
      const scope = (v["outside-scope"] ?? []).map((s) => {
        const at = s.indexOf("=");
        return at > 0 ? { path: s.slice(0, at).trim(), reason: s.slice(at + 1).trim() } : { path: s.trim(), reason: "" };
      });
      return {
        key: "",
        data: {
          status: pos[0],
          tier: v.tier ?? null,
          did: v.did ?? [],
          evidence: v.evidence ?? [],
          outsideScope: scope,
          forOthers: v["for-others"] ?? [],
          decisions: v.decision ?? [],
          notes: v.note ?? [],
          followUps: v["follow-up"] ?? [],
          findings: v.finding ?? [],
        },
      };
    }
    case "verdict": {
      const runs = runList(v.runs);
      if (typeof runs === "string") return { problem: runs };
      return { key: "", data: { tier: pos[0], runs, packChanges: v["pack-change"] ?? [], decisions: v.decision ?? [], notes: v.note ?? [] } };
    }
    case "finding": {
      const runs = runList(v.runs);
      if (typeof runs === "string") return { problem: runs };
      const criterion = Number(pos[0]);
      if (!Number.isInteger(criterion) || criterion < 1) return { problem: `the criterion is its number in ACCEPTANCE (1, 2, …), not "${pos[0] ?? ""}"` };
      if (pos[1] !== "met" && pos[1] !== "unmet") return { problem: `say met or unmet, not "${pos[1] ?? ""}"` };
      return { key: String(criterion), data: { criterion, met: pos[1] === "met", runs, note: one(v.note) } };
    }
    case "rule": {
      const thread = threadOf(pos[0]);
      if (!thread) return { problem: `name the thread as T1, T2, …, not "${pos[0] ?? ""}"` };
      return { key: `T${thread}`, data: { thread, decision: pos[1], reason: v.reason } };
    }
    case "amend": {
      const thread = threadOf(pos[0]);
      if (!thread) return { problem: `name the thread as T1, T2, …, not "${pos[0] ?? ""}"` };
      const op =
        pos[1] === "replace"
          ? { kind: "replace", from: v.from, to: v.to }
          : pos[1] === "add" || pos[1] === "remove"
            ? { kind: pos[1], text: v.text }
            : pos[1] === "verify"
              ? { kind: "verify", command: v.command }
              : null;
      if (pos[1] === "clear") return { key: `T${thread}`, data: null };
      if (!op) return { problem: `the change is replace, add, remove, verify, or clear, not "${pos[1] ?? ""}"` };
      const earlier = listRecords(db, attemptId, "amendment").find((r) => r.data.thread === thread)?.data.ops ?? [];
      return { key: `T${thread}`, data: { thread, ops: [...earlier, op] } };
    }
    case "review-finding": {
      const at = /^(.+?)(?::(\d+))?$/.exec(pos[1] ?? "");
      const n = listRecords(db, attemptId, "review-finding").length + 1;
      return { key: `F${n}`, data: { n, severity: pos[0], path: at?.[1], line: at?.[2] ? Number(at[2]) : null, text: v.text } };
    }
    case "decide":
      return { key: "", data: { action: pos[0], reason: v.reason, note: one(v.note), question: v.question ?? null, to: v.to ?? null } };
    case "plan": {
      if (!v.file) return { problem: "give the plan delta as a JSON file: --file <path> (or --file - for stdin)" };
      const raw = v.file === "-" ? stdin() : existsSync(v.file) ? readFileSync(v.file, "utf8") : null;
      if (raw === null) return { problem: `no file at ${v.file}` };
      try {
        return { key: "", data: JSON.parse(raw) };
      } catch (e) {
        return { problem: `the file is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
}

export interface RecordCliResult {
  code: number;
  output: string;
}

export async function recordCli(argv: string[], env: NodeJS.ProcessEnv = process.env, stdin = () => readFileSync(0, "utf8")): Promise<RecordCliResult> {
  const [command, ...rest] = argv as [RecordCommand, ...string[]];
  if (!env.YAGURA_ATTEMPT) return { code: 2, output: `yagura ${command} only works inside a yagura session (YAGURA_ATTEMPT is not set)\n` };
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    return { code: 2, output: `${e instanceof Error ? e.message : String(e)}\nusage: ${RECORD_USAGE[command]}\n` };
  }
  const boot = loadBootstrap(env);
  const db = openStore(layout(boot).db);
  try {
    const attemptId = Number(env.YAGURA_ATTEMPT) as AttemptId;
    const row = db.prepare("SELECT evidence_token FROM attempts WHERE id = ?").get(attemptId) as { evidence_token: string | null } | undefined;
    const given = Buffer.from(env.YAGURA_EVIDENCE_TOKEN ?? "");
    const expected = Buffer.from(row?.evidence_token ?? "");
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected))
      return { code: 2, output: `yagura ${command} refused: YAGURA_EVIDENCE_TOKEN does not match this attempt's session\n` };
    const role = (env.YAGURA_ROLE ?? "") as Role;
    if (command === "check-done") return checkDone(db, attemptId, role, parsed.values.hook ? stdin : null);

    const kind = KIND[command];
    const unit = getUnit(db, getAttempt(db, attemptId).unitId);
    const refs = { projectId: unit.projectId, unitId: unit.id, attemptId };
    const refuse = (problem: string): RecordCliResult => {
      recordEvent(db, "command.rejected", refs, { command, problem, args: rest.slice(0, 20) });
      return { code: 1, output: `yagura ${command} was not recorded: ${problem}\nusage: ${RECORD_USAGE[command]}\n` };
    };
    if (!(ROLE_RECORDS[role] ?? []).includes(kind)) return refuse(`the ${role || "unknown"} role does not record ${kind}s`);
    const built = build(db, attemptId, command as Exclude<RecordCommand, "check-done">, parsed.positionals, parsed.values, stdin);
    if ("problem" in built) return refuse(built.problem);
    if (built.data === null) {
      db.prepare("DELETE FROM agent_records WHERE attempt_id = ? AND kind = ? AND key = ?").run(attemptId, kind, built.key);
      return { code: 0, output: `cleared ${kind} ${built.key}\n${remaining(db, attemptId, role)}` };
    }
    const checked = RECORD_SCHEMAS[kind].safeParse(built.data);
    if (!checked.success) return refuse(issuesOf(checked.error));
    const problem = recordProblem(db, attemptId, kind, checked.data as RecordData<typeof kind>);
    if (problem) return refuse(problem);
    putRecord(db, attemptId, kind, built.key, checked.data as RecordData<typeof kind>);
    recordEvent(db, "record.saved", refs, { kind, key: built.key });
    return { code: 0, output: `recorded ${kind}${built.key ? ` ${built.key}` : ""}\n${remaining(db, attemptId, role)}` };
  } finally {
    db.close();
  }
}

const remaining = (db: Db, attemptId: AttemptId, role: Role) => {
  const missing = missingRecords(db, attemptId, role);
  return missing.length ? `still to record:\n${missing.map((m) => `- ${m}`).join("\n")}\n` : "nothing left to record\n";
};

export const MAX_HOOK_BLOCKS = 2;

// As a Claude Code Stop hook: block the stop while something is missing, at most MAX_HOOK_BLOCKS times per attempt, so it cannot loop.
// The daemon runs the same check after the session; this only lets the agent fix it while it still has its context.
function checkDone(db: Db, attemptId: AttemptId, role: Role, hookInput: (() => string) | null): RecordCliResult {
  const missing = missingRecords(db, attemptId, role);
  if (!hookInput) return { code: missing.length ? 1 : 0, output: remaining(db, attemptId, role) };
  try {
    hookInput();
  } catch {
    // The hook's own input is not needed; the count of earlier blocks lives in the store.
  }
  if (!missing.length) return { code: 0, output: "" };
  const unit = getUnit(db, getAttempt(db, attemptId).unitId);
  const refs = { projectId: unit.projectId, unitId: unit.id, attemptId };
  const blocked = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hook.blocked' AND attempt_id = ?").get(attemptId) as { n: number }).n;
  if (blocked >= MAX_HOOK_BLOCKS) return { code: 0, output: "" };
  recordEvent(db, "hook.blocked", refs, { missing });
  const reason = `yagura has not got what your role must record, so you cannot finish yet:\n${missing.map((m) => `- ${m}`).join("\n")}\nRecord it with those commands, then end with your report again.`;
  return { code: 0, output: JSON.stringify({ decision: "block", reason }) };
}
