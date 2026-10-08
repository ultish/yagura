import { existsSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import type { ProjectId, Repo, RepoId, Sha, Unit } from "./domain.js";
import { ensureMirror, git } from "./git.js";
import { layout } from "./paths.js";
import { getRepo, listAttempts, type Db } from "./store.js";

// Read-only views of a repo's trunk for the dashboard, straight from yagura's mirror. Every commit is tied to the unit
// that landed it, by yagura's own record of the landed SHA first and the commit's trailers second, so code can always
// lead back to the story behind it.
export interface CommitUnit {
  sha: Sha;
  date: string;
  subject: string;
  author: string;
  projectId: ProjectId | null;
  seq: number | null;
  verdict: string | null;
}
export interface FileView {
  path: string;
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
  // One entry per line: the commit that last wrote it.
  blame: Sha[];
  commits: Record<string, CommitUnit>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Only loading the tree fetches; the other views read what that load (or the engine) fetched, so a page stays consistent.
async function mirrorOf(db: Db, boot: Bootstrap, repoId: RepoId, fetch = false): Promise<{ repo: Repo; mirror: string; trunk: string }> {
  const repo = getRepo(db, repoId);
  const mirror = layout(boot).mirror(repo.id);
  if (fetch || !existsSync(mirror)) await ensureMirror(repo.url, mirror);
  return { repo, mirror, trunk: `origin/${repo.defaultBranch}` };
}

const trailer = (body: string, key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(body)?.[1]?.trim() ?? null;

function unitOfCommit(db: Db, sha: string, body: string): Pick<CommitUnit, "projectId" | "seq"> {
  const landed = db.prepare("SELECT project_id, seq FROM units WHERE merged_sha = ?").get(sha) as { project_id: ProjectId; seq: number } | undefined;
  if (landed) return { projectId: landed.project_id, seq: landed.seq };
  const project = trailer(body, "Yagura-Project");
  const unit = trailer(body, "Yagura-Unit");
  return project && unit && /^U\d+$/.test(unit) ? { projectId: project as ProjectId, seq: Number(unit.slice(1)) } : { projectId: null, seq: null };
}

async function readCommits(db: Db, mirror: string, args: string[]): Promise<CommitUnit[]> {
  const out = await git(["log", "--format=%H%x00%aI%x00%an%x00%s%x00%b%x01", ...args], { gitDir: mirror });
  return out
    .split("\x01")
    .map((c) => c.replace(/^\n/, ""))
    .filter((c) => c.trim())
    .map((c) => {
      const [sha, date, author, subject, body = ""] = c.split("\x00") as [string, string, string, string, string?];
      return { sha: sha as Sha, date, author, subject, verdict: trailer(body, "Yagura-Verdict"), ...unitOfCommit(db, sha, body) };
    });
}

export async function repoTree(db: Db, boot: Bootstrap, repoId: RepoId): Promise<{ head: Sha; branch: string; files: string[] }> {
  const { repo, mirror, trunk } = await mirrorOf(db, boot, repoId, true);
  const head = (await git(["rev-parse", trunk], { gitDir: mirror })) as Sha;
  const files = (await git(["ls-tree", "-r", "--name-only", "-z", head], { gitDir: mirror })).split("\0").filter(Boolean);
  return { head, branch: repo.defaultBranch, files };
}

export async function repoFile(db: Db, boot: Bootstrap, repoId: RepoId, path: string): Promise<FileView> {
  const { mirror, trunk } = await mirrorOf(db, boot, repoId);
  const size = Number(await git(["cat-file", "-s", `${trunk}:${path}`], { gitDir: mirror }));
  const empty = { path, text: null, blame: [], commits: {} };
  if (size > MAX_FILE_BYTES) return { ...empty, binary: false, tooLarge: true };
  const text = await git(["show", `${trunk}:${path}`], { gitDir: mirror });
  if (text.includes("\0")) return { ...empty, binary: true, tooLarge: false };
  const blame = (await git(["blame", "--porcelain", trunk, "--", path], { gitDir: mirror }))
    .split("\n")
    .filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l))
    .map((l) => l.slice(0, 40) as Sha);
  const unique = [...new Set(blame)];
  const commits: Record<string, CommitUnit> = {};
  for (const c of await readCommits(db, mirror, ["--no-walk", ...unique])) commits[c.sha] = c;
  return { path, text, binary: false, tooLarge: false, blame, commits };
}

export async function repoHistory(db: Db, boot: Bootstrap, repoId: RepoId, opts: { path?: string; limit?: number } = {}): Promise<CommitUnit[]> {
  const { mirror, trunk } = await mirrorOf(db, boot, repoId);
  return readCommits(db, mirror, ["--first-parent", `-n${opts.limit ?? 100}`, trunk, ...(opts.path ? ["--", opts.path] : [])]);
}

export interface Change {
  commit: CommitUnit;
  base: Sha;
  files: string[];
  stats: Record<string, { added: number; removed: number }>;
  diff: string;
  truncated: boolean;
}

async function diffOf(mirror: string, base: string, head: string): Promise<Omit<Change, "commit" | "base">> {
  const files = (await git(["diff", "--name-only", "-z", base, head], { gitDir: mirror })).split("\0").filter(Boolean);
  const stats: Change["stats"] = {};
  for (const l of (await git(["diff", "--numstat", base, head], { gitDir: mirror })).split("\n").filter(Boolean)) {
    const [added, removed, path] = l.split("\t") as [string, string, string];
    stats[path] = { added: Number(added) || 0, removed: Number(removed) || 0 };
  }
  const diff = await git(["diff", "--stat", "--patch", "--no-color", base, head], { gitDir: mirror });
  return { files, stats, diff: diff.slice(0, MAX_DIFF_BYTES), truncated: diff.length > MAX_DIFF_BYTES };
}

// What one commit on trunk changed, against its first parent, as a merge request shows it.
export async function repoChange(db: Db, boot: Bootstrap, repoId: RepoId, sha: string): Promise<Change> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`${sha} is not a commit`);
  const { mirror } = await mirrorOf(db, boot, repoId);
  const [commit] = await readCommits(db, mirror, ["--no-walk", sha]);
  if (!commit) throw new Error(`commit ${sha} not found`);
  const parent = await git(["rev-parse", "--verify", "--quiet", `${commit.sha}^1`], { gitDir: mirror }).catch(() => EMPTY_TREE);
  return { commit, base: parent as Sha, ...(await diffOf(mirror, parent, commit.sha)) };
}

// What a unit changed: the commit that landed it, or, before it lands, its latest handed-off branch against its base.
export async function unitCode(db: Db, boot: Bootstrap, unit: Unit): Promise<(Change & { source: "merged" | "branch"; branch: string | null }) | null> {
  if (!unit.repoId) return null;
  if (unit.mergedSha) return { ...(await repoChange(db, boot, unit.repoId, unit.mergedSha)), source: "merged", branch: null };
  const work = listAttempts(db, unit.id)
    .filter((a) => a.headSha && a.baseSha && a.state === "handed_off")
    .at(-1);
  if (!work) return null;
  const { mirror } = await mirrorOf(db, boot, unit.repoId);
  const [commit] = await readCommits(db, mirror, ["--no-walk", work.headSha!]);
  return { commit: commit!, base: work.baseSha!, ...(await diffOf(mirror, work.baseSha!, work.headSha!)), source: "branch", branch: work.branch };
}

const MAX_DIFF_FILES = 200;
const MAX_DIFF_FILE_BYTES = 1024 * 1024;

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  old: string;
  new: string;
  binary: boolean;
  tooLarge: boolean;
}

// Both sides of every file changed between two commits, for an editor that draws the diff itself.
export async function diffFilesBetween(gitDir: string, base: string, head: string) {
  const listed = await git(["diff", "--name-status", "--no-renames", "-z", base, head], { gitDir }).catch(() => null);
  if (listed === null) return { base, head, files: null, omitted: 0 };
  const parts = listed.split("\0").filter(Boolean);
  const changes: { code: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ code: parts[i]!, path: parts[i + 1]! });
  const none = { text: "", binary: false, tooLarge: false };
  const side = async (sha: string, path: string) => {
    const size = Number(await git(["cat-file", "-s", `${sha}:${path}`], { gitDir }).catch(() => "-1"));
    if (size < 0) return none;
    if (size > MAX_DIFF_FILE_BYTES) return { ...none, tooLarge: true };
    const text = await git(["show", `${sha}:${path}`], { gitDir, raw: true });
    return text.includes("\0") ? { ...none, binary: true } : { ...none, text };
  };
  const files: DiffFile[] = [];
  for (const c of changes.slice(0, MAX_DIFF_FILES)) {
    const [o, n] = await Promise.all([c.code === "A" ? none : side(base, c.path), c.code === "D" ? none : side(head, c.path)]);
    files.push({
      path: c.path,
      status: c.code === "A" ? "added" : c.code === "D" ? "deleted" : "modified",
      old: o.text,
      new: n.text,
      binary: o.binary || n.binary,
      tooLarge: o.tooLarge || n.tooLarge,
    });
  }
  return { base, head, files, omitted: Math.max(0, changes.length - MAX_DIFF_FILES) };
}

export async function repoDiffFiles(db: Db, boot: Bootstrap, repoId: RepoId, base: string, head: string) {
  const { mirror } = await mirrorOf(db, boot, repoId);
  return diffFilesBetween(mirror, base, head);
}
