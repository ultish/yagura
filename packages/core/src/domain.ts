declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EnvironmentId = Brand<string, "EnvironmentId">;
export type RepoId = Brand<string, "RepoId">;
export type ProjectId = Brand<string, "ProjectId">;
export type UnitId = Brand<number, "UnitId">;
export type AttemptId = Brand<number, "AttemptId">;
export type DrainId = Brand<number, "DrainId">;
export type LeaseId = Brand<number, "LeaseId">;
export type ArtifactId = Brand<number, "ArtifactId">;
export type VerdictId = Brand<number, "VerdictId">;
export type GateId = Brand<number, "GateId">;
export type EventId = Brand<number, "EventId">;
export type Sha = Brand<string, "Sha">;
export type IsoTime = Brand<string, "IsoTime">;

export const PROVIDERS = ["kube-namespace", "docker-compose", "local-process", "ios-sim"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const FORGES = ["none", "glab", "gh"] as const;
export type Forge = (typeof FORGES)[number];

export const DOCTOR_STATUSES = ["unknown", "passing", "failing"] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export const PACK_STATUSES = ["missing", "unproven", "proven", "stale"] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

export const PROJECT_STATES = ["framing", "active", "paused", "closing", "closed"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const MERGE_POLICIES = ["auto", "human"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

export const UNIT_TYPES = [
  "plan",
  "work",
  "verify",
  "measure",
  "pack",
  "rebase",
  "ci-fix",
  "review-triage",
  "land",
  "release",
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const ROLES = ["planner", "worker", "verifier", "pack", "rebase", "ci-fix", "review-triage"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_OF: Record<UnitType, Role | null> = {
  plan: "planner",
  work: "worker",
  verify: "verifier",
  measure: "verifier",
  pack: "pack",
  rebase: "rebase",
  "ci-fix": "ci-fix",
  "review-triage": "review-triage",
  land: null,
  release: null,
};

export const UNIT_STATES = [
  "draft",
  "ready",
  "running",
  "handed_off",
  "verifying",
  "verified",
  "landing",
  "landed",
  "done",
  "rejected",
  "failed",
  "blocked",
  "abandoned",
] as const;
export type UnitState = (typeof UNIT_STATES)[number];

export const UNIT_TRANSITIONS: Record<UnitState, readonly UnitState[]> = {
  draft: ["ready", "abandoned"],
  ready: ["running", "blocked", "abandoned"],
  running: ["handed_off", "failed", "ready", "abandoned"],
  handed_off: ["verifying", "done", "rejected", "blocked", "abandoned"],
  verifying: ["verified", "rejected", "blocked", "abandoned"],
  verified: ["landing", "verifying", "abandoned"],
  landing: ["landed", "verifying", "blocked", "abandoned"],
  rejected: ["ready", "blocked", "abandoned"],
  failed: ["ready", "blocked", "abandoned"],
  blocked: ["ready", "abandoned"],
  landed: [],
  done: [],
  abandoned: [],
};

export function canTransition(from: UnitState, to: UnitState): boolean {
  return UNIT_TRANSITIONS[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(
    readonly unitId: UnitId,
    readonly from: UnitState,
    readonly to: UnitState,
  ) {
    super(`unit ${unitId}: illegal transition ${from} -> ${to}`);
  }
}

export const DEP_KINDS = ["needs-source", "needs-landed", "scope-overlap"] as const;
export type DepKind = (typeof DEP_KINDS)[number];

export const ATTEMPT_STATES = ["queued", "running", "handed_off", "failed", "stopped"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const HANDOFF_STATUSES = ["success", "partial", "blocked"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const FAILURE_MODES = [
  "timebox",
  "context-exhausted",
  "oom",
  "network",
  "tool-error",
  "harness-error",
  "scope",
  "unknown",
] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export const PASS_TIERS = [
  "deployed-verified",
  "live-local-verified",
  "e2e-verified",
  "unit-verified",
  "build-only",
] as const;
export type PassTier = (typeof PASS_TIERS)[number];
export const FAIL_TIERS = ["verifier-blocked", "verifier-failed"] as const;
export type FailTier = (typeof FAIL_TIERS)[number];
export type Tier = PassTier | FailTier;

export function meetsTier(tier: Tier, min: PassTier): boolean {
  const rank = (PASS_TIERS as readonly Tier[]).indexOf(tier);
  return rank !== -1 && rank <= PASS_TIERS.indexOf(min);
}

export const LEASE_STATES = ["queued", "active", "released", "reaped"] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export const ARTIFACT_SOURCES = ["daemon", "agent"] as const;
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export const GATE_STATES = ["open", "answered", "defaulted", "cancelled"] as const;
export type GateState = (typeof GATE_STATES)[number];

export const MR_DECISIONS = ["fixed", "dismissed", "asked"] as const;
export type MrDecision = (typeof MR_DECISIONS)[number];

export const SETTING_SCOPES = ["global", "environment", "repo", "project"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export interface Environment {
  id: EnvironmentId;
  name: string;
  provider: Provider;
  providerConfig: Record<string, unknown>;
  capacity: number;
  doctorStatus: DoctorStatus;
  doctorCheckedAt: IsoTime | null;
  createdAt: IsoTime;
}

export interface Repo {
  id: RepoId;
  url: string;
  defaultBranch: string;
  forge: Forge;
  verifyPackPath: string;
  packStatus: PackStatus;
  packProvenSha: Sha | null;
  createdAt: IsoTime;
}

export interface Project {
  id: ProjectId;
  name: string;
  goal: string;
  predicate: string;
  minTier: PassTier;
  environmentId: EnvironmentId | null;
  state: ProjectState;
  mergePolicy: MergePolicy;
  andonReason: string | null;
  createdAt: IsoTime;
  closedAt: IsoTime | null;
}

export interface Unit {
  id: UnitId;
  projectId: ProjectId;
  seq: number;
  type: UnitType;
  state: UnitState;
  repoId: RepoId | null;
  targetUnitId: UnitId | null;
  goal: string;
  writeScope: string[];
  forbidScope: string[];
  acceptance: string[];
  verify: string | null;
  context: string[];
  measurements: MeasurementSpec[];
  playbook: string | null;
  timeboxSeconds: number;
  maxAttempts: number;
  createdByDrainId: DrainId | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface MeasurementSpec {
  name: string;
  command: string;
  unit: string;
}

export interface UnitDep {
  unitId: UnitId;
  dependsOn: UnitId;
  kind: DepKind;
}

export interface Attempt {
  id: AttemptId;
  unitId: UnitId;
  n: number;
  state: AttemptState;
  harness: string;
  model: string | null;
  pluginVersions: Record<string, string>;
  pid: number | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: Sha | null;
  headSha: Sha | null;
  handoffStatus: HandoffStatus | null;
  selfTier: Tier | null;
  failureMode: FailureMode | null;
  exitCode: number | null;
  stopNote: string | null;
  tokensIn: number;
  tokensOut: number;
  contextPeak: number;
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
}

export interface Verdict {
  id: VerdictId;
  unitId: UnitId;
  attemptId: AttemptId;
  tier: Tier;
  repoId: RepoId;
  headSha: Sha;
  patchId: string | null;
  depShas: Record<string, Sha>;
  artifactVersions: Record<string, string>;
  artifactIds: ArtifactId[];
  voidedAt: IsoTime | null;
  voidReason: string | null;
  createdAt: IsoTime;
}

export interface RenderedBrief {
  goal: string;
  repo: { id: RepoId; worktree: string; branch: string; baseSha: Sha };
  scope: { write: string[]; forbid: string[] };
  context: string[];
  readonly: { repoId: RepoId; path: string; sha: Sha }[];
  acceptance: string[];
  verify: string;
  env: Record<string, string>;
  timeboxMinutes: number;
  forbidden: string[];
  method: string;
  report: string;
  standing: string;
}

export interface Handoff {
  status: HandoffStatus;
  branch: string | null;
  whatIDid: string;
  measurements: string;
  verification: Tier | "not-verified" | null;
  evidence: string[];
  notes: string;
  followUps: string;
  raw: string;
}

export type HarnessEvent =
  | { kind: "session"; sessionId: string; model: string | null; plugins: Record<string, string> }
  | { kind: "text"; text: string; parentId: string | null }
  | { kind: "tool_call"; id: string; name: string; input: unknown; parentId: string | null }
  | { kind: "tool_result"; id: string; output: string; isError: boolean; parentId: string | null }
  | { kind: "usage"; outputTokens: number; contextTokens: number }
  | { kind: "final"; text: string; isError: boolean; stopReason: string | null; costUsd: number | null }
  | { kind: "ignored"; type: string };
