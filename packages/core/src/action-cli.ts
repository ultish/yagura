import { timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { adoptProposal, findAction, reportBroken } from "./actions.js";
import { inCheckout, runIn } from "./actionrun.js";
import { loadBootstrap } from "./config.js";
import type { AttemptId, EnvironmentId, RepoId } from "./domain.js";
import { doctorRunOf } from "./doctor.js";
import { layout } from "./paths.js";
import { getAttempt, getProject, getUnit, openStore } from "./store.js";

const USAGE = `usage: yagura action propose --name <name> --use "<when to use it>" [--all] -- <command>
       yagura action broken --name <name> --reason "<what went wrong>"
`;

// Who is calling: a doctor run, or an agent's session in a unit, each proven by the token yagura gave that session.
function callerOf(
  db: ReturnType<typeof openStore>,
  env: NodeJS.ProcessEnv,
): { environmentId: EnvironmentId | null; repoId: RepoId | null; attemptId: AttemptId | null; author: "doctor" | "agent" } | string {
  if (env.YAGURA_DOCTOR_RUN) {
    const run = doctorRunOf(db, env);
    return typeof run === "string" ? run : { environmentId: run.environmentId, repoId: run.repoId, attemptId: null, author: "doctor" };
  }
  const attemptId = Number(env.YAGURA_ATTEMPT) as AttemptId;
  const row = db.prepare("SELECT evidence_token FROM attempts WHERE id = ?").get(attemptId) as { evidence_token: string | null } | undefined;
  const given = Buffer.from(env.YAGURA_EVIDENCE_TOKEN ?? "");
  const expected = Buffer.from(row?.evidence_token ?? "");
  if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected))
    return "refused: YAGURA_EVIDENCE_TOKEN does not match this attempt's session";
  const unit = getUnit(db, getAttempt(db, attemptId).unitId);
  return { environmentId: getProject(db, unit.projectId).environmentId, repoId: unit.repoId, attemptId, author: "agent" };
}

// An agent offers a command it found useful (yagura runs it on a clean checkout and saves it only when it passes), or says a saved
// one does not work. Both act on the environment of the agent's own project, for the agent's own repo (--all: every repo there).
export async function actionAgentCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; output: string }> {
  const split = argv.indexOf("--");
  const { positionals, values } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    options: { name: { type: "string" }, use: { type: "string" }, reason: { type: "string" }, all: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const command = split === -1 ? "" : argv.slice(split + 1).join(" ");
  const sub = positionals[0];
  if ((sub !== "propose" && sub !== "broken") || !values.name) return { code: 2, output: USAGE };
  if (!env.YAGURA_ATTEMPT && !env.YAGURA_DOCTOR_RUN) return { code: 2, output: "yagura action only works inside a yagura agent session or doctor run\n" };
  const boot = loadBootstrap(env);
  const db = openStore(layout(boot).db);
  try {
    const caller = callerOf(db, env);
    if (typeof caller === "string") return { code: 2, output: `yagura action ${caller}\n` };
    if (!caller.environmentId || !caller.repoId) return { code: 1, output: "your work has no environment or repo, so it has no actions\n" };
    const { environmentId, attemptId } = caller;
    const repoId: RepoId = caller.repoId;
    if (sub === "broken") {
      const action = findAction(db, environmentId, repoId, values.name);
      if (!action) return { code: 1, output: `no action ${values.name} applies to ${repoId}; \`yagura env actions ${environmentId}\` lists them\n` };
      reportBroken(db, action.id, values.reason ?? "", attemptId);
      return { code: 0, output: `${action.name} marked broken; the doctor looks at it next\n` };
    }
    if (!values.use || !command) return { code: 2, output: USAGE };
    const run = await inCheckout({ db, boot }, repoId, null, (dir, sha) =>
      runIn({ db, boot }, { dir, sha, environmentId, repoId, actionId: null, command, by: caller.author, attemptId }),
    );
    const status = run.timedOut ? "timed out" : `exit ${run.exitCode}`;
    const tail = run.output.trim().split("\n").slice(-20).join("\n");
    if (run.exitCode !== 0 || run.timedOut)
      return { code: 1, output: `yagura ran it on a clean checkout of ${repoId}@${run.sha.slice(0, 10)}: ${status}. Nothing was saved.\n${tail}\n` };
    const saved = adoptProposal(db, {
      environmentId,
      repoId: values.all ? null : repoId,
      name: values.name,
      use: values.use,
      author: caller.author,
      attemptId,
      run,
    });
    return {
      code: 0,
      output: saved.suggested
        ? `${values.name} is the developer's own action, so yours is shown beside it as a suggestion (run passed, ${status})\n`
        : `${values.name} saved and proven by yagura's run on ${repoId}@${run.sha.slice(0, 10)}\n`,
    };
  } finally {
    db.close();
  }
}
