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
  return { code: r.status, out: r.stdout };
};
const pendingFile = () => join(tmpdir(), `fake-records-${process.env.YAGURA_HOME?.replace(/\W/g, "_")}-${process.env.YAGURA_ATTEMPT}.json`);
const canRecord = () => !!process.env.YAGURA_CLI && process.env.FAKE_RECORDS !== "prose";
function record(calls) {
  if (process.env.FAKE_FORGET === process.env.YAGURA_ROLE) return writeFileSync(pendingFile(), JSON.stringify(calls));
  for (const c of calls) {
    const r = yg(...c);
    if (r && r.code !== 0) throw new Error(`yagura ${c.join(" ")} failed: ${r.out}`);
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

async function main() {
  if (resumeAt > 0) return resumed(process.argv[resumeAt + 1]);
  const sessionId = process.env.YAGURA_ROLE === "watchman" ? `w-${process.pid}-${Date.now()}` : "s1";
  emit({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", plugins: [{ name: "pstack", version: "0.5.0" }] });
  const skills =
    {
      worker: ["yagura:yagura-worker", "pstack:poteto-mode", "pstack:principle-prove-it-works", "pstack:principle-test-behavior-not-implementation"],
      pack: ["yagura:yagura-pack"],
      rebase: ["yagura:yagura-rebase"],
      "review-triage": ["yagura:yagura-review-triage"],
      reviewer: ["yagura:yagura-reviewer"],
      planner: ["yagura:yagura-planner"],
      verifier: ["yagura:yagura-verifier"],
      watchman: ["yagura:yagura-watchman"],
      manager: ["yagura:yagura-manager"],
    }[process.env.YAGURA_ROLE] ?? [];
  skills.push(...(process.env.FAKE_SKILLS ?? "").split(",").filter(Boolean));
  if (mode !== "noskills")
    for (const skill of skills) emit({ type: "assistant", message: { content: [{ type: "tool_use", id: `sk-${skill}`, name: "Skill", input: { skill } }] } });
  if (process.env.YAGURA_ROLE === "watchman") return watchman(sessionId);
  if (process.env.YAGURA_ROLE === "manager") return manager();
  if (brief.startsWith("# yagura investigation brief"))
    return finish(
      process.env.FAKE_INVESTIGATE === "garbage"
        ? "## Status\nsuccess\n\nNothing to report.\n"
        : "## Status\nsuccess\n\n## Findings\n- the failing test depends on the clock: it passes before noon\n\n## Notes, concerns, deviations\n- none\n",
    );
  if (process.env.YAGURA_ROLE === "rebase") return rebase();
  if (/Apply the arbiter's rulings/.test(brief)) return fixer();
  if (process.env.YAGURA_ROLE === "review-triage") return triage();
  if (process.env.YAGURA_ROLE === "reviewer") return reviewer();
  if (mode === "engine") return engine(process.env.YAGURA_ROLE);
  if (mode === "hang") return setTimeout(() => {}, 60_000);
  if ((mode ?? "").startsWith("verify")) return verify(mode);
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
  const handoff =
    mode === "nohandoff"
      ? "DONE"
      : `## Status\n${mode === "blocked" ? "blocked" : "success"}\n\n## Branch\n\`b\`\n\n## What I did\n- edited ${file}\n\n## Verification\nunit-verified\n\n## Evidence\n- python3 -m unittest -> ok\n${process.env.FAKE_WORKER_NOTE ? `\n## For other units\n- ${process.env.FAKE_WORKER_NOTE}\n` : ""}${mode === "scope-justified" ? "\n## Outside scope\n- README.md: the new flag needs a line in the docs\n" : ""}`;
  finish(handoff);
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
  if (process.env.YAGURA_ROLE === "manager") return manager();
  // A resumed fixer (asked to explain a path outside scope) answers again with what it handed off, plus the reason.
  const savedFix = join(tmpdir(), `fake-triage-${process.cwd().replace(/\W/g, "_")}`);
  if (existsSync(savedFix)) {
    const before = readFileSync(savedFix, "utf8");
    return finish(`${before}\n## Outside scope\n- outside/extra.txt: the fix needs a test that proves it\n`);
  }
  const file = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { encoding: "utf8" }).trim().split("\n")[0];
  appendFileSync(file, `# fixed after findings: ${/run:\d+/.test(brief)}\n`);
  const g = (...args) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", ...args]);
  g("add", file);
  g("commit", "-q", "-m", "fix after findings");
  emit({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }], usage: { input_tokens: 900, output_tokens: 20 } } });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `## Status\nsuccess\n\n## Branch\n\`b\`\n\n## What I did\n- fixed ${file}\n\n## Verification\nunit-verified\n${process.env.FAKE_RESUME_JUSTIFY ? `\n## Outside scope\n- ${file}: the docs needed the new flag\n` : ""}`,
    terminal_reason: "completed",
    total_cost_usd: 0.01,
  });
}

// FAKE_MANAGER: the action to decide (default fresh); FAKE_MANAGER=garbage answers without a usable decision.
function manager() {
  const action = process.env.FAKE_MANAGER ?? "fresh";
  if (action === "garbage") return finish("## Status\nsuccess\n\nI am not sure what to do.\n");
  const repo = /^- U\d+ \(([\w-]+)\):/m.exec(brief)?.[1] ?? "repo";
  const lines = [`action: ${action}`, `reason: the fake manager chose ${action}`];
  if (action === "relay") {
    const to = [...brief.slice(brief.indexOf("## OTHER UNITS")).matchAll(/^- (U\d+) \(\w+\):/gm)]
      .map((m) => m[1])
      .slice(0, Number(process.env.FAKE_RELAY_TO ?? 1));
    lines.push(`to: ${to.join(", ")}`, "note: the shared helper moved");
  }
  if (action === "fresh" || action === "resume") lines.push("note: write it with care");
  if (action === "ask") lines.push("question: Should it try again?");
  if (action === "investigate") lines.push("question: Why does the scenario fail on head?");
  const delta =
    action === "split"
      ? "\n```json\n" +
        JSON.stringify({
          add: ["a", "b"].map((k) => ({
            key: `split-${k}`,
            repo,
            goal: `half ${k}`,
            write: [`app/split-${k}/**`],
            accept: [`half ${k} exists`],
            verify: "true",
            playbook: "feature",
          })),
          summary: "split in two",
        }) +
        "\n```\n"
      : "";
  if (canRecord()) {
    const field = (k) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
    const decide = ["decide", action, "--reason", field("reason")];
    for (const k of ["note", "question", "to"]) if (field(k)) decide.push(`--${k}`, field(k));
    const plan = action === "split" ? [["plan", "--json", delta.replace(/```json|```/g, "").trim()]] : [];
    record([...plan, decide]);
    return finish(`I chose ${action}.\n\n## Decision\naction: stop\n`);
  }
  finish(`## Status\nsuccess\n\n## Decision\n${lines.join("\n")}\n${delta}`);
}

// Fixes threads that say "please fix" (or that the developer said to fix), and dismisses the rest.
// The arbiter only rules: each thread is fix, dismissed, or (with FAKE_TRIAGE_AMEND) asked. It changes nothing.
function triage() {
  const threads = [...brief.matchAll(/^- T(\d+) · [\s\S]*?(?=^- T\d+ · |^- Decisions from|^## )/gm)].map((m) => ({ n: m[1], text: m[0] }));
  const file = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { encoding: "utf8" }).trim().split("\n")[0];
  // FAKE_TRIAGE_AMEND: a thread the developer has not decided yet is asked, with an amendment that would change the unit's first acceptance criterion.
  const amend = process.env.FAKE_TRIAGE_AMEND;
  const accept = /## ACCEPTANCE\n- (.+)/.exec(brief)?.[1];
  const lines = threads.map((t) => {
    if (amend && /The developer trusts/.test(brief)) return `- T${t.n}: fix — make the greeting celebrate`;
    if (amend && !/The developer decided: (fix|dismiss)/.test(t.text)) return `- T${t.n}: asked — should this change what the unit must do?`;
    const fix = /please fix|The developer decided: fix/.test(t.text) && !/The developer decided: dismiss/.test(t.text);
    return fix ? `- T${t.n}: fix — added the review fix to ${file}` : `- T${t.n}: dismissed — the existing test covers this case`;
  });
  const amendments = amend
    ? lines
        .filter((l) => l.includes("asked") || l.includes("make the greeting celebrate"))
        .map((l) => `- ${/^- (T\d+)/.exec(l)[1]}: replace: ${accept} => celebration emojis are part of the output`)
    : [];
  const sections = `## Decisions\n${lines.join("\n")}\n${amendments.length ? `\n## Amendments\n${amendments.join("\n")}\n` : ""}`;
  if (canRecord() && !process.env.FAKE_TRIAGE_SECTIONS_FIRST) {
    const word = { fix: "fix", asked: "ask", dismissed: "dismiss" };
    record([
      ...lines.map((l) => {
        const [, n, decision, reason] = /^- T(\d+): (fix|asked|dismissed) — (.+)$/.exec(l);
        return ["rule", `T${n}`, word[decision], "--reason", reason];
      }),
      ...amendments.map((a) => ["amend", /^- (T\d+)/.exec(a)[1], "replace", "--from", accept, "--to", "celebration emojis are part of the output"]),
    ]);
    // The report is for the developer and may say anything, headings included; yagura reads only the records.
    return finish(`I ruled on ${lines.length} thread(s).\n\n## Status\nblocked\n\n${sections}`);
  }
  const status = "## Status\nsuccess\n\n## Verification\nunit-verified\n\n";
  // FAKE_TRIAGE_SECTIONS_FIRST: a real model sometimes writes the rulings ahead of the handoff, in prose only.
  finish(process.env.FAKE_TRIAGE_SECTIONS_FIRST ? `${sections}\n${status}` : `${status}${sections}`);
}

// The worker the arbiter's rulings go to: it changes the code for each thread the arbiter ruled a fix, and commits.
function fixer() {
  const threads = [...brief.matchAll(/^- T(\d+) · /gm)].map((m) => m[1]);
  const file = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { encoding: "utf8" }).trim().split("\n")[0];
  for (const n of threads) appendFileSync(file, `# review fix T${n}\n`);
  if (process.env.FAKE_TRIAGE_OUTSIDE) {
    mkdirSync("outside", { recursive: true });
    writeFileSync("outside/extra.txt", "a test the fix needs\n");
    execFileSync("git", ["add", "outside/extra.txt"]);
  }
  execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", "commit", "-qam", "review fixes"]);
  const handoff = `## Status\nsuccess\n\n## Branch\n\`b\`\n\n## What I did\n- fixed ${file} for ${threads.map((n) => `T${n}`).join(", ")}\n\n## Verification\nunit-verified\n`;
  writeFileSync(join(tmpdir(), `fake-triage-${process.cwd().replace(/\W/g, "_")}`), handoff);
  finish(handoff);
}

// FAKE_REVIEW: unset or "none" → no findings; "<severity>[:text]" → one finding on the first changed file; "write" → edits the worktree.
// A re-review (the brief says "fixes only") finds nothing, so a fixed change settles.
function reviewer() {
  const [, base, head] = /git diff ([0-9a-f]{40})\.\.([0-9a-f]{40})/.exec(brief);
  const file = execFileSync("git", ["diff", "--name-only", `${base}..${head}`], { encoding: "utf8" })
    .trim()
    .split("\n")[0];
  const want = brief.includes("only the fixes made after the last review") ? "none" : (process.env.FAKE_REVIEW ?? "none");
  if (want === "write") writeFileSync(file, "reviewer was here\n");
  const [severity, ...rest] = want.split(":");
  const text = rest.join(":") || "please fix: this branch has no test for the empty case";
  const findings = want === "none" || want === "write" ? "- none" : `- F1 [${severity}] ${file}:1 — ${text}`;
  finish(`## Status\nsuccess\n\n## Findings\n${findings}\n\n## Notes, concerns, deviations\n- none\n`);
}

// Replays the branch onto the named trunk commit, keeping the branch's side of each conflict.
function rebase() {
  const onto = /git rebase ([0-9a-f]{40})/.exec(brief)[1];
  if (process.env.FAKE_REBASE === "fail")
    return finish("## Status\nblocked\n\n## Verification\nnot-verified\n\n## Notes, concerns, deviations\n- could not resolve\n");
  execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", "rebase", "-X", "theirs", onto]);
  finish("## Status\nsuccess\n\n## Verification\nunit-verified\n\n## What I did\n- rebased and kept both changes\n");
}

function verify(mode) {
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "yagura:yagura-verifier" } }] } });
  const script = `${process.cwd()}/scenario.sh`;
  const body =
    mode === "verify-weak" ? "true" : mode === "verify-fail" ? "grep -q 'never there' app/orders.py" : "grep -q 'edited by fake agent' app/orders.py";
  writeFileSync(script, `${body}\n`);
  const run = (at) => {
    const out = execSync(`yagura evidence run --at ${at} --label scenario -- sh ${script}`, { encoding: "utf8" });
    return Number(/run:(\d+)/.exec(out)[1]);
  };
  if (mode === "verify-tamper") appendFileSync(`${process.env.YAGURA_HEAD}/app/orders.py`, "# edited by fake agent\n");
  // Fixes a broken doctor and adds a check, the way a verifier repairs the pack it was handed.
  let packChanges = "none";
  if (mode === "verify-fix-pack" || mode === "verify-bad-pack") {
    const file = `${process.env.YAGURA_PACK}/verify.json`;
    const pack = JSON.parse(readFileSync(file, "utf8"));
    if (pack.doctor) pack.doctor = "true";
    pack.checks.push({ name: "orders-edited", command: "grep -q 'edited by fake agent' app/orders.py", tier: "unit-verified" });
    writeFileSync(file, mode === "verify-bad-pack" ? "{ not json" : JSON.stringify(pack));
    writeFileSync(`${process.env.YAGURA_PACK}/../../stray.txt`, "outside the pack\n");
    packChanges = "- doctor: the old one probed a service this repo does not use\n- added orders-edited, which runs what this change built";
  }
  const base = run("base");
  const head = run("head");
  const tier = mode === "verify-fail" ? "verifier-failed" : "unit-verified";
  const cite = mode === "verify-lie" ? "run:999" : `run:${head}`;
  // A lie cannot be recorded (yagura verdict refuses a run it did not record), so verify-lie reports in prose to exercise the fallback.
  if (canRecord() && mode !== "verify-lie") {
    record([
      ["finding", "1", mode === "verify-fail" ? "unmet" : "met", "--runs", `${head},${base}`],
      [
        "verdict",
        tier,
        "--runs",
        `${head},${base}`,
        ...packChanges
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .flatMap((l) => ["--pack-change", l.slice(2)]),
        "--decision",
        "tested the edited file directly",
      ],
    ]);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Verified ${tier} with run:${head} and run:${base}.\n\n## Verification\nverifier-failed`,
      terminal_reason: "completed",
      total_cost_usd: 0.01,
    });
    return;
  }
  const handoff = `## Status\nsuccess\n\n## Verification\n${tier}\n\n## Evidence\n- ${cite} scenario on head\n- run:${base} scenario on base\n\n## Findings\n- [x] criterion: ${cite}\n\n## Pack changes\n${packChanges}\n\n## Decisions\n- tested the edited file directly\n`;
  emit({ type: "result", subtype: "success", is_error: false, result: handoff, terminal_reason: "completed", total_cost_usd: 0.01 });
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
    const unit = (key, write) => ({ key, repo, goal: `write ${key}`, write: [write], accept: [`${key} file exists`], verify: "true", playbook: "feature" });
    const disagreed = [...brief.matchAll(/^- D(\d+) on U\d+/gm)].map((m) => Number(m[1]));
    if (disagreed.length)
      return finish(
        "Plan:\n```json\n" +
          JSON.stringify({ add: disagreed.map((n) => ({ ...unit(`fix-d${n}`, `app/fix${n}/**`), disagreement: n })), summary: "fix forward" }) +
          "\n```",
      );
    const delta = !workRows.length
      ? { add: [unit("a", "app/a/**"), unit("b", "app/b/**"), unit("c", "app/a/extra/**")], summary: "three units" }
      : { done: workRows.every((s) => s === "landed"), summary: workRows.every((s) => s === "landed") ? "all landed" : "waiting" };
    return finish("Plan:\n```json\n" + JSON.stringify(delta) + "\n```");
  }
  if (role === "pack") {
    mkdirSync(".agents/verify", { recursive: true });
    const pack = {
      provider: "local-process",
      doctor: "test -d .",
      deploy: 'echo up > "$YAGURA_LEASE_DIR/up"',
      teardown: 'rm "$YAGURA_LEASE_DIR/up"',
      checks: [{ name: "unit", command: process.env.FAKE_PACK_CHECK ?? 'test -f "$YAGURA_LEASE_DIR/up" && test -f README.md', tier: "unit-verified" }],
    };
    writeFileSync(".agents/verify/verify.json", `${JSON.stringify(pack, null, 2)}\n`);
    execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", "add", "-A"]);
    execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", "commit", "-q", "-m", "verify pack"]);
    return finish("## Status\nsuccess\n\n## Verification\nunit-verified\n\n## What I did\n- wrote .agents/verify/verify.json\n");
  }
  if (role === "worker") {
    const base = /Expected to write:\n- ([^*\n]+?)\/?\*\*/.exec(brief)[1];
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
    const followUps = process.env.FAKE_FOLLOWUPS ? `\n## Suggested follow-ups\n- ${process.env.FAKE_FOLLOWUPS}\n` : "\n## Suggested follow-ups\n- None.\n";
    return setTimeout(
      () =>
        finish(
          `## Status\nsuccess\n\n## Verification\nunit-verified\n${followUps}${process.env.FAKE_WORKER_NOTE ? `\n## For other units\n- ${process.env.FAKE_WORKER_NOTE}\n` : ""}`,
        ),
      400,
    );
  }
  if (role === "verifier") {
    const file = /^\+\+\+ b\/(.+)$/m.exec(brief)[1];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><rect width="360" height="120" fill="#1c2134"/><text x="20" y="66" fill="#ece6da" font-family="monospace" font-size="18">${file}</text></svg>`;
    writeFileSync(
      "scenario.sh",
      [
        'mkdir -p "$YAGURA_EVIDENCE/notes"',
        `echo "looked for ${file} at $YAGURA_AT" > "$YAGURA_EVIDENCE/notes/check.txt"`,
        `printf '%s' '${svg}' > "$YAGURA_EVIDENCE/screen.svg"`,
        `node -e 'require("fs").writeFileSync(process.env.YAGURA_EVIDENCE + "/pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))'`,
        `echo "checking ${file}"`,
        process.env.FAKE_VERIFY_NEEDS_FIX ? `grep -q 'fixed after findings' ${file}` : `test -f ${file}`,
        "",
      ].join("\n"),
    );
    let packChanges = "none";
    if (/^- doctor on trunk: run:\d+ exit [1-9]/m.test(brief)) {
      const file = `${process.env.YAGURA_PACK}/verify.json`;
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), doctor: "true" }));
      packChanges = "- doctor: it probed a service this repo does not use";
    }
    const exits = {};
    const run = (at) => {
      const out = execSync(`yagura evidence run --at ${at} --label s -- sh ${process.cwd()}/scenario.sh`, { encoding: "utf8" });
      const [, id, exit] = /run:(\d+) .*: (?:exit (\d+)|timed out)/.exec(out);
      exits[at] = exit === "0";
      return Number(id);
    };
    const changes = packChanges
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .flatMap((l) => ["--pack-change", l.slice(2)]);
    if (process.env.FAKE_VERIFY_BLOCKED) {
      if (canRecord()) {
        record([["verdict", "verifier-blocked", "--note", process.env.FAKE_VERIFY_BLOCKED]]);
        return finish(`I could not verify it: ${process.env.FAKE_VERIFY_BLOCKED}`);
      }
      return finish(`## Status\nblocked\n\n## Verification\nverifier-blocked\n\n## Notes, concerns, deviations\n- ${process.env.FAKE_VERIFY_BLOCKED}\n`);
    }
    const base = run("base");
    const head = run("head");
    if (!exits.head) {
      if (canRecord()) {
        record([["verdict", "verifier-failed", "--runs", `${head},${base}`, ...changes]]);
        return finish(`It fails on head: run:${head}.`);
      }
      return finish(`## Status\nsuccess\n\n## Verification\nverifier-failed\n\n## Evidence\n- run:${head} fails on head\n- run:${base}\n`);
    }
    const order = ["deployed-verified", "live-local-verified", "e2e-verified", "unit-verified", "build-only"];
    const listed = [...brief.matchAll(/^- [\w-]+ \(([\w-]+)\): base/gm)].map((m) => m[1]);
    const tier = order.find((t) => listed.includes(t)) ?? "unit-verified";
    if (canRecord()) {
      record([
        ["finding", "1", "met", "--runs", `${head},${base}`],
        ["verdict", tier, "--runs", `${head},${base}`, ...changes],
      ]);
      return finish(`Verified at ${tier}: run:${head} passes on head, run:${base} fails on trunk.`);
    }
    return finish(`## Status\nsuccess\n\n## Verification\n${tier}\n\n## Evidence\n- run:${head}\n- run:${base}\n\n## Pack changes\n${packChanges}\n`);
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
  if (asked.startsWith("typo")) {
    const fixed = asked === "typo once" && current.includes("## YOUR PREVIOUS REPLY WAS REJECTED");
    const records = fixed ? { decisions: [{ text: "fixed on retry" }] } : { answered: [{ question: "Q99", answer: "x" }] };
    return finish(`${fixed ? "Corrected." : "First try."}\n\n\`\`\`yagura\n${JSON.stringify(records)}\n\`\`\``);
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
  const pack = { provider: "local-process", checks: [{ name: "unit", command: "test -f README.md", tier: "unit-verified" }] };
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
            repos: [{ id: "proto", description: "a prototype", verifyPack: pack }],
            projects: [project("proto-a", []), project("proto-b", ["proto-a"])],
          },
        };
  finish(`Here is the plan.\n\n\`\`\`yagura\n${JSON.stringify(records)}\n\`\`\``);
}
