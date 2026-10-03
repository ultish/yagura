import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Bootstrap } from "./config.js";
import type { Forge, PackStatus, Repo, RepoId, Sha } from "./domain.js";
import { ensureMirror, git, readFileAt } from "./git.js";
import { parsePack, type PackLoad } from "./pack.js";
import { layout } from "./paths.js";
import { chooseRoute } from "./route.js";
import { addRepo, recordEvent, type Db } from "./store.js";

export const REPO_ID = /^[a-z][a-z0-9-]{1,39}$/;
const PACK_PATH = ".agents/verify";

export class RepoUnusable extends Error {}

const isUrl = (source: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/\s]+@[^/\s:]+:/.test(source);

export function resolveSource(source: string): string {
  const s = source.trim();
  if (isUrl(s)) return s;
  return resolve(s === "~" || s.startsWith("~/") ? join(homedir(), s.slice(1)) : s);
}

export function suggestRepoId(source: string): string {
  if (!source.trim()) return "repo";
  const name = basename(
    resolveSource(source)
      .replace(/[/:]+$/, "")
      .replace(/\.git$/, ""),
  )
    .split(":")
    .pop()!;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 40);
  return REPO_ID.test(slug) ? slug : "repo";
}

export interface RepoInspection {
  url: string;
  defaultBranch: string;
  trunk: Sha;
  pack: PackLoad;
  notes: string[];
}

export const packStatusOf = (pack: PackLoad): PackStatus => (pack.ok ? "unproven" : "missing");

// Trunk's pack as last read: a proof is kept while a pack still parses, and lost when it no longer does.
export function syncPackStatus(db: Db, repoId: RepoId, pack: PackLoad): PackStatus {
  db.prepare("UPDATE repos SET publish_json = ? WHERE id = ?").run(pack.ok && pack.pack.publish ? JSON.stringify(pack.pack.publish) : null, repoId);
  const current = (db.prepare("SELECT pack_status FROM repos WHERE id = ?").get(repoId) as { pack_status: PackStatus }).pack_status;
  const next: PackStatus = !pack.ok ? "missing" : current === "missing" ? "unproven" : current;
  if (next !== current) {
    db.prepare("UPDATE repos SET pack_status = ?, pack_proven_sha = CASE WHEN ? = 'missing' THEN NULL ELSE pack_proven_sha END WHERE id = ?").run(
      next,
      next,
      repoId,
    );
    recordEvent(db, "repo.pack_status", {}, { repo: repoId, from: current, to: next, reason: pack.ok ? null : pack.reason });
  }
  return next;
}

async function remoteHead(url: string): Promise<{ defaultBranch: string; trunk: Sha }> {
  let out: string;
  try {
    out = await git(["ls-remote", "--symref", url, "HEAD"]);
  } catch (e) {
    const detail = (e as { stderr?: string }).stderr?.trim().split("\n").pop() ?? (e instanceof Error ? e.message : String(e));
    throw new RepoUnusable(`cannot read ${url} as a git repo: ${detail}`);
  }
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1];
  const sha = /^([0-9a-f]{40})\tHEAD$/m.exec(out)?.[1];
  if (!branch || !sha) throw new RepoUnusable(`${url} has no commits on a default branch`);
  return { defaultBranch: branch, trunk: sha as Sha };
}

// A working copy would be the landing target, and git refuses a push to its checked-out branch.
async function refuseWorkingCopy(url: string): Promise<void> {
  if (isUrl(url) || !existsSync(url)) return;
  if ((await git(["rev-parse", "--is-bare-repository"], { cwd: url }).catch(() => "true")) === "true") return;
  const origin = await git(["remote", "get-url", "origin"], { cwd: url }).catch(() => "");
  throw new RepoUnusable(`${url} is a working copy; give the repo's git URL instead${origin ? ` (its origin is ${origin})` : ""}`);
}

export async function inspectRepo(source: string, mirror?: string): Promise<RepoInspection> {
  const url = resolveSource(source);
  await refuseWorkingCopy(url);
  const { defaultBranch, trunk } = await remoteHead(url);
  const gitDir = mirror ?? mkdtempSync(join(tmpdir(), "yagura-inspect-"));
  try {
    if (mirror) await ensureMirror(url, gitDir);
    else await git(["clone", "--bare", "--quiet", "--depth", "1", "--branch", defaultBranch, url, gitDir]);
    const pack = parsePack(await readFileAt(gitDir, trunk, `${PACK_PATH}/verify.json`), PACK_PATH);
    const notes = pack.ok ? [] : [`${pack.reason}; verification stays env-blocked until a pack lands on ${defaultBranch}`];
    return { url, defaultBranch, trunk, pack, notes };
  } finally {
    if (!mirror) rmSync(gitDir, { recursive: true, force: true });
  }
}

export function checkRepoFree(db: Db, id: string, url: string): void {
  if (!REPO_ID.test(id)) throw new RepoUnusable(`repo id ${id} must be lowercase words joined by dashes, e.g. kafka-diff`);
  if (db.prepare("SELECT 1 FROM repos WHERE id = ?").get(id)) throw new RepoUnusable(`repo ${id} already exists`);
  const same = db.prepare("SELECT id FROM repos WHERE url = ?").get(url) as { id: string } | undefined;
  if (same) throw new RepoUnusable(`${url} is already registered as repo ${same.id}`);
}

export async function registerRepo(
  ctx: { db: Db; boot: Bootstrap },
  input: { source: string; id?: string; forge?: Forge; land?: "push" },
): Promise<{ repo: Repo; inspection: RepoInspection }> {
  const id = input.id?.trim() || suggestRepoId(input.source);
  checkRepoFree(ctx.db, id, resolveSource(input.source));
  const route = chooseRoute(ctx.db, resolveSource(input.source), input);
  const inspection = await inspectRepo(input.source, layout(ctx.boot).mirror(id as RepoId));
  const repo = addRepo(ctx.db, { id, url: inspection.url, defaultBranch: inspection.defaultBranch, ...route, packStatus: packStatusOf(inspection.pack) });
  return { repo, inspection };
}

async function packTree(mirror: string, ref: string, path: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", `${ref}:${path}`], { cwd: mirror })).trim();
  } catch {
    return null;
  }
}

// A proven pack whose files changed on trunk since it was proven is stale until a verification passes it again.
export async function notePackStale(db: Db, repo: Repo, mirror: string): Promise<PackStatus> {
  if (repo.packStatus !== "proven" || !repo.packProvenSha) return repo.packStatus;
  const [then, now_] = await Promise.all([
    packTree(mirror, repo.packProvenSha, repo.verifyPackPath),
    packTree(mirror, `origin/${repo.defaultBranch}`, repo.verifyPackPath),
  ]);
  if (!then || !now_ || then === now_) return "proven";
  db.prepare("UPDATE repos SET pack_status = 'stale' WHERE id = ?").run(repo.id);
  recordEvent(
    db,
    "repo.pack_status",
    {},
    { repo: repo.id, from: "proven", to: "stale", reason: `the pack changed on ${repo.defaultBranch} since ${repo.packProvenSha.slice(0, 10)}` },
  );
  return "stale";
}

// Every verification runs the trunk pack's doctor, deploy, and checks on trunk; when all of them pass, with the pack as
// trunk has it (the verifier changed nothing), that is a proof of the pack.
export function proveTrunkPack(
  db: Db,
  repoId: RepoId,
  trunkSha: string,
  runs: { label: string; at: string; exitCode: number | null; timedOut: boolean }[],
  checks: { name: string }[],
): boolean {
  const status = (db.prepare("SELECT pack_status FROM repos WHERE id = ?").get(repoId) as { pack_status: PackStatus }).pack_status;
  if (status !== "unproven" && status !== "stale") return false;
  const onTrunk = runs.filter((r) => r.at === "base");
  const ok = (r: { exitCode: number | null; timedOut: boolean }) => r.exitCode === 0 && !r.timedOut;
  const lifecycle = onTrunk.filter((r) => r.label === "pack:doctor" || r.label === "pack:deploy");
  const everyCheck = checks.every((c) => {
    const run = onTrunk.filter((r) => r.label === `check:${c.name}`).at(-1);
    return run && ok(run);
  });
  if (!checks.length || !everyCheck || !lifecycle.every(ok)) return false;
  db.prepare("UPDATE repos SET pack_status = 'proven', pack_proven_sha = ? WHERE id = ?").run(trunkSha, repoId);
  recordEvent(db, "repo.pack_status", {}, { repo: repoId, from: status, to: "proven", sha: trunkSha, by: "verification" });
  return true;
}
