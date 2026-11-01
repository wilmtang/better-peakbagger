# Maptoolkit basemap integration — October 31

Requested scope: add Maptoolkit as a selectable basemap in native 2D and 3D,
working in the isolated `codex/maptoolkit-basemap` worktree based on `a951cf7b`.
Retain the existing OpenFreeMap option and native map/route owners.

## Decisions

- Use the official [Hiking style](https://docs.maptoolkit.org/map-styles/)
  without a key. The same cartography uses the existing terrain mesh in 3D.
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

## 3D implementation and verification

- The 2D vector provider is honored on entering 3D; explicit in-3D choices
  retain their existing priority. Returning to 2D restores its own selection.
  Named sprites are installed/restored through MapLibre's public APIs. The
  terrain mesh, route and overlays are preserved during every style graft.
- Provider-specific style and tile limits disable the corresponding option,
  retain their deadline across swaps, and re-enable without automatic requests.
  Both bridge consumers validate the normalized footer clearance that keeps
  the host overlay menu above the required attribution.
- Eight hardware renderer cases passed in each browser: 1280/375-pixel maps,
  light/dark, normal/enlarged text, geographic vector features on non-flat
  elevation, mode switching, pending cancellation, failure/retry, style and
  tile cooldowns, mesh/route identity and anchored controls. Chrome passed two
  additional real consent cases at 1280/375 × 800. Firefox stubs extension
  API/storage; Chrome retains real settings, manifest and worker authorization.
  The served Map constructor alone is instrumented to inspect actual rendering.
- OpenFreeMap's existing 2D and 3D paths passed their regression matrices.
- One live 3D Hiking viewport rendered on actual elevation in hidden Chrome.
  A duplicate copyright visible in that inspection was reproduced with faithful
  TileJSON markup; the new assertion failed before the fix and passed after it.
  Final synthetic attribution and narrow/dark consent screenshots were inspected.
- Build and repository lint passed with eight existing owned warnings. The full
  Node suite ran 3,852 tests: 3,850 passed and the same two snow-depth JSON
  fixture-registration tests failed. The focused boundaries passed 112 tests.

## Intentionally unchanged

- Existing basemap defaults, 3D opt-in and manual confirmation.
- No new host permissions, API key, remote executable code or provider accounts.
- The Community Service remains an external proprietary dependency. No provider
  style is vendored, relicensed as AGPL or retargeted to a different tile source.
- 2D cooldowns are isolated-document scoped and 3D cooldowns frame scoped; no
  persistent provider budget is shared across tabs or separate mode renderers.

## Verification limits

All browser work is hidden on Apple M3 Pro hardware (Chrome uses Metal).
The focused fixture stubs provider responses; the separate single-view live
checks prove availability at that time, not service reliability or licensing
approval. Hidden runs do not establish native window focus, browser menus,
touch or screen-reader use.
Teardown inspection found no remaining verification browser processes or
disposable profiles. The requested source worktree and its loadable `dist/`
remain available for review.

The required real-manifest Chrome gate was run after adding the logo resource;
it still stops at the existing Garmin Settings visibility assertion in
`scripts/verify-settings-navigation.mjs` (line 308). Earlier full suites had two
unregistered snow-depth JSON fixture failures. Preserve these unrelated gates
explicitly in the final handoff.
