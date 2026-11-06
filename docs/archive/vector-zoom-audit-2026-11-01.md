# 2D vector zoom audit — November 1

Requested follow-up: reproduce and fix intermittent 2D zoom flicker on
`codex/maptoolkit-basemap`, starting at `e4f1d8c5`.

## Findings

- **Z1 — image and camera change in different documents.** In
  `src/maps/vector-map.js`, `VectorLayer.update` resets the Leaflet slot to the
  new camera immediately; the extension-origin frame processes the view and
  paints later. `moveend` therefore exposes an old image at the new transform.
  A controlled native zoom from 10 to 11, holding only the renderer's view
  messages, reproduced a **65.6 CSS-pixel snap** away from the native summit
  marker on the unfixed implementation. MapLibre remained at zoom 9 while
  Leaflet was at 11. This reproduces with cached previous-view tiles, without
  a provider outage. A queued move callback could also interrupt a zoom that
  started after that callback was scheduled.
- **Z2 — prior checks covered settled alignment.** Geographic pixel checks used
  non-animated camera jumps and waited for the result. They did not inspect
  intermediate zoom frames or the delayed renderer handoff. The new fixture
  installs its message hold before the product listener and exposes only the
  renderer instance for measurement; authorization remains real in Chrome.
- **Z3 — a hidden renderer can stop keeping up.** Moving the rendering iframe
  with an older camera can take it offscreen during a distant pan. The initial
  implementation of image handoff then stalled at the south-polar regression
  in Chromium; warm rendering also waited about three seconds on the hidden
  frame's own clock. Keep the rendering document in the viewport and coalesce
  style restoration and rendering on the visible parent's paint clock. Late
  images must retain their actual camera and cannot replace better current
  geographic coverage after a reversal.

## Fixed and verified

- Z1: the frame captures only rendered cartography as an ImageBitmap paired
  with its actual camera and CSS dimensions. Leaflet commits the image and
  transform in one task, keeping the prior image geographically aligned while
  the renderer catches up. Native zoom animation and native overlay ownership
  remain in place. A queued motion callback rechecks animation state when it
  executes. The unfixed source failed the new composited-pixel assertion above;
  the final implementation passes.
- Z2: `node scripts/verify-vector-map.mjs --maptoolkit --zoom-only` passed **37 cases
  in each browser**: 36 repeated native button/wheel zooms plus a held bitmap
  from a distant camera that completes after returning to the original view.
  Chrome inspected 381 composited samples, including 203 animated samples;
  Firefox inspected 552, including 329 animated samples. Independent per-frame
  geometry checks and actual screenshot pixels require alignment within four
  CSS pixels and no native-raster flash. PNG analysis runs outside the page so
  the verifier cannot block its animation. Cases cover 1280/375 × 800,
  light/dark and 100/200% CSS zoom. Every run snapshots shipped assets before
  launch, avoiding mixed bundles during another build.
- Z3: only the page canvas is transformed; the iframe stays within the current
  viewport. The isolated bridge schedules coalesced parent-clock redraws and
  cancels them on suspension/removal. The dedicated frame's animation callbacks
  also use that clock: MapLibre defers inline style restoration to rAF, which
  otherwise adds a one-second warm-start delay even with explicit redraws.
  Valid older images can keep up with fast
  pans; the page rejects images with worse current coverage or zoom resolution.
  The delayed distant-image case passes, as do world/polar alignment cases.
  Captures are bounded to one in flight and have a 15-second failure deadline.
  Late activation images are closed; forwarded images retain their provider
  identity; queued errors from a different provider cannot reset the current
  selection (checked in the zoom/reversal fixture). Pause/deselection clear
  the page pixel buffer.
- Progressive/warm checks passed two cases per browser. The final synthetic
  fixture measured initial/warm paint at **134/95 ms in Chrome**, **229/55 ms
  in Firefox**, timed from the trusted selection event rather than automation
  input. Warm selection retains the same iframe and validated style, requires
  fresh authorization and adds no style request. These are measured fixture
  results, not live latency guarantees.
- Focused unit/project checks: **39 passed**. Coverage includes malformed paint
  metadata, frame/activation identity, bitmap cleanup on suspension/timeout,
  request cancellation, warm reactivation and parent-clock coalescing.
- Complete synthetic Maptoolkit matrices: **20 2D cases per browser**, **10
  Chrome 3D/mode-switch cases**, **8 Firefox 3D/mode-switch cases**. Existing
  OpenFreeMap's **20 Chrome 2D cases** also pass. These cover loading, usable
  partial output, outages, retry/cancellation, native marker interaction,
  raster restoration, provider cooldowns and anchored picker/page geometry.
- Live Maptoolkit: initial view and one explicitly awaited zoom-in/out sequence
  rendered with the real extension in Chrome (84 provider requests). All three
  target-page screenshots were visually inspected for cartography, native
  route/peak placement, picker, zoom controls, logo and copyright containment.
  This is a fixture Peakbagger shell with real provider tiles.
- All rendering checks ran **hidden**, on hardware: Chrome **156.0.8078.4**,
  ANGLE Metal **Apple M3 Pro**, and Firefox **157.0**, **Apple M3 Pro**. Chrome
  loads the actual unpacked extension. Firefox's fixture stubs extension APIs
  and one-use capability transport, while rendering the shipped MapLibre code.
- Build produced **66 bundles**. Repository ESLint and web-ext lint passed
  with eight existing owned manifest/vendor warnings. Full Node suite:
  **3,861 tests, 3,859 passed, two existing fixture failures** listed below.
  The prior audit's malformed documentation path citation was also corrected;
  maintained-document links and script inventory pass.

## Intentionally not changed

- Native Leaflet camera, zoom animation, routes, markers and interaction owners.
- Both fixed providers, host allowlists, one-use authorization, rate limits,
  bounded renderer reuse and first-use 3D consent. No provider prefetch,
  durable imagery, remote executable code or new setting.
- Newly exposed areas can still wait for provider tiles during zoom-out; the
  renderer cannot manufacture coverage outside the last painted view.
- The existing unregistered `maps/snow-depth-legend.json` fixture causes both
  failures in `test/project/fixtures-privacy.test.mjs`. This zoom fix does not
  change its registration or privacy rules.
- `npm run verify -- chrome` reaches the existing Garmin Settings visibility
  timeout in `scripts/verify-settings-navigation.mjs` (line 308), called from
  `scripts/verify-extension.mts`. The required gate was run again after the
  bridge change; it is not reported as passing.

## Changed but not fully proven

- Live rendering covers one Maptoolkit region and desktop viewport, not all
  providers, terrain, devices, networks or authenticated Peakbagger layouts.
  Repeatable zoom/geometry coverage uses synthetic provider data. Free-service
  latency remains variable; synthetic loading timings are not a live-service
  speed guarantee.
- Hidden checks cannot establish native window focus/placement, OS menus,
  touch gestures, screen-reader behavior, or behavior on another GPU/platform.
  They do inspect actual composited map pixels and animation transitions.
- The two unrelated Node failures and Garmin browser gate remain open; this
  audit does not claim a green repository-wide release gate.
