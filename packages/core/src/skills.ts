import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSetting, type Bootstrap } from "./config.js";
import type { ProjectId, Role, Unit } from "./domain.js";
import { getProject, projectRepos, type Db } from "./store.js";

export const SKILL_PURPOSES = ["scaffold", "work"] as const;
export type SkillPurpose = (typeof SKILL_PURPOSES)[number];

export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

// Skill folders are often symlinks into another checkout, so an entry counts when its SKILL.md resolves.
const skillNames = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md"))) : []);

// What a Claude session started by yagura can load: the developer's user skills, every installed plugin's skills, and yagura's own overlay plugin.
export function installedSkills(boot: Bootstrap, claudeDir = claudeConfigDir()): Set<string> {
  const names = new Set<string>(skillNames(join(claudeDir, "skills")));
  const add = (plugin: string, dir: string) => {
    for (const name of skillNames(join(dir, "skills"))) names.add(`${plugin}:${name}`);
  };
  const manifest = join(claudeDir, "plugins", "installed_plugins.json");
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { plugins?: Record<string, { installPath: string }[]> };
    for (const [key, installs] of Object.entries(parsed.plugins ?? {})) for (const i of installs) add(key.split("@")[0]!, i.installPath);
  }
  add("yagura", boot.skillsDir);
  return names;
}

export const isInstalled = (installed: Set<string>, skill: string) =>
  installed.has(skill) || (!skill.includes(":") && [...installed].some((n) => n.slice(n.indexOf(":") + 1) === skill));

// The project skills a session must load, on top of the role's own required skills.
export function requiredProjectSkills(db: Db, unit: Pick<Unit, "projectId" | "repoId" | "type" | "scaffold">): string[] {
  const at = { projectId: unit.projectId, repoId: unit.repoId ?? undefined, environmentId: getProject(db, unit.projectId).environmentId };
  const purpose: SkillPurpose = unit.scaffold ? "scaffold" : "work";
  return resolveSetting(db, `skills.${purpose}`, at).value;
}

export interface SkillCheck {
  skill: string;
  purposes: SkillPurpose[];
  repos: string[];
  installed: boolean;
}

export function projectSkillChecks(db: Db, boot: Bootstrap, projectId: ProjectId, claudeDir?: string): SkillCheck[] {
  const found = new Map<string, SkillCheck>();
  for (const repoId of projectRepos(db, projectId).map((r) => r.id))
    for (const purpose of SKILL_PURPOSES)
      for (const skill of resolveSetting(db, `skills.${purpose}`, { projectId, repoId, environmentId: getProject(db, projectId).environmentId }).value) {
        const c = found.get(skill) ?? { skill, purposes: [], repos: [], installed: false };
        if (!c.purposes.includes(purpose)) c.purposes.push(purpose);
        if (!c.repos.includes(repoId)) c.repos.push(repoId);
        found.set(skill, c);
      }
  if (!found.size) return [];
  const installed = installedSkills(boot, claudeDir);
  return [...found.values()].map((c) => ({ ...c, installed: isInstalled(installed, c.skill) }));
}

export function skillMethod(skills: string[]): string {
  return skills.length ? ` Then load these project skills with the Skill tool before you change anything, and follow them: ${skills.join(", ")}.` : "";
}

export const REQUIRED_SKILLS: Partial<Record<Role, readonly string[]>> = {
  worker: ["yagura:yagura-worker", "pstack:poteto-mode", "pstack:principle-prove-it-works", "pstack:principle-test-behavior-not-implementation"],
  planner: ["yagura:yagura-planner"],
  judge: ["yagura:yagura-judge"],
  lead: ["yagura:yagura-unit-lead"],
  watchman: ["yagura:yagura-watchman"],
  doctor: ["yagura:yagura-doctor"],
};

export function missingSkills(role: Role, loaded: readonly string[], project: readonly string[] = []): string[] {
  const bare = (s: string) => s.slice(s.indexOf(":") + 1);
  return [...(REQUIRED_SKILLS[role] ?? []), ...project].filter((req) => !loaded.some((l) => l === req || bare(l) === bare(req)));
}
