-- The tables yagura import reads, as schema version 46 (main before the core-loop build) left them; dumped from a real home.
CREATE TABLE schema_version (
  version INTEGER NOT NULL
);
CREATE TABLE settings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'environment', 'repo', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, key),
  CHECK ((scope = 'global') = (scope_id = ''))
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
, push_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (push_confirmed IN (0, 1)), revert_scan_sha TEXT, publish_json TEXT);
CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('kube-namespace', 'docker-compose', 'local-process', 'ios-sim')),
  provider_config_json TEXT NOT NULL DEFAULT '{}',
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  created_at TEXT NOT NULL
, notes TEXT NOT NULL DEFAULT '');
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
CREATE TABLE prompt_texts (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  scope_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('guidance', 'notes')),
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, role, kind)
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
  created_at TEXT NOT NULL, issue_messages_json TEXT NOT NULL DEFAULT '[]', announced_json TEXT,
  PRIMARY KEY (repo_id, number)
);
CREATE TABLE watchman_turns (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads (id),
  message_id INTEGER NOT NULL REFERENCES thread_messages (id),
  pid INTEGER,
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed', 'stopped')),
  model TEXT,
  context_peak INTEGER NOT NULL DEFAULT 0,
  log_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
, cost_usd REAL NOT NULL DEFAULT 0, session_id INTEGER REFERENCES thread_sessions (id));
CREATE INDEX watchman_turns_running ON watchman_turns (thread_id) WHERE state = 'running';
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
