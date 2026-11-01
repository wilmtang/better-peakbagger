# Maptoolkit performance and picker audit — October 31

Scope: audit and repair the 2D/3D implementation on
`codex/maptoolkit-basemap`, starting at `40ad4d3b`. Preserve native routes,
provider attribution, trusted activation, cancellation and rate-limit policy.

## Findings and acceptance

- **M1 — picker overflows its native surround.** `bindVectorMap` gives the
  select a minimum width without resizing Peakbagger's fixed 170px
  `#selboxdiv`. The former browser fixture omitted this wrapper. A faithful
  fixture failed before the fix: select right edge 1294, surround 1270,
  viewport 1280. Resize the surround with its select, bound both to the map,
  preserve geometry across pending/success/error and restore sizing on unload.
- **M2 — expensive redundant relief.** The official Hiking document contains
  four hillshade passes with independent DEM ladders, plus bathymetry.
  3D also paints its own terrain hillshade. Retain hiking geometry/labels/icons
  and water colors, use a single provider hillshade in 2D and the existing
  terrain hillshade in 3D, and remove sources orphaned by this adaptation.
- **M3 — repeated renderer startup and unnecessary view work.** The bridge
  removes the 2D frame on every deselection or 3D suspension. Reselection loads
  the module, workers, style, metadata and tile decoding again. Each view also
  calls resize and jumpTo even if its dimensions/camera did not change.
  Reduce repeat work without allowing parked frames or page messages to start
  provider requests. Keep bounded retention and fail closed on reactivation.
- **M4 — first display waits for every tile.** The 2D frame waits for
  `areTilesLoaded()` before showing any cartography, so a slow secondary tile
  holds the whole map behind a loading message. Show usable rendered coverage
  progressively and retain settled-viewport failure recovery.
- **M5 — outgoing 3D errors can discard the replacement.** Provider protocol
  results were tied to the live map but not its vector swap generation, and
  any `bpb-vector:` source error could force terrain-only. A late HTTP failure
  reproduced the missing ownership check. Ignore stale results/cancellation
  and errors from removed sources while retaining provider cooldown policy.

## Fixed and verified

- M1: changed child-only minimum sizing to a bounded width and let the native
  surround fit that width. Restored owned sizing/attributes on teardown.
  The new faithful browser assertion failed on the unfixed implementation
  with the overflow above, then passed eight layout cases per browser in hidden
  Chrome 156.0.8078.4 (Apple M3 Pro Metal) and Firefox 157 (Apple M3 Pro):
  1280/375 × 800, light/dark, 100/200% CSS zoom. Narrow/enlarged and desktop
  screenshots were inspected. Build and targeted ESLint passed. Chrome loads
  the real extension; Firefox stubs its API/capability transport.
- M2/M4: Hiking adapts from eight to five sources and four to one provider
  hillshades in 2D; 3D uses four provider sources and its existing terrain
  hillshade. Water colors, contours, labels and sprite configuration survive.
  The actual downloaded official style normalized/adapted successfully (130
  layers in 2D, 129 in 3D). Usable 2D output now appears on render while secondary
  requests remain pending. The new assertion failed against the previous frame
  source at “Painted usable tiles appear while secondary tiles are still
  pending,” then passed against the fix. A held-tile hardware browser test
  passed in Chrome and Firefox (230/275 ms first paint in the synthetic fixture;
  these are not live-service timings). Chrome's complete 20-case 2D and 10-case
  3D matrices passed. Fifty-five focused tests, build and targeted ESLint passed.
  Duplicate camera/size messages now skip resize/jumpTo; selecting the current
  3D vector base preserves the existing graph.
- M3: retain at most one initialized 2D renderer per fixed provider for 60
  seconds, without reparenting its live iframe. Parking clears the style,
  aborts actual protocol sockets and blocks new requests. Reactivation consumes
  a fresh one-use worker capability; per-activation generations reject stale
  completion and failure messages. Pending boots are discarded; expiration,
  unload and BFCache discard all parked resources. A regression probe using the
  prior bridge (only its fixture-slot name adapted) failed because deselection
  destroyed the initialized frame. Current tests pass for bounded retention,
  both providers, TTL, request aborts, missing authority, stale authorization
  rejection, stale messages and cooldown isolation. Eighty-one focused tests
  passed. The full Chrome 20-case 2D and 10-case 3D matrices and Firefox's 20-case
  2D and eight-case 3D matrices passed during this work. Warm-path browser tests
  confirm iframe identity and no second style request, with fresh activation.
  The first-paint guard additionally requires vector coverage at the actual
  camera center: overscan or DEM tiles alone cannot prematurely hide the native
  map. Loaded empty/parent tiles remain valid.
- M5: vector protocol work captures the map, provider and swap generation.
  Switching aborts outgoing transports; stale success/failure becomes an
  ignored cancellation, including the secondary error emitted after a handled
  provider limit. Removed-source errors cannot discard the replacement. The
  new late-HTTP regression failed before the fix with “old provider failed,”
  then passed alongside socket-abort and source-identity assertions. All 38
  terrain tests, build and targeted ESLint passed. The final hidden hardware
  3D matrices passed ten Chrome cases and eight Firefox renderer cases.

## Intentionally not changed

- Provider defaults, first-use 3D consent, privacy and host allowlists.
- No offline tile store, durable provider style copy, prefetch on page load,
  new dependencies or permissions.
- Network latency and provider availability remain external factors.

## Changed but not fully proven

Verification is in progress. Existing repository-wide fixture and Garmin
Settings gate failures from the integration record must be rechecked and
reported separately. Hidden checks do not establish native popup menus,
screen readers, focus/window placement or touch interactions.
