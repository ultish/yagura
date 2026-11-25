// Starts claude the way yagura starts a planner (same argv, stream-json stdin, a git checkout as cwd, yagura's plugin), without the daemon.
//   node scripts/agent-probe.mjs <claude bin or wrapper> [--plain] [--model <m>] [--plugin-dir <dir>]...
//   --plain runs in an empty non-git folder instead, the way the watchman's thread folder is
//   --without=<flag> drops one of yagura's flags (and its value), to find the one that matters: --without=--plugin-dir, --without=--disallowed-tools, ...
//   --prompt <text> replaces the prompt, which loads a skill, e.g. --prompt "reply with the single word ok"
// Prints the init line, each tool call, the result, the exit code and the whole stderr; the raw stream is kept in the folder it names.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { claudeAdapter } from "../packages/core/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plain: { type: "boolean" },
    model: { type: "string" },
    "plugin-dir": { type: "string", multiple: true },
    without: { type: "string", multiple: true },
    prompt: { type: "string" },
  },
});
const bin = positionals[0];
if (!bin) {
  console.error("usage: node scripts/agent-probe.mjs <claude bin or wrapper> [--plain] [--model <m>] [--plugin-dir <dir>]...");
  process.exit(2);
}
const out = mkdtempSync(join(tmpdir(), "yagura-probe-"));
const cwd = join(out, values.plain ? "plain" : "repo");
execFileSync("mkdir", ["-p", cwd]);
if (!values.plain) {
  writeFileSync(join(cwd, "README.md"), "seed\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
}
const built = claudeAdapter.command({
  prompt:
    values.prompt ??
    "# yagura plan brief\n\nThis is a harness test, not a real plan. Load the skill yagura:yagura-planner with the Skill tool, then reply with the single word ok. Do not run any other tool.",
  bin,
  model: values.model ?? null,
  permissionMode: "bypassPermissions",
  pluginDirs: [join(here, "..", "plugins", "yagura"), ...(values["plugin-dir"] ?? [])],
  addDirs: [],
  extraArgs: [],
});
const VALUELESS = new Set(["-p", "--verbose", "--replay-user-messages"]);
const drop = new Set(values.without ?? []);
const argv = [];
for (let i = 0; i < built.argv.length; i++) {
  const a = built.argv[i];
  if (i > 0 && drop.has(a)) {
    if (!VALUELESS.has(a)) i++;
    continue;
  }
  argv.push(a);
}
const { stdin } = built;
console.log("cwd:", cwd);
console.log("argv:", JSON.stringify(argv));
const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true, env: { ...process.env, YAGURA_ROLE: "planner" } });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
child.on("error", (e) => console.log("could not start:", e.message));
child.stdin.on("error", () => {});
child.stdin.end(stdin);
child.on("close", (code, signal) => {
  writeFileSync(join(out, "stdout.jsonl"), stdout);
  writeFileSync(join(out, "stderr.txt"), stderr);
  for (const l of stdout.split("\n").filter(Boolean)) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      console.log("RAW", l.slice(0, 300));
      continue;
    }
    if (e.type === "system" && e.subtype === "init")
      console.log("INIT", e.claude_code_version, e.model, e.permissionMode, "plugins:", (e.plugins ?? []).map((p) => p.name).join(","));
    else if (e.type === "assistant") {
      for (const c of e.message.content) if (c.type === "tool_use") console.log("CALL", c.name, JSON.stringify(c.input).slice(0, 150));
    } else if (e.type === "result") console.log("RESULT", e.subtype, String(e.result ?? "").slice(0, 300));
  }
  console.log(`exit ${code ?? signal}`);
  console.log("stderr:\n" + (stderr || "(none)"));
  console.log("kept in", out);
});
