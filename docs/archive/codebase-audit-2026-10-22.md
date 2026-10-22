# Codebase Audit & Remediation Plan — 2026-10-22

Original Gemini report: audited commit `c73be873`, version `4.0.2`.

Implementation review began at `dc6fc32e` with unrelated weather work already
present; that work was preserved and later committed separately as `980732f3`.
The original findings and suggested patches below are historical evidence, not
current source locations. Several snippets, fallback durations and file names
were stale; the closure ledger records what was actually changed.

## Baseline Verification

| Check | Result | Notes |
| --- | --- | --- |
| `npm test` | Pass | 3,194 / 3,194 tests passed (`duration_ms 41136`). |
| `npm run lint` | Pass | `eslint .` passes with 0 warnings/errors; `scripts/check-web-ext-lint.mjs` builds all 50 `dist/` bundles and passes with 0 errors and the 8 existing allowlisted `web-ext` warnings (`DANGEROUS_EVAL`, `UNSAFE_VAR_ASSIGNMENT`). |
| `npm run audit:ci` | Fail (known dev-only chain) | 5 vulnerabilities (2 moderate, 3 high) in `node-forge <=1.3.x` via `web-ext -> @devicefarmer/adbkit -> node-forge`. Tracked in prior audit ledgers as an unowned dev-tooling dependency outside `dist/`. |
| `node scripts/verify-layout-stability.mjs --chrome-only --surface=maps` | **Fail (`ENOENT`)** | Crashes immediately attempting to read removed `dist/css/sentinel.css` (see **F1**). |

---

## Findings Summary

| ID | Severity | Category | Surface / Files | Summary |
| --- | --- | --- | --- | --- |
| **F1** | **P2** | Bug / CI Gate Breakage | `scripts/verify-layout-stability.mjs:725-726` | `verify-layout-stability.mjs` still loads removed `dist/css/sentinel.css` and `dist/content/sentinel-map.js`, crashing `npm run verify -- layout-stability` (`ENOENT`). |
| **F2** | **P2** | Bug / Bad UX | `src/maps/map-overlay-leaflet.js:58, 64-71`, `src/maps/map-layers.js:158-159` | 2D raster overlays (`slope`, `land`) enabled during a rate-limit cooldown get stuck in permanent `Loading` on **Retry** after the cooldown expires because `retry(id)` never calls `add(id)` when `!layers.has(id)`. |
| **F3** | **P2** | Bug / State Race | `src/maps/map-layer-bridge.js:19, 29, 50-54, 116-123`, `src/maps/map-layers.js:270-277` | `installMapLayerBridge` announces default overlay opacities before `chrome.storage.local.get` finishes reading saved opacities, and a late `storage.get` callback can overwrite newer `save` writes. |
| **F4** | **P2** | Bug / Bridge Race | `src/terrain/terrain-map.js:416-417, 512-525, 542-549`, `src/terrain/terrain-frame-runtime.js:42-45, 2254-2293, 2313-2318` | Terrain bridge drops `update` (`routeStyle` / `theme`) and `snowStations.conditions` that arrive while frame activation `authorize()` is in flight, and initializes `snowConditions` to `null` (permissive `canSelect`). |
| **F5** | **P2** | Bug / Rate-Limit Discipline | `src/maps/map-overlay-tiles.js:159, 173`, `src/maps/sentinel-session.js:56, 97`, `src/maps/map-layer-bridge.js:79`, `src/maps/map-layers.js:126, 281` | Non-monotonic rate-limit cooldown assignments in map overlays allow concurrent in-flight tile/session responses with shorter `Retry-After` headers to shorten an active provider cooldown. |
| **F6** | **P3** | Engineering Smell / Dead Code | `src/maps/sentinel-map.js`, `src/maps/sentinel.css`, `src/maps/peak-snow-map.js`, `src/maps/sentinel-layer.js:32-245`, `docs/mountain-local-time.md:28` | Unshipped legacy Sentinel and SNOTEL map modules (`~529` lines) remain in `src/maps/` after the shared Overlays migration (`b900d73b`), alongside a stale `dist/content/sentinel-map.js` doc reference. |

---

## Detailed Findings & Remediation Plan

### F1 — `scripts/verify-layout-stability.mjs` crashes with `ENOENT` on the `maps` surface (P2 Bug / CI Gate Breakage)

- **Location:**
  - `scripts/verify-layout-stability.mjs:725-726`
  - `.github/workflows/test.yml:143` (`npm run verify -- layout-stability`)
- **Root Cause:**
  Commit `b900d73b` (`feat: share map overlays across native and terrain views`) replaced the standalone Sentinel map bundle (`content/sentinel-map.js` and `css/sentinel.css`) with the unified map layers bundle (`content/map-layers.js` and `css/map-layers.css`) in `scripts/build-config.mjs` and `manifest.json`. However, `mapCase` in `scripts/verify-layout-stability.mjs` still reads `await asset('css/sentinel.css')` and `await asset('content/sentinel-map.js')` and queries the legacy `#bpb-sentinel-bar` / `#bpb-snow-bar` DOM selectors.
- **Reproduction:**
  Run `node scripts/verify-layout-stability.mjs --chrome-only --surface=maps` after `npm run build`. It fails before launching a page with:
  `Error: ENOENT: no such file or directory, open '.../dist/css/sentinel.css'`.
- **Why existing tests missed it:**
  `test/project/manifest-capture.test.mjs` validates `manifest.json` against `scripts/build-config.mjs`, and `test/project/showcase.test.mjs` checks HTTPS fixture invariants across verifier scripts, but no unit test verifies that `asset('...')` paths referenced in `scripts/verify-layout-stability.mjs` exist in `scripts/build-config.mjs`.
- **Remediation Plan:**
  1. Update `mapCase` in `scripts/verify-layout-stability.mjs` to inject `css/map-layers.css` and `content/map-layers.js` and verify layout stability across the unified `#bpb-map-layers` Overlays control (menu toggle, `sentinel` / `snotel` / `slope` / `land` rows, inline status/retry transitions, and date/filter interactions).
  2. Add a structural assertion in `test/project/manifest-capture.test.mjs` (or `test/project/showcase.test.mjs`) that parses `asset('...')` calls in `scripts/verify-layout-stability.mjs` and verifies every referenced path is declared in `scripts/build-config.mjs` (`ENTRIES` or `COPY_FILES`).

---

### F2 — 2D raster overlays enabled during a provider cooldown get stuck in permanent `Loading` on Retry (P2 Bug / Bad UX)

- **Location:**
  - `src/maps/map-overlay-leaflet.js:58, 64-71`
  - `src/maps/map-layers.js:158-159`
- **Root Cause:**
  When `slope` or `land` is enabled while `state.retryAt > Date.now()`—which happens when:
  1. The user opens **Full Screen** while `slope` or `land` is enabled and rate-limited (`handoff` carries both `enabled: true` and `retryAt > Date.now()`),
  2. The user exits 3D terrain back to the 2D Leaflet map after hitting a `slope` or `land` rate limit in 3D, or
  3. The user toggles a rate-limited `slope` or `land` row off and back on before the cooldown expires—
  `createLeafletOverlays.set(id, state)` returns early at `src/maps/map-overlay-leaflet.js:58` (`if (state.retryAt > Date.now()) return;`) before calling `add(id)`. Consequently, `layers.has(id)` remains `false` and `records` has zero tile entries for `id`.
  Once the cooldown timer expires, the **Retry** button becomes enabled. Clicking **Retry** runs `onRetry` in `src/maps/map-layers.js:158-159`, which sets `statuses[id]` to `{ pending: true, message: 'Loading slope shading' }` (or `'Loading public lands'`) and calls `binding?.engine.retry(id)`. However, `createLeafletOverlays.retry(id)` (`src/maps/map-overlay-leaflet.js:64-71`) only iterates over existing `records`:
  ```js
  retry(id) {
    if (states[id]?.retryAt > Date.now()) return;
    for (const record of records.values()) {
      if (record.id === id && (record.failed || !record.ready)) draw(record);
    }
  }
  ```
  Because `add(id)` was never called, `layers.has(id)` is `false` and `records` is empty for `id`. No Leaflet `GridLayer` is mounted, zero tiles are requested, neither `onActivity` nor `onError` ever fires, and the row stays stuck in `Loading` indefinitely until the user toggles the overlay off and on again.
- **Reproduction:**
  Deterministically reproduced in jsdom with `installMapLayers`: mounting with a 50 ms handoff cooldown on `slope`, waiting for the cooldown to expire, and clicking `.bpb-layers-retry` results in `added: 0, drawn: 0`, row status `loading`, and detail text `Loading slope shading` permanently.
- **Why existing tests missed it:**
  `test/maps/map-layers.test.mjs` tests `retry` after a tile fails on an already-mounted Leaflet layer (`layers.has(id) === true`), not when `set(id, state)` skipped `add(id)` due to an active `retryAt` cooldown.
- **Remediation Plan:**
  1. In `src/maps/map-overlay-leaflet.js:64` (`retry(id)`), check whether the layer is enabled and not yet mounted before iterating `records`:
     ```js
     retry(id) {
       if (!states[id]?.enabled || states[id]?.retryAt > Date.now()) return;
       if (!layers.has(id)) {
         add(id);
         return;
       }
       for (const record of records.values()) {
         if (record.id === id && (record.failed || !record.ready)) draw(record);
       }
     }
     ```
  2. Add a regression test in `test/maps/map-layers.test.mjs` covering cooldown expiry + **Retry** when `slope`/`land` starts enabled under cooldown (handoff and toggle-off/on during cooldown).

---

### F3 — `installMapLayerBridge` announces default overlay opacities before `storage.local` finishes reading saved opacities, and late `storage.get` can clobber `save` (P2 Bug / State Race)

- **Location:**
  - `src/maps/map-layer-bridge.js:19, 29, 50-54, 116-123`
  - `src/maps/map-layers.js:130, 270-277`
- **Root Cause:**
  Item O2 in `docs/archive/map-overlays-audit-2026-10-21.md` gated `announce()` on `settingsReady` (`chrome.storage.sync`), so feature flags do not flash defaults before sync storage resolves. However, `preferences` (`opacities`) are loaded separately via `storage.get(OVERLAY_PREFERENCES_KEY)` from `chrome.storage.local` (`src/maps/map-layer-bridge.js:116-122`), and `announce()` is **not** gated on `preferencesReady`.
  1. When `settings.requireCurrent()` resolves before `storage.get(OVERLAY_PREFERENCES_KEY)` (or when `request` arrives from `map-layers.js` after `settingsReady` is `true` but before `storage.get` settles), `announce()` posts default opacities (`85 / 55 / 55 / 100`) to the page.
  2. If the user interacts with any overlay control before `storage.get` resolves, `touched` becomes `true` in `src/maps/map-layers.js:130`. When `storage.get` later resolves and calls `announce()`, `src/maps/map-layers.js:271` checks `if (!touched)` and ignores the stored opacities—and the user's subsequent `save()` writes the default opacities back to `chrome.storage.local`, permanently overwriting their saved opacities.
  3. Even without `touched` gating, `src/maps/map-layer-bridge.js:118` unconditionally assigns `preferences = sanitizeOverlayPreferences(stored?.[OVERLAY_PREFERENCES_KEY])` when `storage.get` resolves, overwriting any `preferences` already updated by an earlier `save` message (`line 67`).
- **Why existing tests missed it:**
  In `test/maps/map-layers.test.mjs`, the mock `storage.local.get` resolves synchronously in the same microtask tick as `settings.requireCurrent()`, never exercising out-of-order completion or user interaction between the two reads.
- **Remediation Plan:**
  1. In `src/maps/map-layer-bridge.js`, track `let preferencesReady = !storage?.get;` and `let preferencesRevision = 0;`.
  2. Increment `preferencesRevision` in the `save` handler (`line 67`) and `storage.onChanged` listener (`line 107`).
  3. In the initial `storage.get(OVERLAY_PREFERENCES_KEY)` callback (`lines 116-123`), only assign `preferences` when `preferencesRevision === 0`, set `preferencesReady = true`, and call `announce()` inside `finally`.
  4. Gate `announce()` (`line 29`) on `if (disposed || !settingsReady || !preferencesReady) return;`.
  5. Add a unit test in `test/maps/map-layers.test.mjs` with a deferred `storage.local.get` verifying that `announce()` waits for both `settingsReady` and `preferencesReady` and that an intervening `save` is not overwritten when `storage.local.get` resolves late.

---

### F4 — Terrain bridge drops `update` (`routeStyle` / `theme`) and `snowStations.conditions` during frame authorization (P2 Bug / Bridge Race)

- **Location:**
  - `src/terrain/terrain-map.js:416-417, 512-525, 542-549`
  - `src/terrain/terrain-frame-runtime.js:42-45, 2254-2293, 2313-2318`
- **Root Cause:**
  Two state-synchronization gaps exist across the `terrain-map.js` ↔ `terrain-frame-runtime.js` `postMessage` boundary while `authorize()` is awaiting `chrome.runtime.sendMessage({ type: 'ACTIVATE_TERRAIN_FRAME' })`:
  1. **Dropped `update` (`routeStyle` / `theme`) during `init` or `resume` authorization:**
     When the iframe posts `'ready'`, `terrain-map.js:542-544` immediately posts `init` (`postToFrame('init', pendingInit)`), while keeping `pendingInit` non-null until `'loaded'` arrives. Inside the iframe, `terrain-frame-runtime.js:2257` awaits `authorize({ token: data.token, action: 'init' })` before setting `authorized = true` and `activeGeneration = nextGeneration`.
     If `controller.update({ routeStyle, theme })` is called on the host page during that async window (e.g., `gpx-analyzer.js` applying route color/width/glow settings from `bridge.js`), `terrain-map.js:520-525` mutates `pendingInit.routeStyle` / `pendingInit.theme` (which was already serialized into the `init` message) and calls `postToFrame('update', ...)`. The iframe receives `update` while `authorized` is still `false` (or while `activeGeneration` is still the old generation during `resume`) and drops it at `terrain-frame-runtime.js:2291-2293`. When `'loaded'` later arrives (`terrain-map.js:545-549`), `terrain-map.js` replays `pendingInit.snowStations` and `latestLayers`, then sets `pendingInit = null` without replaying `routeStyle` or `theme`.
  2. **Dropped `snowStations.conditions` in `pendingInit` and permissive `snowConditions = null` default:**
     When `controller.setSnowStations(stations, { reveal, conditions })` is called before `'loaded'`, `terrain-map.js:516` stores `pendingInit.snowStations = stations` and `pendingInit.revealSnowStations = Boolean(options.reveal)` but drops `options.conditions`. On `'loaded'` (`line 546`), it posts `snowStations` without `conditions`. Inside `terrain-frame-runtime.js:42-44`, `snowConditions` initializes to `null`, and `canSelect: id => snowConditions === null || snowConditions.has(id)` treats `null` as "all stations are selectable for the peak weather card." As a result, clicking a SNOTEL marker in 3D that has no matching condition entry in `peak-weather.js` selects it in the 3D overlay and posts `snowStationSelect` for a station that the peak weather card cannot display.
- **Why existing tests missed it:**
  `test/terrain/terrain-map.test.mjs` and `test/terrain/terrain-frame-runtime.test.mjs` resolve frame activation immediately or send `update` / `snowStations` after `'loaded'`.
- **Remediation Plan:**
  1. In `src/terrain/terrain-map.js`, track the latest `routeStyle`, `theme`, and `snowStationConditions` (on `pendingInit` and across `resume`), include `conditions: pendingInit.snowStationConditions` when replaying `snowStations` on `'loaded'`, and replay `postToFrame('update', { routeStyle, theme })` on `'loaded'` if `update()` was called after `init` / `resume` was posted.
  2. In `src/terrain/terrain-frame-runtime.js:42-44`, initialize `snowConditions = new Set()` (or only allow selection when `snowConditions instanceof Set && snowConditions.has(id)`) and preserve the previous `snowConditions` set when a `snowStations` message omits `conditions` rather than resetting it to `null`.
  3. Add regression tests in `test/terrain/terrain-map.test.mjs` and `test/terrain/terrain-frame-runtime.test.mjs` covering `update()` during in-flight `init`/`resume` authorization and `setSnowStations(..., { conditions })` queued before `'loaded'`.

---

### F5 — Non-monotonic rate-limit cooldown retention in map overlays (P2 Bug / Rate-Limit Discipline)

- **Location:**
  - `src/maps/map-overlay-tiles.js:159, 173`
  - `src/maps/sentinel-session.js:56, 97`
  - `src/maps/map-layer-bridge.js:79`
  - `src/maps/map-layers.js:126, 281`
- **Root Cause:**
  `docs/archive/codebase-audit-2026-10-21.md` (F1/F3) established the repo-wide invariant that rate-limit cooldowns must be retained monotonically (`Math.max(existing, incoming)` with a default cooldown fallback when `Retry-After` is absent). The map overlay modules still overwrite `retryAt` directly:
  1. `src/maps/map-overlay-tiles.js:159`: `createTilePool` runs up to `concurrency = 4` tile requests in parallel. For `land` tiles, when one request fails with 429 (`Retry-After: 120`), `blocked.set(blockKey, error)` records `retryAt = now + 120_000`, but sibling in-flight `land` tile requests are not aborted (only `slope` calls `abortSlope()`). If an already in-flight sibling tile returns 429 a moment later with a shorter `Retry-After` (e.g., `Retry-After: 5` from another edge node or missing `Retry-After`), `blocked.set(blockKey, error)` overwrites the 120 s cooldown with the shorter value, and `src/maps/map-layers.js:126` (`states[id] = { ...states[id], retryAt: info.retryAt }`) overwrites the UI cooldown state to match.
  2. `src/maps/sentinel-session.js:97`: in `loadDates`, `if (error?.code === 'RATE_LIMITED') retryAt = error.retryAt;` overwrites `retryAt` without `Math.max` and without a fallback when `error.retryAt` is undefined (unlike `tileUrl` at line 56 which falls back to `Date.now() + 60_000`).
  3. `src/maps/map-layer-bridge.js:79` and `src/maps/map-layers.js:281`: cooldown timestamps merged from `cooldown` messages are not clamped with `Math.max` against existing active cooldowns.
- **Why existing tests missed it:**
  `test/maps/map-layers.test.mjs` and `test/maps/sentinel.test.mjs` test single 429 responses rather than overlapping in-flight tile/session responses with differing `Retry-After` values.
- **Remediation Plan:**
  1. In `src/maps/map-overlay-tiles.js`, retain the maximum `retryAt` when updating `blocked.get(blockKey)` and abort sibling in-flight requests for the same `blockKey` when a rate limit is recorded.
  2. In `src/maps/sentinel-session.js:56, 97`, `src/maps/map-layer-bridge.js:79`, and `src/maps/map-layers.js:126, 281`, apply `Math.max(currentRetryAt || 0, nextRetryAt || (Date.now() + 60_000))` when recording a `RATE_LIMITED` cooldown.
  3. Add unit tests in `test/maps/map-layers.test.mjs` verifying monotonic `retryAt` retention across concurrent `land` / `slope` / `sentinel` 429 responses.

---

### F6 — Unshipped legacy map modules (`sentinel-map.js`, `sentinel.css`, `peak-snow-map.js`, `createSentinelLayer`) and stale doc reference (P3 Engineering Smell)

- **Location:**
  - `src/maps/sentinel-map.js` (109 lines)
  - `src/maps/sentinel.css` (81 lines)
  - `src/maps/peak-snow-map.js` (125 lines)
  - `src/maps/sentinel-layer.js:32-245` (`createSentinelLayer`, 214 lines)
  - `docs/mountain-local-time.md:28`
- **Root Cause:**
  Commit `b900d73b` unified the 2D and 3D map overlays into `src/maps/map-layers.js`, `src/maps/map-layer-control.js`, `src/maps/map-overlay-leaflet.js`, `src/maps/sentinel-session.js`, and `src/maps/snotel-map-leaflet.js`. An `esbuild` metafile trace across all 50 `ENTRIES` and `COPY_FILES` in `scripts/build-config.mjs` confirms:
  - `src/maps/sentinel-map.js`, `src/maps/sentinel.css`, and `src/maps/peak-snow-map.js` are never bundled or copied into `dist/`.
  - `src/maps/sentinel-layer.js` is imported by `src/maps/sentinel-session.js` solely for the 17-line `sentinelCaptureChoice` helper; its 214-line `createSentinelLayer` export is tree-shaken out of every `dist/` bundle and is only exercised by `test/maps/sentinel.test.mjs`.
  - Leaving these dead modules in `src/maps/` masked **F1** during code search and creates maintenance traps where fixes can be applied to unshipped files.
  - `docs/mountain-local-time.md:28` still lists `dist/content/sentinel-map.js` instead of `dist/content/map-layers.js`.
- **Remediation Plan:**
  1. Remove `createSentinelLayer` from `src/maps/sentinel-layer.js` (keeping `sentinelCaptureChoice` and `SENTINEL_TILE_SIZE`), and delete the unshipped `src/maps/sentinel-map.js`, `src/maps/sentinel.css`, and `src/maps/peak-snow-map.js`.
  2. Update `test/maps/sentinel.test.mjs` and `test/snow/snotel-map.test.mjs` so unit tests exercise the shipped `sentinel-session.js` / `snotel-map-leaflet.js` / `map-layers.js` surfaces rather than the deleted legacy wrappers.
  3. Update `docs/mountain-local-time.md:28` from `dist/content/sentinel-map.js` to `dist/content/map-layers.js`.

---

## Candidates Investigated & Rejected (or Reconciled with Prior Audits)

To avoid false positives or re-reporting closed items, the following areas were traced end-to-end and verified clean or already tracked:

1. **Shared Settings Schema & Cross-World Validation (`src/settings/settings-schema.js`, `src/settings/bridge.js`, `src/gpx/gpx-analyzer.js`, `src/maps/big-map.js`, `src/terrain/terrain-frame-runtime.js`):**
   - Verified that all page-world and terrain-frame consumers validate `postMessage` payloads exclusively through `src/settings/settings-schema.js` with no local constant drift.
2. **Activity Capture Privacy & Ownership Gates (`src/capture/provider-page.js`, `src/capture/capture-core.js`, `src/background/background.js`, `src/ascent/ascent-draft.js`):**
   - Verified that raw GPX never leaves the provider page, ownership fails closed when signals are missing or ambiguous, waypoints share the 3,000-point budget and strip elevation/time/description/extensions, and draft filling never triggers Peakbagger Save.
3. **3D Terrain LOD, Cancellation & Cache Bounds (`src/terrain/terrain-coordinator.js`, `src/terrain/terrain-frame-runtime.js`, `src/terrain/terrain-cache.js`):**
   - Verified recent commits (`c73be873`, `ff365fa2`, `5149d2eb`, `685b1163`): `AbortController` propagation cancels superseded DEM/satellite work cleanly, `ImageBitmap.close()` is called on replaced/cleared overlay textures, and `terrain-cache.js` enforces byte/entry eviction in memory and IndexedDB.
4. **Content-Script Page Features (`src/gpx/gpx-analyzer.js`, `src/ascent/ascent-filter.js`, `src/ascent/ascent-weather.js`, `src/weather/peak-weather.js`, `src/reports/report-editor.js`, `src/favorites/climber-hover-card.js`):**
   - Verified generation guards on async weather/ERA5/sun/hover fetches, offline mountain-local timezone fallback (`src/time/mountain-tz.js`), and HTML escaping (`esc()`) across tooltip and summary templates.
5. **Prior Audit Items Reconciled (`docs/archive/codebase-audit-2026-10-21.md`, `docs/archive/map-overlays-audit-2026-10-21.md`, `docs/plans/codebase-audit-2026-10-19.md`):**
   - All fixed items from the 2026-10-21 codebase and map-overlays audits remain intact in `HEAD`.
   - The `npm run audit:ci` `web-ext -> @devicefarmer/adbkit -> node-forge` advisory remains an unowned dev-only transitive dependency tracked in prior closure ledgers.

---

## Prioritized Remediation Order

1. **Step 1 (F1 + F6):** Update `scripts/verify-layout-stability.mjs` to load `css/map-layers.css` and `content/map-layers.js`, add a build-config asset assertion test in `test/project/`, remove unshipped `src/maps/sentinel-map.js`, `src/maps/sentinel.css`, `src/maps/peak-snow-map.js`, and `createSentinelLayer`, and update `docs/mountain-local-time.md`.
2. **Step 2 (F2 + F5):** Fix `createLeafletOverlays.retry(id)` in `src/maps/map-overlay-leaflet.js` so retrying an unmounted cooldown-blocked layer calls `add(id)`, and enforce monotonic `Math.max` rate-limit cooldown retention across `src/maps/map-overlay-tiles.js`, `src/maps/sentinel-session.js`, `src/maps/map-layer-bridge.js`, and `src/maps/map-layers.js`.
3. **Step 3 (F3):** Gate `installMapLayerBridge` initial `announce()` on `preferencesReady` and guard initial `storage.get` with a revision counter in `src/maps/map-layer-bridge.js`.
4. **Step 4 (F4):** Preserve and replay `routeStyle`, `theme`, and `snowStations.conditions` across terrain frame activation in `src/terrain/terrain-map.js` and tighten `snowConditions` initialization in `src/terrain/terrain-frame-runtime.js`.

---

## Closure Ledger

### Fixed and Verified

| Item | Resolution | Commit / focused evidence |
| --- | --- | --- |
| F1 | Layout verification now loads the shipped map-layer owner and CSS, drives renderer/station protocol states, and checks trigger, rows, action, native content and document scroll. A build-inventory assertion rejects unshipped literal assets; the runner requires executed cases. | `0aa519eb`; the asset guard first failed on the removed Sentinel CSS. Eight hidden Chrome/Firefox theme/viewport variants passed, each with 1x/2x text. |
| F2 | Leaflet retains desired overlay state. Retry mounts a layer skipped during cooldown at the saved opacity, while disabled/transparent overlays remain off. Existing successful canvases remain painted. | `9e1a74e1`; four new cases failed with zero requests before the fix; 23 focused tests passed. |
| F3 | Initial preferences wait for both settings and local opacity storage. A save revision prevents a late read from replacing newer values. Controls stay unpainted until readiness, closing the earlier user-interaction window too; failure settles to schema defaults. | `51bd28c9`, `c1f6661b`; bridge races, two native/3D visibility assertions and a real Chrome visibility assertion failed before their fixes. All 50 focused owner/control/bridge tests then passed. |
| F4 | Launch-owned state buffers route style, theme and bounded station-condition membership while the worker issues activation; the pending-init replay then covers frame authorization and resume. Partial updates preserve omitted fields. Unknown/new-activation membership offers no weather-card action. | `c2019a02`, `c6b7b239`; five new assertions caught both early and late authorization windows and permissive actions. All 35 terrain tests passed, including cancellation and generation guards. |
| F5 | Tile providers, Sentinel sessions, station replies and native/terrain handoffs retain the longest applicable provider deadline. Earlier failed tile outcomes share an extendable provider limit, and absent Retry-After retains the existing five-minute fallback. | `d3408219`; six new assertions failed before the fix; 56 focused tests passed. |
| F6 | Removed four unshipped legacy map files; extracted the live capture-format helper and ported date/DST/offset/dateline, stale-zone, unsupported-view and station coverage onto shipped owners. Fixed maintained references. | `0aa519eb`; 203 focused map/snow/asset tests passed. |
| Additional layout defect | A long error at 2x text made the scrollable public-land menu clamp its scroll when Retry started, moving the action 282 px. Recovery reserves its exact feedback height only while the action holds focus, releasing it on blur. | `0aa519eb`, `c1f6661b`; the real-browser assertion reproduced the movement, then passed in Chrome and Firefox. A subsequent Firefox component check exposed a 0.4 px rounding change; retaining the measured fraction removed it and the component gate passed. |
| Script audit | Removed the obsolete Sentinel alias; reduced the old weather audit to its unique Nepal interval case; removed an API verifier's assertion against a retired Buddy banner. Registered four useful standalone checks, rejected unsupported arguments before setup, blocked unrelated live reads in the peak-layout check, and indexed all 100 root modules. | `f2dda245`; 100 syntax checks and 40 runner/asset/inventory tests passed. API limits, exact-document backup BFCache, weather intervals and offline peak layout all passed in hidden Chrome. |

Script review traced maintained callers in package scripts, the dispatcher,
CI/actions, imports, tests and living documentation, and compared file hashes.
There were no byte-identical duplicate modules. Imported case groups, teardown,
certificate, renderer, viewport and bounded diagnostic helpers remain active;
their count is not evidence of dead code. The complete owner grouping lives in
[scripts/README.md](../../scripts/README.md). Duplicated GPS restoration, weather
tab styling and day switching remain covered by the maintained weather runners;
the retained interval driver proves 25 partial/full intervals sum to 24 mm.

### Intentionally Not Changed

- Public-land providers remain independent. A failed BC source cannot erase or
  block validated US/Alberta content. Already-started mixed tiles may finish;
  subsequent work for a limited provider is blocked. The combined land row can
  become retryable when any relevant provider is available; applying one maximum
  to that aggregate would incorrectly block unrelated providers.
- F3's proposed local `storage.onChanged` revision increment referred to a
  listener absent from the actual bridge. The real competing startup/save paths
  are guarded without inventing a second preference synchronization feature.
- No feature/permission expansion, live account writes, native Save automation,
  dependency-policy renewal, push, release, or changes to unrelated weather work.
- The original report's five-vulnerability dependency baseline was historical.
  The current strict audit rejects three high development-only findings in
  web-ext / adbkit / node-forge. Production audit reports zero. The existing
  exact-path exception passes without modification and expires October 24 at
  00:00 PDT (2026-10-24T07:00:00Z), covering October 23 only. No acceptance was
  renewed or broadened.

### Changed but Not Fully Proven

- Controlled authorization interleavings and condition membership are covered by
  serialized-message/jsdom regressions. Final browser smoke exercises the real
  extension and hardware renderer, but does not deliberately delay the real
  worker's capability consumption to reproduce every authorization ordering.
- Layout tests use real shipped assets and HTTPS Peakbagger fixtures; the
  isolated station service and terrain status replies in the broad layout gate
  are stubbed. The separate integration verifier supplies real Leaflet/MapLibre
  and real extension loading with intercepted provider responses.
- Packaged Firefox 158.0.1 passed its smoke but reported BFCache restored=false.
  The unpacked run earlier restored successfully; the final packaged run does
  not establish that cached-document path. This remains a release proof gap.
- Hidden tests do not prove native browser chrome, permission prompts, onscreen
  focus/window placement, screen-reader behavior or live provider compatibility.
  No live provider/account or hosted CI/release result is claimed.

### Final Verification

The final integration/package checks ran against isolated commit
`c6b7b239461735597557826d7d8a2f9ca911efee`. Concurrent map-location/elevation and
weather edits appeared in the shared checkout during this task, including files
changed after the audit commits. Those edits were preserved and excluded from
this verification snapshot and from the audit commits. Earlier shared-tree lint
caught a shadowed variable in an untracked concurrent map-menu file; the isolated
committed snapshot passes lint. Results below apply to that exact snapshot.

| Check | Actual result |
| --- | --- |
| `npm test` | 3,216 passed, zero failed. Rebuilt all 50 shipped bundles. |
| `npm run test:scale` | 14 passed, zero failed. |
| `npm run lint` | Passed ESLint and shipped web-ext lint with eight existing owner-reviewed warnings. |
| Script syntax / dispatch / inventory | All 100 root modules passed node --check; 40 focused runner/asset/inventory assertions passed. Unsupported selections are rejected before setup. |
| Map layout transitions | Hidden Chrome 156.0.8078.4 and Playwright Firefox 157.0; 390×900 and 1280×900, light/dark, 1x/2x control text. Initial preference readiness, all four rows, long error → pending → repeated error → success, keyboard retry and capture selection passed with 1 px geometry tolerance. Rendered screenshots inspected. |
| Component layout | Hidden Chrome 156 and Playwright Firefox 157; 736/320×800, light/dark, 1x/2x text, native selector checks at 1280/375×800 and desktop 200% CSS zoom. Recovery/focus/compactness checks passed after removing fractional rounding. |
| Hardware map integration | Hidden Chrome 156.0.8078.4 at 1000×700; Leaflet 1.9.4, packaged MapLibre 6.13.0 and ANGLE Metal on Apple M3 Pro. Native/terrain recovery, opacity/mosaic pixels, provider independence, Full Screen state, capture choices and suspend/resume passed; software renderer rejected. |
| Minified store archives | Release build succeeded. Both Chrome and Firefox archives passed required-file/manifest/notice/development-artifact validation with 108 entries each. No store submission occurred. |
| Exact packaged browser checks | One complete pair passed on hidden Chrome 156.0.8078.4 and installed Firefox 158.0.1, viewport 1000×760. Archive fingerprints stayed unchanged. Chrome restored BFCache; Firefox did not, as retained above. |
| Strict dependency audit | Still rejects three high findings in the existing web-ext / adbkit / node-forge development chain. No new acceptance or lockfile change. |
| Production / reviewed dependency audit | npm audit --omit=dev reports zero. The existing exact development-only exception passes through its unchanged expiry. |
| Documentation | Five documentation/asset/inventory checks passed after archiving the supplied historical report; isolated git diff --check passed. |
| Teardown | Verifiers exited and reported teardown. A separate process-command-line inspection found no matching verification browser/helper processes. The disposable dependency symlink was removed without following it; the managed verification checkout was archived. Temporary packages and rendered artifacts were removed after inspection. |

Validated temporary archive SHA-256 values (files were discarded after testing):

- Chrome: ae08899fa2deb8a58ea2a4fb7256cf9e516d285585a8fd22fb4f02d7e6bddd6e
- Firefox: 4f39105f6a351a5464302ef4f8ece0a521b606666bf29e29c17b1b4cc3e5b2fc

The focused commits above are local. No push, merge, tag, release, provider write
or publication was performed. Native/live, delayed real-worker authorization and
packaged Firefox BFCache proof limits remain explicit; this is local closure of
the confirmed findings, not universal browser/provider certification.
