import { describe, expect, it } from "vitest";
import { SETTING_LAYERS, SETTINGS, describeSettings, type SettingKey } from "./config.js";
import { SETTING_DOCS, SETTING_GROUPS } from "./settings-docs.js";
import { openStore, addRepo } from "./store.js";
import { setSetting } from "./config.js";
import type { RepoId } from "./domain.js";

const keys = Object.keys(SETTINGS) as SettingKey[];

describe("setting docs", () => {
  it("document every setting, once, with a plain title and help", () => {
    expect(Object.keys(SETTING_DOCS).sort()).toEqual([...keys].sort());
    const titles = keys.map((k) => SETTING_DOCS[k].title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const k of keys) {
      expect(SETTING_DOCS[k].title.length, k).toBeGreaterThan(3);
      expect(SETTING_DOCS[k].help.endsWith("."), k).toBe(true);
    }
  });

  it("put every setting in a known group, and use every group", () => {
    for (const k of keys) expect(SETTING_GROUPS, k).toContain(SETTING_DOCS[k].group);
    for (const g of SETTING_GROUPS)
      expect(
        keys.some((k) => SETTING_DOCS[k].group === g),
        g,
      ).toBe(true);
  });

  it("offer only values the setting accepts, with an example that is one of them", () => {
    for (const k of keys) {
      const { options, example } = SETTING_DOCS[k];
      if (!options) continue;
      for (const o of options) expect(SETTINGS[k].safeParse(o).success, `${k}=${o}`).toBe(true);
      expect(options, k).toContain(example);
    }
  });

  it("type a list one per line only when it is a list", () => {
    for (const k of keys) if (SETTING_DOCS[k].lines) expect(Array.isArray(SETTINGS[k].parse(undefined)), k).toBe(true);
  });

  it("reach every global setting from the page that lists them", () => {
    const db = openStore(":memory:");
    const globals = keys.filter((k) => SETTING_LAYERS[k].length === 0);
    const listed = describeSettings(db).map((s) => s.key);
    for (const k of globals) expect(listed, k).toContain(k);
    expect(describeSettings(db, {}, "repo").every((s) => s.layers.includes("repo"))).toBe(true);
  });

  it("say what an empty box does, for exactly the settings whose default is empty", () => {
    for (const k of keys) {
      const fallback = SETTINGS[k].parse(undefined);
      const isEmpty = fallback === null || fallback === "" || (Array.isArray(fallback) && fallback.length === 0);
      expect(Boolean(SETTING_DOCS[k].emptyMeans), k).toBe(isEmpty);
    }
  });

  it("tells a layer what the setting would be without it", () => {
    const db = openStore(":memory:");
    addRepo(db, { id: "r", url: "file:///r", defaultBranch: "main" });
    setSetting(db, "global", "", "forge.trusted_authors", ["ultish", "jimmyxhui"]);
    setSetting(db, "repo", "r", "forge.trusted_authors", []);
    const at = describeSettings(db, { repoId: "r" as RepoId }, "repo").find((s) => s.key === "forge.trusted_authors")!;
    expect(at).toMatchObject({ value: [], source: "repo", inherited: ["ultish", "jimmyxhui"] });
    expect(describeSettings(db).find((s) => s.key === "forge.trusted_authors")).not.toHaveProperty("inherited");
  });
});

describe("harness.claude.bin", () => {
  it("saves a bare command name as the path found on PATH, and refuses one that is not there", async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolveSetting } = await import("./config.js");
    const dir = mkdtempSync(join(tmpdir(), "yagura-bin-"));
    writeFileSync(join(dir, "my-claude"), "#!/bin/sh\n");
    chmodSync(join(dir, "my-claude"), 0o755);
    const db = openStore(":memory:");
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      setSetting(db, "global", "", "harness.claude.bin", "my-claude");
      expect(resolveSetting(db, "harness.claude.bin").value).toBe(join(dir, "my-claude"));
      expect(() => setSetting(db, "global", "", "harness.claude.bin", "no-such-claude")).toThrow(/not on PATH/);
    } finally {
      process.env.PATH = path;
    }
  });
});
