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
