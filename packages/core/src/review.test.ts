import { describe, expect, it } from "vitest";
import { parseFindings } from "./review.js";

describe("parseFindings", () => {
  it("reads one finding per line with severity and location", () => {
    expect(parseFindings("- F1 [blocking] app/orders.py:42 — divides by zero on an empty cart\n- F2 [nit] app/x.py — name").findings).toEqual([
      { n: 1, severity: "blocking", path: "app/orders.py", line: 42, text: "divides by zero on an empty cart" },
      { n: 2, severity: "nit", path: "app/x.py", line: null, text: "name" },
    ]);
    expect(parseFindings("- none")).toEqual({ findings: [], problem: null });
  });

  it("refuses a missing section, an unknown severity, or a line out of form", () => {
    expect(parseFindings("").problem).toMatch(/no ## Findings section/);
    expect(parseFindings("- F1 [major] a.py:1 — x").problem).toBe('F1 has severity "major"; use blocking, should, or nit');
    expect(parseFindings("- the code is fine but long").problem).toMatch(/not in the form/);
  });
});
