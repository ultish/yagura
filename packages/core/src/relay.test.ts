import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkoutUnit, createUnitBranch } from "./branch.js";
import { commitAll, ensureMirror, git, resolveRef } from "./git.js";
import { installRelay, PUSH_BRANCH_VAR } from "./relay.js";

const author = { name: "worker", email: "worker@localhost" };
let forge: string;
let mirror: string;
let checkout: string;
const branch = "yagura/demo/u1";

const push = (args: string[], env: Record<string, string> = { [PUSH_BRANCH_VAR]: branch }) =>
  new Promise<string>((resolve) =>
    execFile("git", ["push", ...args], { cwd: checkout, env: { ...process.env, ...env } }, (err, _out, stderr) =>
      resolve(err ? (/yagura: .*/.exec(stderr)?.[0].trimEnd() ?? `refused: ${stderr}`) : "accepted"),
    ),
  );

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "yagura-relay-"));
  const seed = join(root, "seed");
  await git(["init", "--quiet", "-b", "main", seed]);
  writeFileSync(join(seed, "greet.py"), "def greet(): return 'hi'\n");
  await commitAll(seed, "init", author);
  forge = join(root, "forge.git");
  await git(["clone", "--quiet", "--bare", seed, forge]);
  mirror = join(root, "mirror.git");
  await ensureMirror(forge, mirror);
  installRelay(mirror);
  await createUnitBranch(mirror, branch, "main");
  checkout = join(root, "u1");
  await checkoutUnit(mirror, checkout, branch);
  writeFileSync(join(checkout, "greet.py"), "def greet(): return 'hello'\n");
  await commitAll(checkout, "say hello", author);
});

describe("the relay on yagura's mirror", () => {
  it("takes a fast-forward of the unit's own branch and passes it on to the forge", async () => {
    expect(await push(["origin", branch])).toBe("accepted");
    const head = await git(["rev-parse", "HEAD"], { cwd: checkout });
    expect(await resolveRef(mirror, `refs/heads/${branch}`)).toBe(head);
    expect(await resolveRef(forge, `refs/heads/${branch}`)).toBe(head);
  });

  it("refuses a force-push that rewrites the branch", async () => {
    await push(["origin", branch]);
    await git(["commit", "--quiet", "--amend", "-m", "say hello, rewritten"], { cwd: checkout });
    expect(await push(["--force", "origin", branch])).toBe(`yagura: ${branch} only moves forward; merge instead of rebasing, and never force-push`);
  });

  it("refuses a push to any other branch, a deletion, and a push from outside a worker's session", async () => {
    expect(await push(["origin", "HEAD:refs/heads/main"])).toBe(`yagura: you may push only ${branch}, not main`);
    expect(await push(["origin", "HEAD:refs/heads/yagura/demo/u2"])).toBe(`yagura: you may push only ${branch}, not yagura/demo/u2`);
    expect(await push(["origin", `:refs/heads/${branch}`])).toBe(`yagura: ${branch} cannot be deleted`);
    expect(await push(["origin", branch], {})).toBe("yagura: this copy takes pushes only from a unit's worker");
    expect(await resolveRef(forge, "refs/heads/main")).toBe(await resolveRef(mirror, "refs/remotes/origin/main"));
  });
});
