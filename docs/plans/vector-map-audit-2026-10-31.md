# 2D vector map audit remediation — October 31

Scope: the four independently reproduced findings in the self-audit of
`b8bba98f`. Keep the existing OpenFreeMap Liberty style, native Leaflet owners,
trusted-selection authorization and extension-origin rendering boundary.

## Findings and acceptance checks

| ID | Priority | Finding and source | Acceptance / independent commit |
| --- | --- | --- | --- |
| V1 | P1 | Default MapLibre camera constraints change the authoritative Leaflet center/zoom in `src/maps/vector-map-frame.js`. At 80°N/native zoom 3 the audit measured about 100 pixels of displacement; world zoom 0 requested -1 but rendered 0.366. | Compare geographic vector points with native marker positions at world zoom 0/1, north/south polar edges and an ordinary view. Prove the new pixel assertion fails before the fix. |
| V2 | P2 | The frame's resource-error handler feeds only its one-time load check. After a successful load, an uncached viewport returning only 503 tiles leaves an opaque empty map with no recovery feedback. | Detect a settled, wholly unusable viewport without rejecting valid empty tiles or usable partial/cached output; restore native imagery and offer Retry. Verify outage → retry → success with stable controls. |
| V3 | P2 | The rejected authorization path in `src/maps/vector-map-bridge.js` does not check the frame identity after pause/resume. | Delay two authorization requests, replace the frame, then reject the outgoing request. The replacement must survive and initialize; current failures must still reach the UI. |
| V4 | P2 | Frame disposal loses the style loader's rate-limit state. A response with Retry-After 120 allowed another request 96 ms later. | Preserve a bounded provider cooldown outside the renderer, guard pointer/keyboard/programmatic retries and re-selection, and recover after expiry. Include tile-level rate limits and preserve the trust boundary. |

## Closure ledger

### Fixed and verified

- V1: use MapLibre's public camera-constraint callback to retain the validated
  Leaflet camera. Five geographic pixel cases passed in hidden Chrome
  156.0.8078.4 / Metal (real extension) and Firefox 157 / Apple M3 Pro (capability
  transport stubbed), initial viewport 1280 × 800. The assertion failed before
  the fix on missing geographic pixels at world zoom 0. Build, targeted ESLint,
  documentation links and 21 boundary/documentation tests passed.
- V3: the authorization success and rejection paths share the same current-frame
  predicate. The new delayed-rejection test failed before the fix by removing
  the replacement frame; it now preserves that frame and sends its own token.
  A current request failure still reports an error. Build, targeted ESLint and
  14 authorization/bridge/documentation tests passed.
- V2: inspect settled viewport tile availability after every view change. A
  wholly failed viewport restores native imagery; loaded empty tiles, partial
  output and cached parents remain usable. The new browser assertion failed
  before the fix on missing Retry after a post-load 503 outage. Five recovery
  cases passed in each hidden hardware browser above, including 1280/375 × 800,
  dark mode and 200% CSS zoom; keyboard Retry, focus and page/action geometry
  stayed stable. Build, targeted ESLint and boundary/documentation tests passed.
  Integration follow-up: MapLibre's source-error flag can emit its one-time load
  event with other tiles still pending. Readiness now accepts the later settled
  idle event during initial loading too. A deterministic frame test failed on
  the old gate and passed after the fix; this explains the intermittent initial
  partial-tile timeouts observed during concurrent full-suite/browser runs.
  Failed TileJSON is also distinguished from valid empty/out-of-coverage data;
  unused sources and old errors on loaded sources do not cause false outages.
  The new metadata assertion failed before the fix with an opaque blank map
  and hidden Retry; adapter unit coverage failed on the same classification.
  The expanded six-case recovery matrix passed in each hardware browser.
- V4: a provider-scoped MapLibre protocol retains tile/metadata/glyph/sprite
  rate-limit headers. The isolated bridge retains a validated deadline outside
  renderer entries and stops other vector frames in the document. Both worlds
  revalidate deadlines through the shared network validator. Retry preserves
  focus and geometry, rejects repeated pointer/keyboard/programmatic activation
  during cooldown, and enables without automatically fetching at expiry. The
  browser assertion failed before the fix on enabled Retry after a 429 with
  Retry-After 120. Three cooldown cases passed per hidden hardware browser above,
  including tile-level limits and real timer expiry. Unit coverage exercises
  re-selection, multiple maps, suspension, stale frames, malformed deadlines,
  cookie/referrer omission, provider URL validation, cancellation and deadlines.

### Intentionally not changed

- Provider, style, persistent permissions and page-local selection policy.
- Firefox's focused renderer fixture stubs extension capability transport;
  Chrome loads the real unpacked extension.
- Cooldown coordination is isolated-document scoped, including its 2D renderer
  suspension. Separate tabs, reloads and the separate 3D renderer do not share a
  persisted provider budget; no new storage or permission is introduced.
- Unrelated repository gates: the previous full test run had two unregistered
  JSON fixture failures; the broader Chrome gate stopped at a Garmin Settings
  visibility assertion. These are not vector-map fixes.

### Changed but not fully proven

None for V1–V4's local acceptance checks; external verification limits remain below.

### Integration checks

The final vector matrix covers 20 cases per browser at 1280/375 × 800, light/dark
and 200% CSS zoom, with geographic pixels, long held dragging, native marker
interaction, failure/retry/cancellation and geometry within one CSS pixel.
Chrome 156.0.8078.4 uses Metal on Apple M3 Pro and the real extension; Firefox
157 uses Apple M3 Pro hardware rendering with only capability transport stubbed.
Target-page screenshots were visually inspected, including narrow dark errors
and cooldowns and enlarged text. The final matrices ran alongside the full
Node suite, including the load conditions that previously exposed the initial
readiness race.

- Build, repository ESLint and web-ext lint passed (eight existing owned
  packaging/vendor warnings); 26 focused boundary/documentation tests passed.
- Full Node suite: 3,845 tests, 3,843 passed, two failed. Both failures are the
  pre-existing unregistered `test/fixtures/maps/snow-depth-legend.json` format in
  `test/project/fixtures-privacy.test.mjs`; no vector test failed.
- The broader real-extension Chrome gate was run and still stopped at the
  existing Garmin Settings visibility assertion in
  `scripts/verify-settings-navigation.mjs` (line 308). The focused vector Chrome
  matrix loads the real manifest/extension but does not close that unrelated gate.
- Teardown inspection found no remaining verification browser processes or
  disposable vector/extension test profiles.

## Verification limits

Use hidden hardware rendering with isolated profiles and HTTPS Peakbagger
fixtures. Synthetic provider responses prove controlled failure/recovery, not
live-provider availability or policy. Hidden checks do not establish native OS
focus/window placement, native dropdown painting, touch or screen-reader use.
Record exact checks and results as each independent unit is committed.
