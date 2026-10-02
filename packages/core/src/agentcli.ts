import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Bootstrap } from "./config.js";
import type { RepoId } from "./domain.js";
import { ensureMirror } from "./git.js";
import { layout } from "./paths.js";
import { getRepo, type Db } from "./store.js";

// Agents reach the CLI through the shim on their PATH. They may look things up and record evidence; every change to yagura goes
// through their handoff or records block, never the CLI. Fails closed: anything not recognised as a read is refused.
const READS: Record<string, (args: string[]) => boolean> = {
  show: () => true,
  logs: () => true,
  trace: () => true,
  gates: () => true,
  git: () => true,
  evidence: () => true,
  settings: (a) => !a.includes("import"),
  thread: (a) => a.length === 0 || ["list", "show", "search", "mentions"].includes(a[0]!),
  env: (a) => a[0] === "values" || a[0] === "presets" || (a[0] === "notes" && !a.includes("set")),
  template: (a) => a[0] === "list",
  project: (a) => a[0] === "skills",
};

export function agentRefusal(argv: string[], env: NodeJS.ProcessEnv): string | null {
  const role = env.YAGURA_ROLE;
  if (!role) return null;
  const [command = "", ...args] = argv;
  if (READS[command]?.(args)) return null;
  return `yagura ${[command, ...args].join(" ").slice(0, 80)}: refused for the ${role} role. Agents may only read yagura (show, logs, trace, gates, settings, thread list|show|search|mentions, env values|presets|notes, template list, project skills, git); changes go through your handoff or your records block.\n`;
}

export const GIT_READS = ["log", "show", "ls-tree", "diff", "grep", "blame"] as const;
// Options that write files, read outside the repo, or run programs.
const UNSAFE_GIT_ARG = /^(--output(=|$)|--no-index$|--ext-diff$|--textconv$|--open-files-in-pager|-O|--exec)/;
const FETCH_EVERY_MS = 60_000;

const run = promisify(execFile);

export async function gitRead(db: Db, boot: Bootstrap, argv: string[]): Promise<{ code: number; output: string }> {
  const [repoId, sub, ...args] = argv;
  if (!repoId || !sub) return { code: 2, output: `usage: yagura git <repo> ${GIT_READS.join("|")} [args]   (trunk is origin/<default branch>)\n` };
  if (!(GIT_READS as readonly string[]).includes(sub)) return { code: 2, output: `yagura git: only ${GIT_READS.join(", ")} are allowed, not ${sub}\n` };
  const unsafe = args.find((a) => UNSAFE_GIT_ARG.test(a));
  if (unsafe) return { code: 2, output: `yagura git: ${unsafe} is not allowed\n` };
  const repo = getRepo(db, repoId as RepoId);
  const trunk = `origin/${repo.defaultBranch}`;
  const split = args.indexOf("--");
  const revs = (split === -1 ? args : args.slice(0, split)).filter((a) => !a.startsWith("-"));
  // fetch moves only origin/*: the mirror's HEAD and local default branch stay where the clone left them.
  const stale = revs.find((a) => a.split(/[~^:@]/)[0] === "HEAD" || a.split(/[~^:@]/)[0] === repo.defaultBranch);
  if (stale) return { code: 2, output: `yagura git: ${stale} is the mirror's copy from when it was cloned; trunk is ${trunk} (e.g. ${trunk}:README.md)\n` };
  if ((sub === "log" || sub === "show") && !revs.length) args.splice(split === -1 ? args.length : split, 0, trunk);
  const mirror = layout(boot).mirror(repo.id);
  const fetchHead = join(mirror, "FETCH_HEAD");
  let note = "";
  if (!existsSync(fetchHead) || Date.now() - statSync(fetchHead).mtimeMs > FETCH_EVERY_MS)
    await ensureMirror(repo.url, mirror).catch((e: unknown) => {
      if (!existsSync(mirror)) throw e;
      note = `(could not fetch ${repo.id}, showing the mirror as last fetched: ${e instanceof Error ? e.message.split("\n")[0] : String(e)})\n`;
    });
  try {
    const { stdout } = await run("git", ["--git-dir", mirror, "--no-pager", sub, ...args], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GIT_EXTERNAL_DIFF")), GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, output: note + stdout };
  } catch (e) {
    const err = e as { code?: number; stderr?: string; stdout?: string };
    return { code: typeof err.code === "number" ? err.code : 1, output: note + (err.stdout ?? "") + (err.stderr ?? String(e)) };
  }
}
