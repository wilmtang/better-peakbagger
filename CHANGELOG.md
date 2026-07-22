# Changelog
## Unreleased

- **Organize source and tests by ownership.** Runtime modules now live in named
  domain directories under `src/`, with matching test directories under
  `test/`; build configuration, imports, safety scans, and maintained
  documentation follow the same structure. Shipped `dist/` paths and extension
  behavior are unchanged.

- **Keep settings navigation responsive with large favorite lists.** Sidebar
  links still animate nearby moves, but long jumps now land immediately instead
  of scrolling through hundreds or thousands of climber rows.

- **See when an individual ascent is already backed up.** On an owned saved
  ascent, the GitHub control now checks the connected repository in the
  background and shows **Backed up ✓** when the structured ascent, report, and
  stored GPX still match. A changed or absent copy keeps the normal backup
  action, and the check never runs when ascent backup is disabled or GitHub is
  not connected.

- **Filter ascent beta by favorite climbers.** The full Peak Ascents view now
  has a Favorites chip that combines with Trip report, GPS track, Link, and Has
  beta. It works immediately from the signed-in user's Buddy List, keeps an
  owner-scoped local cache fresh without blocking the table, and can instead use
  a device-local custom list of up to 1,500 climbers. Settings makes that local
  storage boundary explicit and can add, sort, merge, mirror, remove, and Undo
  custom favorites; public climber pages get a compact add/remove control only
  in custom mode. A shared GitHub connection can explicitly write
  or restore the custom list as `favorites.json` even when ascent backup is off,
  with a link to the successful backup commit; automatic ascent backup never
  touches it.
  
## 3.0.0 — 2026-07-20

- **Manage every trip-report draft in one place.** A new **TR drafts**
  section in Settings lists the reports autosaved on this device, newest first,
  with their ascent, save time, format, expiry, and a short preview. You can open
  the matching Peakbagger form, copy the report as Markdown, or delete one or all
  drafts with a brief Undo window. Quiet **Manage TR drafts** links beside the
  report editor and in its draft-recovery banner open the manager directly,
  landing on the section without scrolling through unrelated settings first.
  Existing drafts without ascent labels remain available under an ID-based
  fallback name.

- **Warm 3D terrain before you open it.** With 3D enabled, hovering or focusing
  the 3D button now quietly pre-requests the elevation tiles for the view, so
  the map opens from cache instead of waiting on the network. The pre-request is
  bounded, rate-limited, and only ever fires from that deliberate interaction —
  never merely because a map page loaded — and only while 3D is on.

- **Make returning to 3D near-instant.** Leaving a 3D map now parks its renderer
  in the background for a few minutes instead of tearing it down, so switching
  2D→3D→2D→3D resumes in a frame rather than rebuilding MapLibre and its terrain
  worker each time. The renderer is fully released after five minutes of not
  being used, or immediately if you turn 3D maps off. Switching between 2D and
  3D also preserves the live map center and zoom instead of reframing the route.

- **Add a compass to 3D maps.** A Google-Maps-style compass now floats just
  above the 3D button whenever a 3D terrain view is open. It tilts and rotates
  with the camera, and clicking it snaps the view back to north-up looking
  straight down. It respects reduced-motion and is not shown on the 2D map.

- **Reorganize the settings page into two-level sections.** The options page
  now groups related settings under always-visible sub-sections — Activity
  creation splits into *GPX capture* and *Trip report editor*; Map & GPX chart
  into *GPX chart* and *Map* — with a matching two-level sidebar. Units stay
  with the chart they govern, and the trip-report controls move beside the rest
  of activity creation. Existing deep links (#general, #capture, #map-chart,
  #beta, #github) still work.

- **Open ascent lists newest-first (optional).** A new **Newest ascents first**
  toggle in Ascent beta filters (off by default) flips a default oldest-first
  ascent list to descending as soon as it loads, using the same instant reorder
  a header click does. An explicit sort in the URL, or a column you click,
  always wins.

- **Carry the captured activity link into the trip-report field.** When you
  capture a Garmin or Strava activity, its link now lands in Peakbagger's "URL
  Link to External Trip Report" field on the draft — only when that field is
  empty, so a link you typed is never overwritten. The link is rebuilt from the
  activity id, never a stored raw tab URL. A new **External trip report link**
  toggle in Activity capture (on by default) controls it.

- **Make activity capture easier to control and more complete.** You can cancel
  an in-progress Garmin or Strava capture and immediately discard its temporary
  job, even if provider or summit requests finish later. Multi-day captures can
  now fill Peakbagger's per-day distance, gain, loss, high point, and camp rows,
  controlled by a new default-on **Ascent details** setting. Track analysis also
  preserves missing elevations as unknown instead of inventing zero-height
  points, and recognizes camping on summit-first tracks.

- **Link straight to a freshly saved ascent.** After Peakbagger confirms an
  ascent was added or saved, the success page now offers a **View the New
  Ascent** link next to "Go Back to Referring Page" — previously the new ascent
  was reachable only by hunting through the photo link's id.

- **Pipeline full-profile backups into atomic GitHub batches.** The My Ascents
  reader now continues while GitHub commits the previous group, batching up to
  ten ascents into one tree, commit, and branch update. A bounded 30-ascent /
  32 MiB in-tab buffer applies backpressure during slow uploads, ordinary files
  ride directly in the tree request, and every extension-owned GitHub writer is
  serialized before it reads the branch. Failed batches stay ready for Resume
  without another Peakbagger fetch. See the
  [GitHub backup deep dive](docs/github-ascent-backup.md#full-profile-producer-consumer-pipeline).

- **Initialize empty GitHub backup repositories correctly.** The first backup
  now creates the repository marker and default branch through GitHub's
  supported Contents API before committing the ascent atomically. Brand-new
  repositories no longer retry an unsupported ref creation for every ascent.

- **Pause profile backups on GitHub errors.** A full-profile run shows the
  actionable error immediately and retains the rejected batch for Resume
  instead of counting it as a series of ascent failures. Brief repository
  conflicts get bounded, delayed retries first so GitHub propagation windows
  do not require manual intervention.

- **Keep profile backup folder names descriptive.** The verified My Ascents
  list now supplies the peak name and any omitted full date when Peakbagger's
  fetched edit form leaves those display fields empty, avoiding generic
  `undated-peak-a…` folders when better metadata is available.

- **Process an uploaded GPX on the ascent form.** Peakbagger's own Add Ascent
  page now understands a plain GPX file: a fresh form gets today's date filled
  in, and choosing a `.gpx` in the native GPS Track field swaps Preview for a
  one-click **✦ Process** button. Processing parses the file on the page (the
  raw XML never leaves it), resolves the climb's timezone offline from the
  track's start, finds summits along the corridor in Peakbagger's database,
  and fills the form with the same derived values activity capture computes —
  attaching a privacy-reduced ≤3,000-point copy of the track (large files stop
  hitting Peakbagger's point limit) and running GPS Preview exactly once.
  Multi-peak traverses get a summit picker that can open the other ascents as
  prepared draft tabs with capture's date-suffix and Trip Info coordination; a
  bound peak the track only brushes is offered as an explicit
  closest-approach "use anyway" choice. Review and Save stay manual.

- **Back up ascents to GitHub.** An opt-in feature that saves each ascent to a
  GitHub repository you control. Turn it on in Settings and connect once via
  GitHub's device flow (only the app's public client id ships — no secret, no
  token to paste), then pick a single repository on GitHub's own installation
  page. After you save an ascent, a **Back up to GitHub** button on the ascent
  page commits one folder per ascent — the trip report as real Markdown, every
  entered field as versioned `ascent.json`, and Peakbagger's stored GPS track —
  as a single atomic Git Data commit; re-saving re-syncs the same folder even
  if the date or peak changed. An optional "back up automatically after each
  save" mode does the same without the click. The backup is strictly read-only
  toward Peakbagger and never clicks a Save control; the access token lives only
  in local extension storage, never synced, and never reaches a web page. The
  optional `github.com` / `api.github.com` host permissions are requested only
  when the feature is enabled. See
  [github-ascent-backup.md](docs/github-ascent-backup.md).

- **Trip-report editor rebuilt on established editors.** Rich text mode now
  runs on TipTap (ProseMirror) with a schema locked to the supported
  Peakbagger tags: live toolbar states, undo/redo, markdown-style typing
  shortcuts (`**bold**`, `# `, `1. `), table insertion with contextual
  row/column controls, an image popover, and a "more formats" panel for
  inline code, highlight, sub/superscript, small, inline quote, and text
  color. Markdown mode is now a CodeMirror source pane with GFM syntax
  highlighting beside a live preview — no more Write/Preview tabs — with
  synced scrolling, stacking vertically on narrow windows. Everything still
  converts through the same allowlisted model to Peakbagger's square-bracket
  format, and the preview remains the extension's own rendering of exactly
  what will be saved.

- **Expand trip-report media without weakening the editor boundary.** Rich
  reports can resize images and direct videos, understand Obsidian-style image
  dimensions, and embed trusted YouTube links. The conversion path preserves
  playable media, hex colors, table-cell line breaks, and portable HTML in
  Markdown reports while continuing to reject unsafe or unsupported markup.
  An optional setting can add a small Better Peakbagger credit to reports.

- **Polish the extension's first-use and settings surfaces.** The toolbar popup
  now shows a useful welcome state when no capture has started, and Settings has
  an About section with the installed version and project/support links.

- **ES-module build and development workflow.** Runtime source now uses ES
  imports and esbuild produces the unpacked `dist/` extension; browser vendor
  libraries come from locked npm dependencies instead of committed copies.
  Tests exercise built bundles and release archives package `dist/`. The
  Chromium and Firefox development commands now rebuild continuously and reload
  the extension only after every bundle and copied asset succeeds; Firefox
  mirrors that complete build into its inline-Preferences source first. The new
  [development guide](docs/development.md) documents the browser loop, page
  refresh boundary, verification, dependency, and release workflows.

## 2.2.0 — 2026-07-17

- **3D terrain on peak pages.** The 3D terrain toggle is now available on individual peak maps (`Peak.aspx`), joining ascent maps and Full Screen maps.
- **Activity capture enhancements.** GPX drafts now preserve elevation and timestamps. Added support for coordinate-only and trackless captures, improved handling of Peakbagger preview failures, and added a cached capture reset action.
- **First-use consent for 3D maps.** Added an explicit first-use consent flow before the 3D map feature fetches external elevation and map tile data.
- **Firefox fixes.** Fixed the initialization of isolated settings consumers and normalized the Control-drag gesture for 3D terrain tilt.
- **Fixed 3D time-series chaser color.**
- **Trip report editor.** The ascent form's trip report box is now a rich
  text editor with a GitHub-flavored Markdown mode and structural preview.
  Headings, quotes, emphasis/strike, links, real nested lists, tables, inline
  and preformatted code, rules, HTTPS images, and the useful Peakbagger inline
  tags all convert through one allowlisted model to the site's square-bracket
  format. Legacy line-based lists still import; `[p]`/`[div]`/`[br]` normalize
  to Peakbagger's newline convention. Unsupported embeds and unsafe HTML become
  visible text after an edit, while untouched server values and Plain mode stay
  verbatim. Reports autosave as local drafts on your device (offered back after
  a lost save, cleared on Save Ascent, expired after two weeks). Can be turned
  off in settings.

- **OSM Vector (beta) 3D map layer.** Added a new GPU-rendered vector basemap option for the 3D terrain view. Labels stay crisp and upright when the camera is tilted, sitting above the route so text remains readable.
- **Peak dots on the 3D map.** Peakbagger's native peak dots now render directly on the 3D terrain view, reusing the same data feed as the 2D map.
- **3D peak dots stay clickable at any tilt.** Tilting the 3D terrain camera
  no longer shrinks the dots' click area — near-horizontal views used to make
  them all but unclickable, because clicks were resolved through the terrain
  surface behind each dot rather than the dot itself. Clicks and the pointer
  cursor now follow exactly where each ring is drawn, at every pitch, and the
  rings keep a constant screen size like the 2D map's markers instead of
  shrinking into the distance.
- **Crisper 3D drapes.** The draped map texture no longer drops in resolution and blurs during small camera tilts.
- **3D peak dots sit on the summit.** Peakbagger's coordinates for a peak
  are often a few dozen meters off the mountain's rendered apex — invisible
  on the flat 2D map, but glaring downslope once the 3D camera tilts. Each
  dot now walks uphill on the rendered terrain to the nearby local summit,
  and stays exactly at Peakbagger's coordinates whenever no genuine summit
  is within reach — the walk is leashed both horizontally and vertically,
  so a dot never migrates onto a neighboring, bigger mountain, not even
  one whose own summit is close enough to reach. A dot's position is remembered between camera settles:
  tilting or panning never moves it (it used to wander on sharp ridges as
  the terrain detail level changed with the view), and crossing into a
  higher zoom level is the only time a finer terrain sample may refine it —
  in one hop, even when the zoom outruns the terrain download (the dot
  used to hop back to the raw database coordinate and off the summit for
  a beat whenever the finer terrain had not streamed in yet).
- **No more flicker when resizing the 3D map.** Dragging the map's resize
  handle while the 3D view is open used to blink on every step — each size
  change cleared the canvas and the repaint waited for the next frame. The
  view now repaints in the same instant it is resized.
- **Fixed 3D toggle on Full Screen maps.** Restored the 3D toggle button on Full Screen GPS maps, which was failing to appear in Chrome due to a script-injection order issue.
- **Fixed 3D toggle visibility.** The 3D toggle is now correctly hidden when the experimental 3D terrain feature is turned off in settings.
- **Fixed peak popups.** An open peak popup is now safely closed when the map's peak dots refresh.

## 2.1.0 — 2026-07-15

- **The 3D map is a one-tap toggle on the map.** The 3D/2D control now floats in
  the bottom-right corner, stacked just above the zoom controls — the way map
  apps like Gaia place it — and flips the view in place instead of sitting in the
  panel below. It lines up precisely above the zoom in both 2D and 3D (the toggle
  measures the map's zoom stack rather than guessing), and the 3D zoom is a
  two-button control matching the native 2D zoom. In 3D, the layer picker stays
  in the top-right corner so no control jumps corners when you toggle. The
  redundant "Not live conditions" caption is gone (the map still shows terrain
  shape, not live conditions — noted where it matters).
- **3D terrain on Full Screen maps.** The same floating **3D** toggle is now on
  Full Screen maps (`BigMap.aspx`), not just ascent pages. It lifts the route off
  the native 2D map onto MapLibre terrain, draping the layer you had selected, and
  restores the 2D map when you toggle back. Single-ascent maps (`t=A`) show one
  route in your preferred color; group maps (`t=G`) keep each track's own color
  so climbers stay distinguishable in 3D just like the 2D map, both with a
  matching casing. Off by default with the rest of the experimental 3D map;
  markers and peaks stay 2D-only.
- **Scroll zooms the 3D map directly.** The 3D terrain view now zooms on plain
  scroll, exactly like the native 2D map it replaces — no more ⌘/Ctrl modifier —
  on ascent pages and both Full Screen map types. An always-visible hint —
  *"Drag to pan · scroll to zoom · right-drag to tilt"* — keeps the remaining
  gestures discoverable. MapLibre's momentary full-surface overlay is suppressed
  in favor of the persistent hint. Consistent in Chrome and Firefox.
- **Steadier 3D shading.** The 3D hillshade is now anchored to the map instead of
  the camera, so a small tilt or rotate no longer swings the light across the
  terrain and flips the shading — the viewpoint moves, but the lit slopes stay put.
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
- **Internals.** The pure GPX metrics pipeline moved to `src/gpx/gpx-metrics.js`
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
  `test/project/fixtures-privacy.test.mjs` fails the build if a raw identifier reappears
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
  `src/theme/theme.js` now injects the sheet through an idempotent `ensureSheet()`
  tied to every `apply()`, so the authoritative settings read and every live
  toggle re-assert the sheet — the attribute can no longer exist without it. New
  `test/theme/theme-inject.test.mjs` locks in the invariant.
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
  flash persisted. `src/theme/theme.js` now injects the sheet from JS as a `<style>`
  in `<html>` at `document_start`, in the same synchronous tick that sets the
  attribute — the approach Dark Reader uses. The rules moved from
  `src/site-dark.css` (removed) to `src/theme/site-dark-css.js` as `window.BPBDarkCSS`;
  the manifest no longer uses a `css` entry. Details in
  `docs/dark-mode-flash.md`.
- **Legible header banner.** The site header sits on the (light) `header.jpg`
  photo with its title + nav links set to inline `color:black`. The theme's
  global `a { color: … }` was overriding that black with the light-on-dark link
  color, washing the links out over the photo. `.mainbanner a` / `.mainmenu a`
  are now re-darkened to `#000`.
- **WCAG AA contrast guard.** New `test/theme/dark-contrast.test.mjs` parses the
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
  (most visible in Brave). `src/theme/theme.js` now mirrors the theme preference
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
- **Dark mode** across all of Peakbagger via `src/theme/theme.js` (sets
  `data-bpb-theme` on `<html>`) and `src/site-dark.css` (dark rules scoped under
  that attribute, injected but inert until enabled). The GPX chart and filter
  bar theme themselves to match.
- **Settings bridge** (`src/settings/bridge.js`): the MAIN-world GPX analyzer can't read
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

- **Peakbagger GPX Analyzer** (was v13.13) → `src/gpx/gpx-analyzer.js`, running in
  the page's main world with Chart.js 4.5.1 now vendored locally instead of
  pulled from a CDN.
- **Peakbagger Ascent Beta Filter** (was v0.1.0) → `src/ascent/ascent-filter.js`,
  running as an isolated content script.

Feature behavior is unchanged from the userscripts. Because both features read
and write the same page-origin `localStorage` keys (`pb_gpx_unit_pref`,
`pbAscentBetaFilter.v1`), existing preferences carry over seamlessly for anyone
switching from the userscripts to the extension.
