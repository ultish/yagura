import { resolveSetting } from "./config.js";
import { TERMINAL_STATES, type ProjectId, type RepoId, type Unit } from "./domain.js";
import { addUnit, getProject, getRepo, projectRepos, recordEvent, type Db } from "./store.js";

// Creating a repo's verification guide is an ordinary work unit the developer starts, one repo at a time. It goes through the usual
// branch, judge, and merge, and it changes only the guide.
export const GUIDE_CREATE_PLAYBOOK = "guide-create";

export const isGuideCreate = (unit: Pick<Unit, "playbook">) => unit.playbook === GUIDE_CREATE_PLAYBOOK;

export interface GuideUnitRef {
  projectId: ProjectId;
  seq: number;
  state: string;
}

// The creation still in flight for the repo, in any project: a second one would write the same files.
export function guideCreationUnder(db: Db, repoId: RepoId): GuideUnitRef | null {
  const rows = db
    .prepare("SELECT project_id, seq, state FROM units WHERE repo_id = ? AND playbook = ? ORDER BY id DESC")
    .all(repoId, GUIDE_CREATE_PLAYBOOK) as { project_id: ProjectId; seq: number; state: string }[];
  const open = rows.find((r) => !TERMINAL_STATES.has(r.state as never));
  return open ? { projectId: open.project_id, seq: open.seq, state: open.state } : null;
}

const ACCEPTANCE = [
  "The repo has .claude/skills/verify-<app>/SKILL.md saying how to launch the app, how to tell it is healthy, and where proof files go, and every command in it was run as written",
  "features/ has one page for each kind of check the app supports today (how to reach it, how to drive it, what it returns), and features/README.md indexes them",
  "At least one feature was driven end to end against the running app, and what came back matches what its page says",
  "Only files under .claude/skills/verify-* changed",
];

export function createGuideUnit(db: Db, input: { projectId: ProjectId; repoId: RepoId; note?: string }): Unit {
  const { projectId, repoId } = input;
  const project = getProject(db, projectId);
  if (project.state !== "active") throw new Error(`${projectId} is not active, so it cannot take a new unit`);
  if (!projectRepos(db, projectId).some((r) => r.id === repoId)) throw new Error(`${projectId} does not use ${repoId}`);
  const open = guideCreationUnder(db, repoId);
  if (open) throw new Error(`${open.projectId} U${open.seq} is already creating ${repoId}'s verification guide`);
  const at = { projectId, repoId };
  const note = input.note?.trim();
  const unit = addUnit(db, {
    projectId,
    type: "work",
    repoId: getRepo(db, repoId).id,
    title: `Create ${repoId}'s verification guide`,
    goal: `Create ${repoId}'s verification guide`,
    acceptance: ACCEPTANCE,
    context: [
      "This is a guide creation, not a feature. Load pstack:create-verification-skill and write the guide to .claude/skills/verify-<app>/, then drive one feature to prove it works. Write pages only for what the app does today, never for features that do not exist yet. Change nothing outside .claude/skills/verify-*. Behaviour that is broken in the app is a follow-up for the planner, not yours to fix.",
      ...(note ? [`The developer said: ${note}`] : []),
    ],
    playbook: GUIDE_CREATE_PLAYBOOK,
    timeboxSeconds: resolveSetting(db, "timebox.work_seconds", at).value,
    maxAttempts: resolveSetting(db, "max_attempts", at).value,
  });
  recordEvent(db, "guide.create_requested", { projectId, unitId: unit.id }, { repo: repoId, note: note ?? "" });
  return unit;
}
