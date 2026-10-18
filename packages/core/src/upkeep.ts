import { existsSync } from "node:fs";
import { resolveSetting, type Bootstrap } from "./config.js";
import { TERMINAL_STATES, type ProjectId, type RepoId, type Unit } from "./domain.js";
import { git } from "./git.js";
import { layout } from "./paths.js";
import { addUnit, getRepo, listProjects, projectRepos, recordEvent, type Db } from "./store.js";

// A guide upkeep is an ordinary work unit whose job is the repo's verification guide: drive every page against the app and correct the
// pages that no longer match it. It goes through the usual branch, judge, and merge; it never changes product code.
export const UPKEEP_PLAYBOOK = "guide-upkeep";

export const isUpkeep = (unit: Pick<Unit, "playbook">) => unit.playbook === UPKEEP_PLAYBOOK;

const upkeepUnits = (db: Db, repoId: RepoId) =>
  db.prepare("SELECT id, state, created_at FROM units WHERE repo_id = ? AND playbook = ? ORDER BY id").all(repoId, UPKEEP_PLAYBOOK) as {
    id: number;
    state: string;
    created_at: string;
  }[];

// A report from an upkeep unit's own judge is a finding on that unit, not a reason for another upkeep.
const eventsAfter = (db: Db, type: string, repoId: RepoId, since: string) =>
  (
    db
      .prepare(
        `SELECT data_json FROM events WHERE type = ? AND ts > ? AND json_extract(data_json, '$.repo') = ?
         AND (unit_id IS NULL OR unit_id NOT IN (SELECT id FROM units WHERE playbook = ?)) ORDER BY id`,
      )
      .all(type, since, repoId, UPKEEP_PLAYBOOK) as { data_json: string }[]
  ).map((r) => JSON.parse(r.data_json) as { report?: string; note?: string });

function mergesSince(db: Db, repoId: RepoId, since: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM events e JOIN units u ON u.id = e.unit_id
         WHERE e.type = 'unit.state' AND json_extract(e.data_json, '$.to') = 'merged' AND e.ts > ? AND u.repo_id = ?
         AND (u.playbook IS NULL OR u.playbook != ?)`,
      )
      .get(since, repoId, UPKEEP_PLAYBOOK) as { n: number }
  ).n;
}

export interface UpkeepDue {
  reasons: string[];
  stale: string[];
}

// Derived, not queued, and never on a clock: a repo is due when the developer asked, when a judge reported a stale page, or when enough
// units have merged into it since the last upkeep. One upkeep per repo at a time.
export function upkeepDue(db: Db, repoId: RepoId): UpkeepDue | null {
  const all = upkeepUnits(db, repoId);
  if (all.some((u) => !TERMINAL_STATES.has(u.state as never))) return null;
  const since = all.at(-1)?.created_at ?? "";
  const reasons: string[] = [];
  const asked = eventsAfter(db, "guide.upkeep_requested", repoId, since);
  if (asked.length)
    reasons.push(
      [
        "The developer asked for a guide upkeep.",
        ...asked
          .map((a) => a.note?.trim())
          .filter(Boolean)
          .map((n) => `They said: ${n}`),
      ].join("\n"),
    );
  const stale = eventsAfter(db, "guide.stale", repoId, since)
    .map((e) => e.report ?? "")
    .filter(Boolean);
  if (stale.length) reasons.push(`A judge reported stale pages that no unit caused:\n${stale.map((s) => `- ${s}`).join("\n")}`);
  const every = resolveSetting(db, "verify.upkeep_every_merges", { repoId }).value;
  const merged = mergesSince(db, repoId, since);
  if (every > 0 && merged >= every) reasons.push(`${merged} units have merged into this repo since the guide was last checked.`);
  return reasons.length ? { reasons, stale } : null;
}

// The project that takes the unit: the newest one still active on the repo. With none, the ask waits.
export function upkeepProject(db: Db, repoId: RepoId): ProjectId | null {
  const open = listProjects(db)
    .filter((p) => p.state === "active" && projectRepos(db, p.id).some((r) => r.id === repoId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return open[0]?.id ?? null;
}

export function requestUpkeep(db: Db, repoId: RepoId, note: string): ProjectId | null {
  getRepo(db, repoId);
  recordEvent(db, "guide.upkeep_requested", {}, { repo: repoId, note });
  return upkeepProject(db, repoId);
}

export async function repoHasGuide(db: Db, boot: Bootstrap, repoId: RepoId): Promise<boolean> {
  const mirror = layout(boot).mirror(repoId);
  if (!existsSync(mirror)) return false;
  const files = await git(["ls-tree", "-r", "--name-only", `origin/${getRepo(db, repoId).defaultBranch}`], { gitDir: mirror }).catch(() => "");
  return /^\.claude\/skills\/verify-[^/]+\/SKILL\.md$/m.test(files);
}

const ACCEPTANCE = [
  "Every page of the repo's verification guide was driven as written against the app, and what each page says it returns matches what came back; a page that did not match was corrected",
  "The guide's SKILL.md (launch, doctor, evidence) and features/README.md (the index lines) make no claim about the app that no longer holds",
  "Only files under .claude/skills/verify-* changed",
  "Behaviour that is broken in the app (not in a page) is listed as a follow-up and was not fixed here",
];

export async function scheduleUpkeep(
  db: Db,
  boot: Bootstrap,
  hasGuide: (repoId: RepoId) => Promise<boolean> = (r) => repoHasGuide(db, boot, r),
): Promise<Unit[]> {
  const created: Unit[] = [];
  const repos = new Set(listProjects(db).flatMap((p) => (p.state === "active" ? projectRepos(db, p.id).map((r) => r.id) : [])));
  for (const repoId of repos) {
    const due = upkeepDue(db, repoId);
    const projectId = due ? upkeepProject(db, repoId) : null;
    if (!due || !projectId || !(await hasGuide(repoId))) continue;
    const at = { projectId, repoId };
    const unit = addUnit(db, {
      projectId,
      type: "work",
      repoId,
      goal: `Bring ${repoId}'s verification guide back in line with the app`,
      acceptance: ACCEPTANCE,
      context: [
        "This is a guide upkeep. Drive every page of .claude/skills/verify-* against the app, correct each page that no longer matches what the app returns, and correct the same claim wherever else the guide repeats it (SKILL.md's doctor and launch steps, features/README.md's index lines). Change nothing else. Behaviour that is really broken in the app is a follow-up for the planner, not yours to fix.",
        ...due.reasons,
      ],
      playbook: UPKEEP_PLAYBOOK,
      timeboxSeconds: resolveSetting(db, "timebox.work_seconds", at).value,
      maxAttempts: resolveSetting(db, "max_attempts", at).value,
    });
    recordEvent(db, "guide.upkeep", { projectId, unitId: unit.id }, { repo: repoId, reasons: due.reasons });
    created.push(unit);
  }
  return created;
}
