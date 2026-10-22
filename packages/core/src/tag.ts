import type { RunContext } from "./agent.js";
import { approvalsOf, commitSubject } from "./audit.js";
import { resolveSetting } from "./config.js";
import type { Unit } from "./domain.js";
import { ensureMirror, git } from "./git.js";
import { layout } from "./paths.js";
import { getProject, getRepo, getUnit, markTagPushed, recordEvent, type Db } from "./store.js";

// A release tag is yagura's to push, never a worker's: the mirror takes a worker's push only for its own unit's branch. After the unit has merged,
// yagura tags the commit that merged it and pushes that one tag to the forge, which is what starts a repo's release workflow.
export type TagOutcome = "pushed" | "waiting" | "conflict" | "none";

const baseOf = (db: Db, unit: Unit) => unit.base ?? getRepo(db, unit.repoId!).defaultBranch;

// The commit a tag the forge already has points at, peeled through an annotated tag; null when the forge has no such tag.
async function remoteTarget(gitDir: string, tag: string): Promise<string | null> {
  const out = await git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { gitDir });
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(/\s+/) as [string, string]);
  return (rows.find(([, ref]) => ref.endsWith("^{}")) ?? rows[0])?.[0] ?? null;
}

export async function pushUnitTag(ctx: RunContext, unitId: Unit["id"]): Promise<TagOutcome> {
  const { db, boot } = ctx;
  const unit = getUnit(db, unitId);
  if (!unit.tag || unit.tagPushedAt || unit.state !== "merged" || !unit.mergedSha || !unit.repoId) return "none";
  const repo = getRepo(db, unit.repoId);
  const mirror = layout(boot).mirror(repo.id);
  const sha = unit.mergedSha;
  await ensureMirror(repo.url, mirror);

  // The forge must already have the commit on the branch the unit merged into; tagging a commit it lacks would push a branch's worth of history.
  const onBranch = await git(["merge-base", "--is-ancestor", sha, `refs/remotes/origin/${baseOf(db, unit)}`], { gitDir: mirror }).then(
    () => true,
    () => false,
  );
  if (!onBranch) return "waiting";

  const there = await remoteTarget(mirror, unit.tag);
  if (there) {
    if (there === sha) {
      markTagPushed(db, unit.id, sha);
      return "pushed";
    }
    const said = db
      .prepare("SELECT 1 FROM events WHERE type = 'unit.tag_conflict' AND unit_id = ? AND json_extract(data_json, '$.found') = ?")
      .get(unit.id, there);
    if (!said) recordEvent(db, "unit.tag_conflict", { projectId: unit.projectId, unitId: unit.id }, { tag: unit.tag, found: there, wanted: sha });
    return "conflict";
  }

  const project = getProject(db, unit.projectId);
  const at = { projectId: unit.projectId, repoId: repo.id };
  const { requestedBy, approvedBy } = approvalsOf(db, unit);
  const message = [
    `${project.id}/U${unit.seq}: ${commitSubject(unit.title)}`,
    "",
    `Tagged by yagura after the unit merged as ${sha.slice(0, 10)}.`,
    ...(requestedBy ? [`Requested-by: ${requestedBy}`] : []),
    ...(approvedBy ? [`Approved-by: ${approvedBy}`] : []),
  ].join("\n");
  const identity = [
    "-c",
    `user.name=${resolveSetting(db, "git.author_name", at).value}`,
    "-c",
    `user.email=${resolveSetting(db, "git.author_email", at).value}`,
  ];
  await git([...identity, "tag", "-f", "-a", unit.tag, sha, "-m", message], { gitDir: mirror });
  await git(["push", "--quiet", "origin", `refs/tags/${unit.tag}:refs/tags/${unit.tag}`], { gitDir: mirror });
  markTagPushed(db, unit.id, sha);
  return "pushed";
}
