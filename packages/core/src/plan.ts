import { z } from "zod";
import { resolveSetting } from "./config.js";
import { listDisagreements, markPlanned } from "./disagreements.js";
import { TERMINAL_STATES, type ProjectId, type RepoId, type Unit, type UnitId } from "./domain.js";
import {
  addDep,
  addGate,
  addUnit,
  addUnitNote,
  amendUnit,
  bumpMaxAttempts,
  getUnit,
  getUnitBySeq,
  listAttempts,
  listDeps,
  projectRepos,
  recordEvent,
  transitionUnit,
  type Db,
} from "./store.js";

export const WORK_PLAYBOOKS = [
  "bug-fix",
  "feature",
  "refactoring",
  "perf-issue",
  "hillclimb",
  "prototype",
  "visual-parity",
  "runtime-forensics",
  "trace-forensics",
  "investigation",
  "authoring-a-skill",
] as const;

const UnitRef = z.string().regex(/^U\d+$/, "unit references look like U3");

export const PlanUnit = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/, "keys are lowercase words, e.g. discount-create"),
    repo: z.string(),
    base: z.string().min(1).optional(),
    goal: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    context: z.array(z.string()).default([]),
    after: z.array(z.string()).default([]),
    refs: z.array(z.string().min(1)).default([]),
    playbook: z.enum(WORK_PLAYBOOKS).default("feature"),
    scaffold: z.boolean().default(false),
    timeboxMinutes: z.number().int().positive().max(240).optional(),
    disagreement: z.number().int().positive().optional(),
  })
  .strict();

export const PlanDelta = z
  .object({
    add: z.array(PlanUnit).default([]),
    amend: z
      .array(
        z
          .object({
            unit: UnitRef,
            goal: z.string().min(1).optional(),
            acceptance: z.array(z.string().min(1)).min(1).optional(),
            context: z.array(z.string()).optional(),
            after: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .default([]),
    retry: z.array(z.object({ unit: UnitRef, note: z.string().min(1) }).strict()).default([]),
    cancel: z.array(z.object({ unit: UnitRef, reason: z.string().min(1) }).strict()).default([]),
    gates: z.array(z.object({ question: z.string().min(1), options: z.array(z.string()).min(2), default: z.string() }).strict()).default([]),
    done: z.boolean().default(false),
    summary: z.string().default(""),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const g of d.gates)
      if (!g.options.includes(g.default))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `gate "${g.question}": default must be one of its options`, path: ["gates"] });
  });
export type PlanDelta = z.output<typeof PlanDelta>;

export class PlanRejected extends Error {}

function assertAcyclic(db: Db, projectId: ProjectId): void {
  const edges = new Map<UnitId, UnitId[]>();
  for (const d of listDeps(db, projectId)) edges.set(d.unitId, [...(edges.get(d.unitId) ?? []), d.dependsOn]);
  const state = new Map<UnitId, "visiting" | "done">();
  const visit = (u: UnitId, path: UnitId[]): void => {
    if (state.get(u) === "done") return;
    if (state.get(u) === "visiting") throw new PlanRejected(`dependency cycle through units ${[...path, u].join(" -> ")}`);
    state.set(u, "visiting");
    for (const next of edges.get(u) ?? []) visit(next, [...path, u]);
    state.set(u, "done");
  };
  for (const u of edges.keys()) visit(u, []);
}

export interface ApplyResult {
  added: Unit[];
  warnings: string[];
}

export function applyDelta(db: Db, projectId: ProjectId, delta: PlanDelta, drainId: number | null): ApplyResult {
  return db.transaction((): ApplyResult => {
    const repos = new Set(projectRepos(db, projectId).map((r) => r.id as string));
    const warnings: string[] = [];
    const unitRef = (ref: string, what: string): Unit => {
      try {
        return getUnitBySeq(db, projectId, Number(ref.slice(1)));
      } catch {
        throw new PlanRejected(`${what}: ${ref} does not exist in this project`);
      }
    };

    const keys = new Set<string>();
    for (const a of delta.add) {
      if (keys.has(a.key)) throw new PlanRejected(`duplicate key "${a.key}" in add`);
      keys.add(a.key);
      if (!repos.has(a.repo)) throw new PlanRejected(`${a.key}: repo "${a.repo}" is not part of this project (${[...repos].join(", ")})`);
    }

    const created = new Map<string, Unit>();
    for (const a of delta.add) {
      const sctx = { projectId, repoId: a.repo as RepoId };
      const timebox = resolveSetting(db, "timebox.work_seconds", sctx).value;
      const maxAttempts = resolveSetting(db, "max_attempts", sctx).value;
      const disagreed = a.disagreement === undefined ? undefined : listDisagreements(db, { projectId }).find((x) => x.id === a.disagreement);
      const because = disagreed
        ? `On U${getUnit(db, disagreed.unitId).seq} you disagreed with "${disagreed.about}". You said: "${disagreed.reason}". This unit follows that up.`
        : null;
      const unit = addUnit(db, {
        projectId,
        type: "work",
        repoId: a.repo as RepoId,
        base: a.base ?? null,
        goal: a.goal,
        acceptance: a.acceptance,
        context: [...a.context, ...(because ? [because] : [])],
        playbook: a.playbook,
        scaffold: a.scaffold,
        refs: a.refs,
        timeboxSeconds: a.timeboxMinutes ? a.timeboxMinutes * 60 : timebox,
        maxAttempts,
      });
      if (drainId !== null) db.prepare("UPDATE units SET created_by_drain_id = ? WHERE id = ?").run(drainId, unit.id);
      created.set(a.key, getUnit(db, unit.id));
      if (a.disagreement !== undefined) {
        const d = listDisagreements(db, { projectId }).find((x) => x.id === a.disagreement);
        if (!d) throw new PlanRejected(`${a.key}: there is no disagreement D${a.disagreement} in this project`);
        if (d.state !== "open") throw new PlanRejected(`${a.key}: D${d.id} is already ${d.state}`);
        markPlanned(db, d.id, unit.id);
      }
    }

    const after = (unit: Unit, name: string, refs: string[]) => {
      for (const ref of refs) {
        const on = created.get(ref) ?? (/^U\d+$/.test(ref) ? unitRef(ref, `${name} comes after`) : undefined);
        if (!on) throw new PlanRejected(`${name} comes after "${ref}", which is neither a key in this delta nor an existing unit`);
        if (on.state === "dropped") throw new PlanRejected(`${name} comes after ${ref}, which was dropped`);
        addDep(db, { unitId: unit.id, dependsOn: on.id });
      }
    };
    for (const a of delta.add) after(created.get(a.key)!, a.key, a.after);
    assertAcyclic(db, projectId);

    for (const m of delta.amend) {
      const u = unitRef(m.unit, "amend");
      if (u.state !== "waiting" || listAttempts(db, u.id).length) throw new PlanRejected(`amend: ${m.unit} has already started (${u.state})`);
      amendUnit(db, u.id, { goal: m.goal, acceptance: m.acceptance, context: m.context });
      if (m.after) {
        db.prepare("DELETE FROM unit_deps WHERE unit_id = ?").run(u.id);
        after(u, m.unit, m.after);
      }
    }
    assertAcyclic(db, projectId);

    for (const r of delta.retry) {
      const u = unitRef(r.unit, "retry");
      if (u.state !== "stuck") throw new PlanRejected(`retry: ${r.unit} is ${u.state}; only stuck units can be retried`);
      addUnitNote(db, u.id, `Planner: ${r.note}`);
      bumpMaxAttempts(db, u.id, listAttempts(db, u.id).length + 1);
      transitionUnit(db, u.id, "waiting", { by: "planner", drain: drainId });
    }

    for (const c of delta.cancel) {
      const u = unitRef(c.unit, "cancel");
      if (TERMINAL_STATES.has(u.state)) warnings.push(`${c.unit} is already ${u.state}`);
      else if (u.state === "building") warnings.push(`${c.unit} is being built and was not cancelled; cancel it again once it is not`);
      else transitionUnit(db, u.id, "dropped", { by: "planner", reason: c.reason, drain: drainId });
    }

    for (const g of delta.gates) addGate(db, { projectId, question: g.question, options: g.options, defaultOption: g.default, kind: "planner" });

    recordEvent(db, "plan.applied", { projectId }, { drain: drainId, added: [...created.values()].map((u) => `U${u.seq}`), warnings, done: delta.done });
    return { added: [...created.values()], warnings };
  })();
}
