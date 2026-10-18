export interface UpkeepAnswer {
  asked: boolean;
  hasGuide: boolean;
  project: string | null;
}

// What the repo row says after "Run upkeep", in the words a developer needs: did it start, where, or why not.
export function upkeepMessage(a: UpkeepAnswer): { tone: "lamp" | "bell"; text: string } {
  if (!a.hasGuide) return { tone: "bell", text: "This repo has no verification guide yet, so there is nothing to check." };
  if (!a.project) return { tone: "bell", text: "Asked. No active project uses this repo, so it waits until one does." };
  return { tone: "lamp", text: `Asked. A guide upkeep is added to ${a.project} within a few seconds.` };
}
