import { Button } from "../../components/ui/Button";
import { Notice, type NoticeTone } from "../../components/ui/Notice";
import { StatusIndicator } from "../../components/ui/StatusIndicator";
import type { SignInPreviewState } from "./useSignInPreview";

/**
 * Shown only while a visual preview (?state=) is on screen: sign-in itself is
 * now real (GET /api/v1/auth/me), and the preview message below it is not.
 * Desktop only (`lg` and up); below that the page is exactly as it was.
 */
export function PreviewModeStrip({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="hidden lg:block">
      <div className="mb-6 space-y-2 border-b border-line-subtle pb-6">
        <StatusIndicator tone="neutral" label="Preview mode" />
        <p className="text-ui text-ink-muted">
          You are viewing a preview of a sign-in state. The message below is illustrative, not a result.
        </p>
      </div>
    </div>
  );
}

// Outcomes of GET /api/v1/auth/me (contract §3.0): 200, 401 UNAUTHENTICATED
// ("Missing or invalid token.") and 500 INTERNAL_ERROR. The wording is this
// UI's own; engine or backend text is never shown. The real sign-in states
// reuse this wording (see SignInPage).
export const CONTENT: Record<
  SignInPreviewState,
  { tone: NoticeTone; role: "status" | "alert"; title: string; body: string; action: string }
> = {
  checking: {
    tone: "info",
    role: "status",
    title: "Checking your token…",
    body: "This takes a moment.",
    action: "Exit preview",
  },
  invalid: {
    tone: "danger",
    role: "alert",
    title: "That token wasn't accepted",
    body: "Check it and try again.",
    action: "Exit preview",
  },
  error: {
    tone: "danger",
    role: "alert",
    title: "We couldn't check your token",
    body: "Try again in a moment.",
    action: "Try again",
  },
};

type SignInStatusProps = {
  state: SignInPreviewState | null;
  /** Only clears the visual preview state. It verifies and sends nothing. */
  onReset: () => void;
};

/** A visual preview of a sign-in state. Desktop only (`lg` and up). */
export function SignInStatus({ state, onReset }: SignInStatusProps) {
  if (!state) return null;
  const content = CONTENT[state];

  return (
    <div className="hidden lg:block">
      <Notice tone={content.tone} role={content.role} title={content.title}>
        <p>{content.body}</p>
        <p className="mt-2 text-meta text-ink-muted">Preview of this state. Nothing was checked.</p>
        <div className="mt-3">
          <Button variant="tertiary" size="sm" onClick={onReset} className="-ml-2">
            {content.action}
          </Button>
        </div>
      </Notice>
    </div>
  );
}
