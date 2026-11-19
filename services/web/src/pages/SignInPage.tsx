import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { DevAuthBanner } from "../components/layout/DevAuthBanner";
import { Wordmark } from "../components/layout/Wordmark";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { FormField } from "../components/ui/FormField";
import { Icon } from "../components/ui/Icon";
import { Notice } from "../components/ui/Notice";
import { PreviewModeStrip, SignInStatus } from "../features/auth/SignInStatus";
import { TokenField } from "../features/auth/TokenField";
import { useSignInPreview } from "../features/auth/useSignInPreview";
import { cx } from "../lib/cx";

// Facts from docs/PHASE2_ARCHITECTURE.md (D1, scope rule) and contract §2.6.
const LEDGER = [
  { term: "Default policy", detail: "Liquidity-aware waterfall" },
  { term: "Data", detail: "Synthetic daily bridge state, up to 30 September 2025" },
  { term: "Scope", detail: "Historical replay and synthetic simulation only" },
];

type Outcome = "idle" | "not-connected";

/**
 * Development sign-in (arch §8.3). VISUAL ONLY for now: validating the token
 * with GET /api/v1/auth/me needs the shared contracts and API client. Until
 * then, the token is never stored, sent or logged.
 *
 * The preview-mode notice, the Show/Hide control and the checking / invalid /
 * error previews are desktop only (`lg` and up). Below that the page is
 * unchanged. The previews are purely visual (?state=), see useSignInPreview.
 */
export function SignInPage() {
  const [token, setToken] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const preview = useSignInPreview();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A new attempt: hide the token again and leave any visual preview.
    setRevealed(false);
    preview.reset();
    if (token.trim() === "") {
      setError("Enter your development token.");
      setOutcome("idle");
      return;
    }
    setError(null);
    setToken("");
    setOutcome("not-connected");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <DevAuthBanner />
      {/* Desktop (lg+): the wordmark gets its own row, and the two columns are
          centred together beneath it. The card has a fixed width and its top
          lines up with the eyebrow. Below lg the layout is a single column. */}
      <div className="mx-auto grid w-full max-w-content flex-1 grid-cols-1 gap-12 px-4 py-10 sm:px-6 lg:grid-rows-[auto_1fr] lg:px-10 lg:py-12">
        <div className="flex">
          <Wordmark to="/sign-in" />
        </div>

        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-16 lg:self-center xl:grid-cols-[minmax(0,1fr)_26rem] xl:gap-24">
          <section aria-labelledby="intro-heading" className="flex flex-col justify-between gap-12">
            <div className="space-y-6">
              <p className="eyebrow-category">Cross-border CBDC routing</p>
              <h1 id="intro-heading" className="font-serif-display text-heading-lg text-ink-primary lg:text-balance">
                Liquidity routing, with every assumption labelled.
              </h1>
              <p className="max-w-xl text-body text-ink-muted">
                Route a transaction across bridge venues, then inspect the allocation, the metrics and the explanation
                behind it.
              </p>
            </div>

            {/* "Gilded ledger lines" as hairlines: DESIGN.md reserves the gold
                gradient for charts and keeps Copper off borders. */}
            <dl className="max-w-xl border-t border-line-subtle">
              {LEDGER.map((row) => (
                <div
                  key={row.term}
                  className="grid grid-cols-1 gap-1.5 border-b border-line-subtle py-4 sm:grid-cols-[10rem_1fr] sm:gap-6"
                >
                  <dt className="eyebrow pt-0.5">{row.term}</dt>
                  <dd className="text-ui text-ink-body">{row.detail}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="signin-heading" className="flex items-center lg:items-start">
            <Card className="w-full p-6 sm:p-8">
              <PreviewModeStrip />
              <div className="mb-8 space-y-2">
                <h2 id="signin-heading" className="font-serif-display text-title text-ink-primary">
                  Sign in
                </h2>
                <p className="text-ui text-ink-muted">Use the development token you generated on this machine.</p>
              </div>

              <form noValidate onSubmit={handleSubmit} className="space-y-6">
                <FormField
                  label="Development token"
                  required
                  error={error}
                  helper="A 64-character hexadecimal token. Never share it or commit it."
                >
                  {({ invalid, ...control }) => (
                    // No `name`: the token is never part of a native form
                    // submission, so it can never reach the URL or history.
                    <TokenField
                      {...control}
                      invalid={invalid}
                      revealed={revealed}
                      onRevealedChange={setRevealed}
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value);
                        if (error) setError(null);
                      }}
                      className={cx(
                        preview.state === "invalid" && "lg:border-status-danger",
                        preview.state === "checking" && "lg:opacity-60",
                      )}
                    />
                  )}
                </FormField>

                <SignInStatus state={preview.state} onReset={preview.reset} />

                <Button
                  type="submit"
                  className={cx("w-full", preview.state === "checking" && "lg:hidden")}
                  iconEnd={<Icon name="arrowRight" size={16} />}
                >
                  Sign in
                </Button>
                {preview.state === "checking" ? (
                  <div className="hidden lg:block">
                    <Button
                      disabled
                      className="w-full"
                      iconStart={
                        <span
                          aria-hidden="true"
                          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                        />
                      }
                    >
                      Checking…
                    </Button>
                  </div>
                ) : null}

                <div aria-live="polite">
                  {outcome === "not-connected" ? (
                    <Notice tone="warning" title="Sign-in isn't connected yet">
                      Token validation with <code className="text-ink-body">GET /api/v1/auth/me</code> will be added once
                      the shared API contracts are merged. Your token was not stored or sent.
                    </Notice>
                  ) : null}
                </div>
              </form>

              <details className="group mt-8 border-t border-line-subtle pt-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-pill text-ui font-medium text-ink-secondary hover:text-paper-white [&::-webkit-details-marker]:hidden">
                  <span className="inline-flex items-center gap-2">
                    <Icon name="key" size={16} />
                    How do I get a development token?
                  </span>
                  <Icon name="chevronDown" size={16} className="transition-transform group-open:rotate-180" />
                </summary>
                <ol className="mt-4 list-decimal space-y-3 pl-5 text-ui text-ink-muted marker:text-ink-subtle">
                  <li>
                    Generate a random token locally:
                    <code className="mt-2 block overflow-x-auto rounded-card border border-line-subtle bg-surface-panel px-3 py-2 text-meta text-ink-body">
                      node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;
                    </code>
                  </li>
                  <li>
                    Register its SHA-256 hash, with your role, in the backend&apos;s git-ignored{" "}
                    <code className="text-ink-body">dev-tokens.json</code>. See the backend README.
                  </li>
                  <li>Paste the token here. It is for development only and is not production security.</li>
                </ol>
              </details>

              <div className="mt-6">
                <Link
                  to="/"
                  className="inline-flex items-center gap-1.5 rounded-pill text-ui text-ink-muted hover:text-paper-white"
                >
                  Preview the application layout
                  <Icon name="arrowRight" size={14} />
                </Link>
              </div>
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
