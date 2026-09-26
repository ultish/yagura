import { existsSync, readFileSync } from "node:fs";
import { write } from "./agent.js";

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

export function readSpec(path: string): Spec | null {
  return existsSync(path) ? parseSpec(readFileSync(path, "utf8")) : null;
}

export function writeSpec(path: string, spec: Spec): void {
  write(path, renderSpec(spec));
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [];

export function relevantSections(spec: Spec, message: string): SpecSection[] {
  const said = words(message);
  return spec.sections.filter((s) => words(s.heading).some((w) => said.some((x) => x.startsWith(w) || w.startsWith(x))));
}
