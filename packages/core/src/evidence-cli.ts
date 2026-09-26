import { parseArgs } from "node:util";
import { loadBootstrap } from "./config.js";
import type { AttemptId } from "./domain.js";
import { readArtifact, runEvidence, type At } from "./evidence.js";
import { layout } from "./paths.js";
import { openStore } from "./store.js";

const tail = (text: string, lines = 60) => text.split("\n").slice(-lines).join("\n").trimEnd();

export async function evidenceCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; output: string }> {
  const split = argv.indexOf("--");
  const { positionals, values } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    options: { at: { type: "string" }, label: { type: "string" }, timeout: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const command = split === -1 ? "" : argv.slice(split + 1).join(" ");
  if (positionals[0] !== "run" || (values.at !== "base" && values.at !== "head") || !values.label || !command)
    return { code: 2, output: "usage: yagura evidence run --at base|head --label <name> [--timeout <seconds>] -- <command>\n" };
  if (!env.YAGURA_ATTEMPT) return { code: 2, output: "evidence run only works inside a yagura verify session (YAGURA_ATTEMPT is not set)\n" };

  const boot = loadBootstrap(env);
  const db = openStore(layout(boot).db);
  try {
    const run = await runEvidence(db, boot, {
      attemptId: Number(env.YAGURA_ATTEMPT) as AttemptId,
      at: values.at as At,
      label: values.label,
      command,
      timeoutSeconds: values.timeout ? Number(values.timeout) : undefined,
    });
    const stdout = run.stdoutArtifactId ? readArtifact(db, boot, run.stdoutArtifactId).toString() : "";
    const stderr = run.stderrArtifactId ? readArtifact(db, boot, run.stderrArtifactId).toString() : "";
    const status = run.timedOut ? "timed out" : `exit ${run.exitCode}`;
    const output = [
      `run:${run.id} at ${run.at} (${run.sha.slice(0, 10)}): ${status} in ${run.durationMs}ms`,
      ...(run.tampered ? ["warning: the checkout had been modified before this run; yagura restored it and flagged the run as tampered"] : []),
      "--- stdout (tail) ---",
      tail(stdout) || "(empty)",
      "--- stderr (tail) ---",
      tail(stderr) || "(empty)",
      "",
    ].join("\n");
    return { code: 0, output };
  } finally {
    db.close();
  }
}
