import { resolveSetting } from "./config.js";
import type { Forge, LandRoute, Project, Repo } from "./domain.js";
import type { Db } from "./store.js";

export class RouteNeeded extends Error {}

const isUrl = (url: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\s]+@[^/\s:]+:/.test(url);

// A local path or file:// repo is yagura's own or a test's; only a remote's trunk needs a deliberate route.
export const isRemote = (url: string) => isUrl(url) && !/^file:\/\//i.test(url);

export function hostOf(url: string): string | null {
  const scp = /^[^/\s]+@([^/\s:]+):/.exec(url);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function inferForge(db: Db, url: string): Forge | null {
  const host = hostOf(url);
  if (!host) return null;
  if (host === "github.com") return "gh";
  const withPort = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? new URL(url).host.toLowerCase() : host;
  return resolveSetting(db, "forge.glab_hosts").value.some((h) => [host, withPort].includes(h.toLowerCase())) ? "glab" : null;
}

export function chooseRoute(db: Db, url: string, choice: { forge?: Forge; land?: "push" }): { forge: Forge; pushConfirmed: boolean } {
  if (choice.forge && choice.forge !== "none") return { forge: choice.forge, pushConfirmed: false };
  if (choice.land === "push" || !isRemote(url)) return { forge: "none", pushConfirmed: true };
  if (choice.forge === "none")
    throw new RouteNeeded(`pushing straight to the default branch of ${url} has to be chosen as such (land push), not as forge none`);
  const inferred = inferForge(db, url);
  if (inferred) return { forge: inferred, pushConfirmed: false };
  throw new RouteNeeded(
    `yagura cannot tell how ${url} lands: through pull requests (forge gh), merge requests (forge glab), or by pushing to the default branch (land push); GitLab hosts can be listed in forge.glab_hosts`,
  );
}

export const routeOf = (repo: Repo): LandRoute => (repo.forge === "none" ? "push" : "pr");

export function describeRoute(repo: Repo): string {
  if (repo.forge === "gh") return "through pull requests (gh)";
  if (repo.forge === "glab") return "through merge requests (glab)";
  return isRemote(repo.url) && !repo.pushConfirmed ? `by pushing to ${repo.defaultBranch}, not confirmed` : `by pushing to ${repo.defaultBranch}`;
}

// Why a unit of this project may not land in this repo the way the repo is set up, or null.
export function routeProblem(project: Project, repo: Repo): string | null {
  if (repo.forge === "none" && isRemote(repo.url) && !repo.pushConfirmed)
    return `how should ${repo.id} land? It has no forge, so yagura would push straight to ${repo.defaultBranch}. Choose with \`yagura repo set ${repo.id} --forge gh|glab\` or \`--land push\`, then retry`;
  if (project.land === "pr" && repo.forge === "none")
    return `${project.id} was agreed to land through pull or merge requests, but ${repo.id} has no forge and would push to ${repo.defaultBranch}; set one with \`yagura repo set ${repo.id} --forge gh|glab\`, then retry`;
  if (project.land === "push" && repo.forge !== "none")
    return `${project.id} was agreed to push to ${repo.defaultBranch}, but ${repo.id} lands ${describeRoute(repo)}; change the repo or the project, then retry`;
  return null;
}
