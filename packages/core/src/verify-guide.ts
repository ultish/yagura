import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitProof } from "./domain.js";

export interface GuidePage {
  name: string;
  summary: string;
  text: string;
}

export interface VerifyGuide {
  skill: string;
  dir: string;
  pages: GuidePage[];
}

const PROOF = /\s*\(proof:\s*([^)]*)\)\s*$/;
const PAGE = /^[a-z0-9][a-z0-9-]*$/;

// A proof is page names, or `new <page>` when the unit must write that page first: "orders-api", "orders-api, health", "new shipping-email".
export function parseProofSpec(spec: string): UnitProof | null {
  const m = /^(new\s+)?(.+)$/.exec(spec.trim());
  if (!m) return null;
  const pages = m[2]!.split(",").map((p) => p.trim());
  return pages.every((p) => PAGE.test(p)) ? { pages, isNew: Boolean(m[1]) } : null;
}

export interface AcceptanceInput {
  outcome: string;
  proof?: string;
}

// The planner writes an acceptance line as plain text, with `(proof: orders-api)` at its end, or as { outcome, proof }. Both
// are stored as the outcome and the page(s) that prove it.
export function normalizeAcceptance(items: (string | AcceptanceInput)[]): { acceptance: string[]; proof: (UnitProof | null)[] } {
  const acceptance: string[] = [];
  const proof: (UnitProof | null)[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      acceptance.push(item.outcome);
      proof.push(item.proof ? parseProofSpec(item.proof) : null);
      continue;
    }
    const m = PROOF.exec(item);
    const spec = m ? parseProofSpec(m[1]!) : null;
    acceptance.push(spec ? item.slice(0, m!.index) : item);
    proof.push(spec);
  }
  return { acceptance, proof };
}

function summaryOf(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("---"));
  return (line ?? "").slice(0, 140);
}

export function readVerifyGuides(checkout: string): VerifyGuide[] {
  const skills = join(checkout, ".claude", "skills");
  if (!existsSync(skills)) return [];
  const guides: VerifyGuide[] = [];
  for (const entry of readdirSync(skills, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("verify-")) continue;
    const features = join(skills, entry.name, "features");
    const pages: GuidePage[] = [];
    if (existsSync(features))
      for (const f of readdirSync(features).sort())
        if (f.endsWith(".md") && f !== "README.md") {
          const text = readFileSync(join(features, f), "utf8");
          pages.push({ name: f.slice(0, -3), summary: summaryOf(text), text });
        }
    guides.push({ skill: entry.name, dir: join(".claude", "skills", entry.name), pages });
  }
  return guides.sort((a, b) => a.skill.localeCompare(b.skill));
}

const RULES = `- Drive the guide through \`yagura evidence run --page <page> -- <command>\` so each drive is a recorded run you can cite, tied to its page. Write proof files to \`$YAGURA_EVIDENCE\`, never into the checkout.
- Make every drive exit non-zero when anything differs from what the page says it returns (use \`curl -f\` and compare the body), so a run's exit code means something: a new page must fail on the base, and a drive that succeeds without the change proves nothing.
- The guide's ports and paths are examples. Pick a free port and a temporary directory of your own, so units running side by side do not collide, and stop what you started.
- Drive a page by running its commands as written, then compare what comes back with what the page says it returns. A difference is a stale page or a defect in the code, never something to skip: the worker corrects the page in its branch (and says so with --decision) or fixes the code; the judge records a finding. Do this again after you merge the base branch.`;

// A page the unit names that the repo's guide does not have yet is new, whatever the planner wrote: the worker writes it.
export function markNewPages(proof: (UnitProof | null)[], guides: VerifyGuide[]): (UnitProof | null)[] {
  const have = new Set(guides.flatMap((g) => g.pages.map((p) => p.name)));
  return proof.map((p) => (p && !p.isNew && p.pages.some((page) => !have.has(page)) ? { ...p, isNew: true } : p));
}

const PAGE_TEXT_LIMIT = 4000;

export function verifySection(guides: VerifyGuide[], acceptance: string[], proof: (UnitProof | null)[], role: "worker" | "judge"): string {
  if (guides.length === 0) {
    const wantsNew = proof.some((p) => p?.isNew);
    return [
      "This repo has no verification guide yet.",
      wantsNew || role === "worker"
        ? "If the goal or acceptance asks you to create one, load pstack:create-verification-skill and write it to `.claude/skills/verify-<app>/`, with a page per feature under `features/`. Do not commit anywhere but your branch, and prove it by driving one feature before you hand off. Otherwise prove the work with the environment's tests."
        : "Judge with the environment's tests and runs of your own.",
    ].join("\n");
  }
  const out: string[] = [];
  for (const g of guides) {
    out.push(`Guide: skill \`${g.skill}\` at \`${g.dir}/\`. Load it with the Skill tool before you start.`);
    out.push(g.pages.length ? g.pages.map((p) => `- page ${p.name}: ${p.summary}`).join("\n") : "- (no pages yet)");
  }
  const named = proof.filter((p) => p?.pages.length);
  out.push("");
  out.push(
    named.length
      ? "Proof named for each acceptance line:\n" +
          acceptance
            .map((line, i) => {
              const p = proof[i];
              return `- ${line} → ${p?.pages.length ? `${p.isNew ? "NEW page " : "page "}${p.pages.join(", ")}` : "(none named: pick the page whose use fits, and say which in your hand-off)"}`;
            })
            .join("\n")
      : "No acceptance line names a page: pick the page whose use fits each, and say which in your hand-off.",
  );
  out.push("");
  if (role === "worker") {
    out.push(
      "For a NEW page: write it first and commit it, drive it while the code is still unchanged and see it fail, build the change, then drive it again and see it pass. Tag every drive with `--page <page>`. If a step in an existing page is wrong, fix it in your branch and record it with --decision.",
    );
  } else {
    out.push(
      "For each named page, in this order: (1) run each of its commands exactly as written, changing only the port and paths, as a recorded run with `--page <page>` (yagura refuses an approval unless you drove every named page this way); (2) write down what the page says it returns next to what you got; (3) any difference is a finding, because the page is stale or the code is wrong. Cite those runs in `judge approve --runs`. For a NEW page, also run it with `--page <page> --at base` and see it fail (yagura requires that too); a page that would pass whatever the code does is a finding. A step the worker corrected in a page is part of the change: check the correction.",
    );
    const texts: string[] = [];
    for (const name of new Set(proof.flatMap((p) => p?.pages ?? []))) {
      const page = guides.flatMap((g) => g.pages).find((pg) => pg.name === name);
      if (page)
        texts.push(
          `### page ${page.name}\n\n${page.text.length > PAGE_TEXT_LIMIT ? `${page.text.slice(0, PAGE_TEXT_LIMIT)}\n(cut; read the rest in your checkout)` : page.text}`,
        );
    }
    if (texts.length) out.push("", "The named pages, as they are on this head:", "", ...texts);
  }
  out.push(RULES);
  return out.join("\n");
}
