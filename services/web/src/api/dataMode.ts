import { createContext, useContext } from "react";

/**
 * Where a screen's data comes from.
 * - `live` (the default): the Application API, through the signed-in session's client.
 * - `preview`: the illustrative preview data in src/preview/. A screen in this mode never calls the API.
 *
 * The app picks the mode once, from `VITE_API_MODE` at build or dev-server start (main.tsx). It is not a secret.
 * Screens that haven't been connected to the API yet ignore it and stay on preview data.
 */
export type DataMode = "live" | "preview";

export const DataModeContext = createContext<DataMode>("live");

export function useDataMode(): DataMode {
  return useContext(DataModeContext);
}

/** `preview` only for exactly "preview"; anything else, or nothing, is live. */
export function dataModeFromEnv(value: unknown): DataMode {
  return value === "preview" ? "preview" : "live";
}
