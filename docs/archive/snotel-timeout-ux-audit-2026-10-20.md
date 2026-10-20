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
- **S3 — Refresh follows hidden failed intent.** The initial implementation
  restored the previous station/readings after a failed replacement but kept
  the failed station as `requested`. Consequently Refresh changed the station
  without a corresponding picker choice. The follow-up aligns `requested`
  with the restored result in `src/snow/peak-snow.js` (line 237). Refresh now
  reloads the visible station; selecting the failed station again retries it.
- **S4 — A restored map station can be offered but inert.** `fillStations`
  included a retained station outside the new nearest-three set, but loading
  and change handlers searched only `candidates`. The follow-up shares the
  offered station set across option rendering, request resolution and change
  handling in `src/snow/peak-snow.js` (lines 135–144, 228 and 249).

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
- The initial timeout patch retained the documented failed-intent retry
  behavior. After authorization to resolve remaining problems, S3 deliberately
  changes that contract so Refresh and the displayed station agree. S4 fixes
  an additional option-membership defect uncovered by that follow-up.

## Acceptance and verification

The initial commit `f7bd5c23` contains S1/S2, their regressions and this ledger.
Its verification below used the built `dist/` and the real manifest in isolated,
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

### Station-recovery follow-up

- Before-change proof: three new card tests fail on the old bundle. The two
  failed-switch cases assert the actual wrong station triplet sent by Refresh
  after service failure or timeout. The retained map-station case fails on the
  unchanged error message after selecting an offered but inert option. These
  are explicit identity/visible-status failures rather than setup timeouts.
- `node --test test/snow/*.test.mjs`: 59 passed after the fix. The picker,
  request resolver and restored target now agree. A map station outside the
  nearest three remains selectable and refreshable.
- `npm test`: 3,008 passed. `npm run lint`: passed with the same six owned
  web-ext warnings. Documentation link checks and `git diff --check` passed.
- All 20 snow cases passed in hidden Chromium 156.0.8078.4, Firefox 158.0 and
  Brave Chromium 155.0.8059.85 using the real manifests and intercepted NRCS
  JSON. The 375/681/1440 by 1100 viewport and both-theme matrix remains intact.
  The new failed-switch/Refresh case asserts the restored visible station,
  outgoing station triplet and stable surrounding geometry before, during and
  after recovery. The new 200% browser-zoom case lets a real 15-second deadline
  expire, asserts full-opacity focused Refresh and stable card/native-content
  geometry, and immediately retries. Enlarged timeout screenshots were visually
  inspected in all three browsers. The deliberate-shift negative control passed.
- Disposable screenshot/profile artifacts were removed after inspection and
  exact owned profile paths/process command lines were checked for teardown.

## Closure ledger

### Fixed and verified

- **S1:** explicit timeout wording uses the shared deadline classifier and the
  existing status reservation. Refresh is available at full opacity immediately
  after timeout; previous readings and focus remain intact.
- **S2:** the new tests detect the unfixed message and pass with the fix.
  Actual timeout/retry geometry and appearance pass in Chrome, Firefox and Brave.
- **S3/S4:** the focused regressions detect the unfixed wrong-target/inert-option
  behavior and pass with the fix. Rendered restored-station recovery passes in
  Chrome, Firefox and Brave. Actual timeout/retry geometry at 200% zoom is now
  exercised and passes, closing that earlier proof gap.

### Intentionally not changed

- Explicit NRCS rate limits still block duplicate requests until retry time.
- Pending work still prevents duplicate Refresh actions; native disabled is not
  applied, preserving keyboard focus. Settlement removes the muted appearance.
- Catalog cache, three-result observation cache, sequential hourly/daily reads,
  last-known-good station restoration and map error copy retain their contracts.
- No new permissions, persistence, automatic retries or live-provider requests.

### Changed but not fully proven

- The original existing-profile Brave stale-reading report was not reproduced;
  these local fixes do not establish its cause. Native OS popup input,
  screen-reader announcements and live NRCS recovery remain outside fixture
  proof. No broader correctness claim is made for those unexecuted environments.
