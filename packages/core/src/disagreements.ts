import type { DisagreementAction, DisagreementState, IsoTime, ProjectId, RepoId, UnitId } from "./domain.js";
import { getProject, getUnit, now, recordEvent, setProjectState, type Db } from "./store.js";

// The developer can disagree with any recorded decision after the fact. A follow-up asks the planner for a unit that
// fixes it forward (trunk is never rewritten); a note is kept and shown to later verifiers of the same repo.
export interface Disagreement {
  id: number;
  projectId: ProjectId;
  unitId: UnitId;
  ref: string;
  about: string;
  reason: string;
  action: DisagreementAction;
  state: DisagreementState;
  followUpUnitId: UnitId | null;
  createdAt: IsoTime;
}

const toDisagreement = (r: Record<string, unknown>): Disagreement => ({
  id: r.id as number,
  projectId: r.project_id as ProjectId,
  unitId: r.unit_id as UnitId,
  ref: r.ref as string,
  about: r.about as string,
  reason: r.reason as string,
  action: r.action as DisagreementAction,
  state: r.state as DisagreementState,
  followUpUnitId: (r.follow_up_unit_id as UnitId | null) ?? null,
  createdAt: r.created_at as IsoTime,
});

export class DisagreementInvalid extends Error {}

export function recordDisagreement(db: Db, d: { unitId: UnitId; ref: string; about: string; reason: string; action: DisagreementAction }): Disagreement {
  const unit = getUnit(db, d.unitId);
  if (!d.reason.trim()) throw new DisagreementInvalid("say why you disagree");
  if (!d.about.trim() || !d.ref.trim()) throw new DisagreementInvalid("say what you disagree with");
  const id = Number(
    db
      .prepare("INSERT INTO disagreements (project_id, unit_id, ref, about, reason, action, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(unit.projectId, unit.id, d.ref, d.about.trim(), d.reason.trim(), d.action, d.action === "note" ? "noted" : "open", now()).lastInsertRowid,
  );
  recordEvent(db, "disagreement.recorded", { projectId: unit.projectId, unitId: unit.id }, { disagreement: id, action: d.action, about: d.about });
  // A follow-up needs a planner, and a closed project has none running.
  if (d.action === "follow-up" && getProject(db, unit.projectId).state === "closed") setProjectState(db, unit.projectId, "active");
  return getDisagreement(db, id);
}

export function getDisagreement(db: Db, id: number): Disagreement {
  const r = db.prepare("SELECT * FROM disagreements WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`disagreement ${id} not found`);
  return toDisagreement(r);
}

export function listDisagreements(db: Db, where: { projectId?: ProjectId; unitId?: UnitId; state?: DisagreementState }): Disagreement[] {
  const filters = (
    [
      ["project_id", where.projectId],
      ["unit_id", where.unitId],
      ["state", where.state],
    ] as const
  ).filter(([, v]) => v !== undefined);
  const clauses = filters.map(([c]) => `${c} = ?`);
  const args = filters.map(([, v]) => v);
  return (
    db.prepare(`SELECT * FROM disagreements ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id`).all(...args) as Record<string, unknown>[]
  ).map(toDisagreement);
}

// What later verifiers of a repo read: the developer's notes on how earlier ones judged, newest first.
export function verifierNotes(db: Db, repoId: RepoId, limit = 10): string[] {
  return (
    db
      .prepare(
        `SELECT d.about, d.reason, u.seq, u.project_id FROM disagreements d JOIN units u ON u.id = d.unit_id
         WHERE u.repo_id = ? ORDER BY d.id DESC LIMIT ?`,
      )
      .all(repoId, limit) as { about: string; reason: string; seq: number; project_id: string }[]
  ).map((r) => `On ${r.project_id}/U${r.seq}, about ${r.about}: ${r.reason}`);
}

export function markPlanned(db: Db, id: number, followUpUnitId: UnitId): void {
  db.prepare("UPDATE disagreements SET state = 'planned', follow_up_unit_id = ? WHERE id = ?").run(followUpUnitId, id);
}
