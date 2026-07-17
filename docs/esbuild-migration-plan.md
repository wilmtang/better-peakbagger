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
| 1 | Test harness → eval built bundles (`load-page.mjs` + feature jsdom tests) | ⬜ todo |
| 2 | Convert pure leaves: `settings-schema`, `gpx-metrics`, `capture-core` (+ unit tests) | ⬜ todo |
| 3 | Convert shared leaves: `terrain-basemap`, `peak-markers`, `terrain-cache`, `site-dark-css`, `report-markup`, `provider-page` | ⬜ todo |
| 4 | Convert `settings`, `theme`, `bridge`, `big-map-bridge`, `peak-map-bridge` | ⬜ todo |
| 5 | Convert feature modules: `ascent-filter`, `peak-links`, `gpx-analyzer`, `peak-map`, `big-map`, `terrain-map`, `terrain-frame` | ⬜ todo |
| 6 | Convert editor: `ascent-draft`, `report-editor` | ⬜ todo |
| 7 | Convert entry roots: `background`, `options`, `popup` | ⬜ todo |
| 8 | Strip all transitional bridges; assert no `globalThis.BPB*` remains | ⬜ todo |
| 9 | Vendor → npm (`marked`/`chart.js`/`tz-lookup` bundled, `maplibre` copied); delete `vendor/` | ⬜ todo |
| 10 | Repoint showcase / terrain-verify / firefox packaging scripts to ESM+dist | ⬜ todo |
| 11 | Docs + dev guide (`docs/development.md`, `AGENTS.md`, `README.md`, `CHANGELOG`) | ⬜ todo |
| 12 | Final verification (`npm test` + `npm run verify:extension`) | ⬜ todo |

## Log

- **Step 0** — plan file created.
- _(prior, already committed)_ `build: add esbuild pipeline producing dist/` — esbuild
  bundler, `build-config.mjs`, manifest/HTML/tests repointed to `dist/`. 240 tests green;
  `verify:extension` passes against `dist/`.
