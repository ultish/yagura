import picomatch from "picomatch";
import { z } from "zod";
import { resolveSetting } from "./config.js";
import { listDisagreements, markPlanned } from "./disagreements.js";
import { TERMINAL_STATES, isBuild, type ProjectId, type RepoId, type Unit, type UnitId } from "./domain.js";
import {
  addDep,
  addGate,
  addUnit,
  addUnitNote,
  amendUnit,
  getRepo,
  bumpMaxAttempts,
  getUnit,
  getUnitBySeq,
  listAttempts,
  listDeps,
  listUnits,
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

const Deps = z.array(z.object({ on: z.string(), kind: z.enum(["needs-landed", "needs-source"]).default("needs-landed") }).strict());

export const PlanUnit = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/, "keys are lowercase words, e.g. discount-create"),
    repo: z.string(),
    goal: z.string().min(1),
    write: z.array(z.string().min(1)).min(1),
    forbid: z.array(z.string()).default([]),
    accept: z.array(z.string().min(1)).min(1),
    verify: z.string().min(1),
    context: z.array(z.string()).default([]),
    playbook: z.enum(WORK_PLAYBOOKS).default("feature"),
    scaffold: z.boolean().default(false),
    timeboxMinutes: z.number().int().positive().max(240).optional(),
    refs: z.array(z.string().min(1)).default([]),
    disagreement: z.number().int().positive().optional(),
    deps: Deps.default([]),
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
            write: z.array(z.string().min(1)).min(1).optional(),
            accept: z.array(z.string().min(1)).min(1).optional(),
            verify: z.string().min(1).optional(),
            context: z.array(z.string()).optional(),
            deps: Deps.optional(),
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
  .strict();
export type PlanDelta = z.output<typeof PlanDelta>;

export type Extracted = { ok: true; delta: PlanDelta } | { ok: false; reason: string };

export function extractDelta(message: string): Extracted {
  const blocks = [...message.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = blocks.at(-1);
  if (!last) return { ok: false, reason: "no ```json plan delta block in the final message" };
  let json: unknown;
  try {
    json = JSON.parse(last[1]!);
  } catch (e) {
    return { ok: false, reason: `plan delta is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = PlanDelta.safeParse(json);
  if (!parsed.success)
    return {
      ok: false,
      reason: `plan delta does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  for (const g of parsed.data.gates)
    if (!g.options.includes(g.default)) return { ok: false, reason: `gate "${g.question}": default must be one of its options` };
  return { ok: true, delta: parsed.data };
}

export class PlanRejected extends Error {}

function scopeBase(glob: string): string[] {
  return picomatch
    .scan(glob)
    .base.split("/")
    .filter((s) => s && s !== ".");
}

export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) =>
    b.some((y) => {
      const [p, q] = [scopeBase(x), scopeBase(y)];
      const n = Math.min(p.length, q.length);
      return p.slice(0, n).every((seg, i) => seg === q[i]);
    }),
  );
}

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

    // Verifiers maintain the verify pack; a work unit that lists it would get a brief that both allows and forbids it.
    const withoutPack = (name: string, repoId: string, write: string[]) => {
      const pack = getRepo(db, repoId as RepoId).verifyPackPath;
      const kept = write.filter((g) => g !== pack && !g.startsWith(`${pack}/`));
      if (!kept.length) throw new PlanRejected(`${name} only writes the verify pack (${pack}); verifiers maintain the pack, so leave it out of the plan`);
      if (kept.length < write.length) warnings.push(`${name}: dropped ${pack} from its write scope; verifiers maintain the verify pack`);
      return kept;
    };

    const created = new Map<string, Unit>();
    for (const a of delta.add) {
      const sctx = { projectId, repoId: a.repo as RepoId };
      const timebox = resolveSetting(db, "timebox.work_seconds", sctx).value;
      const maxAttempts = resolveSetting(db, "max_attempts", sctx).value;
      const unit = addUnit(db, {
        projectId,
        type: "work",
        repoId: a.repo as RepoId,
        goal: a.goal,
        writeScope: withoutPack(a.key, a.repo, a.write),
        forbidScope: a.forbid,
        acceptance: a.accept,
        verify: a.verify,
        context: a.context,
        playbook: a.playbook,
        scaffold: a.scaffold,
        refs: a.refs,
        timeboxSeconds: a.timeboxMinutes ? a.timeboxMinutes * 60 : timebox,
        maxAttempts,
      });
      if (drainId !== null) db.prepare("UPDATE units SET created_by_drain_id = ? WHERE id = ?").run(drainId, unit.id);
      transitionUnit(db, unit.id, "ready", { drain: drainId });
      created.set(a.key, getUnit(db, unit.id));
      if (a.disagreement !== undefined) {
        const d = listDisagreements(db, { projectId }).find((x) => x.id === a.disagreement);
        if (!d) throw new PlanRejected(`${a.key}: there is no disagreement D${a.disagreement} in this project`);
        if (d.state !== "open") throw new PlanRejected(`${a.key}: D${d.id} is already ${d.state}`);
        markPlanned(db, d.id, unit.id);
      }
    }

    const addDeps = (unit: Unit, name: string, deps: z.output<typeof Deps>) => {
      for (const d of deps) {
        const on = created.get(d.on) ?? (/^U\d+$/.test(d.on) ? unitRef(d.on, `${name} depends on`) : undefined);
        if (!on) throw new PlanRejected(`${name} depends on "${d.on}", which is neither a key in this delta nor an existing unit`);
        if (on.state === "abandoned") throw new PlanRejected(`${name} depends on ${d.on}, which is abandoned`);
        addDep(db, { unitId: unit.id, dependsOn: on.id, kind: d.kind });
      }
    };
    for (const a of delta.add) addDeps(created.get(a.key)!, a.key, a.deps);

    const serialize = (unit: Unit) => {
      for (const other of listUnits(db, projectId).filter((u) => isBuild(u) && !TERMINAL_STATES.has(u.state)))
        if (other.id < unit.id && other.repoId === unit.repoId && scopesOverlap(unit.writeScope, other.writeScope))
          addDep(db, { unitId: unit.id, dependsOn: other.id, kind: "scope-overlap" });
    };
    for (const unit of created.values()) serialize(unit);
    assertAcyclic(db, projectId);

    for (const m of delta.amend) {
      const u = unitRef(m.unit, "amend");
      if (!["draft", "ready"].includes(u.state) || listAttempts(db, u.id).length) throw new PlanRejected(`amend: ${m.unit} has already started (${u.state})`);
      amendUnit(db, u.id, {
        goal: m.goal,
        writeScope: m.write && withoutPack(m.unit, u.repoId!, m.write),
        acceptance: m.accept,
        verify: m.verify,
        context: m.context,
      });
      if (m.deps) {
        db.prepare("DELETE FROM unit_deps WHERE unit_id = ? AND kind <> 'scope-overlap'").run(u.id);
        addDeps(u, m.unit, m.deps);
        serialize(getUnit(db, u.id));
      }
    }
    assertAcyclic(db, projectId);

    for (const r of delta.retry) {
      const u = unitRef(r.unit, "retry");
      if (!["blocked", "failed", "rejected"].includes(u.state))
        throw new PlanRejected(`retry: ${r.unit} is ${u.state}; only blocked, failed, or rejected units can be retried`);
      addUnitNote(db, u.id, `Planner: ${r.note}`);
      bumpMaxAttempts(db, u.id, listAttempts(db, u.id).length + 1);
      transitionUnit(db, u.id, "ready", { by: "planner", drain: drainId });
    }

    for (const c of delta.cancel) {
      const u = unitRef(c.unit, "cancel");
      if (TERMINAL_STATES.has(u.state)) warnings.push(`${c.unit} is already ${u.state}`);
      else if (u.state === "running") warnings.push(`${c.unit} is running and was not cancelled; cancel it again after it hands off`);
      else transitionUnit(db, u.id, "abandoned", { by: "planner", reason: c.reason, drain: drainId });
    }

    for (const g of delta.gates) addGate(db, { projectId, question: g.question, options: g.options, defaultOption: g.default, kind: "planner" });

    recordEvent(db, "plan.applied", { projectId }, { drain: drainId, added: [...created.values()].map((u) => `U${u.seq}`), warnings, done: delta.done });
    return { added: [...created.values()], warnings };
  })();
}
