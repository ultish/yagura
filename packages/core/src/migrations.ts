export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 2,
    sql: `
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
ALTER TABLE artifacts ADD COLUMN evidence_run_id INTEGER REFERENCES evidence_runs (id);
ALTER TABLE attempts ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE attempts ADD COLUMN missing_skills_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE units ADD COLUMN notes_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE leases_v2 (
  id INTEGER PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments (id),
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  slot TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'active', 'released', 'reaped')),
  vars_json TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT NOT NULL,
  granted_at TEXT,
  released_at TEXT,
  CHECK (state <> 'active' OR slot IS NOT NULL)
);
INSERT INTO leases_v2 SELECT * FROM leases;
DROP TABLE leases;
ALTER TABLE leases_v2 RENAME TO leases;
CREATE UNIQUE INDEX leases_active_slot ON leases (environment_id, slot) WHERE state = 'active';
`,
  },
  {
    version: 3,
    sql: `
ALTER TABLE gates ADD COLUMN kind TEXT NOT NULL DEFAULT 'question';
`,
  },
  {
    version: 4,
    sql: `
ALTER TABLE projects ADD COLUMN refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE units ADD COLUMN refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE units ADD COLUMN landed_sha TEXT;
CREATE INDEX units_landed_sha ON units (landed_sha);
`,
  },
  {
    version: 5,
    sql: `
ALTER TABLE projects ADD COLUMN after_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN phase_gate INTEGER NOT NULL DEFAULT 0 CHECK (phase_gate IN (0, 1));
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
`,
  },
  {
    version: 6,
    sql: `
CREATE TABLE message_refs (
  message_id INTEGER NOT NULL REFERENCES thread_messages (id),
  kind TEXT NOT NULL CHECK (kind IN ('project', 'unit', 'attempt', 'thread', 'repo')),
  ref TEXT NOT NULL,
  project_id TEXT REFERENCES projects (id),
  PRIMARY KEY (message_id, ref)
);
CREATE INDEX message_refs_ref ON message_refs (ref);
CREATE INDEX message_refs_project ON message_refs (project_id);
`,
  },
  {
    version: 7,
    sql: `ALTER TABLE environments ADD COLUMN doctor_json TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    version: 8,
    sql: `
CREATE TABLE environment_values (
  environment_id TEXT NOT NULL REFERENCES environments (id),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  check_cmd TEXT,
  source TEXT NOT NULL DEFAULT 'you',
  position INTEGER NOT NULL,
  last_ok INTEGER,
  last_detail TEXT,
  last_checked_at TEXT,
  PRIMARY KEY (environment_id, name)
);
ALTER TABLE environments ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE leases ADD COLUMN kept_until TEXT;
ALTER TABLE leases ADD COLUMN kept_reason TEXT;
`,
  },
  {
    version: 9,
    sql: `
ALTER TABLE attempts ADD COLUMN session_id TEXT;
ALTER TABLE attempts ADD COLUMN resumes_attempt_id INTEGER REFERENCES attempts (id);
ALTER TABLE attempts ADD COLUMN rejection TEXT CHECK (rejection IN ('code-fault', 'literals', 'scope', 'skills', 'conflict'));
`,
  },
  {
    version: 10,
    sql: `ALTER TABLE units ADD COLUMN scaffold INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 11,
    sql: `
CREATE TABLE merge_requests (
  unit_id INTEGER PRIMARY KEY REFERENCES units (id),
  forge TEXT NOT NULL,
  forge_repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'merged', 'closed')),
  status_json TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 12,
    sql: `
CREATE TABLE mr_threads (
  unit_id INTEGER NOT NULL REFERENCES units (id),
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('review-thread', 'comment', 'review')),
  author TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  comments_json TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('fixed', 'dismissed', 'asked')),
  reason TEXT,
  commit_sha TEXT,
  wave_unit_id INTEGER REFERENCES units (id),
  gate_id INTEGER REFERENCES gates (id),
  directive TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (unit_id, thread_id)
);
`,
  },
  {
    version: 13,
    sql: `ALTER TABLE attempts ADD COLUMN evidence_token TEXT;`,
  },
  {
    version: 14,
    sql: `ALTER TABLE attempts ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]';`,
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 1;
