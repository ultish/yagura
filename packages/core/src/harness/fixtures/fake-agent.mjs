import { execFileSync, execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.FAKE_MODE;
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// Records work the way a real agent does (§27): yagura commands through the CLI on PATH. A session without the CLI (tests of the
// old parsers) gets null and reports in prose. FAKE_FORGET=<role> skips the commands until yagura's reminder resumes the session.
const yg = (...args) => {
  if (!process.env.YAGURA_CLI) return null;
  const r = spawnSync(process.env.YAGURA_CLI, args, { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const pendingFile = () => join(tmpdir(), `fake-records-${process.env.YAGURA_HOME?.replace(/\W/g, "_")}-${process.env.YAGURA_ATTEMPT}.json`);
const canRecord = () => !!process.env.YAGURA_CLI && process.env.FAKE_RECORDS !== "prose";
// yagura handoff with the flags a worker records; h: { did[], evidence[], followUps[], notes[], reason }. A blocked agent is stuck.
const handoffCall = (status, h = {}) => {
  const stuck = status === "blocked" || status === "stuck";
  return [
    "handoff",
    stuck ? "stuck" : "done",
    ...(stuck ? ["--reason", h.reason ?? "the fake agent was told to be blocked"] : []),
    ...(h.did ?? []).flatMap((d) => ["--did", d]),
    ...(h.evidence ?? []).flatMap((d) => ["--evidence", d]),
    ...(h.followUps ?? []).flatMap((d) => ["--follow-up", d]),
    ...(h.notes ?? []).flatMap((d) => ["--note", d]),
  ];
};
// A builder's ending: the handoff recorded through yagura when it can, else the old prose report (tests without the CLI).
function handOff(status, h, prose) {
  if (!canRecord()) return finish(prose);
  record([handoffCall(status, h)]);
  finish(`Handing off ${status}.${h.did?.length ? `\n\n${h.did.map((d) => `- ${d}`).join("\n")}` : ""}\n\n## Status\nblocked`);
}

function record(calls) {
  if (process.env.FAKE_FORGET === process.env.YAGURA_ROLE) return writeFileSync(pendingFile(), JSON.stringify(calls));
  for (const c of calls) {
    const r = yg(...c);
    if (r && r.code !== 0) {
      process.stderr.write(`yagura ${c.slice(0, 2).join(" ")} failed (exit ${r.code}): ${r.out}${r.err ?? ""}\n`);
      process.exit(1);
    }
  }
}
let brief = "";
const resumeAt = process.argv.indexOf("--resume");
// Like claude -p --input-format stream-json: the first line is the prompt, later lines are messages taken in between steps, and the process exits only once stdin closes.
const streaming = process.argv.includes("--input-format");
const textOf = (line) =>
  JSON.parse(line)
    .message.content.map((c) => c.text)
    .join("\n");
const inbox = [];
let waiting = null;
if (streaming) {
  let buf = "";
  let started = false;
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!started) {
        started = true;
        brief = textOf(line);
        main();
      } else if (waiting) waiting(textOf(line));
      else inbox.push(textOf(line));
    }
  });
} else {
  process.stdin.on("data", (d) => (brief += d));
  process.stdin.on("end", main);
}
const nextMessage = (ms) =>
  inbox.length
    ? Promise.resolve(inbox.shift())
    : new Promise((resolve) => {
        const timer = setTimeout(() => ((waiting = null), resolve(null)), ms);
        waiting = (text) => (clearTimeout(timer), (waiting = null), resolve(text));
      });

// FAKE_LIMIT=<seconds>: an attempt's first session is refused by the account's usage limit, the way claude 2.1 reports it, with the
// window resetting that many seconds later; the session yagura resumes after the reset works the original brief.
const limitFile = () => join(tmpdir(), `fake-limit-${process.env.YAGURA_HOME?.replace(/\W/g, "_")}-${process.env.YAGURA_ATTEMPT}`);
function refuse(sessionId) {
  writeFileSync(limitFile(), brief);
  const info = { status: "rejected", resetsAt: Math.ceil(Date.now() / 1000) + Number(process.env.FAKE_LIMIT), rateLimitType: "five_hour" };
  const text = "You've hit your session limit · resets soon";
  emit({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    session_id: sessionId,
    error: "rate_limit",
    is_api_error_message: true,
    api_error: "usage_limit_reached",
    api_error_params: { rate_limit_info: info },
  });
  emit({ type: "result", subtype: "success", is_error: true, result: text, session_id: sessionId, total_cost_usd: 0 });
}

async function main() {
  const continuing = resumeAt > 0 && process.env.FAKE_LIMIT && existsSync(limitFile());
  if (continuing) brief = readFileSync(limitFile(), "utf8");
  else if (resumeAt > 0) return resumed(process.argv[resumeAt + 1]);
  const sessionId = continuing ? process.argv[resumeAt + 1] : process.env.YAGURA_ROLE === "watchman" ? `w-${process.pid}-${Date.now()}` : "s1";
  emit({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", plugins: [{ name: "pstack", version: "0.5.0" }] });
  if (process.env.FAKE_LIMIT && !continuing && !existsSync(limitFile())) return refuse(sessionId);
  const skills =
    {
      worker: ["yagura:yagura-worker", "pstack:poteto-mode", "pstack:principle-prove-it-works", "pstack:principle-test-behavior-not-implementation"],
      planner: ["yagura:yagura-planner"],
      watchman: ["yagura:yagura-watchman"],
      lead: ["yagura:yagura-unit-lead"],
      judge: ["yagura:yagura-judge"],
    }[process.env.YAGURA_ROLE] ?? [];
  skills.push(...(process.env.FAKE_SKILLS ?? "").split(",").filter(Boolean));
  if (mode !== "noskills")
    for (const skill of skills) emit({ type: "assistant", message: { content: [{ type: "tool_use", id: `sk-${skill}`, name: "Skill", input: { skill } }] } });
  if (process.env.YAGURA_ROLE === "watchman") return watchman(sessionId);
  if (mode === "engine") return engine(process.env.YAGURA_ROLE);
  if (mode === "hang") return setTimeout(() => {}, 60_000);
  const file = mode === "scope" || mode === "scope-justified" ? "README.md" : "app/orders.py";
  let steered = null;
  if (mode === "steer") {
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Bash", input: { command: "sleep 1" } }] } });
    steered = await nextMessage(Number(process.env.FAKE_STEER_WAIT_MS ?? 10000));
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "" }] } });
    if (steered) emit({ type: "user", message: { role: "user", content: [{ type: "text", text: steered }] }, isReplay: true });
  }
  if (mode === "success-line") {
    const lines = readFileSync(file, "utf8").split("\n");
    lines[0] = "# edited by fake agent";
    writeFileSync(file, lines.join("\n"));
  } else writeFileSync(file, `# edited by fake agent\n# brief had GOAL: ${brief.includes("## GOAL")}\n${steered ? `# steered: ${steered}\n` : ""}`);
  const g = (...args) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", ...args]);
  g("add", file);
  g("commit", "-q", "-m", "fake agent work");
  writeFileSync("app/notes.txt", "written after commit\n");
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: file } }], usage: { input_tokens: 1200, output_tokens: 30 } },
  });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  if (mode === "nohandoff") return finish("DONE");
  const handoff = `## Status\n${mode === "blocked" ? "blocked" : "success"}\n\n## Branch\n\`b\`\n\n## What I did\n- edited ${file}\n\n## Verification\nunit-verified\n\n## Evidence\n- python3 -m unittest -> ok\n${process.env.FAKE_WORKER_NOTE ? `\n## For other units\n- ${process.env.FAKE_WORKER_NOTE}\n` : ""}${mode === "scope-justified" ? "\n## Outside scope\n- README.md: the new flag needs a line in the docs\n" : ""}`;
  handOff(
    mode === "blocked" ? "blocked" : "success",
    {
      tier: "unit-verified",
      did: [`edited ${file}`],
      evidence: ["python3 -m unittest -> ok"],
      forOthers: process.env.FAKE_WORKER_NOTE ? [process.env.FAKE_WORKER_NOTE] : [],
      outsideScope: mode === "scope-justified" ? [["README.md", "the new flag needs a line in the docs"]] : [],
    },
    handoff,
  );
}

// Mirrors real claude -p --resume (fixtures claude-resume*.jsonl): same session id, no replay, no fresh skill loads.
function resumed(sessionId) {
  if (process.env.FAKE_RESUME === "missing") {
    const error = `No conversation found with session ID: ${sessionId}`;
    emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [error] });
    process.stderr.write(`${error}\n`);
    process.exit(1);
  }
  emit({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", plugins: [{ name: "pstack", version: "0.5.0" }] });
  if (brief.startsWith("# yagura: you have not recorded your work")) {
    const calls = existsSync(pendingFile()) ? JSON.parse(readFileSync(pendingFile(), "utf8")) : [];
    for (const c of calls) yg(...c);
    return finish("Recorded what I had only written down.");
  }
  if (process.env.YAGURA_ROLE === "watchman") return watchman(sessionId);
  const g = (...args) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", ...args], { encoding: "utf8" });
  const merging = /git merge ([0-9a-f]{40})/.exec(brief);
  let file;
  if (merging) {
    spawnSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", "merge", "-q", merging[1]]);
    const conflicted = g("diff", "--name-only", "--diff-filter=U").trim().split("\n").filter(Boolean);
    for (const f of conflicted) writeFileSync(f, "work, merged with the base\n");
    g("add", "-A");
    g("commit", "-q", "--no-edit");
    file = conflicted[0] ?? "nothing";
  } else {
    file =
      g("ls-files", `app/*/${process.env.YAGURA_PROJECT}-${process.env.YAGURA_UNIT}.txt`).trim().split("\n")[0] ||
      g("diff", "--name-only", "HEAD~1", "HEAD").trim().split("\n")[0];
    appendFileSync(file, `# fixed after findings: ${/run:\d+|asked for changes/.test(brief)}\n`);
    g("add", file);
    g("commit", "-q", "-m", "fix after findings");
  }
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }], usage: { input_tokens: 900, output_tokens: 20 } } });
  const prose = `## Status\nsuccess\n\n## Branch\n\`b\`\n\n## What I did\n- fixed ${file}\n\n## Verification\nunit-verified\n`;
  if (canRecord())
    record([
      handoffCall("success", {
        did: [merging ? `merged the base and resolved ${file}` : `fixed ${file}`],
      }),
    ]);
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: canRecord() ? `Fixed ${file}.` : prose,
    terminal_reason: "completed",
    total_cost_usd: 0.01,
  });
}

function finish(text) {
  const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
  if (delay) {
    emit({ type: "assistant", message: { content: [{ type: "text", text: "Working through the brief." }] } });
    return setTimeout(
      () => emit({ type: "result", subtype: "success", is_error: false, result: text, terminal_reason: "completed", total_cost_usd: 0.01 }),
      delay,
    );
  }
  emit({ type: "result", subtype: "success", is_error: false, result: text, terminal_reason: "completed", total_cost_usd: 0.01 });
}

async function engine(role) {
  if (role === "planner") {
    const workRows = [...brief.matchAll(/^\| U\d+ \| work \| (\w+)/gm)].map((m) => m[1]);
    const repo = /^## CODE[^\n]*\n- ([\w-]+):/m.exec(brief)[1];
    const unit = (key, extra = {}) => ({ key, repo, goal: `write ${key}`, acceptance: [`${key} file exists`], playbook: "feature", ...extra });
    const disagreed = [...brief.matchAll(/^- D(\d+) on U\d+/gm)].map((m) => Number(m[1]));
    const delta = disagreed.length
      ? { add: disagreed.map((n) => ({ ...unit(`fix-d${n}`), disagreement: n })), summary: "fix forward" }
      : !workRows.length
        ? process.env.FAKE_UNITS === "0"
          ? { summary: "nothing to plan yet" }
          : process.env.FAKE_UNITS === "2"
            ? { add: [unit("lib"), unit("app", { after: ["lib"] })], summary: "two units" }
            : { add: [unit("a"), unit("b"), unit("c", { after: ["a"] })], summary: "three units" }
        : { done: workRows.every((s) => s === "merged"), summary: workRows.every((s) => s === "merged") ? "all merged" : "waiting" };
    if (canRecord()) {
      record([["plan", "--json", JSON.stringify(delta)]]);
      return finish(`Plan: ${delta.summary}.\n\n\`\`\`json\n{"add": [{"key": "decoy"}]}\n\`\`\``);
    }
    return finish("Plan:\n```json\n" + JSON.stringify(delta) + "\n```");
  }
  // FAKE_LEAD=<action> decides that; otherwise the lead answers by what woke it: a comment is sent to the worker with a reply on the
  // pull request, a judge's question is answered, anything else gets a fresh worker.
  if (role === "lead") {
    const woken = /## WHY YOU WERE WOKEN\n(.*)/.exec(brief)?.[1] ?? "";
    const action = process.env.FAKE_LEAD ?? (/commented/.test(woken) ? "resume" : /judge asks/.test(woken) ? "answer" : "fresh");
    const call = ["decide", action, "--reason", `the fake lead chose ${action}`];
    if (["resume", "fresh", "answer"].includes(action)) call.push("--note", "do what was asked, and say so in a test");
    if (/commented/.test(woken) || action === "reply") call.push("--reply", "Thanks, the worker is on it.");
    if (action === "ask") call.push("--question", "Should it try again?");
    record([call]);
    return finish(`I chose ${action}.`);
  }
  // FAKE_JUDGE_CHANGES=U2,U3: the judge asks those units for changes in their first round and approves after.
  if (role === "judge") {
    const ran = /run:(\d+)/.exec(yg("evidence", "run", "--", "true")?.out ?? "")?.[1];
    const firstRound = /What the last round asked for:\n\(none\)/.test(brief);
    const asks = (process.env.FAKE_JUDGE_CHANGES ?? "").split(",").includes(process.env.YAGURA_UNIT);
    if (process.env.FAKE_JUDGE === "ask") {
      record([["judge", "ask", "--question", "Should the greeting end with a full stop?"]]);
      return finish("I need the developer.");
    }
    if (asks && firstRound) {
      record([["judge", "changes", "--finding", `app:1 ${process.env.YAGURA_UNIT} must say it was fixed`]]);
      return finish("Changes asked.");
    }
    record([["judge", "approve", "--runs", ran]]);
    return finish(`Approved on run:${ran}.`);
  }
  // FAKE_WORKER_STUCK=U2: that unit's first worker hands off stuck; a later one builds as usual.
  if (role === "worker" && (process.env.FAKE_WORKER_STUCK ?? "").split(",").includes(process.env.YAGURA_UNIT) && !brief.includes("A fresh worker takes over")) {
    record([["handoff", "stuck", "--reason", "the spec does not say which rounding to use"]]);
    return finish("Stuck.");
  }
  if (role === "worker") {
    const base = `app/${/## GOAL\nwrite ([\w-]+)/.exec(brief)?.[1] ?? "unit"}`;
    let steered = null;
    if (streaming && process.env.FAKE_STEER_WAIT_MS) {
      emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Bash", input: { command: "sleep 1 # waiting to be steered" } }] } });
      steered = await nextMessage(Number(process.env.FAKE_STEER_WAIT_MS));
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "" }] } });
      if (steered) {
        emit({ type: "user", message: { role: "user", content: [{ type: "text", text: steered }] }, isReplay: true });
        emit({ type: "assistant", message: { content: [{ type: "text", text: `Understood: ${steered}` }] } });
      }
    }
    mkdirSync(base, { recursive: true });
    const pins = Object.entries(process.env).filter(([k]) => k.startsWith("YAGURA_VERSION_"));
    if (pins.length) writeFileSync(`${base}/deps.txt`, pins.map(([k, v]) => `${k.slice("YAGURA_VERSION_".length).toLowerCase()}=${v}\n`).join(""));
    writeFileSync(`${base}/${process.env.YAGURA_PROJECT}-${process.env.YAGURA_UNIT}.txt`, steered ? `work, steered: ${steered}\n` : "work\n");
    const g = (...args) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", ...args]);
    g("add", "-A");
    g("commit", "-q", "-m", `work ${process.env.YAGURA_UNIT}`);
    const ran = canRecord()
      ? /run:(\d+)/.exec(yg("evidence", "run", "--", "test", "-f", `${base}/${process.env.YAGURA_PROJECT}-${process.env.YAGURA_UNIT}.txt`)?.out ?? "")?.[0]
      : null;
    // FAKE_BASE_MOVE=U2: while U2 works, someone else changes the same file on main at the forge (FAKE_ORIGIN).
    if (process.env.FAKE_BASE_MOVE === process.env.YAGURA_UNIT) {
      const other = join(tmpdir(), `fake-other-${process.pid}`);
      execFileSync("git", ["clone", "-q", process.env.FAKE_ORIGIN, other]);
      mkdirSync(join(other, base), { recursive: true });
      writeFileSync(join(other, base, `${process.env.YAGURA_PROJECT}-${process.env.YAGURA_UNIT}.txt`), "theirs\n");
      execFileSync("git", ["-c", "user.name=other", "-c", "user.email=o@x", "-C", other, "add", "-A"]);
      execFileSync("git", ["-c", "user.name=other", "-c", "user.email=o@x", "-C", other, "commit", "-q", "-m", "someone else's change"]);
      execFileSync("git", ["-C", other, "push", "-q", "origin", "HEAD:main"]);
    }
    const followUps = process.env.FAKE_FOLLOWUPS ? `\n## Suggested follow-ups\n- ${process.env.FAKE_FOLLOWUPS}\n` : "\n## Suggested follow-ups\n- None.\n";
    return setTimeout(
      () =>
        handOff(
          "success",
          {
            tier: "unit-verified",
            did: [`wrote ${base}/${process.env.YAGURA_PROJECT}-${process.env.YAGURA_UNIT}.txt`],
            evidence: ran ? [ran] : [],
            followUps: process.env.FAKE_FOLLOWUPS ? [process.env.FAKE_FOLLOWUPS] : [],
            forOthers: process.env.FAKE_WORKER_NOTE ? [process.env.FAKE_WORKER_NOTE] : [],
          },
          `## Status\nsuccess\n\n## Verification\nunit-verified\n${followUps}${process.env.FAKE_WORKER_NOTE ? `\n## For other units\n- ${process.env.FAKE_WORKER_NOTE}\n` : ""}`,
        ),
      400,
    );
  }
}

// A session remembers every prompt it was given, the way a real transcript does; FAKE_SEEN_LOG records each prompt for tests.
function watchman(sessionId) {
  const memory = `.fake-session-${sessionId}`;
  const earlier = existsSync(memory) ? readFileSync(memory, "utf8") : "";
  appendFileSync(memory, `${brief}\n`);
  if (process.env.FAKE_SEEN_LOG) appendFileSync(process.env.FAKE_SEEN_LOG, `${JSON.stringify({ sessionId, resumed: resumeAt > 0, prompt: brief })}\n`);
  const current = brief;
  brief = earlier + brief;
  const asked = [...brief.matchAll(/## THE MESSAGE TO ANSWER\n\[human #\d+\]\n(.*)/g)].at(-1)[1];
  if (asked === "say nothing") return finish("");
  if (asked.startsWith("typo")) {
    const fixed = asked === "typo once" && current.includes("## YOUR PREVIOUS REPLY WAS REJECTED");
    const records = fixed ? { decisions: [{ text: "fixed on retry" }] } : { answered: [{ question: "Q99", answer: "x" }] };
    return finish(`${fixed ? "Corrected." : "First try."}\n\n\`\`\`yagura\n${JSON.stringify(records)}\n\`\`\``);
  }
  // An issue thread (§30): "build" in the comment proposes a unit on FAKE_ISSUE_PROJECT, "never" refuses, anything else asks.
  const issue = /^@\S+(?: \(trusted\))? (?:opened|commented) on issue #(\d+):$/.exec(asked);
  if (issue) {
    const said = current.slice(current.lastIndexOf(asked)).split("\n## ")[0];
    const repo = /- forge issue #\d+ on repo (\S+):/.exec(brief)?.[1];
    if (/build/i.test(said)) {
      const n = issue[1];
      const unit = {
        key: `issue-${n}`,
        repo,
        goal: `write issue-${n}.txt`,
        acceptance: [`issue-${n}.txt exists`],
      };
      const proposal = { summary: `build what issue #${n} asks`, amend: [{ project: process.env.FAKE_ISSUE_PROJECT, units: [unit] }] };
      return finish(`I can build that: one unit writing issue-${n}.txt.\n\n\`\`\`yagura\n${JSON.stringify({ proposal })}\n\`\`\``);
    }
    if (/never/i.test(said)) return finish("No: that is not something this project will do.");
    return finish(`Which file should change?\n\n\`\`\`yagura\n${JSON.stringify({ questions: ["Which file should change?"] })}\n\`\`\``);
  }
  const register = /^register (\S+) (.+)$/.exec(asked);
  if (register) {
    const [, id, existing] = register;
    const proposal = { summary: `work in ${id}`, repos: [{ id, existing }], projects: [{ id: `${id}-work`, goal: "g", predicate: "p", repos: [id] }] };
    return finish(`Registering it.\n\n\`\`\`yagura\n${JSON.stringify({ proposal })}\n\`\`\``);
  }
  // "set up env <id> [from <template>] [preset <p>] NAME=value …"
  const setup = /^set up env (\S+)(.*)$/.exec(asked);
  if (setup) {
    const [, id, rest] = setup;
    const words = rest.trim().split(/\s+/).filter(Boolean);
    const pairs = Object.fromEntries(words.filter((w) => w.includes("=")).map((w) => w.split(/=(.*)/).slice(0, 2)));
    const template = words[words.indexOf("from") + 1];
    const presets = words.flatMap((w, i) => (words[i - 1] === "preset" ? [w] : []));
    const environment = words.includes("from")
      ? { id, template, answers: pairs }
      : {
          id,
          notes: "set up by conversation",
          presets,
          values: Object.entries(pairs).map(([name, value]) => ({ name, value, note: `${name} as the developer gave it`, check: `test -n "$${name}"` })),
        };
    return finish(`Setting up ${id}.\n\n\`\`\`yagura\n${JSON.stringify({ proposal: { summary: `environment ${id}`, environments: [environment] } })}\n\`\`\``);
  }
  const project = (id, after) => ({
    id,
    goal: `build ${id}`,
    predicate: "all files landed",
    repos: ["proto"],
    merge: "auto",
    after,
    spec: `# ${id}\n\n## Scope\nWrite the files.`,
  });
  const records =
    earlier || brief.includes("[watchman #")
      ? {
          decisions: [{ text: "Timestamps are ignored", supersedes: [...current.matchAll(/^- (D\d+):/gm)].at(-1)?.[1] }],
          answered: [...current.matchAll(/^- (Q\d+):/gm)].slice(-1).map((m) => ({ question: m[1], answer: "local" })),
        }
      : {
          title: "proto chain",
          decisions: [{ text: "Build proto in a new repo" }],
          questions: ["Which environment later?"],
          proposal: {
            summary: "two chained projects",
            repos: [{ id: "proto", description: "a prototype" }],
            projects: [project("proto-a", []), project("proto-b", ["proto-a"])],
          },
        };
  finish(`Here is the plan.\n\n\`\`\`yagura\n${JSON.stringify(records)}\n\`\`\``);
}
