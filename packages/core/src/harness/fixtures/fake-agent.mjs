import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_MODE;
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let brief = "";
process.stdin.on("data", (d) => (brief += d));
process.stdin.on("end", () => {
  emit({ type: "system", subtype: "init", session_id: "s1", model: "fake-model", plugins: [{ name: "pstack", version: "0.5.0" }] });
  const skills = { worker: ["yagura:yagura-worker", "pstack:poteto-mode"], planner: ["yagura:yagura-planner"], verifier: ["yagura:yagura-verifier"] }[process.env.YAGURA_ROLE] ?? [];
  if (mode !== "noskills")
    for (const skill of skills) emit({ type: "assistant", message: { content: [{ type: "tool_use", id: `sk-${skill}`, name: "Skill", input: { skill } }] } });
  if (mode === "engine") return engine(process.env.YAGURA_ROLE);
  if (mode === "hang") return setTimeout(() => {}, 60_000);
  if ((mode ?? "").startsWith("verify")) return verify(mode);
  const file = mode === "scope" ? "README.md" : "app/orders.py";
  writeFileSync(file, `# edited by fake agent\n# brief had GOAL: ${brief.includes("## GOAL")}\n`);
  const g = (...args) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", ...args]);
  g("add", file);
  g("commit", "-q", "-m", "fake agent work");
  mkdirSync("app/__pycache__", { recursive: true });
  writeFileSync("app/__pycache__/orders.pyc", "generated after commit\n");
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: file } }], usage: { input_tokens: 1200, output_tokens: 30 } },
  });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  const handoff =
    mode === "nohandoff"
      ? "DONE"
      : `## Status\n${mode === "blocked" ? "blocked" : "success"}\n\n## Branch\n\`b\`\n\n## What I did\n- edited ${file}\n\n## Verification\nunit-verified\n\n## Evidence\n- python3 -m unittest -> ok\n`;
  emit({ type: "result", subtype: "success", is_error: false, result: handoff, terminal_reason: "completed", total_cost_usd: 0.01 });
});

function verify(mode) {
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "yagura:yagura-verifier" } }] } });
  const script = `${process.cwd()}/scenario.sh`;
  const body = mode === "verify-weak" ? "true" : mode === "verify-fail" ? "grep -q 'never there' app/orders.py" : "grep -q 'edited by fake agent' app/orders.py";
  writeFileSync(script, `${body}\n`);
  const run = (at) => {
    const out = execSync(`yagura evidence run --at ${at} --label scenario -- sh ${script}`, { encoding: "utf8" });
    return Number(/run:(\d+)/.exec(out)[1]);
  };
  if (mode === "verify-tamper") appendFileSync(`${process.env.YAGURA_HEAD}/app/orders.py`, "# edited by fake agent\n");
  const base = run("base");
  const head = run("head");
  const tier = mode === "verify-fail" ? "verifier-failed" : "unit-verified";
  const cite = mode === "verify-lie" ? "run:999" : `run:${head}`;
  const handoff = `## Status\nsuccess\n\n## Verification\n${tier}\n\n## Evidence\n- ${cite} scenario on head\n- run:${base} scenario on base\n\n## Findings\n- [x] criterion: ${cite}\n`;
  emit({ type: "result", subtype: "success", is_error: false, result: handoff, terminal_reason: "completed", total_cost_usd: 0.01 });
}

function finish(text) {
  emit({ type: "result", subtype: "success", is_error: false, result: text, terminal_reason: "completed", total_cost_usd: 0.01 });
}

function engine(role) {
  if (role === "planner") {
    const workRows = [...brief.matchAll(/^\| U\d+ \| work \| (\w+)/gm)].map((m) => m[1]);
    const unit = (key, write) => ({ key, repo: "testbed", goal: `write ${key}`, write: [write], accept: [`${key} file exists`], verify: "true", playbook: "feature" });
    const delta = !workRows.length
      ? { add: [unit("a", "app/a/**"), unit("b", "app/b/**"), unit("c", "app/a/extra/**")], summary: "three units" }
      : { done: workRows.every((s) => s === "landed"), summary: workRows.every((s) => s === "landed") ? "all landed" : "waiting" };
    return finish("Plan:\n```json\n" + JSON.stringify(delta) + "\n```");
  }
  if (role === "worker") {
    const base = /May write:\n- ([^*\n]+?)\/?\*\*/.exec(brief)[1];
    mkdirSync(base, { recursive: true });
    writeFileSync(`${base}/${process.env.YAGURA_UNIT}.txt`, "work\n");
    const g = (...args) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@x", ...args]);
    g("add", "-A");
    g("commit", "-q", "-m", `work ${process.env.YAGURA_UNIT}`);
    return setTimeout(() => finish("## Status\nsuccess\n\n## Verification\nunit-verified\n"), 400);
  }
  if (role === "verifier") {
    const file = /^\+\+\+ b\/(.+)$/m.exec(brief)[1];
    writeFileSync("scenario.sh", `test -f ${file}\n`);
    const run = (at) => Number(/run:(\d+)/.exec(execSync(`yagura evidence run --at ${at} --label s -- sh ${process.cwd()}/scenario.sh`, { encoding: "utf8" }))[1]);
    const base = run("base");
    const head = run("head");
    return finish(`## Status\nsuccess\n\n## Verification\nunit-verified\n\n## Evidence\n- run:${head}\n- run:${base}\n`);
  }
}
