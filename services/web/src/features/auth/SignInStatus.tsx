import { Button } from "../../components/ui/Button";
import { Notice, type NoticeTone } from "../../components/ui/Notice";
import { StatusIndicator } from "../../components/ui/StatusIndicator";
import type { SignInPreviewState } from "./useSignInPreview";

/**
 * Always-visible notice that sign-in is not connected. Desktop only (`lg`
 * and up); below that the page is exactly as it was.
 */
export function PreviewModeStrip() {
  return (
    <div className="hidden lg:block">
      <div className="mb-6 space-y-2 border-b border-line-subtle pb-6">
        <StatusIndicator tone="neutral" label="Preview mode" />
        <p className="text-ui text-ink-muted">
          Authentication isn&apos;t connected. Nothing you enter here is checked, stored or sent.
        </p>
      </div>
    </div>
  );
}

// Outcomes of GET /api/v1/auth/me in the rev 5 contract: 200, 401
// UNAUTHENTICATED ("Missing or invalid token.") and 500 INTERNAL_ERROR. The
// wording is this UI's own; engine or backend text is never shown.
const CONTENT: Record<
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
