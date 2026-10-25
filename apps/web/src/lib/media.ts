import { useSyncExternalStore } from "react";

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

// A phone, or any touch screen: the tour points at things a small screen hides, so it does not run there.
export const MOBILE = "(max-width: 700px), (pointer: coarse)";
