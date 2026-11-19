import { useSearchParams } from "react-router-dom";

export type PreviewState = "ready" | "loading" | "empty" | "error";

const STATES: PreviewState[] = ["loading", "empty", "error"];

/**
 * PREVIEW ONLY. Lets a reviewer see each presentation state by adding
 * ?state=loading, ?state=empty or ?state=error to a preview page's URL.
 * Replaced by real request status once the API is integrated.
 */
export function usePreviewState(): { state: PreviewState; clear: () => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get("state");
  const state = (STATES as string[]).includes(raw ?? "") ? (raw as PreviewState) : "ready";
  const clear = () => {
    const next = new URLSearchParams(params);
    next.delete("state");
    setParams(next);
  };
  return { state, clear };
}
