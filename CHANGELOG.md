# Changelog

## Unreleased

- **Clearer 3D map gestures.** The 3D terrain view now shows an always-visible,
  OS-aware hint — *"Drag to pan · ⌘/Ctrl + scroll to zoom · right-drag to
  tilt"* — so the modifier needed to zoom (kept so the page doesn't
  scroll-jack) is discoverable. MapLibre's momentary full-surface overlay is
  suppressed in favor of the persistent hint. Consistent in Chrome and Firefox.
- **Switch the 3D drape from inside the view.** The 3D terrain view now has an
  on-map layer picker mirroring the 2D basemap menu — CalTopo, MyTopo, CalTopo
  USFS, ArcGIS World Topo / Imagery / Gray Canvas, OpenTopoMap, and OpenStreetMap
  — so you can change the draped texture without dropping back to 2D. (Peakbagger
  builds each basemap on demand with no reusable handle, so the picker offers the
  well-known layers that render as CORS-clean tiles MapLibre can sample; WMS,
  contour, and Google/Bing layers stay 2D-only, and your currently selected
  national basemap still drapes when supported.) A layer the tile provider blocks
  by CORS is detected, disabled in the picker with a short explanation, and the
  view falls back to terrain-only. The redundant "Loading 3D terrain…" banner is
  also gone — the button's own loading state is the single cue.
- **Faster 3D terrain loads.** Opening the 3D view now frames the camera on your
  route as the map is created, instead of starting on a wide placeholder view and
  re-framing only after loading — which previously fetched a throwaway tileset
  and built the terrain mesh twice for a view you never saw. The bulk of the
  load-time cost is gone; opening 3D is noticeably quicker, most visibly on
  repeat views whose DEM tiles are already cached.
- **Full Screen maps get the route casing.** Full Screen GPS maps
  (`BigMap.aspx`) now draw the configured white casing behind each native
  track and apply the configured width, matching the embedded ascent map.
  Single-ascent maps (`t=A`) also take the configured route color; group maps
  (`t=G`) keep Peakbagger's per-climber track colors. The casing is a
  non-interactive underlay, so native hover, clicks, and trip-report popups are
  untouched.
- **Snow and wildfire planning links.** Peak pages now add a NOAA NOHRSC
  modeled snow-depth map framed on the summit, and an AirNow Fire and Smoke
  Map centered nearby. Each link appears only where the service covers the
  peak's nation — snow depth in the contiguous U.S. and Alaska, fire and smoke
  across the United States, Canada, and Mexico — read from Peakbagger's own
  "Nation" row and omitted otherwise.
- **Chart times in the climb's local timezone.** The GPX analyzer's clock
  times, `Day N` boundaries, and camping-spot days now use the mountain's
  local time instead of the viewer's. The track's starting coordinate is
  resolved to an IANA timezone by a bundled offline lookup — no coordinates
  leave the page — and the stats bar names the zone: *"Times in the
  mountain's local time (PDT)"*. If the lookup fails, times fall back to a
  labelled solar-time estimate from the start longitude. See
  [docs/mountain-local-time.md](docs/mountain-local-time.md).
- **Capture follows the tab.** Starting a capture right after navigating the
  same tab to a different Garmin or Strava activity no longer returns the
  previous activity's results while the earlier capture is still finishing.
- **Keyboard map resizing can no longer exhaust settings sync.** Arrow-key
  resizing applies immediately but saves once, shortly after the last
  keystroke, instead of writing to synchronized storage on every key repeat.
- **Sort clicks are never lost.** If the ascent-list enhancement fails to
  initialize, header sort clicks fall back to Peakbagger's native navigation
  instead of being silently swallowed.
- **Clearer GPX download failures.** An ascent page whose GPS-track download
  returns an HTTP error now reports that status instead of the misleading
  "No track points found."
- **One-click 3D terrain.** The redundant per-map privacy confirmation is gone:
  after the experimental feature is enabled, choosing **3D terrain** loads the
  view immediately. The General setting now carries the complete Mapterhorn,
  selected-provider, viewed-area, and request-metadata disclosure.
- **Tighter page-world settings bridge.** Page scripts can write only the six
  GPX-analyzer-owned settings keys; feature gates, capture privacy options,
  and the theme remain writable solely from extension-owned surfaces.
- **Internals.** The pure GPX metrics pipeline moved to `src/gpx-metrics.js`
  and is shared with the background capture core, so drafted and displayed
  distance/gain math cannot diverge; analyzer UI text is built with DOM nodes
  instead of dynamic `innerHTML`.

## 2.0.0 — 2026-07-14

- **Experimental 3D terrain maps.** An off-by-default General setting adds an
  explicit 3D terrain choice to ascent maps. The route is rendered in an
  extension-owned MapLibre frame, with a compatible selected Peakbagger map
  draped over the terrain when its provider supports cross-origin WebGL tiles.
  Loading 3D sends elevation-tile coordinates for the viewed area to
  Mapterhorn, a third-party DEM service, and may send map-tile requests to the
  selected map provider; no 3D request occurs until the user enables the
  experiment and chooses **3D terrain**.
- **Bounded terrain caching.** Successful Mapterhorn DEM tiles use a dedicated,
  best-effort on-device cache with a 512 MB default and a configurable
  0–2,048 MB limit. Settings shows the current cache size and hides the cache
  controls while experimental 3D maps are disabled. Browser eviction, quota
  pressure, and corrupt entries safely fall back to the network.
- **Peak planning links.** Peak pages now provide restrained shortcuts to Windy
  weather and Copernicus satellite imagery for the displayed coordinates,
  while malformed or ambiguous coordinates fail closed.
- **Native Full Screen GPS tracks preserved.** Full Screen Maps keep
  Peakbagger's original route colors, hover highlights, click details, and
  multi-track behavior while applying the configured route width.
- **No flash on dark Settings pages.** The options page now applies its cached
  theme synchronously before its stylesheet loads, then reconciles with the
  authoritative synchronized setting.
- **Capture details, under user control.** New Activity capture settings can
  retain GPX waypoint coordinates and names (on by default), create and
  sequence Peakbagger Trip Info for multiple selected summits, and fill
  wilderness nights for an overnight single-ascent capture. Waypoints share
  Peakbagger's 3,000-point limit with the reduced track; all other waypoint
  fields remain excluded.
- **Clearer Settings organization.** Preferences are now grouped into General,
  Activity capture, Map & GPX chart, and Ascent beta filters so each control is
  discoverable by the surface it affects.
- **Map-first GPX layout.** The elevation chart now sits directly below the
  ascent map and its waypoint legend, before Peakbagger's full-screen map link,
  GPS-track warning, and GPX download link.
- **Optional map-layer memory.** A new off-by-default setting remembers the
  last layer chosen in Peakbagger's native map control and restores it on later
  ascent maps. Unknown or unavailable layer IDs fail closed to the site default,
  and disabling the preference forgets the saved layer.
- **Resizable GPX maps.** Ascent maps preserve Peakbagger's original 450 × 450
  px size by default and can be resized from a keyboard-accessible lower-right
  grip up to the full parent width. Width and height are bounded, saved across
  ascent pages, editable in Settings, and resettable to the original size.
  Leaflet is notified after each resize so tiles and overlays reflow correctly.
- **More visible GPX routes.** The ascent-page analyzer now draws a configurable
  route and wider casing, defaulting to 5 px red over 9 px white. Colors are
  available beside the chart and all four appearance values are in Settings.
  The non-interactive, extension-owned layers preserve GPX segment breaks,
  remain behind Peakbagger's native route and markers, and are recreated after
  map-iframe reloads. Unsupported or pathological tracks leave the native map
  unchanged.
- **Correct same-day ascent suffixes.** Draft filling no longer writes encounter
  time into Peakbagger's suffix field. Only selected summits sharing an ascent
  date receive `a`, `b`, … in track-encounter order; singleton dates remain
  blank, and suffixes stay stable even though draft tabs open by confidence.

## 1.4.0 — 2026-07-13

- **Garmin/Strava activity capture.** Clicking the toolbar icon on an owned
  activity verifies the signed-in viewer against the activity author and an
  owner-only edit control before the GPX export is accessed.
- **Confidence-ranked Peakbagger drafts.** Full-resolution, segment-aware
  analysis detects Strong and Probable summit encounters; Possible and Weak
  candidates stay hidden. Strong matches start selected and Probable matches
  remain opt-in.
- **Private GPX Preview workflow.** Draft tabs are grouped as “Peak Drafts,”
  prefilled, and sent through Peakbagger's Preview step without ever clicking
  Save. The uploaded GPX contains only reduced latitude/longitude trackpoints,
  with health, device, time, elevation, waypoint, route, and extension data
  removed.

## 1.3.0 — 2026-07-10

- **Test fixtures: real (masked) captures replace the Wayback ones.** The
  `pid=2296` Mount Rainier PeakAscents fixtures and the home page are now saved
  from the live site instead of the Wayback Machine, and four new whole-page
  fixtures were added (two peak pages, a climber home page, a climber ascent
  list). Every capture came from a signed-in session, so all of the account
  holder's identity is masked: real name → a pseudonym, real climber/ascent ids
  → fakes, and external social links (Strava/Instagram/etc.) → placeholders,
  with the personal pages fully genericized (peaks, dates, ranges). New
  `test/fixtures-privacy.test.mjs` fails the build if a raw identifier reappears
  (the banned identifiers are stored only as salted hashes, so the guard itself
  discloses nothing). Golden chip counts updated for the larger (~4,145-row)
  Rainier capture; the smaller peak fixtures (21500/8241/1039) stay as Wayback
  captures.
- **Test fixtures are self-contained.** Every fixture's `pb.css` stylesheet
  `<link>` is replaced with an inline `<style>` block (from a Wayback `id_`
  capture of `pb.css`), and dead MHTML `cid:` stylesheet links are dropped, so
  fixtures render and test without referencing the live site.
- **GPX chart: default-series setting.** New options-page control chooses which
  elevation curve the ascent-page chart shows on load — both, distance only, or
  time only (`chartDefaultSeries`, default both). Only the *initial* visibility
  is bound to the setting: the chart legend still toggles either series for the
  current view, and that peek no longer persists, so it can't quietly change the
  preference. Applies live to open ascent tabs.
- **Dark mode: self-healing stylesheet injection.** `data-bpb-theme` was set
  unconditionally, but the dark stylesheet was injected once and gated on
  `window.BPBDarkCSS` — so any timing where that one-shot was skipped left the
  attribute set with no sheet, which renders the self-themed GPX chart dark on
  an otherwise-light page (the reported "dark only in the chart on Chrome";
  reproducible when an unpacked build is reloaded with Peakbagger tabs open).
  `src/theme.js` now injects the sheet through an idempotent `ensureSheet()`
  tied to every `apply()`, so the authoritative settings read and every live
  toggle re-assert the sheet — the attribute can no longer exist without it. New
  `test/theme-inject.test.mjs` locks in the invariant.
- **Instant date sort: both directions clickable, and no premature reload.**
  The active-direction header link is no longer made inert — both "Ascent Date"
  and "[sort desc]" stay live, clickable links at all times (the active one is
  marked with the ▲/▼ arrow and bold, not disabled), so either order is always
  one click away. Separately, the sorter now wires up synchronously *before* the
  awaited settings read, and a capture-phase click guard installed at
  `document_start` holds any header sort-link click made during page load — on a
  ~4,000-row list the header is clickable long before the filter bar appears —
  and replays it in the DOM instead of letting it fire a full server reload. The
  guard keys on the row set, so year-jump / metric-toggle links (different
  `y=`/`u=`) are left to navigate normally. The ascent-list content script now
  runs at `document_start` (deferring its DOM work to `DOMContentLoaded`).
- **Removed the "Default minimum trip-report words" setting** from the options
  page. It duplicated the ascent list's inline `≥ N words` control while adding
  a second place to keep in sync, for little benefit. The Trip report chip's
  threshold now persists on its own in the page's `localStorage` (alongside the
  chip on/off states), so it is still remembered across visits — just edited in
  one place. The `defaultMinTrWords` field is gone from `chrome.storage`; the
  configurable "Has beta" definition (with its own `betaTrMinWords`) is
  unchanged.

## 1.2.1 — 2026-07-10

Dark mode polish: kill the flash for good, fix the washed-out header, and guard
contrast with a test.

- **Dark mode flash, finished.** 1.2.0 made the `data-bpb-theme` attribute
  land synchronously, but the dark stylesheet itself was still injected through
  the manifest `content_scripts.css` array — a separate renderer channel that
  doesn't reliably apply before first paint (Brave, cache-served loads), so the
  flash persisted. `src/theme.js` now injects the sheet from JS as a `<style>`
  in `<html>` at `document_start`, in the same synchronous tick that sets the
  attribute — the approach Dark Reader uses. The rules moved from
  `src/site-dark.css` (removed) to `src/site-dark-css.js` as `window.BPBDarkCSS`;
  the manifest no longer uses a `css` entry. Details in
  `docs/dark-mode-flash.md`.
- **Legible header banner.** The site header sits on the (light) `header.jpg`
  photo with its title + nav links set to inline `color:black`. The theme's
  global `a { color: … }` was overriding that black with the light-on-dark link
  color, washing the links out over the photo. `.mainbanner a` / `.mainmenu a`
  are now re-darkened to `#000`.
- **WCAG AA contrast guard.** New `test/dark-contrast.test.mjs` parses the
  shipped dark stylesheet and asserts every text/background pair meets WCAG 2.1
  AA (4.5:1 normal, 3:1 large), grounded against the captured fixtures. Fixing
  the pre-existing failures nudged a few muted colors lighter (placeholder,
  filter label/count) — no visible change, now compliant. Added a home-page
  capture (`test/fixtures/pages/home-default.html`) so the header is covered.

## 1.2.0 — 2026-07-10

Instant date sorting, a user-defined "has beta", and a dark mode fix.

- **Instant Ascent Date sort** on the ascent list: the header's
  `Ascent Date` / `[sort desc]` links now reorder the table in the DOM
  (milliseconds, no page reload). Implemented as a reversal of the served
  order — sections and rows within sections — so `Unknown`/malformed dates
  keep their backend ordering. The URL is rewritten via
  `history.replaceState` so reload/share reproduce the view, and a ▲/▼
  arrow now marks the active sort direction (the site never showed one).
  Views where the links would change the row set (non-date sorts, the
  default "Most Recent Year" page) still navigate normally.
- **Configurable "Has beta"**: new options-page group choosing which
  signals the chip counts — trip report with **≥ N words** (its own
  threshold, separate from the Trip report chip's), GPS track, external
  link. Defaults match the old hardcoded rule; at least one signal must
  stay checked. Changes apply live to open tabs (count and tooltip
  included).
- **Test infrastructure**: raw `PeakAscents.aspx` fixtures captured from
  the Wayback Machine (`test/fixtures/peakascents/`, provenance in its
  README) and a jsdom harness (`npm test`) running the real content
  scripts against them — no live-site access needed for development.
- **Fixed the flash of the light page on load with dark mode enabled**
  (most visible in Brave). `src/theme.js` now mirrors the theme preference
  into page `localStorage` and applies it synchronously at `document_start`,
  before first paint, instead of waiting for the async `chrome.storage` read
  (which stays authoritative and reconciles afterwards). Details in
  `docs/dark-mode-flash.md`.

## 1.1.0 — 2026-07-09

Site-wide dark mode and a centralized settings page.

- **Options page** (`options/`) backed by `chrome.storage.sync`: units
  (auto / imperial / metric), theme (follow system / light / dark), and the
  ascent filter's default minimum trip-report words. Changes apply live to open
  Peakbagger tabs.
- **Dark mode** across all of Peakbagger via `src/theme.js` (sets
  `data-bpb-theme` on `<html>`) and `src/site-dark.css` (dark rules scoped under
  that attribute, injected but inert until enabled). The GPX chart and filter
  bar theme themselves to match.
- **Settings bridge** (`src/bridge.js`): the MAIN-world GPX analyzer can't read
  `chrome.storage`, so it exchanges settings with the isolated world over
  `window.postMessage`. Units and theme now come from the shared settings; the
  in-chart unit dropdown and the filter's word input write back to the same
  store instead of page `localStorage`.
- The in-chart unit dropdown and the filter word threshold are now centralized
  (chip on/off states still persist per-visit in `localStorage`).
- Expanded the README into an architecture deep-dive (content-script worlds, the
  bridge, GPX metrics, the Leaflet map-hover injection, dark mode).

## 1.0.0 — 2026-07-09

Initial release as a standalone Chrome + Firefox extension (Manifest V3).

Migrated from two Tampermonkey userscripts, previously maintained in
`wilmtang/tampermonkey-scripts`:

- **Peakbagger GPX Analyzer** (was v13.13) → `src/gpx-analyzer.js`, running in
  the page's main world with Chart.js 4.5.1 now vendored locally instead of
  pulled from a CDN.
- **Peakbagger Ascent Beta Filter** (was v0.1.0) → `src/ascent-filter.js`,
  running as an isolated content script.

Feature behavior is unchanged from the userscripts. Because both features read
and write the same page-origin `localStorage` keys (`pb_gpx_unit_pref`,
`pbAscentBetaFilter.v1`), existing preferences carry over seamlessly for anyone
switching from the userscripts to the extension.
