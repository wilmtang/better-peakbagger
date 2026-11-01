# Maptoolkit basemap integration — October 31

Requested scope: add Maptoolkit as a selectable basemap in native 2D and 3D,
working in the isolated `codex/maptoolkit-basemap` worktree based on `a951cf7b`.
Retain the existing OpenFreeMap option and native map/route owners.

## Decisions

- Use the official [Hiking style](https://docs.maptoolkit.org/map-styles/)
  without a key. The same cartography will use the existing terrain mesh in 3D.
- Keep fixed provider identities and separate resource host allowlists. Only
  validated style data is downloaded; MapLibre and its worker stay packaged.
- Preserve trusted selection, one-use capabilities, camera alignment, native
  fallback, cancellation and provider-specific cooldowns.
- Use the unmodified official logo at 28 CSS pixels and visible copyright links
  in the bottom-right. Keep overlay menus clear of the attribution area.
- The [Community Terms](https://www.maptoolkit.org/tos) govern this proprietary
  service; it is not a new open-source tile license. Use interactive rendering
  and browser caching, without offline archives or repackaged provider styles.

## Completed and verified

- Provider/style foundation: 20 boundary tests, targeted ESLint and build passed.
  The actual official Hiking document normalized with 133 layers, eight sources
  and three sprite sheets, retaining its copyright metadata.
- 2D integration: 98 focused tests, targeted ESLint and the 66-bundle build
  passed. Twenty controlled hardware cases passed in Chrome 156.0.8078.4 with
  the real extension and Firefox 157 with capability transport stubbed. Cases
  cover 1280/375 × 800, light/dark, 200% CSS zoom, camera pixels, pending/failure/
  retry/cancellation, native marker interaction and stable page/picker geometry.
  Logo decoding/size, visible links, native attribution restoration and zoom
  clearance were checked; the real Chrome overlay menu stays above the logo.
  Firefox's focused fixture does not install the host overlay menu.
- A single live Hiking viewport rendered in hidden hardware Chrome at
  1280 × 800 using actual style, terrain, tiles, glyphs and sprites. The rendered
  map and narrow/dark fixture attribution were visually inspected.

## Remaining implementation

- Add the 3D choice and preserve the selected provider across 2D/3D switches.
- Support named sprite resources when grafting a style into the existing
  terrain renderer, and preserve its terrain/route/overlay ownership.
- Verify the 3D renderer, attribution/menu clearance and failure recovery in
  both browsers, then run repository-wide checks.

## Verification limits

All browser work is hidden on Apple M3 Pro hardware (Chrome uses Metal).
The focused fixture stubs provider responses; the separate single-view live
check proves availability at that time, not service reliability or licensing
approval. Hidden runs do not establish native window focus, browser menus,
touch or screen-reader use.

The required real-manifest Chrome gate was run after adding the logo resource;
it still stops at the existing Garmin Settings visibility assertion in
`scripts/verify-settings-navigation.mjs` (line 308). Earlier full suites had two
unregistered snow-depth JSON fixture failures. Preserve these unrelated gates
explicitly in the final handoff.
