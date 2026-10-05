import { promptPlugin, standingFor } from "./prompts.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { attemptRecorder, runAgentSession, stopRequested, write, type RunContext } from "./agent.js";
import { renderVerifyBrief } from "./brief.js";
import { resolveSetting } from "./config.js";
import {
  PROOF_HARNESS,
  spendsAttempt,
  type Attempt,
  type AttemptId,
  type EnvironmentId,
  type Handoff,
  type Sha,
  type Unit,
  type UnitId,
  type VerdictId,
} from "./domain.js";
import { baseWorktree, listEvidenceRuns, PACK_LABEL, packForAttempt, runEvidence, teardownDeployed } from "./evidence.js";
import { environmentNotes, listValues } from "./envvalues.js";
import { addDetachedWorktree, diffText, ensureMirror, patchId, resolveRef } from "./git.js";
import { ensureRecorded, readHandoff, reportOf, sessionReport } from "./finish.js";
import { loadPack, type VerifyPack } from "./pack.js";
import { commitPackEdit, discardWorkspace, openPackWorkspace, stagePackChanges } from "./packedits.js";
import { pausedBy, pauseEnvironment } from "./envpause.js";
import { amendmentContext } from "./amend.js";
import { verifierNotes } from "./disagreements.js";
import { acquireLease, keepable, keepLease, releaseLease } from "./leases.js";
import { notePackStale, proveTrunkPack, syncPackStatus } from "./repos.js";
import { requiredProjectSkills } from "./skills.js";
import { managerOn } from "./manager.js";
import { depShas, mountSources, sourceEnv, sourceVersions } from "./sources.js";
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
import { CHECK_LABEL, decidePackProof, decideVerdict, type VerdictDecision } from "./verdict.js";

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
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'verify.outcome' AND unit_id = ? AND json_extract(data_json, '$.outcome') = 'invalid'")
      .get(target.id) as { n: number }
  ).n;
}

function earlierVerifications(db: Db, target: Unit): string[] {
  return (db.prepare("SELECT data_json FROM events WHERE type = 'verify.outcome' AND unit_id = ? ORDER BY id").all(target.id) as { data_json: string }[]).map(
    (r) => {
      const d = JSON.parse(r.data_json) as { outcome: string; reason: string; verifyUnit: number };
      return `U${d.verifyUnit}: ${d.outcome}: ${d.reason}`;
    },
  );
}

// The work started from one trunk and is being verified on a later one (a rebase onto a moved trunk, or a retry from it).
function trunkMovedUnder(db: Db, target: Unit, work: Attempt): boolean {
  const first = listAttempts(db, target.id).find((a) => !a.harness.startsWith("yagura-") && a.baseSha);
  return !!first && !!work.baseSha && first.baseSha !== work.baseSha;
}

function applyOutcome(db: Db, target: Unit, work: Attempt, decision: VerdictDecision, verifySeq: number): void {
  const maxRetries = resolveSetting(db, "verify.max_retries", { projectId: target.projectId }).value;
  recordEvent(
    db,
    "verify.outcome",
    { projectId: target.projectId, unitId: target.id },
    // yagura judges the facts the verifier cites, never its argument: an invalid verdict is the one it disagrees with.
    {
      outcome: decision.outcome,
      check: decision.outcome === "invalid" ? "disagreed" : "agreed",
      reason: decision.reason,
      tier: decision.tier,
      verifyUnit: verifySeq,
    },
  );
  switch (decision.outcome) {
    case "verified":
      transitionUnit(db, target.id, "verified", { tier: decision.tier });
      return;
    case "code-fault": {
      updateAttempt(db, work.id, { rejection: "code-fault" });
      addUnitNote(db, target.id, `Verifier U${verifySeq} rejected the previous attempt: ${decision.reason}. Read its findings in handoffs/u${verifySeq}.*.md.`);
      transitionUnit(db, target.id, "rejected", { reason: decision.reason });
      // With a manager on, the rejection stays for the engine to hand to it; otherwise the fixed rules retry or block at once.
      if (managerOn(db, target)) return;
      const used = listAttempts(db, target.id).filter(spendsAttempt).length;
      transitionUnit(db, target.id, used < target.maxAttempts ? "ready" : "blocked", { attemptsUsed: used });
      return;
    }
    case "below-min":
      transitionUnit(db, target.id, "blocked", { reason: decision.reason });
      return;
    case "env-blocked":
      pauseEnvironment(db, target, decision.reason);
      return;
    case "invalid":
      if (decision.passesOnTrunk && trunkMovedUnder(db, target, work)) {
        const reason = `already on ${work.baseSha!.slice(0, 10)}: trunk moved under it, and every scenario its verifier wrote passes on trunk as well as on its head`;
        addUnitNote(db, target.id, `Closed without landing: ${reason}. Its branch is left unmerged.`);
        recordEvent(db, "unit.already_on_trunk", { projectId: target.projectId, unitId: target.id }, { base: work.baseSha, verifyUnit: verifySeq });
        transitionUnit(db, target.id, "done", { reason });
        return;
      }
      if (failedVerifications(db, target) >= maxRetries) {
        const reason = `verification did not reach a verdict ${maxRetries} times: ${decision.reason}`;
        // With a manager on, it decides what to do about a unit its verifier cannot judge; its absence leaves the fixed rules, which block.
        transitionUnit(db, target.id, managerOn(db, target) ? "rejected" : "blocked", { reason });
      } else addVerifyUnit(db, target);
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
  const workspace = proof ? null : await openPackWorkspace(db, { mirror, repo, projectId: project.id, target, verifySeq: unit.seq, head });
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
  const trunkSha = proof ? null : await resolveRef(mirror, `origin/${repo.defaultBranch}`);
  if (!proof) syncPackStatus(db, repo.id, pack);
  if (!proof && pack.ok) await notePackStale(db, getRepo(db, repo.id), mirror);
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
              `INSERT INTO verdicts (unit_id, attempt_id, tier, repo_id, head_sha, patch_id, trunk_outcome, head_outcome, dep_shas_json, artifact_versions_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              JSON.stringify(sourceVersions(sources)),
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

  const discard = async (ws: { path: string }) => {
    await discardWorkspace(ws.path);
    return { checks: null, problem: null };
  };
  // The verifier's pack edit counts at once: yagura re-runs the doctor and every check on both sides with it, then
  // commits it on its own branch to land after this unit. Anything it changed outside the pack is dropped.
  const settlePackEdit = async (a: {
    attemptId: AttemptId;
    target: Unit;
    workspace: { path: string; start: Sha };
    handoff: Handoff;
    runPack: (p: VerifyPack) => Promise<void>;
  }): Promise<{ checks: VerifyPack["checks"] | null; problem: string | null }> => {
    const staged = await stagePackChanges(a.workspace.path, repo.verifyPackPath);
    const refs = { projectId: project.id, unitId: a.target.id, attemptId: a.attemptId };
    if (staged.discarded.length) recordEvent(db, "pack.edit_outside", refs, { paths: staged.discarded });
    if (!staged.changed.length) return discard(a.workspace);
    const edited = loadPack(a.workspace.path, repo.verifyPackPath);
    if (!edited.ok) {
      await discard(a.workspace);
      return { checks: null, problem: `the verifier's pack edit cannot be used (${edited.reason}); the edit was dropped` };
    }
    await a.runPack(edited.pack);
    await commitPackEdit(db, {
      workspace: a.workspace.path,
      start: a.workspace.start,
      attemptId: a.attemptId,
      target: a.target,
      summary: a.handoff.packChanges.trim() || `Changed ${staged.changed.join(", ")}`,
      author: {
        name: resolveSetting(db, "git.author_name", { projectId: project.id, repoId: repo.id }).value,
        email: resolveSetting(db, "git.author_email", { projectId: project.id, repoId: repo.id }).value,
      },
    });
    return { checks: edited.pack.checks, problem: null };
  };

  const projectSkills = requiredProjectSkills(db, unit);
  let lease: Awaited<ReturnType<typeof acquireLease>>;
  try {
    lease = await acquireLease(db, boot, project.environmentId as EnvironmentId, attempt.id);
  } catch (e) {
    if (workspace) await discard(workspace).catch(() => undefined);
    updateAttempt(db, attempt.id, { state: "failed", endedAt: now(), failureMode: "tool-error" });
    const reason = `yagura could not get a slot on ${project.environmentId}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
    return finish({ outcome: "env-blocked", tier: "verifier-blocked", reason, trunkOutcome: null, headOutcome: null, citedRunIds: [] }, false);
  }
  // A slot can be a long wait; another verifier may have paused the environment meanwhile, and starting a session on it would spend what the pause exists to save.
  const pausedGate = pausedBy(db, project.environmentId);
  if (pausedGate) {
    await releaseLease(db, boot, lease.id);
    if (workspace) await discard(workspace).catch(() => undefined);
    updateAttempt(db, attempt.id, { state: "stopped", endedAt: now() });
    const reason = `verification on ${project.environmentId} was paused (gate ${pausedGate}) while this verifier waited for a slot`;
    transitionUnit(db, unit.id, "abandoned", { reason });
    recordEvent(db, "verify.paused_in_queue", { projectId: project.id, unitId: target.id, attemptId: attempt.id }, { gate: pausedGate });
    return {
      attempt: getAttempt(db, attempt.id),
      decision: { outcome: "env-blocked", tier: "verifier-blocked", reason, trunkOutcome: null, headOutcome: null, citedRunIds: [] },
      verdictId: null,
    };
  }
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
    const runPack = async (p: VerifyPack) => {
      if (p.doctor) await capture(sides[0], PACK_LABEL("doctor"), p.doctor);
      for (const check of p.checks) for (const at of sides) await capture(at, CHECK_LABEL(check.name), check.command, check.timeoutSeconds);
    };
    await runPack(pack.pack);

    if (proof) {
      await teardownDeployed(db, boot, attempt.id);
      const decision = decidePackProof({ runs: listEvidenceRuns(db, attempt.id), checks: pack.pack.checks, minTier: project.minTier });
      updateAttempt(db, attempt.id, { state: "handed_off", endedAt: now(), handoffStatus: decision.outcome === "verified" ? "success" : "blocked" });
      return await settle(decision, true);
    }
    const runs = listEvidenceRuns(db, attempt.id);
    const outcomeOf = (name: string, at: "base" | "head") => {
      const r = runs.filter((x) => x.label === CHECK_LABEL(name) && x.at === at).at(-1);
      return r ? `run:${r.id} ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}` : "not run";
    };

    const scenarioDir = join(boot.home, "projects", project.id, "scenarios", `u${unit.seq}.${attempt.n}`);
    mkdirSync(scenarioDir, { recursive: true });
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
      standing: standingFor(db, project.id, "verifier"),
      skills: projectSkills,
      pack: {
        copy: join(workspace!.path, repo.verifyPackPath),
        lifecycle: runs
          .filter((r) => r.label === PACK_LABEL("doctor") || r.label === PACK_LABEL("deploy"))
          .map((r) => `${r.label.slice(5)} on ${r.at === "base" ? "trunk" : "head"}: run:${r.id} ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}`),
      },
      earlier: earlierVerifications(db, target),
      developerNotes: verifierNotes(db, repo.id),
      amendments: amendmentContext(db, target.id),
    });
    write(paths.brief(project.id, unit.seq, attempt.n), briefText);

    const runVerifier = (prompt: string, resume?: string) =>
      runAgentSession(ctx, {
        recorder: attemptRecorder(db, {
          attempt,
          unit,
          projectId: project.id,
          role: "verifier",
          projectSkills,
          inheritedSkills: resume ? getAttempt(db, attempt.id).skills : undefined,
        }),
        adapter,
        run: {
          prompt,
          resume,
          bin: harnessId === "claude" ? setting("harness.claude.bin") : null,
          model: setting("role.verifier.model"),
          permissionMode: setting("harness.claude.permission_mode"),
          pluginDirs: [promptPlugin(db, boot, project.id, { attemptId: attempt.id, role: "verifier" })],
          addDirs: [head, baseWorktree(head), workspace!.path, ...sources.map((s) => s.path)],
          extraArgs: setting("harness.claude.extra_args"),
        },
        cwd: scenarioDir,
        env: {
          ...lease.vars,
          ...sourceEnv(sources),
          YAGURA_HEAD: head,
          YAGURA_BASE: baseWorktree(head),
          YAGURA_PACK: join(workspace!.path, repo.verifyPackPath),
          YAGURA_SCENARIOS: scenarioDir,
        },
        timeboxSeconds: unit.timeboxSeconds,
        logPath: resume ? paths.log(project.id, unit.seq, attempt.n).replace(/\.jsonl$/, ".resume.jsonl") : paths.log(project.id, unit.seq, attempt.n),
      });
    const first = await runVerifier(briefText);

    const stop = stopRequested(db, attempt.id);
    if (stop.stopped) {
      await discard(workspace!);
      await endSlot("stopped");
      updateAttempt(db, attempt.id, { state: "stopped", endedAt: now(), exitCode: first.exitCode });
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
    // The verdict comes from what the verifier recorded (yagura verdict, yagura finding); its report is only kept for the developer.
    const session = await ensureRecorded(db, attempt.id, "verifier", first, (prompt, sessionId) => runVerifier(prompt, sessionId));
    const report = sessionReport(first, session) ?? session.final?.text ?? first.final?.text ?? null;
    if (report) write(paths.handoff(project.id, unit.seq, attempt.n), report);
    const handoff = readHandoff(db, attempt.id, [reportOf(session), reportOf(first)]);
    const settled = handoff ? await settlePackEdit({ attemptId: attempt.id, target, workspace: workspace!, handoff, runPack }) : await discard(workspace!);
    const verdict = decideVerdict({
      handoff,
      runs: listEvidenceRuns(db, attempt.id),
      checks: settled.checks ?? pack.pack.checks,
      playbook: target.playbook,
      minTier: project.minTier,
    });
    const decision: VerdictDecision = settled.problem ? { ...verdict, outcome: "invalid", tier: null, reason: settled.problem } : verdict;
    if (!settled.checks && !settled.problem && trunkSha) proveTrunkPack(db, repo.id, trunkSha, listEvidenceRuns(db, attempt.id), pack.pack.checks);
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
