# esbuild + ES-module migration — plan & progress

Branch: `esbuild-migration` (worktree). Living tracker — updated as each step lands.

**Goal:** build-free IIFE + hand-vendored scripts → esbuild `dist/` build, all `src/`
modules as real ES modules (zero `globalThis.BPB*`), vendor via npm, docs + dev guide.

**Ground rules:** every step ends green (`npm test`) and, for steps touching runtime
`src/`, passes `npm run verify:extension` against `dist/`. Commit every step.

## Approach notes

- `dist/` is the unpacked extension. `scripts/build-config.mjs` is the single source of
  truth for bundle composition; the manifest only names bundle files.
- **Test harness:** jsdom feature tests `eval` the **built IIFE bundle** into the page
  (faithful to what ships, works in every migration state). Pure-module unit tests use
  direct ESM `import`. This decouples test migration from module conversion.
- **Module conversion:** bottom-up. A converted module keeps a *transitional*
  `globalThis.BPBFoo = foo` bridge so not-yet-converted IIFE consumers keep working; all
  bridges are deleted in one late step and their absence is asserted.

## Steps

| # | Step | Status |
|---|------|--------|
| 0 | Plan file | ✅ done |
| 1 | Test harness → eval built bundles (`load-page.mjs` + feature jsdom tests) | ✅ done |
| 2 | Convert pure leaves: `settings-schema`, `gpx-metrics`, `capture-core` (+ unit tests) | ✅ done |
| 3 | Convert shared leaves: `terrain-basemap`, `peak-markers`, `terrain-cache`, `site-dark-css`, `report-markup`, `provider-page` | ✅ done |
| 4 | Convert `settings`, `theme`, `bridge`, `big-map-bridge`, `peak-map-bridge` | ✅ done |
| 5 | Convert feature modules: `ascent-filter`, `peak-links`, `gpx-analyzer`, `peak-map`, `big-map`, `terrain-map`, `terrain-frame` | ⬜ todo |
| 6 | Convert editor: `ascent-draft`, `report-editor` | ⬜ todo |
| 7 | Convert entry roots: `background`, `options`, `popup` | ⬜ todo |
| 8 | Strip all transitional bridges; assert no `globalThis.BPB*` remains | ⬜ todo |
| 9 | Vendor → npm (`marked`/`chart.js`/`tz-lookup` bundled, `maplibre` copied); delete `vendor/` | ⬜ todo |
| 10 | Repoint showcase / terrain-verify / firefox packaging scripts to ESM+dist | ⬜ todo |
| 11 | Docs + dev guide (`docs/development.md`, `AGENTS.md`, `README.md`, `CHANGELOG`) | ⬜ todo |
| 12 | Final verification (`npm test` + `npm run verify:extension`) | ⬜ todo |

## Log

- **Step 4 done** — `settings` (imports `{ settingsSchema }`), `theme` (imports settings +
  darkCss), `bridge`, `big-map-bridge`, `peak-map-bridge` are ES modules. `background-capture`
  now boots the built worker bundle in a vm context. `settings`' transitional bridge is
  *conditional* (won't clobber a pre-set stub) so the map/terrain tests that stub
  `globalThis.BPBSettings` keep control until their consumers import settings in Step 5 (then
  those tests move to a real chrome.storage stub). showcase REQUIRES trimmed. 240 green;
  verify:extension ok.
- **Step 3 done** — `terrain-basemap`, `peak-markers`, `terrain-cache`, `site-dark-css`,
  `report-markup`, `provider-page` are ES modules (named export + bridge; report-markup keeps
  its `globalThis.marked` vendor read). Unit tests: pure modules import directly (setting
  ambient `DOMParser`/`location`/`fetch` where the module reads them); `provider-page`
  (document-coupled) evals its built bundle in each page's jsdom. 240 green; verify:extension ok.
- **Step 2 done** — `settings-schema`, `gpx-metrics`, `capture-core` are ES modules (named
  export + transitional `globalThis` bridge); `capture-core` imports `{ gpxMetrics }`. Unit
  tests (`settings-schema`, `capture-core`) and `background-capture` import them; the worker
  test injects the ESM schema onto its vm global. `showcase` REQUIRES trimmed for converted
  modules. 240 tests green; `verify:extension` passes.
- **Step 1 done** — remaining feature tests eval built bundles: `big-map`, `gpx-analyzer`
  (tz-lookup stays a separate vendor global), `peak-map`, `terrain-map` (cache mock restored
  after the frame bundle evaluates), `theme-inject`. À-la-carte sibling stubs that the
  production bundle always co-contains were dropped; genuine degradation (empty data, absent
  vendor globals) is preserved. `background-capture` (worker, mocks capture-core) and the
  pure-module unit tests convert with their modules in Steps 2–7. 240 tests green.
- **Step 1a** — `load-page.mjs` now evals built bundles (`evalBundle`, `bundles:` option);
  `makeChromeStub` grew a `runtime` stub (a bundle carries idle sibling modules). Migrated:
  `ascent-filter`, `peak-links`, `report-editor`, `bridge`, `ascent-draft`, `popup`,
  `dark-contrast` (loader). Remaining feature tests: `peak-map`, `terrain-map`, `big-map`,
  `gpx-analyzer`, `theme-inject`, `background-capture`. 240 tests green.
- **Step 0** — plan file created.
- _(prior, already committed)_ `build: add esbuild pipeline producing dist/` — esbuild
  bundler, `build-config.mjs`, manifest/HTML/tests repointed to `dist/`. 240 tests green;
  `verify:extension` passes against `dist/`.
