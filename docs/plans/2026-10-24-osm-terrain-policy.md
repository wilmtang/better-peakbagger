# OSM terrain policy and recovery

The user reproduced OSM warning-image tiles in 3D, then restored the map by
turning off DevTools' Disable cache option. The captured request had no Referer
and included Cache-Control: no-cache and Pragma: no-cache. Missing Referer is a
policy compatibility concern, but it is not established as this block's cause.
The response supplied was a generic warning PNG; its printed 403 is not proof
of the actual HTTP response status or the precise edge rule.

Policy references checked October 24, 2026:
[OSM raster tile policy](https://operations.osmfoundation.org/policies/tiles/),
[blocked tiles](https://wiki.openstreetmap.org/wiki/Blocked),
[DevTools caching](https://developer.chrome.com/docs/devtools/network/reference/#disable-cache).

## Fixed and verified

- Credits remain visible in a separate left control stack, with wrapping and
  theme-appropriate contrast. The gesture hint sits above credits, and changing
  attribution leaves zoom, scale, picker, mode button, surrounding content and
  scroll position stable within one CSS pixel.
- The browser assertion failed against the original compact control, then
  passed eight layouts in each hidden GPU browser: 800/320px maps, light/dark,
  and normal/24px text. Chrome used ANGLE Metal on Apple M3 Pro; Firefox 157
  used ANGLE Metal on the same hardware. Chrome screenshots were inspected.
- Final `npm test`: 3,452 passed, including 37 terrain lifecycle tests.
  `npm run lint` passed with the existing eight reviewed vendor/manifest
  warnings. Both verifier CLIs reject unknown selections before launch.
- The real unpacked extension check passed in hidden Chrome for Testing
  156.0.8078.4 at 1000×760, including startup/content-script integration and
  BFCache restoration. Its verifier reported successful teardown.
- Failed raster layers remain available through the existing picker. A retry
  or deliberate switch clears old feedback without moving focus or controls.
  Messages name the failed map and recovery action without inventing CORS as
  the cause. Explicit HTTP 401/403 denials cancel the source even after a good
  tile rendered; an early idle cannot permanently disarm the tile check.
- A pending vector style retains the requested selection and shows brief,
  neutral loading feedback. Rejected styles restore terrain-only gracefully.
- Feedback wraps clear of the compass, mode and zoom controls. Visual review
  caught overlap at 320px/24px text; the browser assertion now checks that
  overlap independently of stationary control geometry.
- Both hidden GPU browsers pass eight real held-tile → HTTP 403 → native
  select type-ahead retry → rendered-raster paths, plus the held-vector-style
  pending/failure path. Focus and geometry stay stable within one CSS pixel.
  Raster blocks come from the local HTTPS server, including worker requests;
  Firefox's vector style is held at the fetch boundary and Chrome's at CDP.
- Regression assertions failed before the fix for permanently disabled raster
  choices, the reverted pending vector selection, and silent HTTP 403 recovery.
  Chrome screenshots of credits, neutral loading, and narrow/wide error states
  were inspected. The request-transform regression preserves browser defaults
  for OSM raster caching/identity without injecting headers or a cache bypass.

## Intentionally not changed

- Keep the OSM raster choice: the user's cache-enabled request succeeds.
  Do not spoof a Referer/User-Agent, change permissions, introduce a proxy or
  override browser debugging settings to work around the policy.
- Leave raster caching with MapLibre and the browser's HTTP cache. The inspected
  raster path sets neither no-cache headers nor a cache-bypass fetch mode.
- Do not classify a decodable HTTP-success warning PNG by OCR, pixel matching
  or guessing: a reliable provider signal is needed. No new live OSM traffic
  is needed for the local UI checks.

## Changed but not fully proven

- Broader terrain runs hit separate existing checks: Chrome's initial 2D zoom
  gap was 41px against a 40px bound, and Firefox's later Sentinel overlay trigger
  was hidden. Focused `--provider-ui` runs retain real GPU rendering and exercise
  this change independently; these failures are not reported as full passes.
- Browser fixtures stub extension storage/activation, elevation, raster tiles,
  vector styles and peak feeds. They do not establish OS focus/window placement,
  native popup-menu behavior, real
  provider policy enforcement, or the exact server-side rule behind this block.
- Text enlargement exercises 24px map/credit text at fixed 800/320px map sizes;
  it is not evidence of browser-chrome zoom or an onscreen OS interaction.
