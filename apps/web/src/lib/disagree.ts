export interface CodeSelection {
  start: number;
  end: number;
  text: string;
}

// What a disagreement about code points at: the file, the selected lines when there are any, and a short quote.
export function codeAbout(path: string, sel: CodeSelection | null): { ref: string; about: string } {
  const lines = sel ? (sel.start === sel.end ? `:${sel.start}` : `:${sel.start}-${sel.end}`) : "";
  const quote = sel ? sel.text.trim().replace(/\s+/g, " ").slice(0, 160) : "";
  return { ref: `code:${path}${lines}`, about: quote ? `${path}${lines} — ${quote}` : `${path}: the change to this file` };
}
