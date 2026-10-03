import type BetterSqlite3 from "better-sqlite3";

// A migration that rebuilds a table (SQLite cannot change a CHECK in place) runs with foreign keys off, then checks them.
export interface Migration {
  version: number;
  sql?: string;
  rebuild?: (db: BetterSqlite3.Database) => void;
}

// Adds the review unit type to the units table's CHECKs, whatever columns earlier migrations gave it.
function addReviewUnitType(db: BetterSqlite3.Database): void {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'units'").get() as { sql: string };
  if (sql.includes("'review',")) return;
  const next = sql
    .replace("'review-triage', 'land'", "'review-triage', 'review', 'land'")
    .replace("type NOT IN ('verify', 'rebase', 'ci-fix', 'review-triage')", "type NOT IN ('verify', 'rebase', 'ci-fix', 'review-triage', 'review')")
    .replace(/^CREATE TABLE units\b/, "CREATE TABLE units_next");
  if (!next.includes("'review', 'land'") || !next.includes("'review-triage', 'review')"))
    throw new Error("migration 24: the units table is not in the expected shape");
  const indexes = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'units' AND sql IS NOT NULL").all() as { sql: string }[]).map(
    (r) => r.sql,
  );
  db.exec(next);
  db.exec("INSERT INTO units_next SELECT * FROM units");
  db.exec("DROP TABLE units");
  db.exec("ALTER TABLE units_next RENAME TO units");
  for (const i of indexes) db.exec(i);
}

function addManagerUnitType(db: BetterSqlite3.Database): void {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'units'").get() as { sql: string };
  if (sql.includes("'manager',")) return;
  const next = sql
    .replace("'review', 'land'", "'review', 'manager', 'land'")
    .replace("'review-triage', 'review') OR", "'review-triage', 'review', 'manager') OR")
    .replace(/^CREATE TABLE units\b/, "CREATE TABLE units_next");
  if (!next.includes("'manager', 'land'") || !next.includes("'review', 'manager') OR"))
    throw new Error("migration 35: the units table is not in the expected shape");
  const indexes = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'units' AND sql IS NOT NULL").all() as { sql: string }[]).map(
    (r) => r.sql,
  );
  db.exec(next);
  db.exec("INSERT INTO units_next SELECT * FROM units");
  db.exec("DROP TABLE units");
  db.exec("ALTER TABLE units_next RENAME TO units");
  for (const i of indexes) db.exec(i);
}

function addInvestigateUnitType(db: BetterSqlite3.Database): void {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'units'").get() as { sql: string };
  if (!sql.includes("'investigate',")) {
    const next = sql
      .replace("'manager', 'land'", "'manager', 'investigate', 'land'")
      .replace("'review', 'manager') OR", "'review', 'manager', 'investigate') OR")
      .replace(/^CREATE TABLE units\b/, "CREATE TABLE units_next");
    if (!next.includes("'investigate', 'land'") || !next.includes("'manager', 'investigate') OR"))
      throw new Error("migration 38: the units table is not in the expected shape");
    const indexes = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'units' AND sql IS NOT NULL").all() as { sql: string }[]
    ).map((r) => r.sql);
    db.exec(next);
    db.exec("INSERT INTO units_next SELECT * FROM units");
    db.exec("DROP TABLE units");
    db.exec("ALTER TABLE units_next RENAME TO units");
    for (const i of indexes) db.exec(i);
  }
  const decisions = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manager_decisions'").get() as { sql: string };
  if (!decisions.sql.includes("'investigate'")) {
    db.exec(
      decisions.sql
        .replace("'stop', 'relay'", "'stop', 'investigate', 'relay'")
        .replace(/^CREATE TABLE "?manager_decisions"?/, "CREATE TABLE manager_decisions_next"),
    );
    db.exec("INSERT INTO manager_decisions_next SELECT * FROM manager_decisions");
    db.exec("DROP TABLE manager_decisions");
    db.exec("ALTER TABLE manager_decisions_next RENAME TO manager_decisions");
    db.exec("CREATE INDEX manager_decisions_unit ON manager_decisions (unit_id)");
  }
}

export const MIGRATIONS: readonly Migration[] = [
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
  {
    version: 15,
    sql: `
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
);
CREATE INDEX watchman_turns_running ON watchman_turns (thread_id) WHERE state = 'running';
`,
  },
  {
    version: 16,
    sql: `
CREATE TABLE pack_edits (
  id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts (id),
  target_unit_id INTEGER NOT NULL REFERENCES units (id),
  base_sha TEXT NOT NULL,
  sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'dropped')),
  pack_unit_id INTEGER REFERENCES units (id),
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX pack_edits_target ON pack_edits (target_unit_id);
`,
  },
  {
    version: 17,
    sql: `
ALTER TABLE attempts ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE watchman_turns ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
`,
  },
  {
    version: 18,
    sql: `
ALTER TABLE environment_values DROP COLUMN check_cmd;
ALTER TABLE environment_values DROP COLUMN last_ok;
ALTER TABLE environment_values DROP COLUMN last_detail;
ALTER TABLE environment_values DROP COLUMN last_checked_at;
ALTER TABLE environments DROP COLUMN doctor_status;
ALTER TABLE environments DROP COLUMN doctor_checked_at;
ALTER TABLE environments DROP COLUMN doctor_json;
`,
  },
  {
    version: 19,
    sql: `
ALTER TABLE mr_threads ADD COLUMN replied_at TEXT;
UPDATE mr_threads SET replied_at = created_at WHERE decision IN ('fixed', 'dismissed');
`,
  },
  {
    version: 20,
    sql: `
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
`,
  },
  {
    version: 21,
    sql: `
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
ALTER TABLE watchman_turns ADD COLUMN session_id INTEGER REFERENCES thread_sessions (id);
`,
  },
  {
    version: 22,
    sql: `
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
`,
  },
  {
    version: 23,
    sql: `
ALTER TABLE repos ADD COLUMN push_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (push_confirmed IN (0, 1));
ALTER TABLE projects ADD COLUMN land TEXT CHECK (land IN ('pr', 'push'));
`,
  },
  { version: 24, rebuild: addReviewUnitType },
  {
    version: 25,
    sql: `
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
`,
  },
  {
    version: 26,
    sql: `
ALTER TABLE attempts ADD COLUMN agent_no INTEGER;
UPDATE attempts SET agent_no = (
  SELECT COUNT(*) FROM attempts a2 JOIN units u2 ON u2.id = a2.unit_id
  WHERE u2.project_id = (SELECT project_id FROM units WHERE id = attempts.unit_id) AND a2.id <= attempts.id
);
`,
  },
  {
    version: 27,
    sql: `
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
ALTER TABLE attempts ADD COLUMN guidance_sha TEXT;
`,
  },
  {
    version: 28,
    sql: `
CREATE TABLE project_specs (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  text TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  { version: 29, sql: "ALTER TABLE repos ADD COLUMN revert_scan_sha TEXT;" },
  {
    version: 30,
    sql: `
CREATE TABLE env_templates (
  name TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 31,
    sql: `
CREATE TABLE review_posts (
  unit_id INTEGER NOT NULL REFERENCES units (id),
  thread_id TEXT NOT NULL,
  forge_ref TEXT,
  posted_at TEXT NOT NULL,
  PRIMARY KEY (unit_id, thread_id)
);
`,
  },
  {
    version: 32,
    sql: `
ALTER TABLE repos ADD COLUMN publish_json TEXT;
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
`,
  },
  { version: 33, sql: "ALTER TABLE projects ADD COLUMN release_policy TEXT NOT NULL DEFAULT 'ci' CHECK (release_policy IN ('ci', 'auto', 'human'));" },
  { version: 34, sql: "ALTER TABLE units ADD COLUMN description TEXT;" },
  { version: 35, rebuild: addManagerUnitType },
  {
    version: 36,
    sql: `
CREATE TABLE manager_decisions (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units (id),
  manager_unit_id INTEGER NOT NULL REFERENCES units (id),
  attempt_id INTEGER REFERENCES attempts (id),
  wake TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('resume', 'fresh', 'split', 'planner', 'ask', 'stop', 'fallback')),
  reason TEXT NOT NULL,
  note TEXT,
  tries INTEGER NOT NULL,
  gate_id INTEGER REFERENCES gates (id),
  created_at TEXT NOT NULL
);
CREATE INDEX manager_decisions_unit ON manager_decisions (unit_id);
`,
  },
  {
    version: 37,
    sql: `
CREATE TABLE manager_decisions_new (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units (id),
  manager_unit_id INTEGER NOT NULL REFERENCES units (id),
  attempt_id INTEGER REFERENCES attempts (id),
  wake TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('resume', 'fresh', 'split', 'planner', 'ask', 'stop', 'relay', 'ignore', 'fallback')),
  reason TEXT NOT NULL,
  note TEXT,
  tries INTEGER NOT NULL,
  gate_id INTEGER REFERENCES gates (id),
  created_at TEXT NOT NULL
);
INSERT INTO manager_decisions_new SELECT * FROM manager_decisions;
DROP TABLE manager_decisions;
ALTER TABLE manager_decisions_new RENAME TO manager_decisions;
CREATE INDEX manager_decisions_unit ON manager_decisions (unit_id);
`,
  },
  { version: 38, rebuild: addInvestigateUnitType },
];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 1;
