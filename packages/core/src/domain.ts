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
export type GateId = Brand<number, "GateId">;
export type EventId = Brand<number, "EventId">;
export type Sha = Brand<string, "Sha">;
export type IsoTime = Brand<string, "IsoTime">;

export const PROVIDERS = ["kube-namespace", "docker-compose", "local-process", "ios-sim"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const FORGES = ["none", "glab", "gh"] as const;
export type Forge = (typeof FORGES)[number];

export const PROJECT_STATES = ["framing", "active", "paused", "closing", "closed"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const MERGE_POLICIES = ["auto", "human"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

// A work unit changes a repo and ends as a merged pull request; a plan unit is the job row of one planning session.
export const UNIT_TYPES = ["plan", "work", "doctor"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const isBuild = (u: { type: UnitType }) => u.type === "work";

export const ROLES = ["planner", "worker", "judge", "lead", "watchman", "doctor"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_NAMES: Record<Role, string> = {
  planner: "project lead",
  worker: "worker",
  judge: "judge",
  lead: "unit lead",
  watchman: "watchman",
  doctor: "doctor",
};

export const ROLE_OF: Record<UnitType, Role> = { plan: "planner", work: "worker", doctor: "doctor" };

export const UNIT_STATES = ["waiting", "building", "judging", "ready", "merged", "stuck", "dropped"] as const;
export type UnitState = (typeof UNIT_STATES)[number];

// The only moves between unit states (core-loop design, "The unit's life"). `stuck` is where the unit lead decides.
export const UNIT_TRANSITIONS: Record<UnitState, readonly UnitState[]> = {
  waiting: ["building", "stuck", "dropped"],
  building: ["building", "judging", "stuck", "waiting", "merged", "dropped"],
  judging: ["judging", "ready", "building", "stuck", "dropped"],
  ready: ["merged", "judging", "building", "stuck", "dropped"],
  stuck: ["waiting", "building", "judging", "ready", "dropped"],
  merged: [],
  dropped: [],
};

export const TERMINAL_STATES: ReadonlySet<UnitState> = new Set(["merged", "dropped"]);

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

// A try that never ran an agent session, or whose session the account's usage limit or the operator ended, is not one the unit spent.
export const spendsAttempt = (a: { state: string; resumesAttemptId?: AttemptId | null; sessionId?: string | null; limitedUntil?: string | null }) =>
  a.state !== "stopped" && !a.limitedUntil && !(a.resumesAttemptId && !a.sessionId);

// A test build of a verified head for its consumers, or the real version CI publishes once it lands (§14).
export const PUBLICATION_KINDS = ["test", "release"] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];
export const PUBLICATION_STATES = ["publishing", "published", "failed", "waiting", "unchanged", "removed", "left"] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

// What a unit lead may decide: send the worker back with a note (`resume`) or start a fresh one (`fresh`), answer the judge's
// question (`answer`), reply on the pull request with no change (`reply`), ask the developer (`ask`), ask the project lead to change
// the plan (`replan`), or give the unit up (`drop`).
export const LEAD_ACTIONS = ["resume", "fresh", "answer", "reply", "ask", "replan", "drop"] as const;
export type LeadAction = (typeof LEAD_ACTIONS)[number];

export const ATTEMPT_STATES = ["queued", "running", "handed_off", "failed", "stopped"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

// What an agent records through its yagura commands; the engine reads these, never the final message.
export const RECORD_KINDS = ["handoff", "judge", "decision", "plan"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const HANDOFF_STATUSES = ["done", "stuck"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const JUDGE_VERDICTS = ["approve", "changes", "ask"] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export const DISAGREEMENT_ACTIONS = ["follow-up", "note"] as const;
export type DisagreementAction = (typeof DISAGREEMENT_ACTIONS)[number];
export const DISAGREEMENT_STATES = ["open", "planned", "noted"] as const;
export type DisagreementState = (typeof DISAGREEMENT_STATES)[number];
export const FAILURE_MODES = ["timebox", "context-exhausted", "oom", "network", "tool-error", "harness-error", "unknown"] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export const LEASE_STATES = ["queued", "active", "released", "reaped"] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export const ARTIFACT_SOURCES = ["daemon", "agent"] as const;
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number];

export const GATE_STATES = ["open", "answered", "defaulted", "cancelled"] as const;
export type GateState = (typeof GATE_STATES)[number];

export const THREAD_AUTONOMIES = ["propose", "go"] as const;
export type ThreadAutonomy = (typeof THREAD_AUTONOMIES)[number];
export const THREAD_STATES = ["open", "closed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];
export const MESSAGE_ROLES = ["human", "watchman", "system"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export const PROPOSAL_STATES = ["pending", "applied", "discarded", "failed"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const MENTION_KINDS = ["project", "unit", "attempt", "thread", "repo"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export const SETTING_SCOPES = ["global", "environment", "repo", "project"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export interface Environment {
  id: EnvironmentId;
  name: string;
  provider: Provider;
  providerConfig: Record<string, unknown>;
  capacity: number;
  answers: Answers;
  createdAt: IsoTime;
}

// The developer's own words on how an environment works, one answer per question; agents read them, the doctor turns them into actions.
export const ANSWER_KEYS = ["tests", "publish", "images", "run", "never", "other"] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];
export type Answers = Record<AnswerKey, string>;
export const emptyAnswers = (): Answers => Object.fromEntries(ANSWER_KEYS.map((k) => [k, ""])) as Answers;
export const ANSWER_QUESTIONS: Record<AnswerKey, string> = {
  tests: "How are tests run?",
  publish: "How are libraries published, and where to?",
  images: "How are images built and pushed?",
  run: "How is the app run or deployed?",
  never: "What must agents never do here?",
  other: "Anything else about this environment",
};

// A command an agent or yagura may run in an environment, with what it is for. Only yagura's own runs prove or break one.
export const ACTION_STATES = ["proven", "edited", "unproven", "broken"] as const;
export type ActionState = (typeof ACTION_STATES)[number];
export const ACTION_AUTHORS = ["doctor", "agent", "you"] as const;
export type ActionAuthor = (typeof ACTION_AUTHORS)[number];
export const ACTION_RUNNERS = ["you", "doctor", "agent", "yagura"] as const;
export type ActionRunner = (typeof ACTION_RUNNERS)[number];
// yagura runs these itself after a library unit merges, so they keep a fixed name and contract.
export const CONTRACT_ACTIONS = ["version", "publish-snapshot", "snapshot-available"] as const;

export interface Action {
  id: number;
  environmentId: EnvironmentId;
  // null: every repo in the environment.
  repoId: RepoId | null;
  name: string;
  use: string;
  command: string;
  state: ActionState;
  author: ActionAuthor;
  authorAttemptId: AttemptId | null;
  reason: string | null;
  suggestion: { command: string; why: string } | null;
  lastRunId: number | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface ActionRun {
  id: number;
  actionId: number | null;
  environmentId: EnvironmentId;
  repoId: RepoId;
  sha: Sha;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  by: ActionRunner;
  attemptId: AttemptId | null;
  createdAt: IsoTime;
}

export const LAND_ROUTES = ["pr", "push"] as const;
export type LandRoute = (typeof LAND_ROUTES)[number];

export interface Repo {
  id: RepoId;
  url: string;
  defaultBranch: string;
  forge: Forge;
  // A remote repo without a forge lands by pushing to trunk only when someone chose that (§23).
  pushConfirmed: boolean;
  createdAt: IsoTime;
}

export interface Project {
  id: ProjectId;
  name: string;
  goal: string;
  predicate: string;
  environmentId: EnvironmentId | null;
  state: ProjectState;
  mergePolicy: MergePolicy;
  land: LandRoute | null;
  andonReason: string | null;
  refs: string[];
  after: ProjectId[];
  phaseGate: boolean;
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
  // The branch the unit starts from and merges into; null means the repo's default branch.
  base: string | null;
  goal: string;
  acceptance: string[];
  context: string[];
  // Units that must merge first.
  after: UnitId[];
  refs: string[];
  notes: string[];
  // The unit's own branch, yagura/<project>/u<n>, once the first worker has started.
  branch: string | null;
  // The head the judge approved, and the commit that merged the unit.
  approvedSha: Sha | null;
  mergedSha: Sha | null;
  playbook: string | null;
  scaffold: boolean;
  timeboxSeconds: number;
  maxAttempts: number;
  createdByDrainId: DrainId | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface Attempt {
  id: AttemptId;
  unitId: UnitId;
  n: number;
  agentNo: number;
  // The role yagura started this agent as, stored when it starts: every label reads it rather than guessing from the unit.
  role: Role | null;
  guidanceSha: string | null;
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
  failureMode: FailureMode | null;
  exitCode: number | null;
  stopNote: string | null;
  tokensIn: number;
  tokensOut: number;
  contextPeak: number;
  costUsd: number;
  sessionId: string | null;
  resumesAttemptId: AttemptId | null;
  // Set while the session waits out the account's usage limit: a try the limit ended is not one the unit spent.
  limitedUntil: string | null;
  skills: string[];
  missingSkills: string[];
  startedAt: IsoTime | null;
  endedAt: IsoTime | null;
}

export interface RenderedBrief {
  goal: string;
  repo: { id: RepoId; worktree: string; branch: string; baseSha: Sha };
  context: string[];
  readonly: { repoId: RepoId; path: string; sha: Sha; version?: string }[];
  acceptance: string[];
  // The environment's answers and actions, as \`environmentSection\` writes them.
  environment: string;
  env: Record<string, string>;
  envNotes?: Record<string, string>;
  timeboxMinutes: number;
  forbidden: string[];
  method: string;
  report: string;
  standing: string;
}

export interface Handoff {
  status: HandoffStatus;
  reason: string | null;
  whatIDid: string;
  evidence: string[];
  notes: string;
  decisions: string;
  followUps: string;
}

export type HarnessEvent =
  | { kind: "session"; sessionId: string; model: string | null; plugins: Record<string, string> }
  | { kind: "text"; text: string; parentId: string | null }
  | { kind: "tool_call"; id: string; name: string; input: unknown; parentId: string | null }
  | { kind: "tool_result"; id: string; output: string; isError: boolean; parentId: string | null }
  | { kind: "usage"; outputTokens: number; contextTokens: number }
  | { kind: "user_text"; text: string }
  | { kind: "final"; text: string; isError: boolean; stopReason: string | null; costUsd: number | null }
  // The account's usage window: `rejected` means the harness refused the request until `resetsAt` (ISO; null when it did not say).
  | { kind: "limit"; status: "allowed" | "allowed_warning" | "rejected"; resetsAt: string | null }
  | { kind: "ignored"; type: string };
