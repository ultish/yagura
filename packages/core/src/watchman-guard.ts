import { join } from "node:path";
import type { Bootstrap } from "./config.js";
import { write } from "./agent.js";

// The watchman's allow list is passed to the harness, but an allow rule in the developer's own settings (say
// `Bash(npm:*)`) would still apply. A PreToolUse hook is the one thing an allow rule cannot override: it refuses any
// shell command that is not one of the watchman's `yagura` reads, optionally piped into a read-only filter.
const GUARD = `import { readFileSync } from "node:fs";
const allowed = JSON.parse(process.argv[2] ?? "[]");
const FILTERS = ["grep", "head", "tail", "wc", "sort", "uniq", "cut"];
let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
const command = String(input?.tool_input?.command ?? "").replace(/\\s+2>&1\\b/g, "").trim();
const refuse = (why) => {
  process.stderr.write(\`yagura refused this command for the watchman: \${why}. It may run only: \${allowed.join(", ")} (optionally piped into \${FILTERS.join(", ")}).\\n\`);
  process.exit(2);
};
if (!command) refuse("no command");
if (/[;&<>\`\\n]|\\$\\(/.test(command)) refuse("chained commands, redirects, and substitutions are not allowed");
const [first, ...rest] = command.split("|").map((s) => s.trim());
if (!allowed.some((p) => first === p || first.startsWith(p + " "))) refuse(\`\${first.split(/\\s+/).slice(0, 2).join(" ")} is not one of its reads\`);
for (const f of rest) if (!FILTERS.includes(f.split(/\\s+/)[0])) refuse(\`\${f.split(/\\s+/)[0]} is not a read-only filter\`);
process.exit(0);
`;

// The command prefixes a `Bash(<prefix>:*)` allow rule names.
export function bashPrefixes(allowedTools: string[]): string[] {
  return allowedTools.flatMap((t) => {
    const m = /^Bash\((.+?)(?::\*)?\)$/.exec(t);
    return m ? [m[1]!] : [];
  });
}

export function watchmanGuardSettings(boot: Bootstrap, allowedTools: string[]): string {
  const script = join(boot.home, "bin", "watchman-guard.mjs");
  write(script, GUARD);
  const arg = JSON.stringify(bashPrefixes(allowedTools)).replace(/'/g, `'\\''`);
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${JSON.stringify(script)} '${arg}'` }] }] },
  });
}
