import { timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { adoptProposal, findAction, reportBroken } from "./actions.js";
import { inCheckout, runIn } from "./actionrun.js";
import { loadBootstrap } from "./config.js";
import type { AttemptId, RepoId } from "./domain.js";
import { layout } from "./paths.js";
import { getAttempt, getProject, getUnit, openStore } from "./store.js";

const USAGE = `usage: yagura action propose --name <name> --use "<when to use it>" [--all] -- <command>
       yagura action broken --name <name> --reason "<what went wrong>"
`;

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
  if (!env.YAGURA_ATTEMPT) return { code: 2, output: "yagura action only works inside a yagura agent session (YAGURA_ATTEMPT is not set)\n" };
  const boot = loadBootstrap(env);
  const db = openStore(layout(boot).db);
  try {
    const attemptId = Number(env.YAGURA_ATTEMPT) as AttemptId;
    const row = db.prepare("SELECT evidence_token FROM attempts WHERE id = ?").get(attemptId) as { evidence_token: string | null } | undefined;
    const given = Buffer.from(env.YAGURA_EVIDENCE_TOKEN ?? "");
    const expected = Buffer.from(row?.evidence_token ?? "");
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected))
      return { code: 2, output: "yagura action refused: YAGURA_EVIDENCE_TOKEN does not match this attempt's session\n" };
    const attempt = getAttempt(db, attemptId);
    const unit = getUnit(db, attempt.unitId);
    const environmentId = getProject(db, unit.projectId).environmentId;
    if (!environmentId || !unit.repoId) return { code: 1, output: "your unit has no environment or repo, so it has no actions\n" };
    const repoId: RepoId = unit.repoId;
    if (sub === "broken") {
      const action = findAction(db, environmentId, repoId, values.name);
      if (!action) return { code: 1, output: `no action ${values.name} applies to ${repoId}; \`yagura env actions ${environmentId}\` lists them\n` };
      reportBroken(db, action.id, values.reason ?? "", attemptId);
      return { code: 0, output: `${action.name} marked broken; the doctor looks at it next\n` };
    }
    if (!values.use || !command) return { code: 2, output: USAGE };
    const run = await inCheckout({ db, boot }, repoId, null, (dir, sha) =>
      runIn({ db, boot }, { dir, sha, environmentId, repoId, actionId: null, command, by: attempt.role === "doctor" ? "doctor" : "agent", attemptId }),
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
      author: attempt.role === "doctor" ? "doctor" : "agent",
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
