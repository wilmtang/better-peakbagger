# SNOTEL timeout and recovery UX audit — October 20, 2026

Scope: Nearby snow's station selection, Refresh, catalog/hourly/daily fetching,
cache ownership, cancellation, settings/lifecycle gates and map handoff. This
is a focused feature audit, not a repository-wide or live-provider certification.

## Findings

- **S1 — Timeout feedback hides the reason for failure.**
  `src/snow/peak-snow.js` (lines 20–30 and 233–244) routed `TimeoutError` through
  the ordinary failure labels. It restored Refresh after settlement, but gave no timeout-specific
  explanation. The new card tests fail against the old bundle on the actual
  generic message for catalog, hourly, daily and refresh timeouts. The new
  browser assertion also fails on that message after a real 15-second deadline.
  Fix: use the shared deadline classifier, reserve the timeout labels alongside
  existing status text, preserve last-known-good readings and immediate retry.
- **S2 — Timeout recovery lacked rendered regression coverage.**
  `scripts/verify-peak-snow-cases.mjs` (lines 126–155) previously exercised HTTP
  failures and pending work, but never let the production deadline expire. Add held-response
  timeout/retry cases at 375 and 1440 pixels in both themes. Compare Refresh,
  heading, card, native column, following native heading and document scroll;
  require full opacity, availability, focus and retained measurements.

## Implementation review

- `src/snow/snotel-client.js` owns bounded, credential-free requests and their
  body reads. New real-deadline tests cover cooperative aborted transports and
  a stalled daily body. A partial observation cannot enter the cache; retry
  needs no cooldown. Explicit HTTP 429 remains a distinct provider backoff.
- The card's generation and abort guards reject replaced work. Cache expiry,
  shared catalog ownership, settings opt-out and BFCache cleanup already have
  focused regression coverage. This patch does not change these boundaries.
- The station map source resolves only identities in its previously exposed
  nearby catalog; renderers revalidate public station records. Map failures
  have a generic catalog-unavailable notice and Retry, separate from this
  observation-card UX.
- **Documented retry ambiguity:** a failed station replacement restores the
  previous station/readings, while Refresh retries the requested station. This
  is the existing explicit contract in `docs/nearby-snow.md`, not a newly
  introduced transport bug. Retain it in this focused change; deciding whether
  the picker or a named retry action should represent failed intent remains a
  separate UX choice.

## Acceptance and verification

One focused implementation commit contains S1/S2, their regressions and this
ledger. Verification used the built `dist/` and the real manifest in isolated,
hidden browser profiles. The card uses HTML/SVG; these checks make no claim
about terrain or a WebGL renderer. Provider JSON was intercepted; production
15-second deadlines expired normally, without changing the runtime clock.

- Before-change proof: all four new card timeout tests failed on the generic
  error message. The new Chrome browser assertion failed for the same visible
  defect after the real deadline, not a fixture or setup failure.
- `node --test test/snow/*.test.mjs`: 56 passed. The client cases cover timed-out
  hourly/daily headers and a stalled daily body, cancellation, no partial cache,
  and immediate retry. The card cases cover catalog, hourly, daily and refresh
  timeouts, clear text, retained measurements, available Refresh and focus.
- `npm test`: 3,005 passed. `npm run lint`: passed with the six existing owned
  web-ext warnings. `git diff --check`: passed.
- `node scripts/verify-ascent-weather.mjs --snow`, the `--firefox` variant, and
  the same Chrome transport with `CHROME_BIN` pointing to installed Brave:
  all 18 cases passed in each browser. Versions: Chromium 156.0.8078.4,
  Firefox 158.0, Brave Chromium 155.0.8059.85. Viewports: 375, 681 and 1440 by
  1100 pixels, both themes; existing enlarged-layout checks cover 200% zoom.
  New actual timeout/retry checks run at 375/1440 in each theme and compare
  Refresh, heading, card, native column, following native heading and document
  scroll within one pixel. They require opacity 1, available/focused Refresh
  and retained readings. Screenshots were visually inspected in all three
  browsers. The existing deliberate-layout-shift negative control also passed.
- `node scripts/verify-extension.mjs`: passed in hidden Chromium 156.0.8078.4
  at 1000 by 760 pixels, including a restored BFCache page and clean teardown.
- Documentation link checks passed. Disposable profiles and screenshots were
  removed after inspection; owned browser process command lines were checked.

## Closure ledger

### Fixed and verified

- **S1:** explicit timeout wording uses the shared deadline classifier and the
  existing status reservation. Refresh is available at full opacity immediately
  after timeout; previous readings and focus remain intact.
- **S2:** the new tests detect the unfixed message and pass with the fix.
  Actual timeout/retry geometry and appearance pass in Chrome, Firefox and Brave.

### Intentionally not changed

- Explicit NRCS rate limits still block duplicate requests until retry time.
- Pending work still prevents duplicate Refresh actions; native disabled is not
  applied, preserving keyboard focus. Settlement removes the muted appearance.
- Catalog cache, three-result observation cache, sequential hourly/daily reads,
  selected-station failure restoration and map error copy retain their contracts.
- No new permissions, persistence, automatic retries or live-provider requests.

### Changed but not fully proven

- The original existing-profile Brave stale-reading report was not reproduced;
  these local fixes do not establish its cause. Native OS popup input,
  screen-reader announcements and live NRCS recovery remain outside fixture
  proof. Timeout geometry at 200% zoom was not separately exercised; the existing
  enlarged-layout pending/error checks and reserved-text geometry passed.
