# MapLibre GL JS 6 migration plan

**Status:** completed 2026-08-07

**Target:** MapLibre GL JS 6.2.x

**Created:** 2026-08-07

## Goal

Upgrade the packaged 3D renderer from MapLibre GL JS 5.24.0 to the current 6.x
release without changing Better Peakbagger's privacy boundary, terrain lifecycle,
route/peak behavior, provider traffic, or safe 2D fallback.

This is a runtime migration, not a version-only dependency bump. MapLibre 6 removed
the UMD and dedicated CSP builds that the extension currently copies, switched its
worker to an ES module, changed several rendering defaults, tightened style
validation, and now requires WebGL2. See MapLibre's
[v5-to-v6 migration guide](https://github.com/maplibre/maplibre-gl-js/blob/v6.0.0/docs/guides/v5-to-v6-migration-guide.md)
and [v6.0.0 release notes](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.0.0).

## Current boundary

- `terrain/terrain.html` is a web-accessible extension page embedded into a
  Peakbagger page. It, its renderer, its worker, and CacheStorage remain on the
  extension origin; MapLibre must not move into the page's MAIN world.
- The page currently loads the copied `maplibre-gl-csp.js` global before the
  built `terrain-frame.js` IIFE. The frame explicitly sets the copied CSP worker
  URL before constructing a map.
- MapLibre is lazy: its code is loaded only when the 3D iframe is created. The
  migration must not add it to ordinary page/content bundles or make a network
  request before the existing consent and 3D-action gates.
- Elevation continues to flow through the validated `bpb-dem` custom protocol and
  extension CacheStorage. No new host permission, remote code, coordinate
  transmission, or persistent data is authorized by this migration.
- The native 2D map remains authoritative when 3D cannot start or loses its
  rendering context. No extension path may leave a blank, flat, or indefinitely
  loading terrain surface in place of that fallback.

## Source findings

The application does not use most removed v6 APIs: it has no default MapLibre
import, `map.transform` access, `styleimagemissing` resolver, shader pragma, event
`instanceof` check, or symbol layer. Its required APIs remain present in 6.2,
including `addProtocol`, `removeProtocol`, `setWorkerUrl`,
`setSourceTileLodParams`, `queryTerrainElevation`, terrain, popups, controls, and
GeoJSON sources.

The material migration risks are instead:

1. The v5 `maplibre-gl-csp.js` and `maplibre-gl-csp-worker.js` files no longer
   exist. The 6.2 package ships `maplibre-gl.mjs`,
   `maplibre-gl-worker.mjs`, and `maplibre-gl-shared.mjs`; the worker imports the
   shared sibling.
2. The existing frame and its jsdom tests intentionally consume a separately
   loaded `globalThis.maplibregl`. Bundling the renderer directly into
   `terrain-frame.js` would destroy that isolation seam and make pure lifecycle
   tests instantiate the real WebGL renderer.
3. `zoomLevelsToOverscale` now defaults to `4`, which changes label rendering and
   `queryRenderedFeatures`. The terrain LOD and route hit-testing behavior was
   measured on v5.24.0 and cannot be assumed equivalent.
4. `GeoJSONSource.setData()` is asynchronous in v6. Ignored promise rejections
   could turn renderer teardown, style replacement, or bad-data failures into
   unhandled rejections.
5. Style-spec v25 validates legacy expressions more strictly. The extension's
   generated style and the grafted OpenFreeMap style must both be exercised.
6. WebGL1 is gone. A browser without usable WebGL2 must reach the existing visible
   2D fallback rather than stall before an error listener observes the failure.
7. MapLibre's worker and terrain internals changed substantially. The current LOD,
   cache-retention, missing-DEM, context-loss, and resume measurements are
   version-specific evidence, not invariants guaranteed by the API.

## Chosen direction and decision gate

Preserve MapLibre as a separately loaded vendor global so the runtime boundary,
HTML ordering, unit-test stubs, and terrain-verifier Map proxy remain intact.

The first implementation step is a disposable build spike, not a committed
partial migration:

1. Have esbuild consume the v6 ESM main entry and emit a separate browser artifact
   exposing the `maplibregl` namespace, following the existing generated-vendor
   pattern used for `tz-lookup`.
2. Self-host the module worker under `dist/vendor/` and call `setWorkerUrl()` with
   its extension URL before `new Map()`.
3. Either copy both the worker and its `maplibre-gl-shared.mjs` sibling unchanged,
   or bundle the worker into one self-contained ESM artifact if the copied pair
   fails extension loading or target-browser compatibility. Do not copy only the
   worker and leave its relative import unresolved.
4. Inspect the generated main artifact for `import.meta.url` warnings or a live
   auto-detection path. The explicit worker URL must make auto-detection
   unnecessary; if that cannot be demonstrated, abandon the classic-wrapper
   approach and use an external extension-owned ESM bootstrap instead.
5. Prove the candidate in both a normal HTTPS terrain fixture and the real
   unpacked Chrome and Firefox extensions before building the remainder of the
   migration on it.

The fallback ESM-bootstrap design must still keep MapLibre outside
`terrain-frame.js`, load the frame only after the namespace is ready, obey the
default extension CSP without inline script or `blob:` worker permission, and
retain a test-only fixture seam without publishing renderer internals in
production.

## Execution steps

Each completed independent unit must be committed with the repository's focused
Conventional Commit format. Do not include or overwrite unrelated working-tree
changes; in particular, preserve the pre-existing edit in `ACKNOWLEDGEMENTS.md`
while updating only its MapLibre section.

### 1. Establish the packaging proof

- [x] Record the pre-migration build outputs, archive paths, package sizes,
  web-ext warnings, and v5 terrain LOD result for comparison.
- [x] Install the selected 6.2.x version and update both package files.
- [x] Prototype the separate main wrapper and module-worker arrangement described
  above without changing product behavior.
- [x] Assert that every worker import resolves inside `dist/` and that no worker
  code or main renderer is loaded from a CDN.
- [x] Run a focused hidden Chrome and Firefox terrain boot against the candidate.
- [x] Select the wrapper or ESM-bootstrap design based on observed behavior and
  record the rejected alternative and evidence here before proceeding.

**Gate:** do not start behavioral migration until a real MapLibre 6 canvas and
terrain worker boot from packaged local files in both browsers.

### 2. Make the production build and runtime change

- [x] Replace the deleted CSP main/worker paths in `scripts/build-config.mjs` with
  the chosen generated/copied v6 artifacts and retain the CSS and BSD license.
- [x] Generalize `scripts/build.mjs` vendor generation only as far as needed; do
  not refactor unrelated dependency handling.
- [x] Update `terrain/terrain.html` while preserving stylesheet-before-renderer
  ordering and lazy iframe loading.
- [x] Point `setWorkerUrl()` at the packaged module worker before protocol
  registration and Map construction.
- [x] Keep the renderer-unavailable guard and protocol cleanup valid when the
  main module or worker fails partway through startup.
- [x] Ensure release-archive enumeration treats every generated and copied
  MapLibre artifact as required and rejects a missing shared/worker file.

### 3. Reconcile v6 behavior deliberately

- [x] Set `zoomLevelsToOverscale: undefined` initially to preserve the v5
  rendering/query behavior. Do not adopt the v6 default in the same migration
  unless separate LOD and interaction evidence shows it is an improvement with
  acceptable traffic and memory cost.
- [x] Route every `GeoJSONSource.setData()` promise to an explicit outcome. Ignore
  only a proven stale-map/teardown race; an active renderer failure must degrade
  through the owning route, highlight, or peak policy rather than become an
  unhandled rejection.
- [x] Verify the v6 `data` and `error` event shapes used to distinguish basemap,
  elevation, and source-less renderer failures. Update classification only from
  observed v6 events, not a test-stub assumption.
- [x] Validate the generated DEM/hillshade style and every extension-added
  raster, line, circle, and GeoJSON layer under style-spec v25.
- [x] Exercise the current OpenFreeMap style graft under a bounded, explicit
  vector-layer selection. A provider style failure must retain the existing
  terrain-only notice and must not tear down healthy elevation.
- [x] Prove that custom-protocol cancellation, missing-tile status, DEM decoding,
  route/peak updates, popups, camera handoff, suspend/resume, and removal remain
  race-safe.
- [x] Add a WebGL2-unavailable check that waits for the visible postcondition:
  iframe removal, native 2D restoration, and the correct actionable failure.

### 4. Update focused regression coverage

- [x] Update manifest/build-composition tests to pin the new main, worker, shared,
  CSS, and license arrangement.
- [x] Keep lifecycle tests on a MapLibre stub; do not make `npm test` allocate a
  real WebGL renderer.
- [x] Preserve the terrain fixture's ability to expose only its test Map instance.
  If load mechanics change, instrument fixture responses or use a fixture-owned
  global setter rather than adding a production test hook.
- [x] Extend terrain tests for asynchronous `setData()` success, rejection during
  active use, and rejection after teardown.
- [x] Pin the intentional `zoomLevelsToOverscale` decision.
- [x] Update showcase assertions and browser fixture rewriting for the new loader
  filename/order.
- [x] Re-run web-ext lint, inspect every changed MapLibre warning, and update the
  owned warning baseline only for warnings attributable to the packaged 6.2.x
  source. A moved or vanished warning is not automatically accepted.
- [x] Update release/archive tests so a package missing the worker or shared
  module fails closed.

### 5. Update licensing, review metadata, and maintained documentation

- [x] Update the MapLibre version, artifact description, package link, source
  link, and generated-versus-unmodified distinction in
  `ACKNOWLEDGEMENTS.md` and Firefox AMO approval notes.
- [x] Update `docs/development.md` so its vendor instructions describe the chosen
  ESM/wrapper arrangement rather than claiming MapLibre ships a copied UMD
  global.
- [x] Update `docs/3d-map.md` references to the CSP worker, loader lifecycle,
  WebGL requirement, and every measured LOD/cache value that changed.
- [x] Update maintained architecture/build comments and structural tests together;
  do not rewrite historical archived plans or changelog entries that accurately
  describe v5 behavior at the time.
- [x] Add a user-facing changelog entry only after the runtime result and browser
  compatibility are known.

### 6. Complete verification and package rehearsal

Run all checks from the final candidate, not from an earlier intermediate build:

| Check | Required evidence |
| --- | --- |
| `npm test` | Built bundle, pure logic, lifecycle, async source-update, and structural tests pass |
| `npm run lint:js` | Source lint passes |
| `npm run lint` | Real built extension passes web-ext lint with an inspected warning ledger |
| `npm run audit:ci` | Dependency graph has no accepted advisory gap |
| `npm run package` | Minified Chrome and derived Firefox archives contain every renderer/worker/license artifact |
| `npm run verify:browsers` | Hidden isolated Chrome and Firefox load the real unpacked extension, bridges, iframe, and worker |
| `npm run terrain:verify` | Hidden Chrome on asserted hardware WebGL2 renders terrain, route, peaks, drape, missing DEM, and context-loss fallback |
| `npm run terrain:verify:firefox` | Hidden Firefox on asserted hardware WebGL2 renders and interacts with the same packaged frame |
| `npm run terrain:lod` | v6 pitch sweep reports traffic, retained tiles, rendered levels, renderer, and viewport for comparison with v5 |
| Minimal live provider check | Read-only OpenFreeMap selection succeeds or degrades accurately; requests remain bounded and user-triggered |

Browser verification must use isolated profiles and must not take focus or reuse the
user's normal browser. Report browser versions, renderer, viewport, hidden/visible
mode, and teardown. A GPU fixture does not prove the real extension bridge, and a
real-extension DOM assertion does not prove terrain visuals; both categories are
required.

## Acceptance criteria

- MapLibre 6.2.x is the only installed and packaged MapLibre version.
- `dist/` contains no deleted v5 CSP artifact and contains every local file needed
  by the v6 main and module worker.
- The real Chrome and Firefox extensions start 3D without CSP, module-resolution,
  manifest, or worker-console errors.
- 3D remains opt-in and lazy, and no new permission, provider, remote code, data
  retention, or coordinate disclosure is introduced.
- Routes, peaks, highlights, popups, drape selection, camera synchronization,
  missing DEM behavior, context loss, cancel, suspend, resume, and 2D fallback
  match the maintained contract.
- WebGL2 absence, worker failure, style failure, and active `setData()` rejection
  reach an honest visible fallback with no unhandled rejection or stuck spinner.
- LOD, memory retention, and tile traffic remain within documented bounds. Any
  intentional changed bound is measured and documented rather than inferred from
  a plausible screenshot.
- Chrome and Firefox store archives include accurate license and source-review
  metadata for generated and copied MapLibre artifacts.
- All required checks above pass on the final commit. Live-provider and native-UI
  proof gaps, if any, remain explicitly listed rather than summarized as fixed.

## Rollback

Keep the migration as one focused runtime unit after the packaging proof. If either
browser cannot load the local module worker reliably, or v6 materially regresses
terrain correctness/traffic without a bounded repair, revert the migration unit
to 5.24.0 rather than shipping a mixed v5/v6 artifact set or weakening CSP. Record
the failed browser, worker URL, console error, renderer, and LOD comparison before
closing or revising this plan.

## Completion record

- **Fixed and verified:** MapLibre GL JS 6.2.0 is the only installed version. The
  generated classic global, copied module worker and shared module, CSS, and BSD
  license all ship locally. The worker's sole static import resolves to its
  packaged sibling. Async route, highlight, and peak updates have explicit
  success/failure ownership; WebGL2 startup failure restores the native map; and
  terrain-aware DOM summit rings remain visible and clickable over pitched
  terrain. The full 1,219-test suite, JavaScript lint, owned web-ext warning
  ledger, dependency audit, Chrome and Firefox real-extension checks, hardware
  terrain checks, v6 LOD sweep, packaging, and packaged-extension checks passed.
  The hardware terrain checks used hidden Chrome for Testing with ANGLE Metal on
  Apple M3 Pro and hidden Firefox 151.0 at 1000x760 with its asserted Apple
  hardware renderer; the final real unpacked-extension check also passed in
  hidden Firefox 153.0.3.
- **Intentionally not changed:** `zoomLevelsToOverscale` remains explicitly
  `undefined` to preserve v5 query/rendering behavior. No permission, provider,
  consent, storage, cache, or coordinate-disclosure boundary changed. The
  generated global was retained instead of an ESM bootstrap because it booted
  the local module worker in both browsers while preserving the existing lazy
  loader and test seam; the bootstrap alternative added no demonstrated value.
- **Changed but not fully proven:** A bounded read-only check validated the live
  OpenFreeMap style document with one credential-free, no-referrer request, but
  did not exercise every live vector tile or provider failure. Hidden protocol
  checks cannot prove native browser focus, prompt placement, toolbar chrome, or
  window placement. The v5 baseline LOD run had a pre-existing 179 ms collapse
  against its 120 ms timing bound; the v6 run passed all four acceptance checks,
  but those measurements remain specific to the recorded hardware and fixture.

### Follow-up packaging simplification — 2026-08-08

The generated classic main wrapper described above was subsequently removed.
`terrain/terrain.html` now loads `terrain-frame.js` as a native module; that entry
imports the unmodified packaged `vendor/maplibre-gl.mjs` directly. The lifecycle
runtime remains explicitly injectable for jsdom, and GPU fixtures instrument the
served frame module rather than publishing a production MapLibre global. The
module worker, shared sibling, lazy extension-frame boundary, and all privacy and
fallback invariants are unchanged.
