import { describe, expect, it } from "vitest";
import type { AttemptId, Handoff, Sha } from "./domain.js";
import type { EvidenceRun } from "./evidence.js";
import { decideVerdict, type VerdictInput } from "./verdict.js";

let nextId = 1;
const run = (at: "base" | "head", label: string, command: string, exitCode: number, extra: Partial<EvidenceRun> = {}): EvidenceRun => ({
  id: nextId++,
  attemptId: 1 as AttemptId,
  at,
  sha: (at === "base" ? "b" : "h") as Sha,
  label,
  command,
  exitCode,
  timedOut: false,
  tampered: false,
  durationMs: 1,
  stdoutArtifactId: null,
  stderrArtifactId: null,
  ...extra,
});

const handoff = (verification: Handoff["verification"], evidence: string[]): Handoff => ({
  status: "success",
  branch: null,
  whatIDid: "",
  measurements: "",
  verification,
  evidence,
  notes: "",
  followUps: "",
  raw: "",
});

function scenario(opts: { checkBase?: number; checkHead?: number; scenBase?: number; scenHead?: number } = {}) {
  nextId = 1;
  const runs = [
    run("base", "check:unit", "python3 -m unittest", opts.checkBase ?? 0),
    run("head", "check:unit", "python3 -m unittest", opts.checkHead ?? 0),
    run("base", "discount", "sh /s/discount.sh", opts.scenBase ?? 1),
    run("head", "discount", "sh /s/discount.sh", opts.scenHead ?? 0),
  ];
  return {
    runs,
    base: (h: Handoff | null): VerdictInput => ({
      handoff: h,
      runs,
      checks: [{ name: "unit", tier: "unit-verified" }],
      playbook: "feature",
      minTier: "unit-verified",
    }),
  };
}

describe("decideVerdict", () => {
  it("verifies when a cited scenario fails on trunk, passes on head, and checks prove the tier", () => {
    const { base } = scenario();
    const d = decideVerdict(base(handoff("unit-verified", ["run:4 discount passes on head", "run:3 fails on trunk"])));
    expect(d).toMatchObject({ outcome: "verified", tier: "unit-verified", citedRunIds: [4, 3] });
    expect(d.trunkOutcome).toBe("unit exit 0; scenario exit 1");
  });

  it("caps an overclaimed tier at what the checks proved", () => {
    const { base } = scenario();
    expect(decideVerdict(base(handoff("deployed-verified", ["run:4"])))).toMatchObject({ outcome: "verified", tier: "unit-verified" });
  });

  it("rejects the code when a pack check regresses on head", () => {
    const { base } = scenario({ checkHead: 1 });
    expect(decideVerdict(base(handoff("unit-verified", ["run:4"])))).toMatchObject({ outcome: "code-fault", tier: "verifier-failed" });
  });

  it("treats verifier-failed as a code fault only with a failing head run as proof", () => {
    const { base } = scenario({ scenHead: 1 });
    expect(decideVerdict(base(handoff("verifier-failed", ["run:4 still fails"])))).toMatchObject({ outcome: "code-fault" });
    expect(decideVerdict(base(handoff("verifier-failed", ["looks wrong to me"])))).toMatchObject({ outcome: "invalid" });
  });

  it("blames the verifier, not the code, when the scenario passes on trunk too", () => {
    const { base } = scenario({ scenBase: 0 });
    expect(decideVerdict(base(handoff("unit-verified", ["run:4"])))).toMatchObject({ outcome: "invalid", reason: expect.stringMatching(/proves nothing/) });
  });

  it("requires the scenario to have run on trunk as well as head", () => {
    const { runs, base } = scenario();
    const input = base(handoff("unit-verified", ["run:4"]));
    expect(decideVerdict({ ...input, runs: runs.filter((r) => r.id !== 3) })).toMatchObject({
      outcome: "invalid",
      reason: expect.stringMatching(/both trunk and head/),
    });
  });

  it("rejects citations of runs yagura never recorded, and runs on tampered checkouts", () => {
    const { runs, base } = scenario();
    expect(decideVerdict(base(handoff("unit-verified", ["run:4", "run:99"])))).toMatchObject({ outcome: "invalid", reason: expect.stringMatching(/run:99/) });
    const tampered = runs.map((r) => (r.id === 4 ? { ...r, tampered: true } : r));
    expect(decideVerdict({ ...base(handoff("unit-verified", ["run:4"])), runs: tampered })).toMatchObject({ outcome: "invalid" });
  });

  it("reports an environment block without touching the work", () => {
    const { base } = scenario();
    expect(decideVerdict(base(handoff("verifier-blocked", [])))).toMatchObject({ outcome: "env-blocked", tier: "verifier-blocked" });
    const broken = scenario({ checkBase: 1, checkHead: 1 });
    expect(decideVerdict(broken.base(handoff("unit-verified", ["run:4"])))).toMatchObject({ outcome: "env-blocked" });
  });

  it("holds a pass below the project minimum", () => {
    const { base } = scenario();
    expect(decideVerdict({ ...base(handoff("unit-verified", ["run:4"])), minTier: "deployed-verified" })).toMatchObject({
      outcome: "below-min",
      tier: "unit-verified",
    });
  });

  it("accepts a refactor whose scenario behaves identically on trunk and head", () => {
    const { base } = scenario({ scenBase: 0 });
    expect(decideVerdict({ ...base(handoff("unit-verified", ["run:4"])), playbook: "refactoring" })).toMatchObject({ outcome: "verified" });
  });

  it("is invalid without a handoff or a tier", () => {
    const { base } = scenario();
    expect(decideVerdict(base(null)).outcome).toBe("invalid");
    expect(decideVerdict(base(handoff(null, ["run:4"]))).outcome).toBe("invalid");
  });
});
