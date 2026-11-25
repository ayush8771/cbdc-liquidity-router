import { createContext, useContext } from "react";

/**
 * The build flag `VITE_OBSERVATIONS` (AD-1 §3.3.4). It is on only for exactly "on"; any other
 * value, or none, is off. Like the data mode it is read once, at start-up (main.tsx), and is
 * public, not a secret. The context defaults to off, so a tree with no provider shows nothing.
 */
export const ObservationsFlagContext = createContext<boolean>(false);

export function useObservationsFlag(): boolean {
  return useContext(ObservationsFlagContext);
}

export function observationsFlagFromEnv(value: unknown): boolean {
  return value === "on";
}
