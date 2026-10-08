import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Sha } from "./domain.js";
import { githubForge, gitlabForge, type ForgeAdapter } from "./forge.js";
import { commitAll, git } from "./git.js";

const fixtures = (name: string) => fileURLToPath(new URL(`./harness/fixtures/${name}`, import.meta.url));
const author = { name: "dev", email: "dev@localhost" };
const branch = "yagura/demo/u1";

const forges: { name: string; make: (origin: string, state: string) => ForgeAdapter }[] = [
  {
    name: "GitHub, fake gh",
    make: (origin, state) => {
      process.env.FAKE_GH_ORIGIN = origin;
      process.env.FAKE_GH_STATE = state;
      return githubForge(fixtures("fake-gh.mjs"), "ultish/app");
    },
  },
  {
    name: "GitLab, fake glab",
    make: (origin, state) => {
      process.env.FAKE_GLAB_ORIGIN = origin;
      process.env.FAKE_GLAB_STATE = state;
      return gitlabForge(fixtures("fake-glab.mjs"), "gitlab.example.com/team/app");
    },
  },
];

describe.each(forges)("a unit's pull request on $name", ({ make }) => {
  let origin: string;
  let state: string;
  let forge: ForgeAdapter;
  let head: Sha;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "yagura-forge-"));
    const seed = join(root, "seed");
    await git(["init", "--quiet", "-b", "main", seed]);
    writeFileSync(join(seed, "greet.py"), "hi\n");
    writeFileSync(join(seed, "notes.md"), "notes\n");
    await commitAll(seed, "init", author);
    origin = join(root, "origin.git");
    await git(["clone", "--quiet", "--bare", seed, origin]);
    await git(["checkout", "--quiet", "-b", branch], { cwd: seed });
    writeFileSync(join(seed, "greet.py"), "hello\n");
    await commitAll(seed, "say hello", author);
    head = (await git(["rev-parse", "HEAD"], { cwd: seed })) as Sha;
    await git(["push", "--quiet", origin, branch], { cwd: seed });
    await git(["checkout", "--quiet", "main"], { cwd: seed });
    writeFileSync(join(seed, "notes.md"), "notes, edited on main\n");
    await commitAll(seed, "main moves on", author);
    await git(["push", "--quiet", origin, "main"], { cwd: seed });
    state = join(root, "state.json");
    forge = make(origin, state);
  });

  it("opens as a draft, cannot merge while a draft, keeps its body current, and merges ready with a two-parent merge commit", async () => {
    const pr = await forge.openDraft({ branch, base: "main", title: "Say hello", body: "Goal: say hello" });
    expect(pr.number).toBe(1);
    expect(await forge.status(pr.number)).toMatchObject({ state: "open", draft: true, headSha: head });
    await expect(forge.mergeCommit(pr.number, head, { subject: "U1: Say hello", body: "Judge approved." })).rejects.toThrow(/draft/);

    await forge.updateBody(pr.number, "Goal: say hello\n\nCloses #12");
    await forge.markReady(pr.number);
    expect(await forge.status(pr.number)).toMatchObject({ state: "open", draft: false });

    const mainBefore = await git(["rev-parse", "main"], { gitDir: origin });
    await forge.mergeCommit(pr.number, head, { subject: "U1: Say hello", body: "Judge approved." });
    const merged = await forge.status(pr.number);
    expect(merged).toMatchObject({ state: "merged", draft: false });
    expect(await git(["rev-parse", "main"], { gitDir: origin })).toBe(merged.mergedSha);
    expect(await git(["log", "-1", "--format=%P", "main"], { gitDir: origin })).toBe(`${mainBefore} ${head}`);
    expect(await git(["log", "-1", "--format=%B", "main"], { gitDir: origin })).toBe("U1: Say hello\n\nJudge approved.");
    expect(await git(["show", "main:greet.py"], { gitDir: origin })).toBe("hello");
    expect(await git(["show", "main:notes.md"], { gitDir: origin })).toBe("notes, edited on main");

    const saved = JSON.parse(readFileSync(state, "utf8")) as { prs?: { body: string }[]; mrs?: { description: string }[] };
    expect(saved.prs?.[0]?.body ?? saved.mrs?.[0]?.description).toBe("Goal: say hello\n\nCloses #12");
  });

  it("refuses to merge once the head moved past the approved commit", async () => {
    const pr = await forge.openDraft({ branch, base: "main", title: "Say hello", body: "" });
    await forge.markReady(pr.number);
    await expect(forge.mergeCommit(pr.number, "0".repeat(40) as Sha, { subject: "U1", body: "" })).rejects.toThrow(/match/i);
    expect(await forge.status(pr.number)).toMatchObject({ state: "open" });
  });
});
