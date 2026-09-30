import type { EnvironmentId, ProjectId, Unit } from "./domain.js";
import { addVerifyUnit } from "./runner.js";
import { addGate, getProject, listUnits, recordEvent, type Db } from "./store.js";
import { addMessage, threadsForProject } from "./threads.js";

export const PAUSE_GATE = "environment";

// yagura checks nothing about an environment up front. The first verification that cannot reach something pauses
// verification on that environment for every project on it, so no other verifier spends a session finding the same
// thing, and the developer's answer resumes it.
export function pausedBy(db: Db, environmentId: EnvironmentId | null): number | null {
  if (!environmentId) return null;
  const row = db
    .prepare(
      "SELECT g.id FROM gates g JOIN projects p ON p.id = g.project_id WHERE g.kind = ? AND g.state = 'open' AND p.environment_id = ? ORDER BY g.id LIMIT 1",
    )
    .get(PAUSE_GATE, environmentId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function pauseEnvironment(db: Db, target: Unit, reason: string): number {
  const project = getProject(db, target.projectId);
  const env = project.environmentId!;
  const refs = { projectId: project.id, unitId: target.id };
  const open = pausedBy(db, env);
  if (open) {
    recordEvent(db, "environment.pause_joined", refs, { environment: env, gate: open, reason });
    return open;
  }
  const gate = addGate(db, {
    projectId: project.id,
    unitId: target.id,
    kind: PAUSE_GATE,
    question: `Verification on environment ${env} is paused: ${reason}. It stays paused for every project on ${env} until you answer that it works again.`,
    options: ["fixed"],
  });
  recordEvent(db, "environment.paused", refs, { environment: env, gate, reason });
  for (const thread of threadsForProject(db, project.id))
    addMessage(db, {
      threadId: thread,
      role: "system",
      body: `Verification on environment ${env} is paused (gate ${gate}): U${target.seq}'s verifier could not verify it: ${reason}`,
    });
  return gate;
}

// Units left verifying with no verification queued are the ones a pause stopped; once nothing pauses their
// environment, each gets a fresh verification.
export function resumeVerifications(db: Db, projectId: ProjectId): Unit[] {
  const project = getProject(db, projectId);
  if (pausedBy(db, project.environmentId)) return [];
  const units = listUnits(db, projectId);
  const queued = new Set(units.filter((u) => u.type === "verify" && !["done", "failed", "abandoned"].includes(u.state)).map((u) => u.targetUnitId));
  return units.filter((u) => u.state === "verifying" && !queued.has(u.id)).map((u) => addVerifyUnit(db, u));
}
