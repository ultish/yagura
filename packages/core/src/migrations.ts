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
];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 1;
