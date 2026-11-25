# e2e/

End-to-end checks for the Phase 2 Docker Compose stack (arch §4, §5.4). Dev D.

| File | What it is |
|---|---|
| `api-smoke.py` | API smoke test (Python, standard library only), run by `.github/workflows/phase2-stack.yml`. |
| `stack-security.py` | Runtime security checks on a running Compose project, run by the same workflow. |
| `tests/app.spec.ts` | Chromium browser tests (Playwright) of the real React app behind nginx. |
| `p3/observations.spec.ts`, `playwright.p3.config.ts` | Phase 3 (D-24) observation acceptance, run only by `p3_browser_acceptance.py` on stacks it builds. Not part of `npm test`. See `docs/PHASE3_D24_ACCEPTANCE.md`. |
| `package.json`, `package-lock.json`, `playwright.config.ts` | The Playwright project. Its own `node_modules`; nothing is installed in `services/web`. |

## Browser tests

They need a running, **seeded** stack (`infra/README.md`, "Compose setup") and the disposable analyst token.
They do not start a server and they only talk to a loopback address.

```powershell
cd e2e
npm ci
npx playwright install chromium        # Linux CI: npx playwright install --with-deps chromium
$env:E2E_TOKENS_FILE = "<path to a JSON file>"   # outside the checkout: {"analyst": {"token": "<your analyst token>"}}
npm test                               # E2E_BASE_URL defaults to http://127.0.0.1:8080
```

| Variable | Meaning |
|---|---|
| `E2E_TOKENS_FILE` | Required. JSON file holding the analyst token, outside the checkout. In CI it is the `smoke-tokens.json` that the workflow generates. |
| `E2E_BASE_URL` | Where the web service is published. Default `http://127.0.0.1:8080`. |
| `E2E_OUTPUT_DIR` | Where Playwright writes its output. Default `test-results` (git-ignored). |
| `E2E_ALLOW_REMOTE` | `1` to allow a base URL that is not loopback. The tests create data, so leave it unset. |

Chromium only, viewport 1280x800 (the data screens start at 1024 px), one worker, in order.

### Tokens and artifacts

- The token is read from the file at run time. It is never in a test title, a URL or the log, and an error raised while
  typing it is scrubbed.
- Trace, screenshot and video are **off**, so no recording of the sign-in screen exists. Do not turn them on for a run that
  uses a real token.
- **Failure snapshots can contain the token, and no Playwright setting prevents all of them.** On a failure Playwright writes
  `error-context.md` with an ARIA snapshot of the page, and that lists the *value* of each form field. Checked on 1.64.1,
  with a token-shaped value typed into a password field:

  | Failure | Default | `PLAYWRIGHT_NO_COPY_PROMPT=1` | Field emptied first |
  |---|---|---|---|
  | a plain assertion, field still filled | token written | clean | clean |
  | `expect(locator)` on a missing element, field still filled | token written | **token written** | clean |
  | any failure, page already closed | clean | clean | clean |

  So there are four layers, and the first is the one that matters:
  1. `signIn()` (`tests/helpers.ts`) empties the token field right after the form is submitted, so no snapshot can hold
     it. **Every test must type the token through `signIn()`.** A test that types it any other way and then fails an
     `expect(locator)` will write it into `error-context.md`.
  2. `playwright.config.ts` sets `PLAYWRIGHT_NO_COPY_PROMPT=1`, which stops the end-of-test snapshot. It is an
     undocumented switch read by the pinned version (1.64.1); a later version may ignore it.
  3. The CI step deletes the output directory when it ends, pass or fail (an exit trap).
  4. The workflow's always-run cleanup deletes the whole disposable directory, including that output.

  If you run the suite yourself, delete `test-results/` after a failure and never upload it. Nothing in CI uploads it.
- Use a disposable token only (the stack's `dev-tokens.json` holds hashes of tokens you made for it).
