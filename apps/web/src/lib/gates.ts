import { duration } from "./format";

export function ifUnanswered(gate: { kind: string; defaultOption: string | null; deadline: string | null }, now: number): string | null {
  if (gate.kind === "report") return null;
  if (!gate.defaultOption) return "Waits for your answer.";
  if (gate.defaultOption === "hold") return "Holds until you answer.";
  if (!gate.deadline) return `Waits for you; the default is ${gate.defaultOption}.`;
  const left = Date.parse(gate.deadline) - now;
  return left > 0 ? `Takes ${gate.defaultOption} in ${duration(left)} if nobody answers.` : `Taking ${gate.defaultOption} now.`;
}
