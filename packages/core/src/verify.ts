import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { attemptRecorder, runAgentSession, stopRequested, write, type RunContext } from "./agent.js";
import { renderVerifyBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import { PROOF_HARNESS, spendsAttempt, type Attempt, type EnvironmentId, type Unit, type UnitId, type VerdictId } from "./domain.js";
import { baseWorktree, listEvidenceRuns, PACK_LABEL, packForAttempt, runEvidence, teardownDeployed } from "./evidence.js";
import { environmentNotes, listValues } from "./envvalues.js";
import { addDetachedWorktree, diffText, ensureMirror, patchId } from "./git.js";
import { parseHandoff } from "./handoff.js";
import { acquireLease, keepable, keepLease, releaseLease } from "./leases.js";
import { syncPackStatus } from "./repos.js";
import { requiredProjectSkills } from "./skills.js";
import { depShas, mountSources, sourceEnv } from "./sources.js";
import { addVerifyUnit } from "./runner.js";
import { layout } from "./paths.js";
import {
  addUnitNote,
  createAttempt,
  getAttempt,
  getEnvironment,
  getProject,
  getRepo,
  getUnit,
  listAttempts,
  now,
  recordEvent,
  transitionUnit,
  updateAttempt,
  type Db,
} from "./store.js";
import { CHECK_LABEL, decidePackProof, decideVerdict, lifecycleProblem, type VerdictDecision } from "./verdict.js";

export interface VerifyResult {
  attempt: Attempt;
  decision: VerdictDecision;
  verdictId: VerdictId | null;
}

function latestWorkAttempt(db: Db, target: Unit): Attempt {
  const a = listAttempts(db, target.id)
    .filter((x) => x.state === "handed_off" && x.headSha && x.baseSha)
    .at(-1);
  if (!a) throw new Error(`U${target.seq} has no handed-off attempt to verify`);
  return a;
}

function failedVerifications(db: Db, target: Unit): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'verify.outcome' AND unit_id = ? AND json_extract(data_json, '$.outcome') IN ('invalid', 'env-blocked')",
      )
      .get(target.id) as { n: number }
  ).n;
}

function applyOutcome(db: Db, target: Unit, work: Attempt, decision: VerdictDecision, verifySeq: number): void {
  const maxRetries = resolveSetting(db, "verify.max_retries", { projectId: target.projectId }).value;
  recordEvent(
    db,
    "verify.outcome",
    { projectId: target.projectId, unitId: target.id },
    { outcome: decision.outcome, reason: decision.reason, tier: decision.tier, verifyUnit: verifySeq },
  );
  switch (decision.outcome) {
    case "verified":
      transitionUnit(db, target.id, "verified", { tier: decision.tier });
      return;
    case "code-fault": {
      updateAttempt(db, work.id, { rejection: "code-fault" });
      addUnitNote(db, target.id, `Verifier U${verifySeq} rejected the previous attempt: ${decision.reason}. Read its findings in handoffs/u${verifySeq}.*.md.`);
      transitionUnit(db, target.id, "rejected", { reason: decision.reason });
      const used = listAttempts(db, target.id).filter(spendsAttempt).length;
      transitionUnit(db, target.id, used < target.maxAttempts ? "ready" : "blocked", { attemptsUsed: used });
      return;
    }
    case "below-min":
      transitionUnit(db, target.id, "blocked", { reason: decision.reason });
      return;
    case "env-blocked":
    case "invalid":
      if (failedVerifications(db, target) >= maxRetries)
        transitionUnit(db, target.id, "blocked", { reason: `verification did not reach a verdict ${maxRetries} times: ${decision.reason}` });
      else addVerifyUnit(db, target);
  }
}

export async function runVerifyUnit(ctx: RunContext, verifyUnitId: UnitId): Promise<VerifyResult> {
  const { db, boot } = ctx;
  const unit = getUnit(db, verifyUnitId);
  if (unit.type !== "verify" || !unit.targetUnitId || !unit.repoId) throw new Error(`U${unit.seq} is not a verify unit`);
  if (unit.state !== "ready") throw new Error(`U${unit.seq} is ${unit.state}, not ready`);
  const target = getUnit(db, unit.targetUnitId);
  if (target.state !== "verifying") throw new Error(`target U${target.seq} is ${target.state}, not verifying`);
  const project = getProject(db, unit.projectId);
  if (!project.environmentId) throw new Error(`project ${project.id} has no environment; set one with: yagura project set ${project.id} --env <id>`);
  const repo = getRepo(db, unit.repoId);
  const work = latestWorkAttempt(db, target);
  const sctx = { projectId: project.id, repoId: repo.id, environmentId: project.environmentId };
  const setting = <K extends Parameters<typeof resolveSetting>[1]>(k: K) => resolveSetting(db, k, sctx).value;
  const harnessId = setting("role.verifier.harness");
  const adapter = ctx.adapters[harnessId];
  if (!adapter) throw new Error(`no adapter for harness ${harnessId}`);
  const paths = layout(boot);

  const mirror = paths.mirror(repo.id);
  await ensureMirror(repo.url, mirror);
  const proof = target.type === "pack";
  const attempt = createAttempt(db, unit.id, proof ? PROOF_HARNESS : harnessId, proof ? null : setting("role.verifier.model"));
  const head = paths.worktree(repo.id, project.id, unit.seq, attempt.n);
  mkdirSync(dirname(head), { recursive: true });
  await addDetachedWorktree(mirror, head, work.headSha!);
  await addDetachedWorktree(mirror, baseWorktree(head), work.baseSha!);
  const sources = await mountSources(ctx, target, head);
  updateAttempt(db, attempt.id, { sources });
  updateAttempt(db, attempt.id, { worktreePath: head, baseSha: work.baseSha, headSha: work.headSha });
  transitionUnit(db, unit.id, "running", { attempt: attempt.n, target: target.seq });
  updateAttempt(db, attempt.id, { state: "running", startedAt: now() });

  const finish = (decision: VerdictDecision, handedOff: boolean): VerifyResult => {
    if (handedOff) {
      transitionUnit(db, unit.id, "handed_off", { outcome: decision.outcome });
      transitionUnit(db, unit.id, "done");
    } else transitionUnit(db, unit.id, "failed", { outcome: decision.outcome });
    applyOutcome(db, target, work, decision, unit.seq);
    return { attempt: getAttempt(db, attempt.id), decision, verdictId: null };
  };

  const pack = await packForAttempt(db, boot, attempt.id);
  if (!proof) syncPackStatus(db, repo.id, pack);
  if (!pack.ok) {
    updateAttempt(db, attempt.id, { state: "failed", endedAt: now(), failureMode: "harness-error" });
    const decision: VerdictDecision = {
      outcome: "below-min",
      tier: null,
      reason: `cannot verify: ${pack.reason}`,
      trunkOutcome: null,
      headOutcome: null,
      citedRunIds: [],
    };
    return finish(decision, false);
  }

  const settle = async (decision: VerdictDecision, handedOff: boolean): Promise<VerifyResult> => {
    let verdictId: VerdictId | null = null;
    if (decision.tier) {
      verdictId = db.transaction(() => {
        const id = Number(
          db
            .prepare(
              `INSERT INTO verdicts (unit_id, attempt_id, tier, repo_id, head_sha, patch_id, trunk_outcome, head_outcome, dep_shas_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              target.id,
              attempt.id,
              decision.tier,
              repo.id,
              work.headSha,
              null,
              decision.trunkOutcome,
              decision.headOutcome,
              JSON.stringify(depShas(sources)),
              now(),
            ).lastInsertRowid,
        ) as VerdictId;
        for (const runId of decision.citedRunIds) {
          const r = db.prepare("SELECT stdout_artifact_id, stderr_artifact_id FROM evidence_runs WHERE id = ?").get(runId) as
            { stdout_artifact_id: number | null; stderr_artifact_id: number | null } | undefined;
          for (const artifact of [r?.stdout_artifact_id, r?.stderr_artifact_id])
            if (artifact) db.prepare("INSERT OR IGNORE INTO verdict_artifacts (verdict_id, artifact_id) VALUES (?, ?)").run(id, artifact);
        }
        return id;
      })();
      db.prepare("UPDATE verdicts SET patch_id = ? WHERE id = ?").run(await patchId(head, work.baseSha!, work.headSha!), verdictId);
    }
    return { ...finish(decision, handedOff), verdictId };
  };

  const projectSkills = requiredProjectSkills(db, unit);
  const lease = await acquireLease(db, boot, project.environmentId as EnvironmentId, attempt.id);
  const keepPolicy = resolveSetting(db, "lease.keep", { projectId: project.id, environmentId: project.environmentId }).value;
  let kept: string | null = null;
  const endSlot = async (outcome: VerdictDecision["outcome"] | "stopped") => {
    const what = keepable(getEnvironment(db, project.environmentId as EnvironmentId));
    if (what && (keepPolicy === "always" || (keepPolicy === "failed" && outcome !== "verified")))
      kept = `${keepPolicy === "always" ? "kept as always" : "kept because verification did not pass"} (${outcome})`;
    if (!kept || what === "directory") await teardownDeployed(db, boot, attempt.id);
  };
  try {
    const sides = proof ? (["head"] as const) : (["base", "head"] as const);
    const capture = (at: "base" | "head", label: string, command: string, timeoutSeconds?: number) =>
      runEvidence(db, boot, { attemptId: attempt.id, at, label, command, timeoutSeconds });
    if (pack.pack.doctor) await capture(sides[0], PACK_LABEL("doctor"), pack.pack.doctor);
    for (const check of lifecycleProblem(listEvidenceRuns(db, attempt.id)) ? [] : pack.pack.checks)
      for (const at of sides) await capture(at, CHECK_LABEL(check.name), check.command, check.timeoutSeconds);

    if (proof) {
      await teardownDeployed(db, boot, attempt.id);
      const decision = decidePackProof({ runs: listEvidenceRuns(db, attempt.id), checks: pack.pack.checks, minTier: project.minTier });
      updateAttempt(db, attempt.id, { state: "handed_off", endedAt: now(), handoffStatus: decision.outcome === "verified" ? "success" : "blocked" });
      return await settle(decision, true);
    }
    const early = lifecycleProblem(listEvidenceRuns(db, attempt.id));
    if (early) {
      await endSlot(early.outcome);
      updateAttempt(db, attempt.id, { state: "failed", endedAt: now(), failureMode: "tool-error" });
      return await settle({ ...early, trunkOutcome: null, headOutcome: null, citedRunIds: [] }, false);
    }
    const runs = listEvidenceRuns(db, attempt.id);
    const outcomeOf = (name: string, at: "base" | "head") => {
      const r = runs.filter((x) => x.label === CHECK_LABEL(name) && x.at === at).at(-1);
      return r ? `run:${r.id} ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}` : "not run";
    };

    const scenarioDir = join(boot.home, "projects", project.id, "scenarios", `u${unit.seq}.${attempt.n}`);
    mkdirSync(scenarioDir, { recursive: true });
    const standingPath = paths.standingOrders(project.id);
    const briefText = renderVerifyBrief({
      target: { seq: target.seq, goal: target.goal, playbook: target.playbook, baseSha: work.baseSha!, headSha: work.headSha! },
      acceptance: target.acceptance,
      verifyRecipe: target.verify ?? "(none)",
      diff: await diffText(head, work.baseSha!, work.headSha!),
      checks: pack.pack.checks.map((c) => ({ name: c.name, tier: c.tier, base: outcomeOf(c.name, "base"), head: outcomeOf(c.name, "head") })),
      headPath: head,
      basePath: baseWorktree(head),
      scenarioDir,
      cli: "yagura",
      leaseVars: lease.vars,
      envNotes: Object.fromEntries(
        listValues(db, project.environmentId as EnvironmentId)
          .map((v) => [v.name, v.note])
          .filter(([, n]) => n),
      ),
      environmentNotes: environmentNotes(db, project.environmentId),
      deploys: !!pack.pack.deploy,
      timeboxMinutes: Math.round(unit.timeboxSeconds / 60),
      standing: existsSync(standingPath) ? readFileSync(standingPath, "utf8") : "",
      skills: projectSkills,
    });
    write(paths.brief(project.id, unit.seq, attempt.n), briefText);

    const session = await runAgentSession(ctx, {
      recorder: attemptRecorder(db, { attempt, unit, projectId: project.id, role: "verifier", projectSkills }),
      adapter,
      run: {
        prompt: briefText,
        bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
        model: setting("role.verifier.model"),
        permissionMode: setting("harness.claude.permission_mode"),
        pluginDirs: [boot.skillsDir],
        addDirs: [head, baseWorktree(head), ...sources.map((s) => s.path)],
        extraArgs: setting("harness.claude.extra_args"),
      },
      cwd: scenarioDir,
      env: { ...lease.vars, ...sourceEnv(sources), YAGURA_HEAD: head, YAGURA_BASE: baseWorktree(head), YAGURA_SCENARIOS: scenarioDir },
      timeboxSeconds: unit.timeboxSeconds,
      logPath: paths.log(project.id, unit.seq, attempt.n),
    });

    const final = session.final;
    const stop = stopRequested(db, attempt.id);
    if (stop.stopped) {
      await endSlot("stopped");
      updateAttempt(db, attempt.id, { state: "stopped", endedAt: now(), exitCode: session.exitCode });
      const decision: VerdictDecision = {
        outcome: "invalid",
        tier: null,
        reason: `stopped by operator${stop.note ? `: ${stop.note}` : ""}`,
        trunkOutcome: null,
        headOutcome: null,
        citedRunIds: [],
      };
      return finish(decision, false);
    }
    const handoff = final && !final.isError && !session.timedOut ? parseHandoff(final.text) : null;
    if (final?.text) write(paths.handoff(project.id, unit.seq, attempt.n), final.text);
    const decision = decideVerdict({
      handoff,
      runs: listEvidenceRuns(db, attempt.id),
      checks: pack.pack.checks,
      playbook: target.playbook,
      minTier: project.minTier,
    });
    await endSlot(decision.outcome);
    updateAttempt(db, attempt.id, {
      state: handoff ? "handed_off" : "failed",
      endedAt: now(),
      exitCode: session.exitCode,
      handoffStatus: handoff?.status ?? null,
      selfTier: handoff?.verification === "not-verified" ? null : (handoff?.verification ?? null),
      failureMode: handoff ? null : session.timedOut ? "timebox" : "unknown",
    });

    return await settle(decision, handoff !== null);
  } finally {
    if (kept) keepLease(db, lease.id, resolveSetting(db, "lease.keep_hours", { projectId: project.id, environmentId: project.environmentId }).value, kept);
    else {
      await teardownDeployed(db, boot, attempt.id).catch(() => null);
      await releaseLease(db, boot, lease.id);
    }
  }
}
