import { useSearchParams } from "react-router-dom";

/** The visual states a reviewer can ask to see. There is deliberately no "success". */
export type SignInPreviewState = "checking" | "invalid" | "error";

const STATES: readonly SignInPreviewState[] = ["checking", "invalid", "error"];

/**
 * PREVIEW ONLY. Lets a reviewer see a sign-in state with ?state=checking,
 * ?state=invalid or ?state=error. Nothing is verified, sent or stored.
 *
 * Token safety:
 * - only the `state` parameter is read, and only against the allow-list above,
 *   so any other value (or any other parameter) is ignored and never rendered;
 * - the token is never read here, and this hook never writes anything but the
 *   removal of `state`;
 * - leaving a preview replaces the current history entry rather than adding
 *   one, so the history does not grow.
 */
export function useSignInPreview(): { state: SignInPreviewState | null; reset: () => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get("state");
  const state = STATES.find((s) => s === raw) ?? null;

  const reset = () => {
    if (!params.has("state")) return;
    const next = new URLSearchParams(params);
    next.delete("state");
    setParams(next, { replace: true });
  };

  return { state, reset };
}
