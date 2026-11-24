import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query currently matches, kept live as it changes.
 * Reports false where matchMedia doesn't exist (for example in jsdom), so a
 * page that gates on it falls back to its small-screen version there.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}
