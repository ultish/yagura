import { spawn } from "node:child_process";
import { sourceEnv } from "./sources.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { Bootstrap } from "./config.js";
import type { ArtifactId, AttemptId, ProjectId, Sha } from "./domain.js";
import { isPristine, readFileAt, restorePristine } from "./git.js";
import { activeLease } from "./leases.js";
import { loadPack, parsePack, type PackLoad } from "./pack.js";
import { overlayPack, packWorkspaceOf } from "./packedits.js";
import { layout } from "./paths.js";
import { getAttempt, getRepo, getUnit, now, recordEvent, type Db } from "./store.js";

const MAX_CAPTURE = 5 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

export type At = "base" | "head";

export interface EvidenceRun {
  id: number;
  attemptId: AttemptId;
  at: At;
  sha: Sha;
  label: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  tampered: boolean;
  durationMs: number;
  stdoutArtifactId: ArtifactId | null;
  stderrArtifactId: ArtifactId | null;
}

export const artifactsDir = (boot: Bootstrap, projectId: ProjectId) => join(boot.home, "projects", projectId, "artifacts");

export function putArtifact(
  db: Db,
  boot: Bootstrap,
  a: { projectId: ProjectId; attemptId: AttemptId; kind: string; label: string; data: Buffer; evidenceRunId?: number },
): ArtifactId {
  const sha256 = createHash("sha256").update(a.data).digest("hex");
  const dir = artifactsDir(boot, a.projectId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sha256);
  if (!existsSync(path)) writeFileSync(path, a.data);
  return Number(
    db
      .prepare("INSERT INTO artifacts (sha256, attempt_id, source, kind, label, bytes, evidence_run_id, created_at) VALUES (?, ?, 'daemon', ?, ?, ?, ?, ?)")
      .run(sha256, a.attemptId, a.kind, a.label, a.data.length, a.evidenceRunId ?? null, now()).lastInsertRowid,
  ) as ArtifactId;
}

export const baseWorktree = (headWorktree: string) => `${headWorktree}.base`;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
): Promise<{ exitCode: number | null; timedOut: boolean; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout.on("data", (d: Buffer) => outLen < MAX_CAPTURE && (out.push(d), (outLen += d.length)));
    child.stderr.on("data", (d: Buffer) => errLen < MAX_CAPTURE && (err.push(d), (errLen += d.length)));
    let timedOut = false;
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, sig);
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutSeconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

type RunRequest = { attemptId: AttemptId; at: At; label: string; command: string; timeoutSeconds?: number };

export const PACK_LABEL = (step: "doctor" | "deploy" | "teardown") => `pack:${step}`;
const LIFECYCLE_SECONDS = 900;

// A pack unit's proof uses the pack it wrote; a verification uses its verifier's copy of trunk's pack, which the
// verifier may fix or extend and which runs on both sides alike. The worker's change never supplies the pack.
export async function packForAttempt(db: Db, boot: Bootstrap, attemptId: AttemptId): Promise<PackLoad> {
  const attempt = getAttempt(db, attemptId);
  const unit = getUnit(db, attempt.unitId);
  const target = unit.targetUnitId ? getUnit(db, unit.targetUnitId) : null;
  const repo = getRepo(db, unit.repoId!);
  const workspace = packWorkspaceOf(db, attemptId);
  if (workspace) return loadPack(workspace, repo.verifyPackPath);
  const mirror = layout(boot).mirror(repo.id);
  const ref = target?.type === "pack" ? attempt.headSha! : `origin/${repo.defaultBranch}`;
  return parsePack(await readFileAt(mirror, ref, `${repo.verifyPackPath}/verify.json`), repo.verifyPackPath);
}

export function deployedSide(db: Db, attemptId: AttemptId): At | null {
  const last = db
    .prepare("SELECT label, at FROM evidence_runs WHERE attempt_id = ? AND label IN (?, ?) ORDER BY id DESC LIMIT 1")
    .get(attemptId, PACK_LABEL("deploy"), PACK_LABEL("teardown")) as { label: string; at: At } | undefined;
  return last?.label === PACK_LABEL("deploy") ? last.at : null;
}

export async function runEvidence(db: Db, boot: Bootstrap, req: RunRequest): Promise<EvidenceRun> {
  if (!req.label.startsWith("pack:")) {
    const pack = await packForAttempt(db, boot, req.attemptId);
    if (pack.ok && pack.pack.deploy) {
      const side = deployedSide(db, req.attemptId);
      if (side !== req.at) {
        if (side && pack.pack.teardown)
          await captureRun(db, boot, { ...req, at: side, label: PACK_LABEL("teardown"), command: pack.pack.teardown, timeoutSeconds: LIFECYCLE_SECONDS });
        await captureRun(db, boot, { ...req, label: PACK_LABEL("deploy"), command: pack.pack.deploy, timeoutSeconds: LIFECYCLE_SECONDS });
      }
    }
  }
  return captureRun(db, boot, req);
}

export async function teardownDeployed(db: Db, boot: Bootstrap, attemptId: AttemptId): Promise<EvidenceRun | null> {
  const side = deployedSide(db, attemptId);
  const pack = side ? await packForAttempt(db, boot, attemptId) : null;
  if (!side || !pack?.ok || !pack.pack.teardown) return null;
  return captureRun(db, boot, { attemptId, at: side, label: PACK_LABEL("teardown"), command: pack.pack.teardown, timeoutSeconds: LIFECYCLE_SECONDS });
}

async function captureRun(db: Db, boot: Bootstrap, req: RunRequest): Promise<EvidenceRun> {
  const attempt = getAttempt(db, req.attemptId);
  const unit = getUnit(db, attempt.unitId);
  if (unit.type !== "verify") throw new Error(`attempt ${attempt.id} is not a verify attempt`);
  if (attempt.state !== "queued" && attempt.state !== "running")
    throw new Error(`attempt ${attempt.id} is ${attempt.state}; evidence can only be captured while it runs`);
  if (!attempt.worktreePath || !attempt.baseSha || !attempt.headSha) throw new Error(`attempt ${attempt.id} has no checkouts`);
  const sha = req.at === "head" ? attempt.headSha : attempt.baseSha;
  const cwd = req.at === "head" ? attempt.worktreePath : baseWorktree(attempt.worktreePath);

  const tampered = !(await isPristine(cwd, sha));
  if (tampered) await restorePristine(cwd, sha);
  const workspace = packWorkspaceOf(db, attempt.id);
  if (workspace) overlayPack(workspace, cwd, getRepo(db, unit.repoId!).verifyPackPath);

  const evidenceDir = mkdtempSync(join(boot.home, "evidence-tmp-"));
  const lease = activeLease(db, attempt.id);
  const started = Date.now();
  const result = await runShell(
    req.command,
    cwd,
    { ...process.env, ...(lease?.vars ?? {}), ...sourceEnv(attempt.sources), YAGURA_EVIDENCE: evidenceDir, YAGURA_AT: req.at, YAGURA_SHA: sha },
    req.timeoutSeconds ?? 300,
  );
  const durationMs = Date.now() - started;
  await restorePristine(cwd, sha);

  const run = db.transaction(() => {
    const runId = Number(
      db
        .prepare(
          `INSERT INTO evidence_runs (attempt_id, at, sha, label, command, exit_code, timed_out, tampered, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(attempt.id, req.at, sha, req.label, req.command, result.exitCode, result.timedOut ? 1 : 0, tampered ? 1 : 0, durationMs, now()).lastInsertRowid,
    );
    const base = { projectId: unit.projectId, attemptId: attempt.id, evidenceRunId: runId };
    const stdoutId = putArtifact(db, boot, { ...base, kind: "stdout", label: `${req.label}@${req.at} stdout`, data: result.stdout });
    const stderrId = putArtifact(db, boot, { ...base, kind: "stderr", label: `${req.label}@${req.at} stderr`, data: result.stderr });
    for (const file of walk(evidenceDir))
      putArtifact(db, boot, { ...base, kind: "file", label: `${req.label}@${req.at} ${relative(evidenceDir, file)}`, data: readFileSync(file) });
    db.prepare("UPDATE evidence_runs SET stdout_artifact_id = ?, stderr_artifact_id = ? WHERE id = ?").run(stdoutId, stderrId, runId);
    recordEvent(
      db,
      "evidence.run",
      { projectId: unit.projectId, unitId: unit.id, attemptId: attempt.id },
      {
        run: runId,
        at: req.at,
        label: req.label,
        exit: result.exitCode,
        tampered,
      },
    );
    return getEvidenceRun(db, runId);
  })();
  rmSync(evidenceDir, { recursive: true, force: true });
  return run;
}

function toRun(r: Record<string, unknown>): EvidenceRun {
  return {
    id: r.id as number,
    attemptId: r.attempt_id as AttemptId,
    at: r.at as At,
    sha: r.sha as Sha,
    label: r.label as string,
    command: r.command as string,
    exitCode: (r.exit_code as number | null) ?? null,
    timedOut: r.timed_out === 1,
    tampered: r.tampered === 1,
    durationMs: r.duration_ms as number,
    stdoutArtifactId: (r.stdout_artifact_id as ArtifactId | null) ?? null,
    stderrArtifactId: (r.stderr_artifact_id as ArtifactId | null) ?? null,
  };
}

export function getEvidenceRun(db: Db, id: number): EvidenceRun {
  const r = db.prepare("SELECT * FROM evidence_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) throw new Error(`evidence run ${id} not found`);
  return toRun(r);
}

export function listEvidenceRuns(db: Db, attemptId: AttemptId): EvidenceRun[] {
  return (db.prepare("SELECT * FROM evidence_runs WHERE attempt_id = ? ORDER BY id").all(attemptId) as Record<string, unknown>[]).map(toRun);
}

export function readArtifact(db: Db, boot: Bootstrap, id: ArtifactId): Buffer {
  const r = db
    .prepare("SELECT a.sha256, u.project_id FROM artifacts a JOIN attempts t ON t.id = a.attempt_id JOIN units u ON u.id = t.unit_id WHERE a.id = ?")
    .get(id) as { sha256: string; project_id: ProjectId } | undefined;
  if (!r) throw new Error(`artifact ${id} not found`);
  return readFileSync(join(artifactsDir(boot, r.project_id), r.sha256));
}

export interface ArtifactInfo {
  id: ArtifactId;
  kind: string;
  name: string;
  bytes: number;
  contentType: string;
}

// Agent-written files are served only as types a browser will not run: images, and everything else as text or a download.
const INLINE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function artifactContentType(name: string, data: Buffer): string {
  const inline = INLINE_TYPES[extname(name).toLowerCase()];
  if (inline) return inline;
  return data.subarray(0, 4096).includes(0) ? "application/octet-stream" : "text/plain; charset=utf-8";
}

export function runArtifacts(db: Db, boot: Bootstrap, runId: number): ArtifactInfo[] {
  const run = getEvidenceRun(db, runId);
  const prefix = `${run.label}@${run.at} `;
  const rows = db.prepare("SELECT id, kind, label, bytes FROM artifacts WHERE evidence_run_id = ? ORDER BY id").all(runId) as {
    id: ArtifactId;
    kind: string;
    label: string;
    bytes: number;
  }[];
  return rows.map((r) => {
    const name = r.kind === "file" && r.label.startsWith(prefix) ? r.label.slice(prefix.length) : r.kind;
    return { id: r.id, kind: r.kind, name, bytes: r.bytes, contentType: artifactContentType(name, readArtifact(db, boot, r.id)) };
  });
}

export function artifactName(db: Db, id: ArtifactId): string {
  const r = db
    .prepare("SELECT a.kind, a.label, e.label AS run_label, e.at FROM artifacts a LEFT JOIN evidence_runs e ON e.id = a.evidence_run_id WHERE a.id = ?")
    .get(id) as { kind: string; label: string; run_label: string | null; at: string | null } | undefined;
  if (!r) throw new Error(`artifact ${id} not found`);
  const prefix = r.run_label ? `${r.run_label}@${r.at} ` : "";
  return r.kind === "file" && prefix && r.label.startsWith(prefix) ? r.label.slice(prefix.length) : `${r.label.replace(/\W+/g, "-")}.txt`;
}
