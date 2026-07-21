# Better Peakbagger — 5-feature implementation plan

Self-contained brief for an implementing agent working in `better-peakbagger` repo.

## Implementation status (updated 2026-07-20)

Legend: ✅ done & committed · 🚧 in progress · ⬜ not started

| Unit | Status | Notes |
| --- | --- | --- |
| 1 — "View the New Ascent" link | ✅ done | commit `c7d5b64`; `npm test` green |
| 2 — Captured activity URL → `#URLTB` | ✅ done | commit `9b49eb2`; `npm test` green |
| 3 — Default descending ascent-date sort | ✅ done | commit `71a93a4`; `npm test` green |
| 4 — Two-level settings nav + IA restructure | ✅ done | commit `ed6a4bc`; visually verified light/dark, wide/narrow in headless Chromium |
| 5 — Compass above the 3D toggle | ✅ done | commit `be17b9f`; `npm test` green |
| 6 — 2D→3D keep-alive (suspend/resume) | ✅ done | commit `f7f67e3`; `npm test` green |
| 7 — DEM prefetch + preconnect | ✅ done | `npm test` green (514 tests) |

Cross-cutting still outstanding:
- 🚧 **Real-browser verification** — `npm run terrain:verify` (Units 5–6) and
  `npm run verify:extension` (Units 5–7, build-config changed) run as a single
  pass now that Unit 7 has landed.
- ✅ **Docs** — `PRIVACY.md` prefetch sentence, `docs/architecture.md`
  suspend/resume + prefetch update, and the CHANGELOG entry for Unit 7 are done.
  CHANGELOG entries for Units 1–6 were already in place.

## Context

Better Peakbagger is an MV3 browser extension (vanilla JS, esbuild via `scripts/build.mjs` + `scripts/build-config.mjs` whose `ENTRIES[]` defines bundle composition; tests are node tests in `test/` against PII-masked fixtures in `test/fixtures/` — never write real user identifiers, a hash-based privacy test guards this). Read and follow `AGENTS.md` first (commit discipline: small conventional commits straight to `main`; architecture boundaries; real-browser verification; UX bar).

Five features, ordered as independently committable units:

1. Google-Maps-style compass on 3D maps, above the 3D toggle, click → north-up + top-down. Not shown in 2D.
2. Two-level settings navigation (Sidebery-style sidebar), incl. renames and a new "captured activity URL → URLTB" setting (default ON).
3. "View the New Ascent" link on the ascent-save success page.
4. New Ascent-beta-filter setting: open ascent lists date-descending (default OFF).
5. Shorten the 2–3 s 2D→3D transition: keep-alive iframe + DEM prefetch (both).

Key architecture facts (verified):

- **Settings**: single `chrome.storage.sync` object under key `bpbSettings`; schema/`DEFAULTS`/`clean()` in `src/settings-schema.js` (pure, no deps); storage API `settings.get/set/subscribe` in `src/settings.js`. Options page: `options/options.html|css|js` — left sidebar `nav.side-nav` + scrolling `main.content`, scroll-spy `initSectionNav()` at `options/options.js:216-291`. MAIN-world code can't touch `chrome.storage`; bridges relay via `window.postMessage` (`src/bridge.js` `WRITABLE_KEYS` pattern — do NOT add new keys there; none of the new keys are page-writable).
- **3D map**: page-world coordinators `src/big-map.js` (BigMap.aspx) and `src/peak-map.js` (Peak.aspx) own the floating `#bpb-terrain-toggle` (big-map.js:339-402); isolated-world bridge `src/terrain-map.js` creates/destroys an extension iframe `terrain/terrain.html` (`createFrame` :222-262, `removeFrame` :35-40, `postToPage`/`postToFrame` helpers :28-52); `src/terrain-frame.js` runs MapLibre GL inside (NavigationControl `showCompass:false` at :1199-1201, deliberate — keeps the ctrl stack the same height as the 2D zoom stack; comment at :1193-1198). Frame measures `navTop` (`measureNavTop` :165-169) and posts it in `loaded`/`metrics`; page positions the toggle at `bottom = navTop + TERRAIN_TOGGLE_GAP` (`positionTerrainToggle` big-map.js:235-250; peak-map.js:157-171). Camera preserved 2D↔3D via `src/terrain-camera.js` (center+zoom only). Every toggle currently boots a fresh iframe + MapLibre + CSP worker and destroys all on exit. DEM tiles: `raster-dem` terrarium via custom protocol `bpb-dem://{z}/{x}/{y}.webp` backed by LRU CacheStorage cache `bpb-mapterhorn-dem-v1` (`src/terrain-cache.js`, tiles from `https://tiles.mapterhorn.com`, injectable `fetchFn`/`cacheStorage` for tests).
- **Ascent editor** (`ascentedit.aspx`) bundle `content/ascent-editor.js` = `[ascent-draft.js, gpx-parse.js, settings-schema.js, settings.js, ascent-upload.js, report-markup.js, report-editor.js]` (build-config.mjs:42). After save, the SAME URL shows success: `span#SubTitle` = "Ascent Added/Saved Successfully!" + `<a>Go Back to Referring Page</a>, or, add a new ascent on this page.` + a photo link `Photo.aspx?aid=<NEWID>&pid=…` — the only place the new aid appears. The page uses an ASP.NET UpdatePanel (`div#UpdatePanelAE`) so the success view can arrive via async partial postback → MutationObserver needed.
- **Capture flow**: `src/background.js` `draftReady()` (:888-994) builds the draft `fields` payload; the capture job stores `provider` + `activityId` (:439-440) but the activity URL never reaches the form today. `src/ascent-draft.js` `fillForm()` (:186-239) writes fields; helper `setTextFieldIfEmpty(id, value, {replaceAutofilled})` exists at ascent-draft.js:102. The target field is `#URLTB` ("URL Link to External Trip Report", fixture `test/fixtures/pages/climber-ascentedit.html:257`).
- **Ascent lists**: `src/ascent-filter.js` (document_start on `PeakAscents.aspx` + `ClimbListC.aspx`; imports `settings as S`). Instant client-side sorter `setupInstantTableSort()`; `applyInstantSort = target => {…}` (:325-329) resolves `target.columnIndex` then falls back to `target.key`, then `apply(column, target.dir || column.defaultDir)`. `apply()` (:268-295) reorders via DocumentFragment; for the served-ascending date column it uses a precomputed `reversedDateOrder` and rewrites the URL `sort` param (`ascentdate`/`ascentdated`) via `history.replaceState`. Early click-guard holds header clicks before the sorter is ready (:38-80, module-scope `let applyInstantSort = null; let sortReady` around :59-65). `init()` wires the sorter synchronously at :476, BEFORE the compact-view early return (:478-481) and before the awaited settings read (`betaCfgFrom(await S.get())` ~:531).

---

## Unit 1 — "View the New Ascent" link on the save-success page — ✅ DONE (`c7d5b64`)

**New file** `src/ascent-saved.js` (isolated world, IIFE style like `ascent-upload.js`, no setting gate — pure convenience link). **Bundle**: append `'ascent-saved.js'` to the `content/ascent-editor.js` entry in `scripts/build-config.mjs:42`.

`tryInsert()` logic:
1. Idempotency: bail if `document.getElementById('bpb-view-new-ascent')` exists.
2. Detect success: `#SubTitle` textContent matches `/Ascent (Added|Saved)\/?(Saved )?Successfully/i` — keep tolerant (observed live text: "Ascent Added/Saved Successfully!").
3. Extract aid from `document.querySelector('a[href*="photo.aspx?aid=" i]')` → `new URL(href, location.href).searchParams.get('aid')`, require `/^\d+$/`. No aid → do nothing.
4. Find the anchor whose text matches `/go back to referring page/i`; insert after it: a text node `", "` + `<a id="bpb-view-new-ascent" href="ascent.aspx?aid=<aid>">View the New Ascent</a>`. Result reads: "Go Back to Referring Page, View the New Ascent, or, add a new ascent on this page."
5. Run once at load AND from a MutationObserver on `#UpdatePanelAE`'s **parent** (or `document.body`) with `{childList:true, subtree:true}` — observing the panel itself breaks if ASP.NET replaces the whole element. Debounce bursts (scheduled-flag/microtask). Wrap in try/catch so failures never affect the draft-fill pipeline sharing the bundle.

**Tests**: new `test/ascent-saved.test.mjs` (follow existing jsdom test patterns): success DOM with masked ids → exactly one link with correct href; double-run/observer-refire → no duplicate; no photo link → no insert; form-state fixture `climber-ascentedit.html` → no insert. Any new success fixture must use masked ids and pass the fixtures-privacy test.

---

## Unit 2 — Captured activity URL → `#URLTB` (new setting, default ON) — ✅ DONE (`9b49eb2`)

**Setting** `fillExternalUrl: true` in `DEFAULTS` (`src/settings-schema.js:31-62`) + boolean coercion in `clean()`. Options row lands in "Activity creation → GPX capture" (Unit 4); wire checkbox `id="fill-external-url"` in `options/options.js` like the other booleans (title "External trip report link"; desc: puts the captured Garmin/Strava link into Peakbagger's "URL Link to External Trip Report" field when empty).

**Data path** (activity URL is NOT in the draft payload today — rebuild it from `provider` + `activityId`, don't persist raw tab URLs):
1. `src/provider-url.js`: export pure `providerActivityUrl({provider, activityId})` → `https://connect.garmin.com/app/activity/<id>` / `https://www.strava.com/activities/<id>`, null for junk (`/^\d+$/` on id). `/app/` matches what `providerFromUrl` recognizes (provider-url.js:11).
2. `src/background.js`: add `fillExternalUrl` to `readCapturePreferences()` (:44-52) and `sameCapturePreferences()` (:54-58); in `draftReady()`'s fields object (:983-990) add `externalUrl: job.capturePreferences?.fillExternalUrl !== false ? providerActivityUrl(job) : null`. Local-GPX jobs have `activityId: null` → builder returns null → nothing written (correct).
3. `src/ascent-draft.js` `fillForm()`: after the `SuffixText` write (~:199), `if (typeof fields.externalUrl === 'string' && fields.externalUrl) setTextFieldIfEmpty('URLTB', fields.externalUrl);` — always if-empty, never clobber a user-entered URL.

**Tests**: `providerActivityUrl` unit cases (garmin/strava/junk/unknown); `test/ascent-draft.test.mjs` — fills empty `#URLTB`, leaves pre-filled untouched, null → untouched; `test/background-capture.test.mjs` — DRAFT payload carries `externalUrl` when on, null when off; options control persists.

---

## Unit 3 — Default descending ascent-date sort (new setting, default OFF) — ✅ DONE (`71a93a4`)

**Setting** `betaSortDateDesc: false` in `DEFAULTS` + boolean coercion in `clean()` — do NOT put it in the `['betaTr','betaGps','betaLink']` at-least-one-signal invariant loop (settings-schema.js:155). Options row in the beta section: checkbox `id="beta-sort-date-desc"`, title "Newest ascents first", desc "Open ascent lists sorted by date, newest first, when the page arrives in its default oldest-first order. A sort you choose by clicking a column always wins."

**Hook in `src/ascent-filter.js`**:
1. Module scope: `const settingsPromise = S ? S.get().catch(() => null) : Promise.resolve(null);` kicked off at top level (script runs document_start; this removes the storage round-trip from the critical path). Reuse it later for `betaCfg` (`betaCfgFrom(await settingsPromise)` replacing `await S.get()` ~:531).
2. Module scope `let userSorted = false;` set inside the early click-guard whenever a header sort target is captured (~:61-67) — covers clicks held before wiring AND replayed clicks.
3. Immediately after `setupInstantTableSort(...)` (:476) and **before** the compact-view early return (:478-481):
   ```js
   void settingsPromise.then(s => {
       if (!s || s.betaSortDateDesc !== true) return;
       if (new URLSearchParams(location.search).has('sort')) return; // explicit URL sort wins
       if (userSorted || !applyInstantSort) return;                  // never fight a user click
       applyInstantSort({ columnIndex: -1, key: 'ascentdate', dir: 'desc' });
   });
   ```
   Mechanics (verified): `columnIndex: -1` matches nothing → falls to the `key` lookup → `apply(column, 'desc')` → `reversedDateOrder` fragment reorder preserving year sections; `apply()` also rewrites the URL to `sort=ascentdated` (keep this — reload/back then serve descending natively; a manual click behaves identically). Already-descending pages are reached only via a `sort` param, so the URL check skips them; pages with no date column → `applyInstantSort` finds nothing, no-op. Rows exist at DOMContentLoaded; the flip lands ~ms after, acceptable given default-off.

**Tests** (`test/ascent-filter.test.mjs`, existing fixtures in `test/fixtures/peakascents/`): `2296-rainier-default-recent-year.html` + setting on → newest date first, year sections contiguous, URL rewritten to `sort=ascentdated`; `21500-y9999-sort-ascentdate.html` (explicit sort param) → untouched; `21500-y9998-sort-ascentdated.html` → untouched; setting off → untouched; header click before settings resolve → auto-flip skipped, click honored.

---

## Unit 4 — Two-level settings navigation + IA restructure — ✅ DONE (`ed6a4bc`)

**Files**: `options/options.html`, `options/options.css`, `options/options.js` (`initSectionNav` :216-291), `test/options.test.mjs`. Single scrolling page + scroll-spy stays (matches Sidebery's look); level-2 items are always-visible indented sub-links (no collapse machinery — only ~6 sub-items total).

**Final IA** (keep existing section ids so deep links survive; control element ids unchanged so persistence tests keep passing):
- **General** (`#general`): Theme, Enable experimental 3D map. (Trip-report rows move out.)
- **Activity creation** (`#capture`, renamed from "Activity capture"):
  - *GPX capture* (`#capture-gpx`): retain-waypoints, fill-ascent-details, fill-trip-info, fill-wilderness-nights, **fill-external-url** (Unit 2).
  - *Trip report editor* (`#capture-report`): enable-report-editor, add-report-credit (moved from General).
- **Map & GPX chart** (`#map-chart`):
  - *GPX chart* (`#map-chart-chart`): units, chart default series (Units stays here, not General — it only governs chart/editor surfaces).
  - *Map* (`#map-chart-map`): route appearance, remember layer, 3D terrain cache row (still hidden unless 3D enabled), viewport size.
- **Ascent beta filter** (`#beta`): existing beta-definition rows + **Newest ascents first** (Unit 3). Flat, no sub-items.
- **Settings for nerds** (`#github`, renamed from "GitHub backup"):
  - *GitHub trip backup* (`#github-backup`): existing enable row + `#github-panel`.
- **About** (`#about`).

**Markup**: per subsection `<div class="subsection" id="capture-gpx" role="group" aria-labelledby="…"><h3 class="subsection-title">GPX capture</h3><div class="card">…rows…</div></div>`. Sidebar: each `li` may contain `<a class="nav-item">` + `<ul class="nav-sublist"><li><a class="nav-subitem" href="#capture-gpx">…`.

**CSS**: `.nav-sublist` — indented (padding-left ~14px, subtle left border via `color-mix`), column flex; `.nav-subitem` mirrors `.nav-item` (options.css:85-97) slightly smaller, same hover/focus-visible/`[aria-current]` treatments; `.nav-item.nav-parent-active` = accent text without filled background. On the narrow-viewport horizontal-nav layout (options.css:299-309) hide `.nav-sublist` entirely — level-1 chips suffice.

**Scroll-spy generalization** (`initSectionNav`): build entries from `a.nav-item, a.nav-subitem` in document order, each `{link, section, parentLink}`; existing last-top-≤-marker logic naturally activates sub-items as you scroll (subsections follow their section heading in document order; bottom clamp unchanged); `setActive` sets `aria-current` on exactly one link and toggles `nav-parent-active` on the active entry's parent; click/hashchange lock logic works once entries include sub-item hashes.

**Tests**: update nav-link assertions (labels/ids incl. renames), sub-link presence, scroll-spy activating sub-item + parent class, hash deep-link to a subsection; existing per-control persistence tests should pass unchanged (ids stable). **Visually verify** light+dark, wide+narrow per the UX bar — DOM tests alone are insufficient.

---

## Unit 5 — Compass above the 3D toggle — ✅ DONE (`be17b9f`)

**Decision: page-overlay compass next to `#bpb-terrain-toggle`** (NOT inside the iframe): the requirement is "above the 3D button" which lives in the host page, and the in-frame ctrl stack is deliberately compass-free so its height matches the 2D zoom stack (adding there would shift `measureNavTop` and break toggle alignment). Cost: one throttled view stream + one command message.

**New shared page-world module** `src/terrain-compass.js` exporting `terrainCompass.create({container, toggle, onReset}) → {setVisible, update, position, element}`:
- `button#bpb-terrain-compass.bpb-map-compass` (`type="button"`, initially hidden, `aria-label="Reset the view to north, looking straight down"`, `title="Reset to north"`), inline SVG needle (red north half / neutral south) inside `span.bpb-map-compass-disc`.
- `update(bearing, pitch)`: `disc.style.transform = rotateX(pitch) rotateZ(-bearing)` (button gets `perspective:100px` in CSS so pitch reads as tilt — MapLibre `visualizePitch` treatment). Transform is state, not decoration — always applied; only *transitions* respect `prefers-reduced-motion`.
- `position()`: `el.style.bottom = round(parseFloat(getComputedStyle(toggle).bottom) + toggle.offsetHeight + 8) + 'px'` (`right:10px` from CSS) — works for both measured-navTop and CSS-fallback toggle positions.

**Bundle**: add `'terrain-compass.js'` to `content/big-map.js` and `content/peak-map.js` entries (build-config.mjs:52,54).

**Protocol**:
- Frame → parent: on map `'move'` (alongside the `'moveend'` handler ~terrain-frame.js:1270) post `'view'` `{bearing, pitch}` throttled via requestAnimationFrame (one post per painted frame, like the peak-hover throttle :830-837); post one `'view'` right after `'loaded'`.
- Bridge `src/terrain-map.js`: relay toParent `'view'` → `postToPage('view', {bearing, pitch})` (next to the `'metrics'` branch :315-316); relay toCS `'resetNorth'` → `postToFrame('resetNorth')` (next to `'highlight'` :279-280).
- Frame handles `'resetNorth'` (message switch ~:1315-1329): `map.easeTo({bearing:0, pitch:0, duration: prefersReducedMotion ? 0 : 600})`.

**Coordinators** (`src/big-map.js` + `src/peak-map.js`, symmetric): create the compass once next to the toggle (big-map: in `ensureTerrainToggle()` appending to the same mount; peak-map: next to `mount.append(terrainToggle)` :95-100) with `onReset: () => postTerrain('resetNorth')`. Visible only when `terrainState === 'active'` and no stop pending (show on `'loaded'`, hide in `finishTerrainStop`/`failTerrain`/`updateTerrainToggle`). Call `compass.position()` at the end of `positionTerrainToggle()` in both files. `'view'` handler: validate `Number.isFinite`, normalize bearing to [0,360), clamp pitch [0,85], then `compass.update(...)`. Theme: mirror the toggle's `dataset.theme` in `updateTerrainToggle()`.

**CSS** (`src/terrain-map.css`): `.bpb-map-compass` — 36px circle, `position:absolute; right:10px; z-index:3`, same surface/dark-theme/focus-visible treatment as `.bpb-map-3d-toggle` (:27-51), `perspective:100px`, disc `transition: transform .12s` guarded by reduced-motion.

**Tests**: bridge relays `'view'` toPage / `'resetNorth'` toFrame (`test/terrain-map.test.mjs`); coordinator tests — hidden at idle, appears after synthetic `'loaded'`, `'view'` rotates disc transform, click posts `resetNorth`, hidden after stop. Real behavior via `npm run terrain:verify` + hidden Chrome-for-Testing pass per AGENTS.md.

---

## Unit 6 — 2D→3D keep-alive (suspend/resume) — ✅ DONE (`f7f67e3`)

**Design: all logic in bridge + frame; the page coordinators change zero lines** — they keep sending `'init'`/`'destroy'` and waiting for `'loaded'` (toggle state machine untouched; re-entry just resolves fast).

**Bridge (`src/terrain-map.js`)**:
- State: `let suspended = false, suspendTimer = null, frameLoaded = false;` `SUSPEND_TTL_MS = 5 * 60 * 1000`.
- On page `'destroy'` (:275-278): if frame exists AND `frameLoaded` → post `'suspend'` to frame, set `frame.style.opacity='0'; frame.style.pointerEvents='none'` (same pre-load state used at :304-305), `suspended = true`, start TTL timer → on expiry `postToFrame('destroy'); removeFrame()`. If not loaded (destroy raced boot) → hard destroy as today. Keep posting `'destroyed'` to the page either way.
- In `createFrame(data)` (:222-262): if `suspended && frame?.contentWindow` → clear timer, `suspended = false`, `postToFrame('resume', payload)` instead of building an iframe. Frame replies with normal `'loaded'` → existing branch restores opacity and forwards navTop+camera unchanged.
- `frameLoaded`: set on `'loaded'`, cleared on sending `'init'`/`'resume'` and in `removeFrame()`. `removeFrame()` also clears `suspended`/timer (so the settings-disable path `fail('unavailable')` tears everything down).

**Frame (`src/terrain-frame.js`)**:
- `'suspend'`: stop ambient work (clear peaks debounce timer, remove peak popup, cancel pointer rAF). Map, cache, protocol, DOM stay alive (idle MapLibre at opacity 0 renders nothing).
- `'resume'` (guard: requires live loaded map, else fall through to `createTerrain(data)`): re-validate payload with the same helpers `createTerrain` uses (route, focus, camera via `terrainCamera`, style, theme); `setData` the route source + refresh route paint/theme/focus feature; camera — `jumpTo(requestedCamera)` if present, else `fitBounds(route.bounds, {padding:46, maxZoom:15.5, pitch:60, bearing:0, duration:0})`, else focus jump (bearing/pitch reset to defaults = today's fresh-boot behavior); basemap — keep the user's in-3D picker choice if they made one (new `userPickedBasemap` flag set in the picker change handler ~:1137-1142), else re-run the init-time basemap resolution so a 2D layer change is reflected; peaks — reset `peaksUnavailable`/bounds key and reschedule; `map.resize()`; then `post('loaded', {navTop: measureNavTop(), camera: …})` + one `'view'` (Unit 5).
- `'destroy'` remains a full teardown; `terrainCache.flush()` still runs on real destroy.
- Memory: one hidden WebGL context ≤5 min per tab — acceptable; no cap changes.

**Tests**: bridge — after `'loaded'` then `'destroy'`, iframe stays in DOM at opacity 0 with a `'suspend'` posted; next `'init'` posts `'resume'` and creates no new iframe; fake-timer TTL expiry destroys + removes; destroy-before-loaded hard-destroys; settings-disable removes immediately. Frame resume via `npm run terrain:verify` (extend showcase: 3D→2D→3D, assert instance reuse and sub-second re-entry). Then `npm run verify:extension` (protocol changed).

---

## Unit 7 — DEM prefetch + preconnect — ⬜ NOT STARTED

**Constraint: CacheStorage is origin-keyed** — the content script's `caches` is peakbagger.com's; only extension-origin contexts share `bpb-mapterhorn-dem-v1`. **Prefetch must run in the background worker.**

**New pure module** `src/terrain-tiles.js` (node-testable, exports `terrainTiles`): slippy math `lonToTileX`/`latToTileY`; `fitZoom(bounds, viewport, {padding:46, maxZoom:15.5})` mirroring the frame's fitBounds for 512-px tiles; `tilesForView({bounds | center+zoom, viewport, cap:32})` → `[{z,x,y}]` covering rectangle at `zt = floor(min(fitZoom, 15.5))` plus the parent-level rectangle at `zt-1` (MapLibre fetches ancestors); if over cap, decrement `zt` and retry; clamp lat to ±85.0511287, no antimeridian wrap (frame already rejects >180° spans).

**Background handler** (`src/background.js` message switch ~:1547): `case 'TERRAIN_PREFETCH'`:
- Peakbagger-tab senders only; read settings and **fail closed unless `enable3dMap === true` and `terrainCacheLimitMb > 0`** (3D enablement is the consent gate for contacting Mapterhorn).
- Validate payload numbers (finite; viewport 100–8192).
- Compute tiles, dedupe against a module-level recently-done/in-flight Set (keyed `z/x/y`, ~10 min expiry), run `cache.load({url: 'bpb-dem://z/x/y.webp'})` concurrency 4, swallow per-tile errors. Lazy module-level `terrainCache.create({limitMb})`, recreated if the limit setting changed. Cap ≈32 tiles ≈ 1.3 MB per burst; LRU trim enforces the byte budget.
- Rate limit: one accepted prefetch per tab per 15 s. Reply `{ok:true, tiles:n}`.
- Build config: add `'terrain-cache.js'` + `'terrain-tiles.js'` to the `background.js` entry (build-config.mjs:39).

**Trigger — toggle hover/focus (explicit intent, stays inside 3D consent scope; NOT on page load)**:
- `src/big-map.js`: `pointerenter`/`focus` on the toggle, when `terrainState === 'idle' && terrainEnabled` and a native route exists → compute route bounds, throttle 15 s, `postTerrain('prefetch', {bounds, viewport:{width:innerWidth, height:innerHeight}})`.
- `src/peak-map.js`: same trigger; payload `{center:[lat,lon], zoom, viewport}` from the already-validated peak values.
- Bridge: new toCS `'prefetch'` case — only when terrain enabled; sanity-check finiteness; forward via `ext.runtime.sendMessage({type:'TERRAIN_PREFETCH', …})`, ignore reply.

**Preconnect**: `<link rel="preconnect" href="https://tiles.mapterhorn.com" crossorigin>` in `terrain/terrain.html` head.

**Docs**: one sentence in `PRIVACY.md` (with 3D enabled, hovering the 3D button may pre-request elevation tiles for the visible area from Mapterhorn); update `docs/architecture.md` terrain section for suspend/resume + prefetch; CHANGELOG per unit.

**Tests**: new `test/terrain-tiles.test.mjs` (known lon/lat→tile values, fitZoom hand-checks, cap behavior, clamping); background handler — gate closed when 3D off or limit 0, tile cap, rate limit, `cache.load` called with `bpb-dem://` URLs (inject `fetchFn`/`cacheStorage` fakes via `terrainCache.create`); coordinator/bridge — hover posts one `'prefetch'`, 15 s throttle respected. Confirm worker→Mapterhorn CORS once in the real `verify:extension` run (prefetch `{ok:true}` + cache-usage increase on the options page).

---

## Cross-cutting

- **Commits**: ~7 focused conventional commits straight to `main` (schema + options row + consumer for one setting = one commit), bodies listing checks actually run (AGENTS.md).
- **Checks**: `npm test` always; `npm run verify:extension` after Units 5–7 and any build-config/manifest change; `npm run terrain:verify` for Units 5–6; visual options-page inspection (Unit 4) and compass/keep-alive in hidden Chrome-for-Testing (hardware renderer, never SwiftShader).
- **Settings discipline**: new keys only in `settings-schema.js`; readers use `!== false`/`=== true` on cleaned settings; `WRITABLE_KEYS` in `src/bridge.js` untouched.
- **Fixtures**: masked identifiers only; fixtures-privacy test must pass.

## Risks / notes

1. Success-page DOM (Unit 1) verified from the user's saved capture (`aid` in the photo link, `#SubTitle` text) but not a committed fixture — selectors are tolerant and degrade to no-op; capture a masked success fixture during implementation.
2. Auto-descending sort rewrites the URL to `sort=ascentdated` (same as a manual click) — deliberate, means copy-pasted URLs carry the sort.
3. Garmin URL form: `/app/activity/<id>` chosen for symmetry with `providerFromUrl`; one pure function to change if preferred.
4. Section title kept as "Ascent beta filter" per the user's wording; contains the sort setting too.
