PRAGMA foreign_keys = ON;

CREATE TABLE schema_version (
  version INTEGER NOT NULL
);
INSERT INTO schema_version (version) VALUES (1);

CREATE TABLE settings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'environment', 'repo', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, key),
  CHECK ((scope = 'global') = (scope_id = ''))
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('kube-namespace', 'docker-compose', 'local-process', 'ios-sim')),
  provider_config_json TEXT NOT NULL DEFAULT '{}',
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE environment_values (
  environment_id TEXT NOT NULL REFERENCES environments (id),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'you',
  position INTEGER NOT NULL,
  PRIMARY KEY (environment_id, name)
);

CREATE TABLE env_templates (
  name TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  forge TEXT NOT NULL DEFAULT 'none' CHECK (forge IN ('none', 'glab', 'gh')),
  push_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (push_confirmed IN (0, 1)),
  revert_scan_sha TEXT,
  publish_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  predicate TEXT NOT NULL,
  environment_id TEXT REFERENCES environments (id),
  state TEXT NOT NULL DEFAULT 'framing' CHECK (state IN ('framing', 'active', 'paused', 'closing', 'closed')),
  merge_policy TEXT NOT NULL DEFAULT 'human' CHECK (merge_policy IN ('auto', 'human')),
  land TEXT CHECK (land IN ('pr', 'push')),
  release_policy TEXT NOT NULL DEFAULT 'ci' CHECK (release_policy IN ('ci', 'auto', 'human')),
  andon_reason TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  after_json TEXT NOT NULL DEFAULT '[]',
  phase_gate INTEGER NOT NULL DEFAULT 0 CHECK (phase_gate IN (0, 1)),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE project_repos (
  project_id TEXT NOT NULL REFERENCES projects (id),
  repo_id TEXT NOT NULL REFERENCES repos (id),
  PRIMARY KEY (project_id, repo_id)
);

CREATE TABLE project_specs (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  text TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE drains (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  planner_attempt_id INTEGER,
  delta_json TEXT,
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  rejection TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE units (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('plan', 'work')),
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'building', 'judging', 'ready', 'merged', 'stuck', 'dropped')),
  repo_id TEXT REFERENCES repos (id),
  base TEXT,
  goal TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '[]',
  notes_json TEXT NOT NULL DEFAULT '[]',
  refs_json TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  approved_sha TEXT,
  merged_sha TEXT,
  playbook TEXT,
  scaffold INTEGER NOT NULL DEFAULT 0,
  timebox_seconds INTEGER NOT NULL CHECK (timebox_seconds > 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
  created_by_drain_id INTEGER REFERENCES drains (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, seq),
  CHECK (type = 'plan' OR repo_id IS NOT NULL)
);

CREATE INDEX units_project_state ON units (project_id, state);

CREATE INDEX units_merged_sha ON units (merged_sha);

CREATE TABLE unit_deps (
  unit_id INTEGER NOT NULL REFERENCES units (id),
  depends_on INTEGER NOT NULL REFERENCES units (id),
  PRIMARY KEY (unit_id, depends_on),
  CHECK (unit_id <> depends_on)
);

CREATE INDEX unit_deps_reverse ON unit_deps (depends_on);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units (id),
  n INTEGER NOT NULL,
  agent_no INTEGER,
  role TEXT CHECK (role IN ('planner', 'worker', 'judge', 'lead', 'watchman')),
  guidance_sha TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'handed_off', 'failed', 'stopped')),
  harness TEXT NOT NULL,
  model TEXT,
  plugin_versions_json TEXT NOT NULL DEFAULT '{}',
  pid INTEGER,
  worktree_path TEXT,
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  handoff_status TEXT CHECK (handoff_status IN ('done', 'stuck')),
  failure_mode TEXT CHECK (failure_mode IN ('timebox', 'context-exhausted', 'oom', 'network', 'tool-error', 'harness-error', 'unknown')),
  exit_code INTEGER,
  stop_note TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  context_peak INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  skills_json TEXT NOT NULL DEFAULT '[]',
  missing_skills_json TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  resumes_attempt_id INTEGER REFERENCES attempts (id),
  evidence_token TEXT,
  limited_until TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (unit_id, n)
);

CREATE INDEX attempts_state ON attempts (state);

CREATE TABLE agent_records (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'judge', 'decision', 'plan')),
  key TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (attempt_id, kind, key)
);

CREATE INDEX agent_records_attempt ON agent_records (attempt_id);

CREATE TABLE evidence_runs (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  at TEXT NOT NULL CHECK (at IN ('base', 'head')),
  sha TEXT NOT NULL,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0, 1)),
  tampered INTEGER NOT NULL DEFAULT 0 CHECK (tampered IN (0, 1)),
  duration_ms INTEGER NOT NULL,
  stdout_artifact_id INTEGER REFERENCES artifacts (id),
  stderr_artifact_id INTEGER REFERENCES artifacts (id),
  created_at TEXT NOT NULL
);

CREATE INDEX evidence_runs_attempt ON evidence_runs (attempt_id);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  evidence_run_id INTEGER REFERENCES evidence_runs (id),
  source TEXT NOT NULL CHECK (source IN ('daemon', 'agent')),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX artifacts_attempt ON artifacts (attempt_id);

CREATE TABLE leases (
  id INTEGER PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments (id),
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  slot TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'active', 'released', 'reaped')),
  vars_json TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT NOT NULL,
  granted_at TEXT,
  released_at TEXT,
  kept_until TEXT,
  kept_reason TEXT,
  CHECK (state <> 'active' OR slot IS NOT NULL)
);

CREATE UNIQUE INDEX leases_active_slot ON leases (environment_id, slot) WHERE state = 'active';

CREATE TABLE steers (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'delivered', 'undelivered')),
  reason TEXT,
  log_line INTEGER,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX steers_attempt ON steers (attempt_id);

CREATE TABLE gates (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  unit_id INTEGER REFERENCES units (id),
  kind TEXT NOT NULL DEFAULT 'question',
  question TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  default_option TEXT,
  deadline TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'defaulted', 'cancelled')),
  answer TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX gates_open ON gates (project_id) WHERE state = 'open';

CREATE TABLE merge_requests (
  unit_id INTEGER PRIMARY KEY REFERENCES units (id),
  forge TEXT NOT NULL,
  forge_repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 1 CHECK (draft IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'merged', 'closed')),
  status_json TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE publications (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units (id),
  repo_id TEXT NOT NULL REFERENCES repos (id),
  kind TEXT NOT NULL CHECK (kind IN ('test', 'release')),
  sha TEXT NOT NULL,
  version TEXT,
  state TEXT NOT NULL CHECK (state IN ('publishing', 'published', 'failed', 'waiting', 'unchanged', 'removed', 'left')),
  reason TEXT,
  base_version TEXT,
  base_released INTEGER NOT NULL DEFAULT 0,
  log_path TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (unit_id, kind, sha)
);

CREATE TABLE retro_watches (
  unit_id INTEGER PRIMARY KEY REFERENCES units (id),
  sha TEXT NOT NULL,
  until TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'watching' CHECK (state IN ('watching', 'passed', 'failed', 'reverted', 'expired')),
  reruns INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  fix_unit_id INTEGER REFERENCES units (id),
  checked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE disagreements (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  unit_id INTEGER NOT NULL REFERENCES units (id),
  ref TEXT NOT NULL,
  about TEXT NOT NULL,
  reason TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('follow-up', 'note')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'planned', 'noted')),
  follow_up_unit_id INTEGER REFERENCES units (id),
  created_at TEXT NOT NULL
);

CREATE INDEX disagreements_unit ON disagreements (unit_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  unit_id INTEGER,
  attempt_id INTEGER,
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX events_project ON events (project_id, id);

CREATE VIRTUAL TABLE search USING fts5 (
  body,
  kind UNINDEXED,
  ref_id UNINDEXED,
  project_id UNINDEXED
);

CREATE TABLE usage_holds (
  harness TEXT PRIMARY KEY,
  until TEXT NOT NULL,
  reason TEXT NOT NULL,
  since TEXT NOT NULL
);

CREATE TABLE prompt_texts (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('guidance', 'notes')),
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, role, kind)
);

CREATE TABLE prompt_versions (
  sha TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  autonomy TEXT NOT NULL DEFAULT 'propose' CHECK (autonomy IN ('propose', 'go')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  reported_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE thread_projects (
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  PRIMARY KEY (thread_id, project_id)
);

CREATE TABLE thread_messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  role TEXT NOT NULL CHECK (role IN ('human', 'watchman', 'system')),
  body TEXT NOT NULL,
  turn_log TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX thread_messages_thread ON thread_messages (thread_id, id);

CREATE TABLE thread_decisions (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  text TEXT NOT NULL,
  source_message_id INTEGER REFERENCES thread_messages (id),
  superseded_by INTEGER REFERENCES thread_decisions (id),
  created_at TEXT NOT NULL
);

CREATE TABLE thread_questions (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  text TEXT NOT NULL,
  source_message_id INTEGER REFERENCES thread_messages (id),
  answer TEXT,
  resolved_message_id INTEGER REFERENCES thread_messages (id),
  created_at TEXT NOT NULL
);

CREATE TABLE thread_sessions (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  harness_session_id TEXT NOT NULL,
  seen_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IN ('cleared', 'rolled', 'lost'))
);

CREATE UNIQUE INDEX thread_sessions_current ON thread_sessions (thread_id) WHERE ended_at IS NULL;

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  message_id INTEGER REFERENCES thread_messages (id),
  body_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'discarded', 'failed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE message_refs (
  message_id INTEGER NOT NULL REFERENCES thread_messages (id),
  kind TEXT NOT NULL CHECK (kind IN ('project', 'unit', 'attempt', 'thread', 'repo')),
  ref TEXT NOT NULL,
  project_id TEXT REFERENCES projects (id),
  PRIMARY KEY (message_id, ref)
);

CREATE INDEX message_refs_ref ON message_refs (ref);

CREATE INDEX message_refs_project ON message_refs (project_id);

CREATE TABLE watchman_turns (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  message_id INTEGER NOT NULL REFERENCES thread_messages (id),
  session_id INTEGER REFERENCES thread_sessions (id),
  pid INTEGER,
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed', 'stopped')),
  model TEXT,
  context_peak INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  log_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX watchman_turns_running ON watchman_turns (thread_id) WHERE state = 'running';

CREATE TABLE issue_watches (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id),
  since TEXT NOT NULL,
  polled_at TEXT
);

CREATE TABLE forge_issues (
  repo_id TEXT NOT NULL REFERENCES repos (id),
  number INTEGER NOT NULL,
  thread_id INTEGER NOT NULL UNIQUE REFERENCES threads (id),
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  seen_json TEXT NOT NULL DEFAULT '[]',
  posted_through INTEGER NOT NULL DEFAULT 0,
  needs_approval INTEGER NOT NULL DEFAULT 0,
  issue_messages_json TEXT NOT NULL DEFAULT '[]',
  announced_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);
