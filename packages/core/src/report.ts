import type { Bootstrap } from "./config.js";
import { isBuild, type ProjectId, type Unit } from "./domain.js";
import { ensureMirror } from "./git.js";
import { layout } from "./paths.js";
import { latestDelta } from "./planner.js";
import { addGate, getProject, listGates, listUnits, projectRepos, type Db } from "./store.js";
import { addMessage, getThread, listQuestions, setThreadReported } from "./threads.js";

export type ReportKind = { kind: "closed" } | { kind: "andon"; reason: string } | { kind: "stalled"; blocked: number[] };

export const reportKey = (r: ReportKind) => (r.kind === "closed" ? "closed" : r.kind === "andon" ? `andon:${r.reason}` : `stalled:${r.blocked.join(",")}`);

function blockedReason(db: Db, u: Unit): string {
  const row = db
    .prepare("SELECT data_json FROM events WHERE unit_id = ? AND type = 'unit.state' AND json_extract(data_json, '$.to') = 'stuck' ORDER BY id DESC LIMIT 1")
    .get(u.id) as { data_json: string } | undefined;
  const reason = row ? (JSON.parse(row.data_json) as { reason?: unknown }).reason : null;
  return reason ? (typeof reason === "string" ? reason : JSON.stringify(reason)) : (u.notes.at(-1) ?? "no reason recorded");
}

export async function renderReport(ctx: { db: Db; boot: Bootstrap }, threadId: number, projectId: ProjectId, r: ReportKind): Promise<string> {
  const { db, boot } = ctx;
  const project = getProject(db, projectId);
  const work = listUnits(db, projectId).filter(isBuild);
  const headline =
    r.kind === "closed"
      ? `**${project.id} is done.** ${latestDelta(db, projectId)?.summary ?? ""}`.trim()
      : r.kind === "andon"
        ? `**${project.id} has stopped (andon):** ${r.reason}`
        : `**${project.id} is stuck:** ${r.blocked.map((s) => `U${s}`).join(", ")} blocked and the planner has nothing further to try.`;

  const landed = work
    .filter((u) => u.state === "merged")
    .map((u) => {
      return `- U${u.seq} ${u.goal} — landed \`${u.mergedSha?.slice(0, 10) ?? "?"}\` on ${u.repoId} · \`yagura trace ${u.mergedSha?.slice(0, 10) ?? `${projectId}`}\``;
    });
  const blocked = work.filter((u) => u.state === "stuck").map((u) => `- U${u.seq} ${u.goal}: ${blockedReason(db, u)}`);
  const open = work.filter((u) => !["merged", "dropped", "stuck"].includes(u.state)).map((u) => `- U${u.seq} ${u.goal} (${u.state})`);

  const run: string[] = [];
  for (const repo of projectRepos(db, projectId)) {
    const mirror = layout(boot).mirror(repo.id);
    try {
      await ensureMirror(repo.url, mirror);
      run.push(`- ${repo.id} (${repo.url}, ${repo.defaultBranch})`);
    } catch (e) {
      run.push(`- ${repo.id}: could not read trunk (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  const gates = listGates(db, projectId, "open")
    .filter((g) => g.kind !== "report")
    .map((g) => `- gate ${g.id}: ${g.question} [${g.options.join(" | ")}]`);
  const questions = listQuestions(db, threadId, { openOnly: true }).map((q) => `- Q${q.id}: ${q.text}`);
  const section = (title: string, lines: string[]) => (lines.length ? `\n\n### ${title}\n${lines.join("\n")}` : "");
  return `${headline}${section("Landed", landed)}${section("Blocked", blocked)}${section("Still open", open)}${section("How to run it", run)}${section("Waiting on you", [...gates, ...questions])}`;
}

export async function postReport(ctx: { db: Db; boot: Bootstrap }, threadId: number, projectId: ProjectId, r: ReportKind): Promise<void> {
  const { db } = ctx;
  const body = await renderReport(ctx, threadId, projectId, r);
  db.transaction(() => {
    const message = addMessage(db, { threadId, role: "system", body });
    const thread = getThread(db, threadId);
    setThreadReported(db, threadId, { ...thread.reported, [projectId]: reportKey(r) });
    const verb = r.kind === "closed" ? "is done" : r.kind === "andon" ? "has stopped" : "is stuck";
    addGate(db, {
      projectId,
      kind: "report",
      question: `${projectId} ${verb}; report in thread ${threadId} (message ${message.id})`,
      options: ["seen"],
      defaultOption: "seen",
    });
  })();
}
