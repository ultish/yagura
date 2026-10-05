import { existsSync, readFileSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import type { ProjectId } from "./domain.js";
import { layout } from "./paths.js";
import { readiness } from "./schedule.js";
import { listDisagreements } from "./disagreements.js";
import { getProject, getUnit, listAttempts, listDeps, listGates, listUnits, projectRepos, type Db } from "./store.js";
import { attemptAccount } from "./finish.js";

const HANDOFF_LIMIT = 3000;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function generateStatus(db: Db, boot: Bootstrap, projectId: ProjectId, sinceEventId: number): string {
  const project = getProject(db, projectId);
  const units = listUnits(db, projectId);
  const deps = listDeps(db, projectId);
  const bySeq = new Map(units.map((u) => [u.id, u.seq]));
  const r = readiness(db, projectId);
  const waiting = new Map(r.waiting.map((w) => [w.unit.id, w.reason]));
  const paths = layout(boot);

  const rows = units.map((u) => {
    const attempts = listAttempts(db, u.id);
    const last = attempts.at(-1);
    const outcome = last ? [last.state, last.handoffStatus, last.failureMode].filter(Boolean).join(" ") : "-";
    const d = deps
      .filter((x) => x.unitId === u.id)
      .map((x) => `U${bySeq.get(x.dependsOn)} (${x.kind})`)
      .join(", ");
    const target = u.targetUnitId ? ` → U${bySeq.get(u.targetUnitId)}` : "";
    return `| U${u.seq} | ${u.type}${target} | ${u.state}${waiting.has(u.id) ? ` (${waiting.get(u.id)})` : ""} | ${u.repoId ?? "-"} | ${cell(u.goal)} | ${cell(u.writeScope.join(", ") || "-")} | ${d || "-"} | ${attempts.length}/${u.maxAttempts} | ${outcome} |`;
  });

  const notes = units.filter((u) => u.notes.length).map((u) => `- U${u.seq}: ${u.notes.map(cell).join(" / ")}`);
  const gates = listGates(db, projectId, "open").map(
    (g) => `- gate ${g.id} (${g.kind}${g.unitId ? `, U${bySeq.get(g.unitId)}` : ""}): ${g.question} [${g.options.join(" | ")}]`,
  );

  const events = db
    .prepare(
      `SELECT id, type, unit_id, data_json FROM events WHERE project_id = ? AND id > ?
       AND type IN ('unit.state', 'verify.outcome', 'unit.landed', 'attempt.method_miss', 'plan.rejected', 'gate.answered', 'unit.note')
       ORDER BY id`,
    )
    .all(projectId, sinceEventId) as { id: number; type: string; unit_id: number | null; data_json: string }[];
  const interesting = events
    .map((e) => {
      const d = JSON.parse(e.data_json) as Record<string, unknown>;
      const u = e.unit_id ? `U${bySeq.get(e.unit_id as never)}` : "";
      if (e.type === "unit.state") {
        if (!["handed_off", "verified", "landed", "rejected", "blocked", "failed", "abandoned"].includes(String(d.to))) return null;
        const why = d.reason ? `: ${typeof d.reason === "string" ? d.reason : JSON.stringify(d.reason)}` : "";
        return `- ${u} ${d.from} → ${d.to}${why}`;
      }
      if (e.type === "verify.outcome") return `- ${u} verification ${d.outcome}${d.tier ? ` (${d.tier})` : ""}: ${d.reason}`;
      if (e.type === "unit.landed") return `- ${u} landed at ${String(d.sha).slice(0, 10)}`;
      if (e.type === "attempt.method_miss") return `- ${u} ${d.role} skipped required skills: ${(d.missing as string[]).join(", ")}`;
      if (e.type === "plan.rejected") return `- your previous plan delta was rejected: ${d.reason}`;
      if (e.type === "gate.answered") return `- gate ${d.gate} answered: ${d.answer}`;
      if (e.type === "unit.note") return `- ${u} note: ${d.note}`;
      return null;
    })
    .filter(Boolean);

  const changed = new Set(events.filter((e) => e.type === "unit.state").map((e) => e.unit_id));
  const handoffs = units
    .filter((u) => changed.has(u.id))
    .map((u) => {
      const last = listAttempts(db, u.id)
        .filter((a) => a.endedAt)
        .at(-1);
      const text = last ? attemptAccount(db, last.id, paths.handoff(projectId, u.seq, last.n)) : null;
      if (!text) return null;
      return `### U${u.seq} attempt ${last!.n} (${u.type})\n${text.length > HANDOFF_LIMIT ? `${text.slice(0, HANDOFF_LIMIT)}\n… (truncated)` : text}`;
    })
    .filter(Boolean);

  return `# ${project.id} status

- goal: ${project.goal}
- predicate: ${project.predicate}
- min tier: ${project.minTier} · merge: ${project.mergePolicy} · state: ${project.state}${project.andonReason ? ` · ANDON: ${project.andonReason}` : ""}
- repos: ${projectRepos(db, projectId)
    .map((repo) => `${repo.id} (${repo.defaultBranch})`)
    .join(", ")}

## Units
| unit | type | state | repo | goal | write scope | deps | attempts | last attempt |
|---|---|---|---|---|---|---|---|---|
${rows.join("\n") || "| (none yet) |||||||||"}

## Notes carried on units
${notes.join("\n") || "(none)"}

## Open gates
${gates.join("\n") || "(none)"}

## The developer disagrees (each needs a unit that fixes it forward; set "disagreement" on that unit)
${
  listDisagreements(db, { projectId, state: "open" })
    .map((d) => `- D${d.id} on U${getUnit(db, d.unitId).seq}, about ${d.about}: ${d.reason}`)
    .join("\n") || "(none)"
}

## Since the last plan
${interesting.join("\n") || "(nothing new)"}

## Latest handoffs since the last plan
${handoffs.join("\n\n") || "(none)"}
`;
}
