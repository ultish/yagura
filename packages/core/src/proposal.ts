import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { write } from "./agent.js";
import { resolveSetting, setSetting, type Bootstrap } from "./config.js";
import { SKILL_PURPOSES } from "./skills.js";
import { LAND_ROUTES, MERGE_POLICIES, PASS_TIERS, type EnvironmentId, type LandRoute, type ProjectId, type RepoId } from "./domain.js";
import { commitAll, git } from "./git.js";
import { VerifyPack } from "./pack.js";
import { layout } from "./paths.js";
import { applyDelta, PlanDelta, PlanRejected, PlanUnit } from "./plan.js";
import { checkRepoFree, inspectRepo, packStatusOf, REPO_ID, RepoUnusable, resolveSource, type RepoInspection } from "./repos.js";
import { chooseRoute, describeRoute, isRemote, routeOf, RouteNeeded } from "./route.js";
import { parseSpec, writeSpec } from "./spec.js";
import { ValueInvalid } from "./envvalues.js";
import { addEnvironment, addProject, addRepo, getEnvironment, getProject, getRepo, recordEvent, setProjectState, type Db } from "./store.js";
import { checkDraft, createEnvironment, draftFromTemplate, EnvironmentDraft, TemplateInvalid } from "./templates.js";
import { getProposal, getThread, linkThreadProject, resolveProposal } from "./threads.js";

const Slug = z.string().regex(REPO_ID, "ids are lowercase words joined by dashes, e.g. kafka-diff");
const NewRepo = z.object({ id: Slug, description: z.string().default(""), verifyPack: VerifyPack }).strict();
const ExistingRepo = z.object({ id: Slug, existing: z.string().min(1), forge: z.enum(["gh", "glab"]).optional(), land: z.literal("push").optional() }).strict();
type ExistingRepo = z.output<typeof ExistingRepo>;
const FromTemplate = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    template: z.string(),
    answers: z.record(z.string()).default({}),
    providerConfig: z.record(z.unknown()).default({}),
  })
  .strict();
type ProposedEnvironment = EnvironmentDraft | z.output<typeof FromTemplate>;

export const ProposalBody = z
  .object({
    summary: z.string().min(1),
    repos: z.array(z.union([NewRepo, ExistingRepo])).default([]),
    environments: z.array(z.union([FromTemplate, EnvironmentDraft])).default([]),
    projects: z
      .array(
        z
          .object({
            id: Slug,
            name: z.string().min(1).optional(),
            goal: z.string().min(1),
            predicate: z.string().min(1),
            repos: z.array(z.string()).min(1),
            environment: z.string().nullable().default(null),
            merge: z.enum(MERGE_POLICIES).default("human"),
            land: z.enum(LAND_ROUTES).optional(),
            minTier: z.enum(PASS_TIERS).default("unit-verified"),
            after: z.array(z.string()).default([]),
            phaseGate: z.boolean().default(false),
            refs: z.array(z.string().min(1)).default([]),
            spec: z.string().default(""),
            units: z.array(PlanUnit).default([]),
            skills: z
              .object({
                scaffold: z.array(z.string().min(1)).optional(),
                work: z.array(z.string().min(1)).optional(),
                pack: z.array(z.string().min(1)).optional(),
                verify: z.array(z.string().min(1)).optional(),
                review: z.array(z.string().min(1)).optional(),
              })
              .strict()
              .default({}),
            references: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
    amend: z.array(z.object({ project: z.string(), units: z.array(PlanUnit).min(1), reopen: z.boolean().default(true) }).strict()).default([]),
  })
  .strict()
  .refine((p) => p.repos.length + p.environments.length + p.projects.length + p.amend.length > 0, "a proposal must create or change something");
export type ProposalBody = z.output<typeof ProposalBody>;

export class ProposalInvalid extends Error {}

const isExisting = (r: ProposalBody["repos"][number]): r is ExistingRepo => "existing" in r;

const DEFAULT_ENVIRONMENT = "local";

function defaultEnvironment(db: Db, proposed: string[]): string {
  const envs = [...(db.prepare("SELECT id FROM environments ORDER BY id").all() as { id: string }[]).map((e) => e.id), ...proposed];
  if (envs.length === 1) return envs[0]!;
  if (envs.length === 0) return DEFAULT_ENVIRONMENT;
  throw new ProposalInvalid(`several environments exist (${envs.join(", ")}); name one`);
}

function draftOf(boot: Bootstrap, e: ProposedEnvironment): EnvironmentDraft {
  return "template" in e ? draftFromTemplate(boot, e.template, { id: e.id, name: e.name, answers: e.answers, config: e.providerConfig }) : e;
}

function environmentDrafts(db: Db, boot: Bootstrap, p: ProposalBody): EnvironmentDraft[] {
  const drafts: EnvironmentDraft[] = [];
  for (const e of p.environments) {
    try {
      const d = draftOf(boot, e);
      if (drafts.some((x) => x.id === d.id)) throw new ProposalInvalid(`environment ${d.id} is listed twice`);
      checkDraft(db, d);
      drafts.push(d);
    } catch (err) {
      if (err instanceof TemplateInvalid || err instanceof ValueInvalid || err instanceof z.ZodError)
        throw new ProposalInvalid(
          `environment ${e.id}: ${err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message}`,
        );
      throw err;
    }
  }
  return drafts;
}

// How each repo a proposal names would land: registered ones as set up, existing ones as proposed, new ones (local) by push.
function proposedRoutes(db: Db, p: ProposalBody): Map<string, { route: LandRoute; problem: string | null; describe: string }> {
  const out = new Map<string, { route: LandRoute; problem: string | null; describe: string }>();
  for (const r of p.repos) {
    if (!isExisting(r)) {
      out.set(r.id, { route: "push", problem: null, describe: "by pushing to main (a new local repo)" });
      continue;
    }
    try {
      const chosen = chooseRoute(db, resolveSource(r.existing), r);
      out.set(r.id, {
        route: chosen.forge === "none" ? "push" : "pr",
        problem: null,
        describe:
          chosen.forge === "gh" ? "through pull requests (gh)" : chosen.forge === "glab" ? "through merge requests (glab)" : "by pushing to its default branch",
      });
    } catch (e) {
      if (!(e instanceof RouteNeeded)) throw e;
      throw new ProposalInvalid(`repo ${r.id}: ${e.message}. Ask the developer, then set "forge" or "land" on the repo`);
    }
  }
  for (const row of db.prepare("SELECT id FROM repos").all() as { id: RepoId }[]) {
    const repo = getRepo(db, row.id);
    const problem =
      repo.forge === "none" && isRemote(repo.url) && !repo.pushConfirmed
        ? `repo ${repo.id} has no confirmed landing route (no forge, so it would push to ${repo.defaultBranch}); ask the developer to run \`yagura repo set ${repo.id} --forge gh|glab\` or \`--land push\``
        : null;
    out.set(repo.id, { route: routeOf(repo), problem, describe: describeRoute(repo) });
  }
  return out;
}

// How each proposed project would land, for the proposal card: shown before Go, flagged when it would not land as agreed.
export function proposalRoutes(db: Db, body: unknown): Record<string, { text: string; ok: boolean }> {
  const parsed = ProposalBody.safeParse(body);
  if (!parsed.success) return {};
  let routes: ReturnType<typeof proposedRoutes>;
  try {
    routes = proposedRoutes(db, parsed.data);
  } catch (e) {
    if (!(e instanceof ProposalInvalid)) throw e;
    return Object.fromEntries(parsed.data.projects.map((p) => [p.id, { text: e.message, ok: false }]));
  }
  return Object.fromEntries(
    parsed.data.projects.map((p) => {
      const each = p.repos.map((r) => ({ repo: r, route: routes.get(r) }));
      const ok = each.every(({ route }) => route && !route.problem && (!p.land || p.land === route.route));
      const text = each.map(({ repo, route }) => (each.length > 1 ? `${repo} ` : "") + (route ? `lands ${route.describe}` : "unknown repo")).join("; ");
      return [p.id, { text, ok }];
    }),
  );
}

export function validateProposal(db: Db, boot: Bootstrap, threadId: number, p: ProposalBody): void {
  const newEnvs = environmentDrafts(db, boot, p).map((d) => d.id);
  const repoExists = (id: string) => !!db.prepare("SELECT 1 FROM repos WHERE id = ?").get(id);
  const projectExists = (id: string) => !!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id);
  const newRepos = new Set<string>();
  for (const r of p.repos) {
    if (newRepos.has(r.id)) throw new ProposalInvalid(`repo ${r.id} is listed twice`);
    try {
      if (isExisting(r)) checkRepoFree(db, r.id, resolveSource(r.existing));
      else if (repoExists(r.id))
        throw new RepoUnusable(`repo ${r.id} is already registered; leave it out of the proposal's repos and name it in the project's repos`);
    } catch (e) {
      if (e instanceof RepoUnusable) throw new ProposalInvalid(e.message);
      throw e;
    }
    newRepos.add(r.id);
  }
  const routes = proposedRoutes(db, p);
  const earlier = new Set<string>();
  for (const proj of p.projects) {
    if (projectExists(proj.id) || earlier.has(proj.id)) throw new ProposalInvalid(`project ${proj.id} already exists`);
    for (const r of proj.repos)
      if (!repoExists(r) && !newRepos.has(r)) throw new ProposalInvalid(`${proj.id}: repo ${r} is neither registered nor created by this proposal`);
    for (const r of proj.repos) {
      const route = routes.get(r)!;
      if (route.problem) throw new ProposalInvalid(`${proj.id}: ${route.problem}`);
      if (proj.land === "pr" && route.route === "push")
        throw new ProposalInvalid(
          `${proj.id}: land "pr", but repo ${r} lands ${route.describe} (it has no forge); tell the developer, who can give it a forge or agree to push`,
        );
      if (proj.land === "push" && route.route === "pr")
        throw new ProposalInvalid(`${proj.id}: land "push", but repo ${r} lands ${route.describe}; drop land or ask the developer`);
    }
    for (const a of proj.after)
      if (!projectExists(a) && !earlier.has(a))
        throw new ProposalInvalid(`${proj.id}: after ${a}, which is neither an existing project nor listed earlier in this proposal`);
    if (proj.environment && !newEnvs.includes(proj.environment)) {
      if (!db.prepare("SELECT 1 FROM environments WHERE id = ?").get(proj.environment))
        throw new ProposalInvalid(`${proj.id}: environment ${proj.environment} does not exist`);
    }
    if (!proj.environment) defaultEnvironment(db, newEnvs);
    for (const r of proj.references)
      if (!repoExists(r) && !newRepos.has(r)) throw new ProposalInvalid(`${proj.id}: reference repo ${r} is neither registered nor created by this proposal`);
    for (const u of proj.units)
      if (!proj.repos.includes(u.repo)) throw new ProposalInvalid(`${proj.id}: unit ${u.key} uses repo ${u.repo}, which is not one of the project's repos`);
    earlier.add(proj.id);
  }
  const linked = new Set(getThread(db, threadId).projects as string[]);
  for (const a of p.amend) {
    if (!linked.has(a.project)) throw new ProposalInvalid(`amend: project ${a.project} is not part of this thread`);
    const state = getProject(db, a.project as ProjectId).state;
    if (state === "closed" && !a.reopen) throw new ProposalInvalid(`amend: project ${a.project} is closed; set reopen to add units`);
  }
}

export async function inspectProposalRepos(p: ProposalBody, mirror?: (id: string) => string): Promise<Map<string, RepoInspection>> {
  const out = new Map<string, RepoInspection>();
  for (const r of p.repos.filter(isExisting)) {
    try {
      out.set(r.id, await inspectRepo(r.existing, mirror?.(r.id)));
    } catch (e) {
      if (e instanceof RepoUnusable) throw new ProposalInvalid(`repo ${r.id}: ${e.message}`);
      throw e;
    }
  }
  return out;
}

async function createLocalRepo(boot: Bootstrap, db: Db, r: z.output<typeof NewRepo>): Promise<string> {
  const bare = layout(boot).newRepo(r.id);
  if (existsSync(bare)) return bare;
  const seed = mkdtempSync(join(tmpdir(), `yagura-seed-${r.id}-`));
  try {
    write(join(seed, "README.md"), `# ${r.id}\n\n${r.description}\n`.replace(/\n\n\n$/, "\n"));
    write(join(seed, ".agents/verify/verify.json"), `${JSON.stringify(r.verifyPack, null, 2)}\n`);
    await git(["init", "--quiet", "-b", "main"], { cwd: seed });
    await commitAll(seed, `chore: start ${r.id}`, { name: resolveSetting(db, "git.author_name").value, email: resolveSetting(db, "git.author_email").value });
    await git(["clone", "--quiet", "--bare", seed, bare]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return bare;
}

export interface ApplyProposalResult {
  repos: string[];
  environments: string[];
  projects: string[];
  units: Record<string, string[]>;
}

export async function applyProposal(ctx: { db: Db; boot: Bootstrap }, proposalId: number): Promise<ApplyProposalResult> {
  const { db, boot } = ctx;
  const proposal = getProposal(db, proposalId);
  if (proposal.state !== "pending") throw new Error(`proposal ${proposalId} is ${proposal.state}`);
  const body = ProposalBody.parse(proposal.body);
  try {
    validateProposal(db, boot, proposal.threadId, body);
    const drafts = environmentDrafts(db, boot, body);
    const created: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const e = body.environments[i]!;
      created.push(createEnvironment(db, d, "template" in e ? `template ${e.template}` : "watchman"));
    }
    const existing = await inspectProposalRepos(body, (id) => layout(boot).mirror(id as RepoId));
    const bares = new Map<string, string>();
    for (const r of body.repos) if (!isExisting(r)) bares.set(r.id, await createLocalRepo(boot, db, r));
    const result = db.transaction((): ApplyProposalResult => {
      const out: ApplyProposalResult = { repos: [], environments: created, projects: [], units: {} };
      for (const r of body.repos) {
        const seen = existing.get(r.id);
        if (seen && isExisting(r))
          addRepo(db, { id: r.id, url: seen.url, defaultBranch: seen.defaultBranch, ...chooseRoute(db, seen.url, r), packStatus: packStatusOf(seen.pack) });
        else addRepo(db, { id: r.id, url: bares.get(r.id)!, defaultBranch: "main", packStatus: "unproven" });
        out.repos.push(r.id);
      }
      for (const p of body.projects) {
        const env = p.environment ?? defaultEnvironment(db, []);
        if (!db.prepare("SELECT 1 FROM environments WHERE id = ?").get(env)) {
          addEnvironment(db, { id: env, name: env, provider: "local-process", capacity: 2 });
          out.environments.push(env);
        }
        const project = addProject(db, {
          id: p.id,
          name: p.name ?? p.id,
          goal: p.goal,
          predicate: p.predicate,
          minTier: p.minTier,
          repos: p.repos as RepoId[],
          refs: p.refs,
          after: p.after as ProjectId[],
          phaseGate: p.phaseGate,
          mergePolicy: p.merge,
          land: p.land ?? null,
          environmentId: env as EnvironmentId,
        });
        linkThreadProject(db, proposal.threadId, project.id);
        for (const purpose of SKILL_PURPOSES) {
          const skills = p.skills[purpose];
          if (skills) setSetting(db, "project", project.id, `skills.${purpose}`, skills);
        }
        if (p.references.length) setSetting(db, "project", project.id, "project.reference_repos", p.references);
        if (p.units.length) out.units[p.id] = applyDelta(db, project.id, PlanDelta.parse({ add: p.units }), null).added.map((u) => `U${u.seq}`);
        out.projects.push(p.id);
      }
      for (const a of body.amend) {
        const id = a.project as ProjectId;
        if (getProject(db, id).state === "closed") setProjectState(db, id, "active");
        out.units[a.project] = [...(out.units[a.project] ?? []), ...applyDelta(db, id, PlanDelta.parse({ add: a.units }), null).added.map((u) => `U${u.seq}`)];
      }
      resolveProposal(db, proposalId, "applied", out);
      return out;
    })();
    for (const p of body.projects) if (p.spec.trim()) writeSpec(layout(boot).spec(p.id as ProjectId), parseSpec(p.spec));
    return result;
  } catch (e) {
    if (e instanceof ProposalInvalid || e instanceof PlanRejected) {
      resolveProposal(db, proposalId, "failed", { error: e.message });
      recordEvent(db, "proposal.apply_failed", {}, { thread: proposal.threadId, proposal: proposalId, error: e.message });
    }
    throw e;
  }
}

export function discardProposal(db: Db, proposalId: number, reason = ""): void {
  resolveProposal(db, proposalId, "discarded", { reason });
}

export function describeProposal(body: ProposalBody): string {
  const lines = [body.summary, ""];
  for (const r of body.repos)
    lines.push(
      isExisting(r)
        ? `- existing repo ${r.id}: ${r.existing}${r.forge ? ` (forge ${r.forge})` : r.land ? " (pushes to its default branch)" : ""}`
        : `- new repo ${r.id}${r.description ? `: ${r.description}` : ""} (checks: ${r.verifyPack.checks.map((c) => c.name).join(", ")})`,
    );
  for (const e of body.environments) {
    if ("template" in e) {
      const answered = Object.keys(e.answers);
      lines.push(`- environment ${e.id} from template ${e.template}${answered.length ? ` (answers: ${answered.join(", ")})` : ""}`);
      continue;
    }
    const parts = [...e.values.map((v) => v.name), ...e.presets.map((p) => `preset ${p}`)];
    lines.push(`- environment ${e.id} (${e.provider}, ${e.capacity} slots)${parts.length ? `: ${parts.join(", ")}` : ""}`);
  }
  for (const p of body.projects) {
    const facts = [
      `repos ${p.repos.join(", ")}`,
      `merge ${p.merge}`,
      p.land === "pr" ? "lands through pull/merge requests" : p.land === "push" ? "pushes to the default branch" : "",
      `min ${p.minTier}`,
      p.after.length ? `after ${p.after.join(", ")}` : "",
      p.phaseGate ? "phase gate" : "",
      p.environment ? `env ${p.environment}` : "",
      ...SKILL_PURPOSES.flatMap((k) => (p.skills[k]?.length ? [`${k} skills ${p.skills[k]!.join(", ")}`] : [])),
      p.references.length ? `references ${p.references.join(", ")}` : "",
    ];
    lines.push(`- project ${p.id}: ${p.goal}`, `  done when: ${p.predicate}`, `  ${facts.filter(Boolean).join(" · ")}`);
    for (const u of p.units) lines.push(`  - unit ${u.key}: ${u.goal}`);
  }
  for (const a of body.amend) for (const u of a.units) lines.push(`- ${a.project} + unit ${u.key}: ${u.goal}`);
  return lines.join("\n");
}
