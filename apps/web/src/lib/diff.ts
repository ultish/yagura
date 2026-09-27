export type DiffLineKind = "file" | "hunk" | "add" | "del" | "meta" | "context";

export function diffLines(text: string): { kind: DiffLineKind; text: string }[] {
  return text.split("\n").map((line) => {
    if (line.startsWith("diff --git ")) return { kind: "file", text: line };
    if (line.startsWith("@@")) return { kind: "hunk", text: line };
    if (line.startsWith("+++ ") || line.startsWith("--- ") || /^(index|new file|deleted file|similarity|rename|old mode|new mode) /.test(line))
      return { kind: "meta", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line };
    if (line.startsWith("-")) return { kind: "del", text: line };
    return { kind: "context", text: line };
  });
}
