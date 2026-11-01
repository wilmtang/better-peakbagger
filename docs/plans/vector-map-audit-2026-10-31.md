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

### Intentionally not changed

- Provider, style, persistent permissions and page-local selection policy.
- Firefox's focused renderer fixture stubs extension capability transport;
  Chrome loads the real unpacked extension.
- Unrelated repository gates: the previous full test run had two unregistered
  JSON fixture failures; the broader Chrome gate stopped at a Garmin Settings
  visibility assertion. These are not vector-map fixes.

### Changed but not fully proven

None for V1–V3's local acceptance checks; external verification limits remain below.

V4 remains open and unchanged.

## Verification limits

Use hidden hardware rendering with isolated profiles and HTTPS Peakbagger
fixtures. Synthetic provider responses prove controlled failure/recovery, not
live-provider availability or policy. Hidden checks do not establish native OS
focus/window placement, native dropdown painting, touch or screen-reader use.
Record exact checks and results as each independent unit is committed.
