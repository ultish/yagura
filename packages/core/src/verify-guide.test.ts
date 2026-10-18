import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAcceptance, readVerifyGuides, verifySection } from "./verify-guide.js";

function repoWithGuide(): string {
  const dir = mkdtempSync(join(tmpdir(), "yagura-guide-"));
  const features = join(dir, ".claude", "skills", "verify-orders", "features");
  mkdirSync(features, { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "verify-orders", "SKILL.md"), "---\nname: verify-orders\n---\n");
  writeFileSync(join(features, "README.md"), "# index\n");
  writeFileSync(join(features, "orders-api.md"), "# Orders API\n\nFetch an order by id over HTTP.\n\n```bash\ncurl -s http://127.0.0.1:PORT/orders/42\n```\n");
  writeFileSync(join(features, "health.md"), "# Health\n\nThe service answers /health.\n");
  return dir;
}

describe("normalizeAcceptance", () => {
  it("reads a proof off the end of a line, as a list of pages, or as new", () => {
    expect(normalizeAcceptance(["GET /orders/42 returns shipped (proof: orders-api)"])).toEqual({
      acceptance: ["GET /orders/42 returns shipped"],
      proof: [{ pages: ["orders-api"], isNew: false }],
    });
    expect(normalizeAcceptance(["it works (proof: orders-api, health)"]).proof).toEqual([{ pages: ["orders-api", "health"], isNew: false }]);
    expect(normalizeAcceptance(["emails go out (proof: new shipping-email)"]).proof).toEqual([{ pages: ["shipping-email"], isNew: true }]);
  });

  it("reads the object form", () => {
    expect(
      normalizeAcceptance([
        { outcome: "order 42 is shipped", proof: "orders-api" },
        { outcome: "no proof here" },
        { outcome: "new one", proof: "new shipping-email" },
      ]),
    ).toEqual({
      acceptance: ["order 42 is shipped", "no proof here", "new one"],
      proof: [{ pages: ["orders-api"], isNew: false }, null, { pages: ["shipping-email"], isNew: true }],
    });
  });

  it("leaves a plain line, and a malformed proof, as they are", () => {
    expect(normalizeAcceptance(["greet('Jimmy') returns Hello, Jimmy", "x (proof: Not A Page!)"])).toEqual({
      acceptance: ["greet('Jimmy') returns Hello, Jimmy", "x (proof: Not A Page!)"],
      proof: [null, null],
    });
  });
});

describe("readVerifyGuides", () => {
  it("lists a repo's guide pages without the index", () => {
    const [g] = readVerifyGuides(repoWithGuide());
    expect(g).toMatchObject({ skill: "verify-orders", dir: ".claude/skills/verify-orders" });
    expect(g!.pages.map(({ name, summary }) => ({ name, summary }))).toEqual([
      { name: "health", summary: "The service answers /health." },
      { name: "orders-api", summary: "Fetch an order by id over HTTP." },
    ]);
  });

  it("finds nothing in a repo without one", () => {
    expect(readVerifyGuides(mkdtempSync(join(tmpdir(), "yagura-guide-")))).toEqual([]);
  });
});

describe("verifySection", () => {
  const guides = readVerifyGuides(repoWithGuide());
  const { acceptance, proof } = normalizeAcceptance(["returns shipped (proof: orders-api)", "emails go out (proof: new shipping-email)", "no proof here"]);

  it("tells a worker which page proves each line and how to write a new one", () => {
    const text = verifySection(guides, acceptance, proof, "worker");
    expect(text).toContain("returns shipped → page orders-api");
    expect(text).toContain("emails go out → NEW page shipping-email");
    expect(text).toContain("no proof here → (none named");
    expect(text).toContain("--at base");
    expect(text).toContain("$YAGURA_EVIDENCE");
    expect(text).not.toContain("curl -s http://127.0.0.1:PORT/orders/42");
  });

  it("gives a judge the named pages' own text and the compare-with-the-page steps", () => {
    const text = verifySection(guides, acceptance, proof, "judge");
    expect(text).toContain("run each of its commands exactly as written");
    expect(text).toContain("### page orders-api");
    expect(text).toContain("curl -s http://127.0.0.1:PORT/orders/42");
    expect(text).not.toContain("### page health");
  });

  it("tells a worker to create the guide when the repo has none", () => {
    expect(verifySection([], ["builds"], [null], "worker")).toContain("pstack:create-verification-skill");
    expect(verifySection([], ["builds"], [null], "judge")).not.toContain("create-verification-skill");
  });
});
