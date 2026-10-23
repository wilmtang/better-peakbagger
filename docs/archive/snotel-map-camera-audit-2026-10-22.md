# SNOTEL map camera audit — 2026-10-22

Scope: camera behavior when enabling the SNOTEL overlay with no usable station
in sight. This implements the existing UI design skill and keeps the compact
Overlays control. No new setting, shortcut, permission or provider request was
added.

## Findings and decisions

The prior reveal fitted the current center and three discovery candidates.
A distant alternative could force a wider view even when the closest station
needed only a small adjustment. Visibility used only a 12 px map-edge inset,
so a station beneath the open menu counted as visible. Fixed camera padding
also reserved space on the wrong side of the current overlay control. Finally,
late data could start a camera move after navigation began but before moveend.

The revised rule frames the nearest station within the existing 50 km radius
and the previous camera center. Other stations never widen that automatic fit.
The helper measures native basemap/zoom controls and receives a validated,
normalized rectangles for the outer menu, mode button and compass in the
isolated 3D frame. It selects a
clear area that requires the least zooming out among those rectangles, without
zooming in. There is no move when a station is already clear of controls, data
is empty, navigation is underway, or the map has no usable area. One brief
transition respects reduced motion and wrapped Alaska longitudes.

## Closure ledger

### Fixed and verified

- **Unnecessary regional zoom:** `src/snow/snotel-map-view.js` now ranks supplied
  metadata from the current camera and fits only the closest station plus the
  current center. The new bounds assertion failed against the unfixed helper
  because it included the distant alternative, then passed after the fix.
  Three additional obstruction assertions (2D menu, 3D menu, native chrome)
  likewise failed against the old helper and passed with the fix.
  The real native fixture also requires a useful mountain scale (zoom >= 12).
- **Obscured stations:** visible means a full marker clear of the menu and
  basemap/zoom controls, mode button and compass. Unit cases cover overlap,
  duplicate controls, complete
  occlusion, an already usable station, and exact safe-boundary idempotence.
  Real native and hardware 3D fixtures require the nearest station beside the
  expanded outer menu, with the surrounding map/page geometry unchanged.
- **Late-response camera takeover:** the native owner cancels pending discovery
  at movestart. The authorized 3D bridge relays navigation start before moveend;
  the renderer also rejects a reveal while its camera is moving. Unit cases
  cover activation during a gesture and late results. Real browser cases hold
  station data, begin native navigation or 3D keyboard navigation, release the
  response, and assert that the camera remains where the user left it.
- **Verifier state accuracy:** SNOTEL loading assertions use the actual `loading`
  row state. Camera cases wait for the settled viewport query to replace the
  initial nearby candidates before measuring marker counts. Terrain evaluation
  supports serialized arguments in both browser transports. The explicit
  `camera` selection rejects unknown values and requires all seven cases.

The camera matrix passed with the real unpacked extension in hidden Chromium
156.0.8078.4 and Firefox 158.0.1, both using hardware ANGLE Metal on Apple M3 Pro.
Native and 3D checks cover 1440 × 1100/light and 375 × 1100/dark, including empty
coverage, already-visible stations, passive pans and pending navigation. Reduced
motion, range limits, wrapped longitude, and no zoom-in are also covered by unit tests. Screenshots were visually inspected at desktop and
narrow native/3D sizes. Provider responses are synthetic; no live NRCS request
was needed for this proof.

Final checks: the build produced 50 bundles; `node --test "test/**/*.test.mjs"`
passed all 3,296 tests against that build. ESLint passed, and web-ext lint passed
with the eight existing owned warnings. `npm run verify -- chrome` confirmed
real unpacked extension startup at 1000 × 760. Each browser's focused camera
matrix executed seven cases and completed teardown. The two disposable camera
profiles no longer exist and no task-owned camera verifier processes remain.

### Intentionally not changed

- Discovery remains an explicit, one-shot layer activation. Passive viewport
  updates, ordinary refreshes and engine changes do not repeat it. A retry may
  fulfill an activation that failed before any reveal.
- The local national catalog cache, 50 km radius, up-to-three discovery metadata
  candidates, 50 visible-marker limit, permission/settings gates, popup actions
  and station observation selection remain unchanged.
- Popup styling is outside this camera change. The broad snow-map matrix found
  a separate theme-dependent popup geometry shift: about 1 px horizontally and
  1–2 px vertically, while action focus remained intact. That assertion failed
  in both browsers; its result has not been reclassified as a pass.

### Changed but not fully proven

- The full `snow-map` integration selection stops at the popup-theme assertion
  above, so later unrelated popup/card scenarios were not completed in that
  selection. The focused camera matrix passed all seven cases in both browsers;
  it does not claim closure of the separate popup issue.
- Hidden fixtures do not establish OS focus/window placement, native permission
  prompts, physical touch, screen-reader speech, or current live NRCS catalog
  completeness. Actual hardware graphics, keyboard activation, DOM geometry,
  and the real extension message path were exercised.
