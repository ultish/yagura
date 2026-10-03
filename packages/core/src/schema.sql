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
  doctor_status TEXT NOT NULL DEFAULT 'unknown' CHECK (doctor_status IN ('unknown', 'passing', 'failing')),
  doctor_checked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  forge TEXT NOT NULL DEFAULT 'none' CHECK (forge IN ('none', 'glab', 'gh')),
  verify_pack_path TEXT NOT NULL DEFAULT '.agents/verify',
  pack_status TEXT NOT NULL DEFAULT 'missing' CHECK (pack_status IN ('missing', 'unproven', 'proven', 'stale')),
  pack_proven_sha TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  predicate TEXT NOT NULL,
  min_tier TEXT NOT NULL CHECK (min_tier IN ('deployed-verified', 'live-local-verified', 'e2e-verified', 'unit-verified', 'build-only')),
  environment_id TEXT REFERENCES environments (id),
  state TEXT NOT NULL DEFAULT 'framing' CHECK (state IN ('framing', 'active', 'paused', 'closing', 'closed')),
  merge_policy TEXT NOT NULL DEFAULT 'human' CHECK (merge_policy IN ('auto', 'human')),
  andon_reason TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE project_repos (
  project_id TEXT NOT NULL REFERENCES projects (id),
  repo_id TEXT NOT NULL REFERENCES repos (id),
  PRIMARY KEY (project_id, repo_id)
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
  type TEXT NOT NULL CHECK (type IN ('plan', 'work', 'verify', 'measure', 'pack', 'rebase', 'ci-fix', 'review-triage', 'review', 'manager', 'investigate', 'land', 'release')),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'ready', 'running', 'handed_off', 'verifying', 'verified', 'landing', 'landed', 'done', 'rejected', 'failed', 'blocked', 'abandoned')),
  repo_id TEXT REFERENCES repos (id),
  target_unit_id INTEGER REFERENCES units (id),
  goal TEXT NOT NULL,
  write_scope_json TEXT NOT NULL DEFAULT '[]',
  forbid_scope_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  verify TEXT,
  context_json TEXT NOT NULL DEFAULT '[]',
  measurements_json TEXT NOT NULL DEFAULT '[]',
  playbook TEXT,
  timebox_seconds INTEGER NOT NULL CHECK (timebox_seconds > 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts > 0),
  created_by_drain_id INTEGER REFERENCES drains (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, seq),
  CHECK (type IN ('plan', 'measure') OR repo_id IS NOT NULL),
  CHECK (type NOT IN ('verify', 'rebase', 'ci-fix', 'review-triage', 'review', 'manager', 'investigate') OR target_unit_id IS NOT NULL)
);
CREATE INDEX units_project_state ON units (project_id, state);
CREATE INDEX units_target ON units (target_unit_id);

CREATE TABLE unit_deps (
  unit_id INTEGER NOT NULL REFERENCES units (id),
  depends_on INTEGER NOT NULL REFERENCES units (id),
  kind TEXT NOT NULL CHECK (kind IN ('needs-source', 'needs-landed', 'scope-overlap')),
  PRIMARY KEY (unit_id, depends_on),
  CHECK (unit_id <> depends_on)
);
CREATE INDEX unit_deps_reverse ON unit_deps (depends_on);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units (id),
  n INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'handed_off', 'failed', 'stopped')),
  harness TEXT NOT NULL,
  model TEXT,
  plugin_versions_json TEXT NOT NULL DEFAULT '{}',
  pid INTEGER,
  worktree_path TEXT,
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  handoff_status TEXT CHECK (handoff_status IN ('success', 'partial', 'blocked')),
  self_tier TEXT,
  failure_mode TEXT CHECK (failure_mode IN ('timebox', 'context-exhausted', 'oom', 'network', 'tool-error', 'harness-error', 'scope', 'unknown')),
  exit_code INTEGER,
  stop_note TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  context_peak INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (unit_id, n)
);
CREATE INDEX attempts_state ON attempts (state);

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
  CHECK (state = 'queued' OR slot IS NOT NULL)
);
CREATE UNIQUE INDEX leases_active_slot ON leases (environment_id, slot) WHERE state = 'active';

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  source TEXT NOT NULL CHECK (source IN ('daemon', 'agent')),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_attempt ON artifacts (attempt_id);

CREATE TABLE verdicts (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units (id),
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  tier TEXT NOT NULL CHECK (tier IN ('deployed-verified', 'live-local-verified', 'e2e-verified', 'unit-verified', 'build-only', 'verifier-blocked', 'verifier-failed')),
  repo_id TEXT NOT NULL REFERENCES repos (id),
  head_sha TEXT NOT NULL,
  patch_id TEXT,
  dep_shas_json TEXT NOT NULL DEFAULT '{}',
  artifact_versions_json TEXT NOT NULL DEFAULT '{}',
  trunk_outcome TEXT,
  head_outcome TEXT,
  voided_at TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX verdicts_unit_live ON verdicts (unit_id) WHERE voided_at IS NULL;

CREATE TABLE verdict_artifacts (
  verdict_id INTEGER NOT NULL REFERENCES verdicts (id),
  artifact_id INTEGER NOT NULL REFERENCES artifacts (id),
  PRIMARY KEY (verdict_id, artifact_id)
);

CREATE TABLE measurements (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units (id),
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  unit TEXT NOT NULL,
  claimed_value REAL,
  measured_value REAL,
  drift REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE gates (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  unit_id INTEGER REFERENCES units (id),
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

CREATE TABLE mr_state (
  unit_id INTEGER PRIMARY KEY REFERENCES units (id),
  repo_id TEXT NOT NULL REFERENCES repos (id),
  mr_iid INTEGER NOT NULL,
  url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  last_pipeline_id INTEGER,
  pipeline_status TEXT,
  merge_status TEXT,
  fix_waves INTEGER NOT NULL DEFAULT 0,
  seen_thread_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, mr_iid)
);

CREATE TABLE mr_decisions (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES mr_state (unit_id),
  thread_id TEXT NOT NULL,
  wave INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('fixed', 'dismissed', 'asked')),
  reason TEXT NOT NULL,
  commit_sha TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (unit_id, thread_id, wave)
);

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
