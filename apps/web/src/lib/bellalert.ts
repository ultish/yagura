import type { BellItem } from "../api";

export const tabTitle = (n: number) => (n > 0 ? `(${n}) yagura` : "yagura");

export const newItems = (seen: ReadonlySet<string>, items: readonly BellItem[]): BellItem[] => items.filter((i) => !seen.has(i.id));

// What a desktop notification says for a bell item, and where clicking it goes.
export function announce(item: BellItem): { title: string; body: string; href: string } {
  switch (item.kind) {
    case "gate":
      return {
        title: "yagura · needs your answer",
        body: `${item.unit ? `U${item.unit.seq} ${item.unit.goal}: ` : ""}${item.gate.question}`,
        href: item.unit ? `/p/${item.projectId}/u/${item.unit.seq}` : "/gates",
      };
    case "blocked":
      return {
        title: "yagura · blocked",
        body: `U${item.unit.seq} ${item.unit.goal}: ${item.reason ?? "no reason recorded"}`,
        href: `/p/${item.projectId}/u/${item.unit.seq}`,
      };
    case "proposal":
      return { title: "yagura · proposal ready", body: item.summary, href: `/talk/${item.threadId}` };
  }
}

// A favicon is an image, not page CSS, so it carries literal colours: the tower on the night ground and, when the bell
// rings, a vermilion lamp (--bell) in the corner.
export function faviconHref(ringing: boolean): string {
  const lamp = ringing ? "%3Ccircle cx='25' cy='7' r='6' fill='%23e5553a' stroke='%2311141f' stroke-width='2'/%3E" : "";
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2311141f'/%3E%3Crect x='11' y='9' width='10' height='12' fill='%23f0a94a'/%3E%3Cpath d='M6 10 L13 4 L19 4 L26 10 Z' fill='%238a7160'/%3E%3Cpath d='M10 30 L12 21 M22 30 L20 21' stroke='%238a7160' stroke-width='2'/%3E${lamp}%3C/svg%3E`;
}
