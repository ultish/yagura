export interface Fit {
  label: string;
  // Pixels; the one column left without a width takes what the others leave.
  width?: number;
  // The order columns leave as the room shrinks: 1 goes first. A column without one stays.
  drop?: number;
}

export const FLEX_MIN = 240;

const need = (cols: Fit[]) => cols.reduce((n, c) => n + (c.width ?? FLEX_MIN), 0);

// The columns that fit in `width` pixels, dropping them in their `drop` order, and whether even the ones that stay do not fit (a card layout then).
export function fitColumns<T extends Fit>(cols: T[], width: number): { shown: T[]; cards: boolean } {
  const order = cols.filter((c) => c.drop !== undefined).sort((a, b) => a.drop! - b.drop!);
  let shown = cols;
  for (const gone of order) {
    if (need(shown) <= width) break;
    shown = shown.filter((c) => c !== gone);
  }
  return { shown, cards: need(shown) > width };
}

export const needed = need;
