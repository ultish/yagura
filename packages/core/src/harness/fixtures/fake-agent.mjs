import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.FAKE_MODE;
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
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
      worker: ["yagura:yagura-worker", "pstack:poteto-mode"],
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
  if (process.env.YAGURA_ROLE === "rebase") return rebase();
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
      : `## Status\n${mode === "blocked" ? "blocked" : "success"}\n\n## Branch\n\`b\`\n\n## What I did\n- edited ${file}\n\n## Verification\nunit-verified\n\n## Evidence\n- python3 -m unittest -> ok\n${process.env.FAKE_WORKER_NOTE ? `\n## Notes, concerns, deviations\n- ${process.env.FAKE_WORKER_NOTE}\n` : ""}${mode === "scope-justified" ? "\n## Outside scope\n- README.md: the new flag needs a line in the docs\n" : ""}`;
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
  if (process.env.YAGURA_ROLE === "watchman") return watchman(sessionId);
  if (process.env.YAGURA_ROLE === "manager") return manager();
  if (process.env.YAGURA_ROLE === "review-triage") {
    const before = readFileSync(join(tmpdir(), `fake-triage-${process.cwd().replace(/\W/g, "_")}`), "utf8");
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
  finish(`## Status\nsuccess\n\n## Decision\n${lines.join("\n")}\n${delta}`);
}

// Fixes threads that say "please fix" (or that the developer said to fix), and dismisses the rest.
function triage() {
  const threads = [...brief.matchAll(/^- T(\d+) · [\s\S]*?(?=^- T\d+ · |^- Decisions from|^## )/gm)].map((m) => ({ n: m[1], text: m[0] }));
  const file = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { encoding: "utf8" }).trim().split("\n")[0];
  const lines = threads.map((t) => {
    const fix = /please fix|The developer decided: fix/.test(t.text) && !/The developer decided: dismiss/.test(t.text);
    if (fix) appendFileSync(file, `# review fix T${t.n}\n`);
    return fix ? `- T${t.n}: fixed — added the review fix to ${file}` : `- T${t.n}: dismissed — the existing test covers this case`;
  });
  if (lines.some((l) => l.includes("fixed"))) {
    if (process.env.FAKE_TRIAGE_OUTSIDE) {
      mkdirSync("outside", { recursive: true });
      writeFileSync("outside/extra.txt", "a test the fix needs\n");
      execFileSync("git", ["add", "outside/extra.txt"]);
    }
    execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", "commit", "-qam", "review fixes"]);
  }
  const handoff = `## Status\nsuccess\n\n## Verification\nunit-verified\n\n## Decisions\n${lines.join("\n")}\n`;
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
          `## Status\nsuccess\n\n## Verification\nunit-verified\n${followUps}${process.env.FAKE_WORKER_NOTE ? `\n## Notes, concerns, deviations\n- ${process.env.FAKE_WORKER_NOTE}\n` : ""}`,
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
    if (process.env.FAKE_VERIFY_BLOCKED)
      return finish(`## Status\nblocked\n\n## Verification\nverifier-blocked\n\n## Notes, concerns, deviations\n- ${process.env.FAKE_VERIFY_BLOCKED}\n`);
    const base = run("base");
    const head = run("head");
    if (!exits.head) return finish(`## Status\nsuccess\n\n## Verification\nverifier-failed\n\n## Evidence\n- run:${head} fails on head\n- run:${base}\n`);
    const order = ["deployed-verified", "live-local-verified", "e2e-verified", "unit-verified", "build-only"];
    const listed = [...brief.matchAll(/^- [\w-]+ \(([\w-]+)\): base/gm)].map((m) => m[1]);
    const tier = order.find((t) => listed.includes(t)) ?? "unit-verified";
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
