import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = new URL("..", import.meta.url).pathname;
const env = { ...process.env, YAGURA_HOME: process.env.YAGURA_HOME ?? join(homedir(), ".yagura-dev"), YAGURA_PORT: process.env.YAGURA_PORT ?? "7300" };

const built = spawnSync("pnpm", ["--filter", "@yagura/core", "--filter", "@yagura/daemon", "--filter", "@yagura/cli", "build"], { cwd: root, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const COLORS = { core: 36, daemon: 33, cli: 35, yagura: 32, web: 34 };
const children = [];

function run(name, cmd, args, filter = () => true) {
  const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const tag = `\x1b[${COLORS[name]}m${name.padEnd(6)}\x1b[0m`;
  for (const stream of [child.stdout, child.stderr])
    createInterface({ input: stream }).on("line", (line) => {
      if (filter(line)) console.log(`${tag} ${line}`);
    });
  child.on("exit", (code) => console.log(`${tag} exited (${code})`));
}

const tscFilter = (line) => /error|Found [1-9]/.test(line);
for (const [name, pkg] of [["core", "@yagura/core"], ["daemon", "@yagura/daemon"], ["cli", "@yagura/cli"]])
  run(name, "pnpm", ["--filter", pkg, "exec", "tsc", "--watch", "--preserveWatchOutput"], tscFilter);
run("yagura", process.execPath, ["--watch-path=packages/core/dist", "--watch-path=apps/daemon/dist", "--watch-path=apps/cli/dist", "apps/cli/dist/main.js", "daemon"]);
run("web", "pnpm", ["--filter", "@yagura/web", "exec", "vite", "--clearScreen", "false"]);

console.log(`yagura dev: home ${env.YAGURA_HOME}, API on :${env.YAGURA_PORT}, dashboard with hot reload on http://localhost:5173`);

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
