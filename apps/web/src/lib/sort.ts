export type TimeOrder = "oldest" | "newest";

// Oldest first is a stable sort by time (an item with no time sorts first, keeping its place among its kind); newest first is its mirror.
export function byTime<T>(items: readonly T[], at: (item: T) => string | null | undefined, order: TimeOrder): T[] {
  const time = (item: T) => {
    const t = Date.parse(at(item) ?? "");
    return Number.isNaN(t) ? -Infinity : t;
  };
  const ascending = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => time(a.item) - time(b.item) || a.i - b.i)
    .map((x) => x.item);
  return order === "newest" ? ascending.reverse() : ascending;
}

const KEY = "yagura.unit.order";

export function savedOrder(): TimeOrder {
  try {
    return localStorage.getItem(KEY) === "newest" ? "newest" : "oldest";
  } catch {
    return "oldest";
  }
}

export function saveOrder(order: TimeOrder): void {
  try {
    localStorage.setItem(KEY, order);
  } catch {
    // Storage can be off in a private window; the choice then lasts until the page reloads.
  }
}
