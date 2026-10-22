export const TITLE_MAX = 100;
const MAX = 80;

// The name of a unit made without one: the goal's first sentence, cut at a word when it runs past MAX.
export function titleFromGoal(goal: string): string {
  const first = goal
    .split(/(?<=[.!?])\s/)[0]!
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]$/, "");
  if (first.length <= MAX) return first;
  const cut = first.slice(0, MAX - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > MAX / 2 ? cut.slice(0, word) : cut).trimEnd().replace(/[,;:]$/, "")}…`;
}
