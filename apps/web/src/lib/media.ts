import { useSyncExternalStore } from "react";

// The width at which the top bar gives its links, search and tools to a menu.
export const NARROW = "(max-width: 1280px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// Below these widths a page's side columns leave the layout and open from a button in a slideout instead.
export const PANELS = "(max-width: 900px)";
export const FACTS = "(max-width: 1000px)";
