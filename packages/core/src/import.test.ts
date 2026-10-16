import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeImport, importHome } from "./import.js";
import { openStore } from "./store.js";
import { queuedMessages } from "./watchman.js";

const OLD_SCHEMA = readFileSync(new URL("./fixtures/old-home-v46.sql", import.meta.url), "utf8");
const T = "2026-10-07T10:00:00.000Z";

function oldHome(): string {
  const path = join(mkdtempSync(join(tmpdir(), "yagura-old-")), "yagura.db");
  const old = new Database(path);
  old.exec(OLD_SCHEMA);
  old.exec(`
    INSERT INTO schema_version VALUES (46);
    INSERT INTO settings VALUES
      ('global', '', 'role.worker.model', '"claude-haiku-4-5-20251001"', '${T}'),
      ('global', '', 'role.manager.model', '"claude-haiku-4-5-20251001"', '${T}'),
      ('global', '', 'role.verifier.model', '"claude-haiku-4-5-20251001"', '${T}'),
      ('repo', 'app', 'forge.watch_issues', 'true', '${T}'),
      ('project', 'demo', 'max_attempts', '5', '${T}');
    INSERT INTO repos (id, url, default_branch, forge, pack_status, pack_proven_sha, created_at, push_confirmed, revert_scan_sha)
      VALUES ('app', 'https://example.com/app.git', 'main', 'gh', 'proven', 'abc123', '${T}', 1, 'def456');
    INSERT INTO environments VALUES ('local', 'local', 'local-process', '{}', 2, '${T}', 'runs on this machine');
    INSERT INTO environment_values VALUES ('local', 'REDIS_URL', 'redis://localhost', '', 'you', 0);
    INSERT INTO env_templates VALUES ('box', '{"name":"box","provider":"local-process","capacity":1}', '${T}');
    INSERT INTO prompt_texts VALUES
      ('global', '', 'manager', 'guidance', 'Prefer a fresh worker.', '${T}'),
      ('global', '', 'verifier', 'guidance', 'Run every check.', '${T}'),
      ('global', '', 'all', 'notes', 'Python 3.9 only.', '${T}'),
      ('project', 'demo', 'worker', 'guidance', 'Small commits.', '${T}');
    INSERT INTO threads VALUES (1, 'greeting should say my name', 'propose', 'open', '{"U3":"landed"}', '${T}', '${T}');
    INSERT INTO thread_messages VALUES
      (1, 1, 'human', 'the greeting should say my name', NULL, '${T}'),
      (2, 1, 'watchman', 'Which name?', 'threads/1/turn-1.jsonl', '${T}');
    INSERT INTO thread_decisions VALUES (4, 1, 'The greeting says Jimmy', 2, NULL, '${T}');
    INSERT INTO thread_questions VALUES (1, 1, 'Which name?', 2, 'Jimmy', 1, '${T}');
    INSERT INTO thread_messages VALUES (3, 1, 'human', 'Jimmy', NULL, '${T}'), (4, 1, 'watchman', 'Recorded.', NULL, '${T}');
    INSERT INTO thread_sessions VALUES (2, 1, 'old-session', '{}', '${T}', NULL, NULL);
    INSERT INTO watchman_turns (id, thread_id, message_id, pid, state, model, log_path, started_at, cost_usd, session_id) VALUES
      (1, 1, 1, 10, 'done', 'm', '/old/threads/1/turns/1.jsonl', '${T}', 0.02, 2),
      (2, 1, 3, 11, 'running', 'm', '/old/threads/1/turns/3.jsonl', '${T}', 0.01, 2);
    INSERT INTO issue_watches VALUES ('app', '${T}', '${T}');
    INSERT INTO forge_issues VALUES ('app', 2, 1, 'someone', 'greeting', 'https://example.com/app/issues/2', '["c1"]', 2, 0, '${T}', '[1]', '["d4","u14-pr","u14-landed"]');
  `);
  old.close();
  return path;
}

describe("importHome", () => {
  it("copies the setup and the conversations from a version 46 home, leaves nothing to answer again, renames the manager, and leaves the rest behind", () => {
    const db = openStore(join(mkdtempSync(join(tmpdir(), "yagura-new-")), "yagura.db"));
    const counts = importHome(db, oldHome());

    expect(counts).toEqual({
      settings: 3,
      environments: 1,
      environmentValues: 1,
      templates: 1,
      repos: 1,
      prompts: 2,
      threads: 1,
      messages: 4,
      decisions: 1,
      questions: 1,
      issues: 1,
      skipped: ["global role.verifier.model", "project:demo max_attempts"],
    });
    expect(describeImport(counts)).toBe(
      [
        "settings 3",
        "environments 1 (1 values)",
        "templates 1",
        "repos 1",
        "prompts 2",
        "threads 1 (4 messages, 1 decisions, 1 questions, 1 issues)",
        "skipped 2 settings that no longer exist or belong to a project",
      ].join("\n"),
    );
    expect(db.prepare("SELECT scope, scope_id, key, value_json FROM settings ORDER BY key").all()).toEqual([
      { scope: "repo", scope_id: "app", key: "forge.watch_issues", value_json: "true" },
      { scope: "global", scope_id: "", key: "role.lead.model", value_json: '"claude-haiku-4-5-20251001"' },
      { scope: "global", scope_id: "", key: "role.worker.model", value_json: '"claude-haiku-4-5-20251001"' },
    ]);
    expect(db.prepare("SELECT id, url, forge, push_confirmed, revert_scan_sha FROM repos").all()).toEqual([
      { id: "app", url: "https://example.com/app.git", forge: "gh", push_confirmed: 1, revert_scan_sha: null },
    ]);
    expect(db.prepare("SELECT id, provider, capacity, answers_json FROM environments").all()).toEqual([
      { id: "local", provider: "local-process", capacity: 2, answers_json: '{"other":"runs on this machine"}' },
    ]);
    expect(db.prepare("SELECT role, kind, text FROM prompt_texts ORDER BY role").all()).toEqual([
      { role: "all", kind: "notes", text: "Python 3.9 only." },
      { role: "lead", kind: "guidance", text: "Prefer a fresh worker." },
    ]);
    expect(db.prepare("SELECT id, title, reported_json FROM threads").all()).toEqual([{ id: 1, title: "greeting should say my name", reported_json: "{}" }]);
    expect(db.prepare("SELECT id, text, source_message_id FROM thread_decisions").all()).toEqual([
      { id: 4, text: "The greeting says Jimmy", source_message_id: 2 },
    ]);
    expect(db.prepare("SELECT number, thread_id, seen_json, posted_through, announced_json FROM forge_issues").all()).toEqual([
      { number: 2, thread_id: 1, seen_json: '["c1"]', posted_through: 2, announced_json: '["d4"]' },
    ]);
    expect(queuedMessages(db, 1)).toEqual([]);
    expect(db.prepare("SELECT message_id, session_id, state, cost_usd FROM watchman_turns ORDER BY id").all()).toEqual([
      { message_id: 1, session_id: null, state: "done", cost_usd: 0.02 },
      { message_id: 3, session_id: null, state: "stopped", cost_usd: 0.01 },
    ]);
    expect(db.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("refuses a path with no database", () => {
    const db = openStore(join(mkdtempSync(join(tmpdir(), "yagura-new-")), "yagura.db"));
    expect(() => importHome(db, "/nonexistent/yagura.db")).toThrow("no yagura database at /nonexistent/yagura.db");
  });
});
