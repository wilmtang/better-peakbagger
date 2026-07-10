# Better Peakbagger

A browser extension that makes [Peakbagger](https://www.peakbagger.com/) better for trip planning. It works on **Chrome** and **Firefox** (Manifest V3) and needs no userscript manager.

Three things:

1. **GPX Analyzer** — on an ascent page with a GPS track, injects a rich interactive elevation chart (by distance *and* time), adjusted route metrics, timing/camping stats, and a marker that follows your cursor on Peakbagger's own map.
2. **Ascent Beta Filter** — on a peak's "Ascents of a Peak" list, adds a sticky, stackable filter bar so you can narrow hundreds of logged ascents down to the ones with a trip report, GPS track, or link.
3. **Dark mode + centralized settings** — a site-wide dark theme and an options page for units, theme, and the filter's default word threshold, shared across every Peakbagger page.

Everything runs locally. The extension makes no network requests of its own — the GPX Analyzer only fetches the GPX file already linked on the page — and stores settings in `chrome.storage`.

---

## Install

Not yet on the Chrome Web Store / AMO. Load it unpacked:

### Chrome / Edge / Brave
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder (the one with `manifest.json`).

### Firefox
1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Select `manifest.json`.

> Temporary add-ons are cleared on restart. A permanent install needs Mozilla signing (`web-ext sign` / AMO), or a Developer/Nightly build with `xpinstall.signatures.required = false`.

Open the settings from the extension's options (`chrome://extensions` → Details → Extension options, or Firefox's add-on "Preferences").

---

## Table of contents

- [Feature tour](#feature-tour)
- [Architecture at a glance](#architecture-at-a-glance)
- [Deep dive: content-script worlds](#deep-dive-content-script-worlds)
- [Deep dive: the settings system and the bridge](#deep-dive-the-settings-system-and-the-bridge)
- [Deep dive: the GPX Analyzer](#deep-dive-the-gpx-analyzer)
- [Deep dive: the Leaflet map-hover injection](#deep-dive-the-leaflet-map-hover-injection)
- [Deep dive: the Ascent Beta Filter](#deep-dive-the-ascent-beta-filter)
- [Deep dive: site-wide dark mode](#deep-dive-site-wide-dark-mode)
- [Cross-browser notes](#cross-browser-notes)
- [Project layout](#project-layout)
- [Development & packaging](#development--packaging)
- [Privacy](#privacy)
- [License](#license)

---

## Feature tour

### GPX Analyzer
Runs on `climber/ascent.aspx`. When the page has a "Download this GPS track" link, it parses the GPX in-browser and renders a Chart.js chart.

- **Dual-axis charting** — simultaneous **Elevation by Distance** and **Elevation by Time** lines; click a legend entry to isolate one.
- **Interactive tooltips** — elevation, distance, grade, and timestamp for any trackpoint.
- **Map synchronization** — hovering the chart drops a color-coded marker onto Peakbagger's native Leaflet map, in sync with your cursor.
- **Adjusted metrics** — Haversine distance with confirmed-movement de-noising, hysteresis-based elevation gain, windowed grade — to get closer to Garmin/Strava-style totals. Raw-vs-adjusted deltas are shown when they matter.
- **Multi-day + camping** — detects multi-day trips (adds "Day N" labels) and flags overnight camping coordinates.
- **Double-click a point** copies its `lat, lon` to the clipboard.

### Ascent Beta Filter
Runs on `climber/PeakAscents.aspx`. Injects a sticky filter bar above the table.

- **Has beta** (on by default) — only ascents with a trip report, GPS track, *or* link.
- **Trip report** — only ascents with a written report, with an adjustable **≥ N words** threshold.
- **GPS track** / **Link** — only ascents with a GPS track / an external link.
- Filters **stack** (AND), each chip shows its count, and there's a one-click **Show all**. Empty year separators collapse.

### Dark mode & settings
The options page centralizes three preferences in `chrome.storage.sync`:

- **Units** — Auto (match page) / Imperial / Metric.
- **Theme** — Follow system / Light / Dark. Applies to the whole Peakbagger site and the extension's panels.
- **Default minimum trip-report words** — the filter's starting threshold.

Changes apply live to any open Peakbagger tab.

---

## Architecture at a glance

```
                          chrome.storage.sync  ({ units, theme, defaultMinTrWords })
                                   ▲   │  onChanged
                 ┌─────────────────┼───┼──────────────────────────────────────────┐
   options page  │                 │   ▼                                            │
  options.js ────┘        ┌────────┴────────────────┐                              │
                          │  ISOLATED content world  │  (chrome.storage available) │
                          │  settings.js  (shared)   │                             │
                          │  theme.js  → data-bpb-theme on <html>                  │
                          │  bridge.js  ←── postMessage ──┐                        │
                          │  ascent-filter.js             │                        │
                          └───────────────────────────────┼────────────────────────┘
                                                           │  window.postMessage
                          ┌────────────────────────────────┼───────────────────────┐
                          │  MAIN (page) world              ▼                        │
                          │  chart.umd.min.js  +  gpx-analyzer.js                    │
                          │  (needs page globals: map iframe, Chart, clipboard)      │
                          └──────────────────────────────────────────────────────────┘
```

Two ideas do most of the work:

1. **Content scripts run in two different JavaScript "worlds,"** and each feature is placed in the world it needs. The GPX Analyzer must run in the page's own world; everything else runs in the isolated extension world.
2. Because the MAIN-world analyzer can't touch `chrome.storage`, a tiny **bridge** relays settings across the world boundary over `window.postMessage`.

---

## Deep dive: content-script worlds

A browser extension can inject a content script into either of two JavaScript execution contexts on a page:

- **Isolated world** (the default). The script shares the page's *DOM* but gets its **own** `window`/global scope, and it *can* call extension APIs (`chrome.storage`, messaging, …). Crucially, it **cannot see JavaScript variables the page itself defined** — the page's globals live in a separate realm.
- **MAIN world** (`"world": "MAIN"` in the manifest). The script runs in the page's own realm, exactly like a `<script>` tag the site shipped. It **can** read the page's JS globals and shares the page's `window`, but it **cannot** use extension APIs.

This split is the single most important design constraint in the extension. Here's how each piece lands:

| Script | World | Why |
| --- | --- | --- |
| `gpx-analyzer.js` | **MAIN** | Needs page-realm access: the map iframe's Leaflet globals (see below), the bundled `Chart` global, and page clipboard/`localStorage` semantics identical to a userscript. |
| `chart.umd.min.js` | **MAIN** | Loaded immediately before the analyzer so the `Chart` UMD global lands in the same realm the analyzer reads. |
| `theme.js`, `bridge.js`, `ascent-filter.js`, `settings.js` | isolated | They only touch the DOM and `chrome.storage`; no page globals needed. |

A subtle point about **shared scope**: all content scripts from the *same* extension injected into the *same* frame and world share one global scope. That's why listing `["src/settings.js", "src/ascent-filter.js"]` in a single manifest entry lets `ascent-filter.js` use the `window.BPBSettings` object that `settings.js` defined — and why `settings.js` guards with `if (window.BPBSettings) return;`, since a page that matches several manifest entries will inject it more than once into that one shared world.

The heritage here matters: these two features started as Tampermonkey userscripts (`@grant none`, i.e. running in the page's MAIN world). Porting the analyzer to a MAIN-world content script preserves its behavior *exactly*; the map-hover trick below is why "just run it in the isolated world" was never an option.

---

## Deep dive: the settings system and the bridge

Settings live in **`chrome.storage.sync`** under a single key (`bpbSettings`). `sync` means they roam across a signed-in user's browsers; the payload is three fields, far under the quota.

`src/settings.js` is the shared core, loaded into every isolated content script and the options page. It exposes `window.BPBSettings` with:

- `get()` / `set(patch)` — promise-based, with input **sanitisation** (`clean()`), so a corrupt or partial stored object can never crash a consumer; unknown values fall back to defaults (`{ units: 'auto', theme: 'system', defaultMinTrWords: 1 }`).
- `subscribe(cb)` — wraps `chrome.storage.onChanged` so any context is notified when settings change in another (the options page, another tab).
- `resolveTheme(pref)` — turns the `'system'` preference into a concrete `'light' | 'dark'` via `matchMedia('(prefers-color-scheme: dark)')`.

### The bridge

The GPX Analyzer runs in the MAIN world and therefore **cannot** read `chrome.storage` at all. To give it settings, `src/bridge.js` runs in the isolated world on the *same* ascent pages and relays across the boundary using `window.postMessage` — the one channel both worlds share on a single `window`:

```
page (analyzer)  ── { __bpb, dir:'toCS',  kind:'get' | 'set', patch } ──▶  bridge (isolated)
bridge           ── { __bpb, dir:'toPage', settings } ──────────────────▶  page (analyzer)
```

Flow:

1. On load the analyzer posts `{ dir:'toCS', kind:'get' }` and `await`s the first `toPage` reply (with an 800 ms fallback to defaults, so a missing/slow bridge never hangs the chart).
2. The bridge answers `get` by reading storage and posting the settings back.
3. When the user flips the in-chart unit dropdown, the analyzer posts `{ kind:'set', patch:{ units } }`; the bridge writes storage. `storage.onChanged` then fires, the bridge re-broadcasts, and the chart re-renders — so the inline control and the options page edit **one** source of truth.
4. Any external change (options page, another tab) reaches the chart the same way: `onChanged` → bridge push → analyzer re-render.

Every message is validated (`event.source === window`, `event.origin === location.origin`, an `__bpb` tag, and a direction). The data — units, a theme name, a small integer — is non-sensitive, so exposure on the shared `window` is harmless; the checks exist to ignore unrelated page traffic, not to protect secrets.

---

## Deep dive: the GPX Analyzer

### 1. Extraction
The script finds the "Download this GPS track" anchor, `fetch`es the GPX (same-origin, so no host permission needed), and parses it with `DOMParser` into `<trkpt>` nodes → `{ lat, lon, rawEleM, ms }`. Because it parses raw XML on the client, it's fast and private.

### 2. Chronological sort
GPX editors and Peakbagger's own merging can emit track segments out of order (Day 3 before Day 1, reversed tracks). Every trackpoint is sorted by its `<time>` first, so distance and time accumulate chronologically. Points without valid coordinates/elevation are dropped up front.

### 3. Adjusted metrics
Raw GPX totals are noisy. The analyzer applies several client-side corrections to land near Garmin/Strava numbers, with **no external service**:

- **Distance — confirmed movement.** Naively summing Haversine steps inflates distance because a stationary receiver jitters by a few metres. Naively dropping every sub-5 m step *under*-counts dense switchbacks. So steps accumulate into a **pending buffer**; the buffer's full path length is committed only once the anchor-to-current displacement clears **5 m** (`DIST_CONFIRM_M`). This keeps real switchbacks while suppressing standstill drift. A long pause with tiny displacement (`PAUSE_RESET_SECONDS`) resets the anchor so a lunch stop doesn't slowly accrue phantom metres.
- **Bad-jump rejection.** When timestamps exist, a step whose implied speed exceeds `MAX_REASONABLE_SPEED_MPS` (10 m/s) is discarded from the adjusted mileage — GPS teleports don't count.
- **Elevation gain — smoothed hysteresis.** Elevations are first cleaned with a 5-point median then a short distance-window average. Gain is then counted by a small **state machine** (`unknown → rising → falling`) that only banks a climb once it's confirmed by `ELEVATION_GAIN_THRESHOLD_M` (3 m), so minor dips don't reset the climb and flat noise doesn't manufacture gain.
- **Grade.** Computed over a **distance baseline** (`GRADE_WINDOW_M`, with a lookback cap) rather than point-to-point, which tames wild spikes between closely spaced points.
- **Honest labelling.** The panel calls these "Adjusted GPX metrics" and only surfaces the raw-vs-adjusted delta when it's material (≥3 % distance or ≥5 %/100 ft gain).

### 4. Timing, multi-day, camping
`Start` = first chronological point, `Summit` = timestamp of the highest *adjusted* elevation, `Back to car` = last point; `Time to summit` / `Time back` follow. A *relative-day* helper converts each timestamp to local midnight and diffs against the start date; if the trip spans >1 calendar day it prefixes tooltips/axes/stats with `Day N`. **Camping** detection is purely chronological: whenever a point lands on a later calendar day than its predecessor, the *predecessor's* coordinates are the camp for that night. Being chronological (not spatial), it's immune to overnight GPS drift.

### 5. The chart and its interaction quirks
The chart plots two datasets on one shared Y (elevation) with **two X axes** — distance (bottom) and time (top). Three interaction problems were solved deliberately:

- **The jittering problem.** Two datasets on two X scales confuse "which line am I hovering?" and the tooltip flickers between them. Fix: `interaction: { mode: 'nearest', intersect: true, axis: 'xy' }` — proximity is judged in *both* axes at once, giving a stable focus on the physically nearest line.
- **Disappearing focus.** `hitRadius: 40` + `intersect: true` create a 40 px interactive halo around the lines; move outside it and the tooltip and map marker cleanly vanish instead of sticking to the chart edge.
- **Dynamic interaction mode.** A custom legend `onClick` toggles dataset visibility, and when only *one* line remains it switches to `{ mode: 'index', intersect: false }` so you can scrub the X axis from anywhere in the plot's vertical space; re-enabling the second line restores strict `xy` proximity.

Theming is applied per-render: a `PALETTES[light|dark]` object (resolved from the current theme) colors the panel (inline styles) and the chart (`scales.*.ticks/grid/title.color`, legend label color). Because the analyzer paints its own panel with inline styles, the site-wide dark stylesheet deliberately leaves it alone — the analyzer is the single owner of its own colors and re-themes live on a settings push.

---

## Deep dive: the Leaflet map-hover injection

This is the feature that forces the whole MAIN-world design, and the most fragile thing in the extension — documented here in full because it depends on Peakbagger internals we don't control.

**The goal:** as your cursor moves along the 2-D elevation chart, a dot glides along the *actual geographic route* on Peakbagger's topo map, so you can see *where* on the mountain a given grade or elevation happens.

Peakbagger renders that map inside an `<iframe src="…/MasterMap.aspx">`. Inside that iframe, Peakbagger's own scripts create a [Leaflet](https://leafletjs.com/) map and — usefully for us — leave two values as globals on the iframe's `window`:

- `mapsPlaceholder` — the Leaflet map instance.
- `L` — the Leaflet library itself.

The injection works in three steps, inside Chart.js's `onHover` callback:

1. **Iframe interception.** Find the map iframe and grab its `contentWindow`:
   ```js
   const mapIframe = document.querySelector('iframe[src*="MasterMap.aspx"], iframe[src*="mastermap.aspx"]');
   const iframeWin = mapIframe && mapIframe.contentWindow;
   ```
   This only works because the analyzer runs in the **MAIN world**. An isolated content script can reach a same-origin iframe's *DOM*, but **not** the JavaScript globals (`mapsPlaceholder`, `L`) the iframe's own scripts defined — those live in that frame's page realm. Reading them requires being in the page realm ourselves. *This is the concrete reason the analyzer is a MAIN-world script.* (The iframe is same-origin — both are `peakbagger.com` — so the cross-frame property access is permitted; a cross-origin iframe would throw.)

2. **Leaflet hooking.** The hovered chart point carries the original `{ lat, lon }` (stashed on each datum as `_raw`). Using the iframe's `L` and map instance, the analyzer creates or moves a high-visibility `L.circleMarker` on the real map — red when hovering the distance line, blue for the time line:
   ```js
   const L = iframeWin.L, map = iframeWin.mapsPlaceholder;
   hoverMarker = L.circleMarker([d.lat, d.lon], { radius: 9, color: '#fff', fillColor, weight: 2, fillOpacity: 1 }).addTo(map);
   // subsequent hovers just: hoverMarker.setLatLng([d.lat, d.lon])
   ```
   The marker is recreated if it no longer belongs to the current map instance (the iframe can reload underneath us).

3. **Real-time sync.** `onHover` fires continuously, so `setLatLng` moves the dot in lockstep with the cursor. When the cursor leaves the 40 px hit halo, `activeElements` is empty and the marker is faded to `opacity: 0`.

**Why it's fragile, and how it fails.** `mapsPlaceholder` and `L` are undocumented Peakbagger internals. If Peakbagger renames them, restructures the iframe, or changes origin, the guard `iframeWin && iframeWin.mapsPlaceholder && iframeWin.L` simply goes false and the marker is skipped. **The failure is closed**: the chart, tooltips, and every other feature keep working; you just lose the moving dot. No exception, no console spam. That's the intended contract for a feature built on someone else's private globals.

---

## Deep dive: the Ascent Beta Filter

Runs in the isolated world on `PeakAscents.aspx`.

- **Column resolution.** Peakbagger renders a *different* column set per URL variant (all-years vs. single-year vs. metric), so the script never assumes fixed positions — it resolves the TR-Words / GPS / Link columns from the header row's text on every load. Cells that "look empty" can contain a literal `&nbsp;` (` `), which the parser normalises before testing.
- **The data model.** Each data row becomes `{ words, gps, link, beta }` where `beta = words > 0 || gps || link`. Year-separator rows (single-cell) are tracked as sections so they can be hidden when empty.
- **Stackable AND filters.** Each chip is an independent predicate; a row is visible only if it passes *every* active chip. Toggling recomputes visibility, updates the live "Showing x of y" count, hides now-empty year headers, and reveals a **Show all** escape hatch.
- **State split.** Chip on/off states persist in the page's `localStorage` (`pbAscentBetaFilter.v1`) — lightweight, per-visit UI state. The **word threshold**, by contrast, lives in the shared `chrome.storage` settings (`defaultMinTrWords`), so the inline `≥ N words` input and the options page edit the same value; a `subscribe` keeps the input in sync if it changes elsewhere.
- **Compact view.** The default `PeakAscents.aspx?pid=…` view (no `y=`) only has Climber + Date columns — nothing to filter. There the bar degrades to a one-click link to the full "all years, full details" view (`y=9999`), preserving the existing `sort`/unit params.

---

## Deep dive: site-wide dark mode

Dark mode is delivered by a **static stylesheet plus an attribute toggle**, which is fast and predictable:

- `src/site-dark.css` is injected on **every** Peakbagger page via the manifest, but every rule is scoped under `html[data-bpb-theme="dark"]`, so it's **inert** until that attribute exists.
- `src/theme.js` (isolated, `document_start`) reads the theme setting, resolves `'system'` via `matchMedia`, and sets `data-bpb-theme="dark"` or `"light"` on `<html>`. It also re-applies on `storage.onChanged` and on OS light/dark changes (while following the system).

The dark palette is derived from Peakbagger's native `pb.css` (navy links, purple visited, maroon `h1`, navy `h2`, `table.gray` borders, the `mewallp.gif` body wallpaper) and maps each to a readable dark equivalent, plus higher-specificity overrides for the filter bar (`html[data-bpb-theme="dark"] #pbaf-bar …`, which outrank the bar's own `#pbaf-bar` rules). **Images and the map iframe are left untouched** so photos and topo maps render normally (the theme script uses `all_frames: false`, so it never darkens the map iframe).

Trade-offs, stated honestly:

- **Flash of native page.** `chrome.storage` is async, so there's a brief moment at `document_start` before the attribute lands where the page shows its native light theme. Eliminating it entirely would require synchronous storage the platform doesn't offer.
- **Coverage.** Peakbagger is a large, old-school site; the stylesheet targets the common structural elements (body, tables, links, headings, form controls, legacy `bgcolor` cells). A rarely-visited page may show a stray light element — file it and it's a one-line addition.
- **Stacking with other dark extensions.** If you also run a global dark-mode extension (e.g. Dark Reader), whitelist Peakbagger there so the two don't double up.

The options page themes itself with the same `data-bpb-theme` mechanism (CSS variables under `:root[data-bpb-theme="dark"]`).

---

## Cross-browser notes

- **Manifest V3** for both engines. Content-script-only design (no background service worker needed).
- **`"world": "MAIN"`** for the analyzer requires **Chrome 111+** and **Firefox 128+**.
- **`browser_specific_settings.gecko`** provides the Firefox add-on `id`, `strict_min_version: "140.0"`, and `data_collection_permissions: { required: ["none"] }` (declaring the extension collects no data — a newer AMO requirement, which sets the practical Firefox floor at 140).
- **Storage promises.** `chrome.storage.*` returns promises in MV3 on both engines; `settings.js` also prefers `browser.*` when present, so it's native on Firefox and works via the `chrome.*` alias on Chromium.
- **Match patterns.** `*://*.peakbagger.com/*` covers `www` and the bare host; the ascent/peak-ascent entries list both `ascent.aspx` and `Ascent.aspx` casings since match-pattern paths are case-sensitive.
- **No remote code.** [Chart.js](https://www.chartjs.org/) 4.5.1 is vendored at `vendor/chart.umd.min.js` (MIT) rather than pulled from a CDN — required by MV3, and better for privacy and reliability.

---

## Project layout

```
manifest.json            MV3 manifest (permissions, options_ui, content scripts)
options/
  options.html           settings UI
  options.css            themed via data-bpb-theme + CSS variables
  options.js             load/save + self-theming
src/
  settings.js            shared chrome.storage core (window.BPBSettings)
  theme.js               site-wide theme applier → data-bpb-theme on <html>
  site-dark.css          dark rules, scoped under html[data-bpb-theme="dark"]
  bridge.js              relays settings to the MAIN-world analyzer (postMessage)
  gpx-analyzer.js        elevation/time chart + map-hover (MAIN world)
  ascent-filter.js       ascent-list filter bar (isolated world)
vendor/
  chart.umd.min.js       Chart.js 4.5.1, bundled (MIT)
icons/                   16/32/48/128 px
```

Settings shape (`chrome.storage.sync`, key `bpbSettings`):
```js
{ units: 'auto' | 'imperial' | 'metric',
  theme: 'system' | 'light' | 'dark',
  defaultMinTrWords: number }
```

---

## Development & packaging

```
npm run lint            web-ext lint (0 errors expected)
npm run build           zip to web-ext-artifacts/ for Chrome Web Store / AMO
npm run start:firefox   launch a temp Firefox with the extension
npm run start:chromium  same for Chromium
```

No build step for development — load the folder unpacked. `npm run build` just zips the shippable files (`manifest.json`, `src/`, `vendor/`, `icons/`, `options/`, README, LICENSE); `node_modules`, the lockfile, and `CHANGELOG.md` are excluded.

---

## Privacy

No analytics, no network requests of the extension's own. The GPX Analyzer only fetches the GPX already linked on the ascent page. Preferences live in `chrome.storage.sync` (or your browser's `localStorage` for the filter's chip states) and never leave your browser except via your own browser-sync account.

## License

[AGPL-3.0-or-later](LICENSE). Chart.js is under the MIT License.
