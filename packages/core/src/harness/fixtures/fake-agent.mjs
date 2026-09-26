import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_MODE;
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let brief = "";
process.stdin.on("data", (d) => (brief += d));
process.stdin.on("end", () => {
  emit({ type: "system", subtype: "init", session_id: "s1", model: "fake-model", plugins: [{ name: "pstack", version: "0.5.0" }] });
  if (mode === "hang") return setTimeout(() => {}, 60_000);
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
