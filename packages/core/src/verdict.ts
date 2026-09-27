import { meetsTier, PASS_TIERS } from "./domain.js";
import type { Handoff, PassTier, Tier } from "./domain.js";
import type { EvidenceRun } from "./evidence.js";

export type VerdictOutcome = "verified" | "below-min" | "code-fault" | "env-blocked" | "invalid";

export interface VerdictDecision {
  outcome: VerdictOutcome;
  tier: Tier | null;
  reason: string;
  trunkOutcome: string | null;
  headOutcome: string | null;
  citedRunIds: number[];
}

export interface VerdictInput {
  handoff: Handoff | null;
  runs: EvidenceRun[];
  checks: { name: string; tier: PassTier }[];
  playbook: string | null;
  minTier: PassTier;
}

const REFACTOR_PLAYBOOKS = new Set(["refactoring", "visual-parity"]);
export const CHECK_LABEL = (name: string) => `check:${name}`;

const passed = (r: EvidenceRun) => r.exitCode === 0 && !r.timedOut;
const outcomeOf = (r: EvidenceRun | undefined) => (!r ? "not run" : r.timedOut ? "timed out" : `exit ${r.exitCode}`);

export function citedRuns(handoff: Handoff): number[] {
  const ids = new Set<number>();
  for (const m of `${handoff.evidence.join("\n")}\n${handoff.notes}`.matchAll(/\brun:(\d+)\b/g)) ids.add(Number(m[1]));
  return [...ids];
}

function strongest(tiers: PassTier[]): PassTier | null {
  return PASS_TIERS.find((t) => tiers.includes(t)) ?? null;
}

function weaker(a: PassTier, b: PassTier): PassTier {
  return PASS_TIERS.indexOf(a) > PASS_TIERS.indexOf(b) ? a : b;
}

const lifecycle = (runs: EvidenceRun[], step: string, at?: "base" | "head") => runs.filter((r) => r.label === `pack:${step}` && (!at || r.at === at));

// Trunk that will not deploy or pass doctor is the environment's problem; a head that will not deploy is the change's.
export function lifecycleProblem(runs: EvidenceRun[]): Pick<VerdictDecision, "outcome" | "reason" | "tier"> | null {
  const failed = (step: string, at?: "base" | "head") => lifecycle(runs, step, at).find((r) => !passed(r));
  const doctor = failed("doctor");
  if (doctor)
    return { outcome: "env-blocked", tier: "verifier-blocked", reason: `the pack's doctor failed (run:${doctor.id}), so the environment is not worth driving` };
  const base = failed("deploy", "base");
  if (base) return { outcome: "env-blocked", tier: "verifier-blocked", reason: `trunk does not deploy (run:${base.id})` };
  const head = failed("deploy", "head");
  if (head) return { outcome: "code-fault", tier: "verifier-failed", reason: `head does not deploy (run:${head.id}) while trunk does` };
  return null;
}

export function decideVerdict(input: VerdictInput): VerdictDecision {
  const { handoff, runs } = input;
  const decision = (outcome: VerdictOutcome, reason: string, extra: Partial<VerdictDecision> = {}): VerdictDecision => ({
    outcome,
    reason,
    tier: null,
    trunkOutcome: null,
    headOutcome: null,
    citedRunIds: handoff ? citedRuns(handoff) : [],
    ...extra,
  });

  if (!handoff) return decision("invalid", "verifier ended without a handoff");
  const cited = citedRuns(handoff);
  const byId = new Map(runs.map((r) => [r.id, r]));
  const unknown = cited.filter((id) => !byId.has(id));
  if (unknown.length) return decision("invalid", `cites runs yagura did not record for this verification: ${unknown.map((i) => `run:${i}`).join(", ")}`);
  const tampered = runs.filter((r) => r.tampered);
  if (tampered.length) return decision("invalid", `checkouts were modified before runs ${tampered.map((r) => `run:${r.id}`).join(", ")}`);
  const broken = lifecycleProblem(runs);
  if (broken) return decision(broken.outcome, broken.reason, { tier: broken.tier });

  const checkAt = (name: string, at: "base" | "head") => runs.filter((r) => r.label === CHECK_LABEL(name) && r.at === at).at(-1);
  const regressions = input.checks.filter((c) => {
    const head = checkAt(c.name, "head");
    const base = checkAt(c.name, "base");
    return head && !passed(head) && base && passed(base);
  });
  const checkSummary = (at: "base" | "head") => input.checks.map((c) => `${c.name} ${outcomeOf(checkAt(c.name, at))}`).join(", ");
  const summaries = { trunkOutcome: checkSummary("base"), headOutcome: checkSummary("head") };
  if (regressions.length)
    return decision("code-fault", `pack checks pass on trunk but fail on head: ${regressions.map((c) => c.name).join(", ")}`, {
      tier: "verifier-failed",
      ...summaries,
    });

  const claimed = handoff.verification;
  if (claimed === "verifier-blocked")
    return decision("env-blocked", "verifier reported the environment blocked verification", { tier: "verifier-blocked", ...summaries });
  if (claimed === "verifier-failed") {
    const failingHead = cited.map((id) => byId.get(id)!).filter((r) => r.at === "head" && !passed(r));
    if (!failingHead.length) return decision("invalid", "verifier-failed without citing a failing run on head");
    return decision("code-fault", `verifier found the change does not meet acceptance (${failingHead.map((r) => `run:${r.id}`).join(", ")})`, {
      tier: "verifier-failed",
      ...summaries,
    });
  }
  if (!claimed || claimed === "not-verified") return decision("invalid", "verifier reported no tier");

  const brokenOnBoth = input.checks.filter((c) => {
    const head = checkAt(c.name, "head");
    return head && !passed(head);
  });
  if (brokenOnBoth.length)
    return decision("env-blocked", `pack checks fail on trunk and head alike: ${brokenOnBoth.map((c) => c.name).join(", ")}`, {
      tier: "verifier-blocked",
      ...summaries,
    });

  const scenarioRuns = cited.map((id) => byId.get(id)!).filter((r) => !r.label.startsWith("check:") && !r.label.startsWith("pack:"));
  const refactor = REFACTOR_PLAYBOOKS.has(input.playbook ?? "");
  const pairs = scenarioRuns
    .filter((r) => r.at === "head")
    .map((head) => ({ head, base: runs.filter((r) => r.at === "base" && r.command === head.command).at(-1) }))
    .filter((p): p is { head: EvidenceRun; base: EvidenceRun } => p.base !== undefined);
  const proving = pairs.filter(({ head, base }) => (refactor ? head.exitCode === base.exitCode && passed(head) : passed(head) && !passed(base)));
  if (!proving.length) {
    const why = !pairs.length
      ? "no cited scenario was run on both trunk and head"
      : refactor
        ? "no cited scenario behaves the same on trunk and head"
        : "every cited scenario also passes on trunk, so it proves nothing about the change";
    return decision("invalid", why, summaries);
  }
  const scenario = proving[0]!;
  const scenarioSummary = {
    trunkOutcome: `${summaries.trunkOutcome}; scenario ${outcomeOf(scenario.base)}`,
    headOutcome: `${summaries.headOutcome}; scenario ${outcomeOf(scenario.head)}`,
  };

  const proven = strongest(input.checks.filter((c) => checkAt(c.name, "head") && passed(checkAt(c.name, "head")!)).map((c) => c.tier));
  if (!proven) return decision("invalid", "no pack check passed on head, so no tier is proven", scenarioSummary);
  const tier = (PASS_TIERS as readonly string[]).includes(claimed) ? weaker(claimed as PassTier, proven) : proven;
  if (!meetsTier(tier, input.minTier))
    return decision("below-min", `proven tier ${tier} is below the project's minimum ${input.minTier}`, { tier, ...scenarioSummary });
  return decision(
    "verified",
    `scenario run:${scenario.head.id} passes on head and ${refactor ? "matches" : "fails on"} trunk (run:${scenario.base.id}); checks prove ${proven}`,
    {
      tier,
      ...scenarioSummary,
    },
  );
}

// A pack unit is proven by yagura alone: on the pack's own head, doctor, deploy, every check, and teardown must pass.
export function decidePackProof(input: { runs: EvidenceRun[]; checks: { name: string; tier: PassTier }[]; minTier: PassTier }): VerdictDecision {
  const { runs } = input;
  const at = (label: string) => runs.filter((r) => r.label === label && r.at === "head").at(-1);
  const summary = input.checks.map((c) => `${c.name} ${outcomeOf(at(CHECK_LABEL(c.name)))}`).join(", ");
  const result = (outcome: VerdictOutcome, reason: string, tier: Tier | null): VerdictDecision => ({
    outcome,
    reason,
    tier,
    trunkOutcome: null,
    headOutcome: summary,
    citedRunIds: runs.map((r) => r.id),
  });
  for (const step of ["doctor", "deploy", "teardown"]) {
    const r = runs.filter((x) => x.label === `pack:${step}`).find((x) => !passed(x));
    if (r) return result("code-fault", `the pack's ${step} fails (run:${r.id}, ${outcomeOf(r)})`, "verifier-failed");
  }
  const failing = input.checks.filter((c) => {
    const r = at(CHECK_LABEL(c.name));
    return !r || !passed(r);
  });
  if (failing.length)
    return result(
      "code-fault",
      `pack checks fail on the repo as it is: ${failing.map((c) => `${c.name} ${outcomeOf(at(CHECK_LABEL(c.name)))}`).join(", ")}`,
      "verifier-failed",
    );
  const tier = strongest(input.checks.map((c) => c.tier))!;
  if (!meetsTier(tier, input.minTier)) return result("below-min", `the pack proves at most ${tier}, below the project's minimum ${input.minTier}`, tier);
  const steps = ["doctor", "deploy", "teardown"].filter((s) => runs.some((r) => r.label === `pack:${s}`));
  return result("verified", `pack proven on its head: ${[...steps, `${input.checks.length} check(s)`].join(", ")} pass`, tier);
}
