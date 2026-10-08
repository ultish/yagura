import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type {
  Attempt,
  Environment,
  EvidenceRun,
  Gate,
  Project,
  Proposal,
  Repo,
  SettingInfo,
  Thread,
  ThreadDecision,
  ThreadMessage,
  ThreadQuestion,
  Unit,
  StoryEntry,
  StoryLine,
  UnitStory,
  CommitUnit,
  FileView,
} from "@yagura/core";

export type {
  Attempt,
  Environment,
  EvidenceRun,
  Gate,
  Project,
  Proposal,
  Repo,
  SettingInfo,
  Thread,
  ThreadDecision,
  ThreadMessage,
  ThreadQuestion,
  Unit,
  StoryEntry,
  StoryLine,
  UnitStory,
  CommitUnit,
  FileView,
};

export interface UnitCode {
  source: "landed" | "branch";
  branch: string | null;
  commit: CommitUnit;
  base: string;
  files: string[];
  stats: Record<string, { added: number; removed: number }>;
  diff: string;
  truncated: boolean;
}

export interface ProjectSummary {
  project: Project;
  workCounts: Record<string, number>;
  running: number;
  planning: boolean;
  maxInFlight: number;
  openGates: number;
  blocked: number;
  lastLanded: { seq: number; sha: string; at: string } | null;
  summary: string | null;
  costUsd: number;
  budgetUsd: number | null;
}

export interface RepoView {
  repo: Repo;
  trunk: string | null;
  route: { text: string; confirmed: boolean };
  pack: { ok: true; checks: { name: string; tier: string }[] } | { ok: false; reason: string } | null;
  projects: { id: string; state: string }[];
  landingQueue: { projectId: string; seq: number; goal: string; at: string }[];
  landedCount: number;
  lastLanded: { projectId: string; seq: number; goal: string; at: string; sha: string } | null;
  notes?: string[];
}

interface SlotHolder {
  attemptId: number;
  agentNo: number;
  since: string;
  unit: { projectId: string; seq: number; type: string; goal: string };
}

export interface KeptSlot {
  leaseId: number;
  attemptId: number;
  agentNo: number;
  unit: { projectId: string; seq: number; type: string; goal: string };
  until: string;
  reason: string;
  namespace: string | null;
  context: string | null;
  leaseDir: string | null;
}

export interface EnvValueView {
  name: string;
  value: string;
  note: string;
  source: string;
}

export interface EnvironmentView {
  environment: Environment;
  implemented: boolean;
  active: (SlotHolder & { slot: string })[];
  queued: SlotHolder[];
  projects: { id: string; state: string }[];
  kept: KeptSlot[];
  pausedBy: number | null;
}

export interface EnvironmentDetail extends EnvironmentView {
  values: EnvValueView[];
  keep: { policy: { value: "never" | "failed" | "always"; source: string }; hours: { value: number; source: string }; keeps: "deployed" | "directory" | null };
  presets: { id: string; label: string }[];
}

export interface EnvTemplateFile {
  template: {
    name: string;
    description: string;
    provider: string;
    capacity: number;
    values: { name: string; value: string; note: string; ask: boolean }[];
  } | null;
  name: string;
  error: string | null;
}

export interface SettingsOverview {
  settings: SettingInfo[];
  caps: {
    max_parallel_agents: { running: number; limit: number };
    max_parallel_per_harness: { limit: number; byHarness: Record<string, number> };
    "project.max_in_flight": { id: string; running: number; limit: number }[];
  };
}

export interface UnitView extends Unit {
  attempts: Attempt[];
  verdict: { id: number; tier: string; headSha: string } | null;
  blockedReason: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  repos: Repo[];
  units: UnitView[];
  deps: { unitId: number; dependsOn: number; kind: string }[];
  gates: Gate[];
  waiting: { unitId: number; reason: string }[];
  threads: number[];
  skills: { skill: string; purposes: string[]; repos: string[]; installed: boolean }[];
}

export interface AgentRow extends Attempt {
  unit: { id: number; seq: number; type: string; goal: string; projectId: string; state: string };
  // The unit a verifier, triage, or rebase worked for.
}

export interface AttemptDetail {
  attempt: Attempt;
  unit: UnitView;
  project: { id: string; minTier: string; state: string };
  timeboxSeconds: number;
  brief: string | null;
  handoff: string | null;
  leftovers: string | null;
  runs: EvidenceRun[];
  kept: KeptSlot[];
  waiting: string | null;
  recordedFrom: { id: number; agentNo: number; unitSeq: number } | null;
}

export interface LogLine {
  line: number;
  at: number | null;
  raw: string;
  events: HarnessEvent[];
}

export type HarnessEvent =
  | { kind: "session"; sessionId: string; model: string | null; plugins: Record<string, string> }
  | { kind: "text"; text: string; parentId: string | null }
  | { kind: "tool_call"; id: string; name: string; input: unknown; parentId: string | null }
  | { kind: "tool_result"; id: string; output: string; isError: boolean; parentId: string | null }
  | { kind: "usage"; outputTokens: number; contextTokens: number }
  | { kind: "user_text"; text: string }
  | { kind: "final"; text: string; isError: boolean; stopReason: string | null; costUsd: number | null }
  | { kind: "ignored"; type: string };

export interface Steer {
  id: number;
  body: string;
  state: "pending" | "sent" | "delivered" | "undelivered";
  reason: string | null;
  logLine: number | null;
  createdAt: string;
}

export type BellItem =
  | {
      kind: "gate";
      id: string;
      projectId: string;
      unit: { seq: number; goal: string } | null;
      gate: { id: number; kind: string; question: string; options: string[]; defaultOption: string | null; deadline: string | null };
      at: string;
    }
  | {
      kind: "blocked";
      id: string;
      projectId: string;
      unit: { seq: number; goal: string };
      reason: string | null;
      attempts: number;
      maxAttempts: number;
      at: string;
    }
  | { kind: "proposal"; id: string; threadId: number; threadTitle: string; proposalId: number; summary: string; at: string };

export interface TurnCall {
  name: string;
  arg: string;
  outcome: "ok" | "error" | "refused";
  why: string | null;
  output: string | null;
  atMs: number | null;
}

export interface TurnCalls {
  calls: TurnCall[];
  running: boolean;
}

export interface ThreadView {
  thread: Thread;
  busy: boolean;
  projects: ProjectSummary[];
  messages: ThreadMessage[];
  decisions: ThreadDecision[];
  questions: ThreadQuestion[];
  proposals: (Proposal & { routes?: Record<string, { text: string; ok: boolean }> })[];
  session: { startedAt: string; contextPeak: number; rollAt: number } | null;
  sessionStarts: number[];
  queued: number[];
}

export interface Suggestion {
  token: string;
  kind: "project" | "unit" | "attempt" | "thread" | "repo";
  label: string;
}

const TOKEN_KEY = "yagura.token";

function token(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get("token");
    if (fromUrl) localStorage.setItem(TOKEN_KEY, fromUrl);
    return fromUrl ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const t = token();
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  return json as T;
}

export async function apiText(path: string): Promise<string> {
  const t = token();
  const res = await fetch(path, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.text();
}

export function streamUrl(path: string): string {
  const t = token();
  return t ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : path;
}

export const LiveContext = createContext(0);

export function useLiveVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const source = new EventSource(streamUrl("/api/stream?since=latest"));
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((v) => v + 1);
      }, 250);
    };
    source.addEventListener("yagura", bump);
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return version;
}

export function useApi<T>(path: string | null, opts: { poll?: number } = {}): { data: T | null; error: string | null; reload: () => void } {
  const live = useContext(LiveContext);
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>({ path, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<T>(path).then(
      (data) => !cancelled && setState({ path, data, error: null }),
      (e: unknown) => !cancelled && setState((s) => ({ path, data: s.path === path ? s.data : null, error: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      cancelled = true;
    };
  }, [path, live, nonce]);
  useEffect(() => {
    if (!opts.poll || !path) return;
    const t = setInterval(reload, opts.poll);
    return () => clearInterval(t);
  }, [opts.poll, path, reload]);
  return { data: state.path === path ? state.data : null, error: state.path === path ? state.error : null, reload };
}

export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.pathname,
  );
}

export function useQuery(): URLSearchParams {
  const search = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.search,
  );
  return new URLSearchParams(search);
}

export interface WatchmanTurnRow {
  id: number;
  costUsd: number;
  threadId: number;
  threadTitle: string;
  state: "running" | "done" | "failed" | "stopped";
  model: string | null;
  contextPeak: number;
  startedAt: string;
  endedAt: string | null;
}
