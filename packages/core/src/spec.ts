import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Bootstrap } from "./config.js";
import { layout } from "./paths.js";
import { now, type Db } from "./store.js";

export interface SpecSection {
  heading: string;
  body: string;
}

export interface Spec {
  preamble: string;
  sections: SpecSection[];
}

export function parseSpec(text: string): Spec {
  const parts = text.split(/^## +(.+)$/m);
  const sections: SpecSection[] = [];
  for (let i = 1; i < parts.length; i += 2) sections.push({ heading: parts[i]!.trim(), body: (parts[i + 1] ?? "").trim() });
  return { preamble: parts[0]!.trim(), sections };
}

export function renderSpec(spec: Spec): string {
  const blocks = [spec.preamble, ...spec.sections.map((s) => `## ${s.heading}\n\n${s.body}`.trim())].filter(Boolean);
  return `${blocks.join("\n\n")}\n`;
}

const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function editSpec(spec: Spec, heading: string, body: string | null): Spec {
  const i = spec.sections.findIndex((s) => sameHeading(s.heading, heading));
  if (body === null) return i === -1 ? spec : { ...spec, sections: spec.sections.filter((_, j) => j !== i) };
  const section = { heading: i === -1 ? heading.trim() : spec.sections[i]!.heading, body: body.trim() };
  return { ...spec, sections: i === -1 ? [...spec.sections, section] : spec.sections.map((s, j) => (j === i ? section : s)) };
}

// A project's spec is yagura's, not a repo's: it lives in the store, the watchman edits it by section, and the developer
// edits the whole text in the dashboard.
export interface StoredSpec {
  text: string;
  updatedBy: string;
  updatedAt: string;
}

export function getSpec(db: Db, projectId: string): StoredSpec | null {
  const r = db.prepare("SELECT text, updated_by, updated_at FROM project_specs WHERE project_id = ?").get(projectId) as
    { text: string; updated_by: string; updated_at: string } | undefined;
  return r ? { text: r.text, updatedBy: r.updated_by, updatedAt: r.updated_at } : null;
}

export function readSpec(db: Db, projectId: string): Spec | null {
  const s = getSpec(db, projectId);
  return s ? parseSpec(s.text) : null;
}

export function writeSpec(db: Db, projectId: string, spec: Spec | string, by: string): void {
  const text = typeof spec === "string" ? spec : renderSpec(spec);
  db.prepare(
    `INSERT INTO project_specs (project_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(projectId, text, by, now());
}

// Specs used to be files under each project's folder; the daemon moves any it finds into the store and removes them.
export function importSpecFiles(db: Db, boot: Bootstrap): string[] {
  const moved: string[] = [];
  for (const { id } of db.prepare("SELECT id FROM projects").all() as { id: string }[]) {
    const path = layout(boot).spec(id as never);
    if (!existsSync(path)) continue;
    if (!getSpec(db, id)) writeSpec(db, id, readFileSync(path, "utf8"), "imported");
    rmSync(path);
    moved.push(path);
  }
  return moved;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [];

export function relevantSections(spec: Spec, message: string): SpecSection[] {
  const said = words(message);
  return spec.sections.filter((s) => words(s.heading).some((w) => said.some((x) => x.startsWith(w) || w.startsWith(x))));
}
