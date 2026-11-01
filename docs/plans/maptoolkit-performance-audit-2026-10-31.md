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

## Fixed and verified

- M1: changed child-only minimum sizing to a bounded width and let the native
  surround fit that width. Restored owned sizing/attributes on teardown.
  The new faithful browser assertion failed on the unfixed implementation
  with the overflow above, then passed eight layout cases per browser in hidden
  Chrome 156.0.8078.4 (Apple M3 Pro Metal) and Firefox 157 (Apple M3 Pro):
  1280/375 × 800, light/dark, 100/200% CSS zoom. Narrow/enlarged and desktop
  screenshots were inspected. Build and targeted ESLint passed. Chrome loads
  the real extension; Firefox stubs its API/capability transport.

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
