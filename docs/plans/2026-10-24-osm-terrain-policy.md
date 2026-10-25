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
- Focused terrain unit tests: 37 passed. ESLint passed for the changed modules.

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
- Browser fixtures stub extension storage/activation, elevation, raster tiles
  and peak feeds. They do not establish native focus/window placement, real
  provider policy enforcement, or the exact server-side rule behind this block.
- Planned next: make transient raster failures retryable through the existing
  picker, remove unsupported CORS claims, clear stale feedback when switching,
  and exercise failure/recovery geometry and keyboard focus in both browsers.
