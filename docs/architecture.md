# Architecture and design guide

This document is the maintained technical overview of Better Peakbagger. It
describes module ownership and the boundaries that must remain true as features
change. Detailed operational instructions belong in
[development.md](development.md); dated investigations belong in
[archive/](archive/).

## Shipped runtime

Better Peakbagger is a Manifest V3 extension for Chrome and Firefox. Source is
authored as ES modules and bundled with esbuild into `dist/`. The generated
`dist/` tree is the extension loaded by browsers, evaluated by browser-level
verification, and used for store packages.

`manifest.json` is the source of truth for permissions, execution worlds, and
the order of separately loaded bundles and vendor scripts.
`scripts/build-config.mjs` owns bundle composition and copied assets. The worker
ships as one `dist/background.js` bundle referenced by both browser families.
Peakbagger content-script and web-accessible-resource matches are HTTPS-only,
aligned with host permissions, and deliberately page-specific so large vendor
or MAIN-world bundles are not injected into unrelated pages.

## Execution worlds

Peakbagger features run in the narrowest browser context that provides the data
they need:

| Surface | World | Reason |
| --- | --- | --- |
| Theme, filters, settings bridges, draft filling | Isolated extension world | Needs extension APIs while sharing page DOM. |
| GPX Analyzer, Full Screen GPS coordinator, Peak-page map coordinator | Page `MAIN` world | Needs Peakbagger-owned globals, frames, or page state. |
| Provider adapter | On-demand page `MAIN` world | Needs authenticated same-origin provider state and export access. |
| Terrain renderer | Extension-owned frame | Keeps packaged MapLibre and remote tile traffic outside Peakbagger's page realm. |

MAIN-world code cannot call extension APIs. Isolated-world code cannot read page
JavaScript globals. Moving code across this boundary requires re-evaluating its
data access, trust model, and cross-browser support.

## Settings and trust boundaries

`src/settings-schema.js` is the only settings schema. It owns defaults, bounds,
and validators without depending on DOM or extension APIs. `src/settings.js`
owns `chrome.storage.sync` access.

`src/bridge.js` is the narrow settings bridge from the isolated world to the
MAIN-world GPX Analyzer using `window.postMessage`. Page-world writes are
allowlisted to analyzer-owned preferences. Capture privacy settings, feature
gates, and theme remain writable only from extension surfaces.

Every consumer of settings received through `postMessage` re-validates through
`settings-schema.js`. A message is a trust boundary even when another extension
module produced it.

## Activity capture transaction

Activity capture is explicit and short-lived:

```text
toolbar click (activeTab)
  -> provider ownership and export gate
  -> raw GPX parsed on the provider page
  -> complete Peakbagger summit lookup
  -> encounter scoring and GPX reduction
  -> 30-minute storage.session job
  -> selected, identity-bound draft tabs
  -> GPS Preview exactly once
  -> user review and Save
```

There are intentionally no persistent Garmin or Strava host permissions. The
provider page must establish ownership before fetching GPX and fail closed when
ownership signals or provider DOM are ambiguous. Peakbagger login is verified
before coordinates are requested from the provider page.

Raw source GPX never leaves the activity page and is never persisted. The
background receives analysis fields and later stores only a newly serialized,
allowlisted upload plus derived draft values. Trackpoints and optional
waypoints share a 3,000-point budget. Waypoints carry only latitude, longitude,
and name. Summit lookup must be complete before matches are presented; a partial
response is not equivalent to no peaks.

Prepared drafts expire after 30 minutes and are delivered only after the worker
and `src/ascent-draft.js` verify sender tab, job, peak, and climber identity.
Preview may be triggered exactly once. No extension path clicks a Peakbagger
Save control. Cancelling capture deletes its job immediately; the transaction
identity prevents late provider or lookup results from recreating it.

### Local-file entry point (ascent-form GPX upload)

The same pipeline has a second entry point on `ascentedit.aspx`. When a
user-initiated file pick (`event.isTrusted`; the draft filler's synthetic
change never qualifies) puts a `.gpx` in Peakbagger's GPS Track field,
`src/ascent-upload.js` swaps the native Preview button for the extension's
**Process** button. Processing parses the file on the page with the shared
`src/gpx-parse.js` (the raw XML stays on the page, as with providers),
resolves the climb's UTC offset offline from the packaged `tz-lookup` raster
loaded ahead of the bundle, and sends only the allowlisted analysis fields to
the worker. `GPX_PROCESS_START` verifies the Peakbagger login and the page's
climber identity, runs the shared `analyzeTrack()` stage of `processCapture`
under the same capture preferences, and stores a capture-shaped job in the
same tab-keyed map (same TTL, cleanup, and supersede rules; hidden from the
popup's status view). `GPX_PROCESS_APPLY` registers the current tab as its
own draft tab — after the same identity checks — and hands off to the
existing `DRAFT_READY`/`DRAFT_PROCEED` handshake, so filling, the
privacy-validated cleaned upload replacing the chosen file, and the
exactly-once GPS Preview are all the standard `src/ascent-draft.js` path.

Multi-summit tracks follow the agreed hybrid: a single summit that is (or, on
an unbound page, becomes) the page's peak fills immediately; several summits
show an on-page picker card whose other selections open as confidence-ordered
prepared draft tabs in the "Peak Drafts" group with capture's suffix and Trip
Info parity. Every draft is registered before any tab navigates; an unbound
page then navigates itself to the chosen peak and is filled by standard draft
delivery. A bound peak the track only brushes (an encounter below the
visible-match bar) surfaces as an explicit closest-approach "use anyway"
fallback rather than a silently promoted match — detection stays fail-closed.
The module also autofills today's date into an empty `#DateText`; a populated
date (an existing ascent being edited) is never touched.

The detailed user-facing disclosure is canonical in
[../PRIVACY.md](../PRIVACY.md). Capture algorithms and their regression tests
live in `src/capture-core.js` and the corresponding `test/` modules.

## Draft identity and ordering

Alphabetical Peakbagger suffixes are assigned only among selected drafts that
share an ascent date. Assignment follows track-encounter order before tabs are
opened in confidence order. Singleton dates retain a blank suffix. Encounter
time is analysis metadata and must not be written into `SuffixText`.

Multi-peak trip names prefer the first GPX track name, then the activity page
heading, then selected summit names joined in track order. Names are normalized
and limited to 200 characters.

## GPX analysis and maps

Shared geometry and elevation-gain primitives live in `src/gpx-metrics.js` so
capture drafts and the GPX Analyzer cannot silently diverge.

`src/gpx-analyzer.js` owns ascent-page GPX parsing, adjusted metrics, chart
interaction, map synchronization, and the extension route overlay. Its overlay
must remain separate from and behind Peakbagger's native route and markers.
`src/big-map.js` owns Full Screen GPS behavior. `src/peak-map.js` owns Peak-page
terrain coordination.

The optional terrain renderer stays dormant until the user chooses 3D and
accepts the first-use disclosure. The isolated terrain bridge validates bounded
route segments or a summit focus and an optional compatible raster descriptor.
The extension frame requests Mapterhorn DEM tiles and, when selected, an
OpenFreeMap vector style or a compatible raster basemap.

The 3D frame mirrors Peakbagger's native peak feed through the page-world
coordinator rather than contacting Peakbagger itself. Marker replies are
validated all-or-nothing. Screen-space hit testing keeps billboarded rings
interactive on pitched terrain. See [3d-peak-markers.md](3d-peak-markers.md)
for the rendering rationale and limitations.

Chart clock times and day boundaries use the climb's local timezone, resolved
offline from the starting coordinate with the packaged `tz-lookup` data.
Failures fall back to a labelled longitude estimate and never break the panel
or send coordinates to a timezone service. See
[mountain-local-time.md](mountain-local-time.md).

## Page-feature ownership

- `src/gpx-analyzer.js`: ascent GPX analysis, chart, and map synchronization.
- `src/ascent-filter.js`: PeakAscents filtering and in-DOM sorting.
- `src/ascent-draft.js`: validated draft filling and exactly-once Preview.
- `src/gpx-parse.js`: the pure GPX-text parser shared by the provider adapter
  and the ascent-form upload flow (one parser for both entry points).
- `src/ascent-upload.js`: ascent-form date autofill, the Process button and
  its states, on-page parse + offline timezone resolve, the summit picker
  card, and `GPX_PROCESS_*` messaging.
- `src/report-markup.js`: allowlisted bracket, editor-DOM, and Markdown
  conversions.
- `src/report-editor.js`: trip-report editing orchestration and local draft
  lifecycle.
- `src/report-rich-editor.js`: the schema-locked TipTap surface for rich mode.
- `src/report-md-editor.js`: the CodeMirror source pane for Markdown mode.
- `src/theme.js`: synchronous site theme startup and reconciliation.
- `src/peak-links.js`: user-invoked external conditions and imagery links.
- `src/ascent-snapshot.js`: the ascentedit.aspx form→snapshot mapping captured
  at Save (the only place that knows those field names).
- `src/ascent-page.js` / `src/ascent-backup.js`: the saved ascent page reader
  (ownership, peak, GPX link, report) and the isolated-world "Back up to GitHub"
  affordance.
- `src/github-backup.js`: DOM-free payload builder (folder slug, `ascent.json`,
  `report.md`, commit message). `src/github-client.js`: the injected-fetch Git
  Data commit client. `src/github-auth.js`: device-flow auth plus the
  `storage.local`-only token/repo accessor. The token is held only by the
  background worker and never reaches a content script. The worker persists an
  in-progress device authorization in `storage.session` and advances it one
  interval-gated request per options-page status message, so worker suspension
  cannot lose the displayed code. The GitHub backup design lives in
  [github-ascent-backup.md](github-ascent-backup.md).

Extend the owning surface rather than adding cross-feature globals. The trip
report format and safety contract are documented in
[trip-report-editor.md](trip-report-editor.md). The stylesheet-before-theme
startup invariant is documented in [dark-mode-flash.md](dark-mode-flash.md).

## Storage and lifecycle

- `storage.sync`: user preferences (including the GitHub backup on/off and
  auto-backup gates; never the token or repo).
- `storage.local`: terrain-cache index, extension-local report drafts, and the
  GitHub backup token/repo (secrets must not ride browser-account sync).
- `storage.session`: capture jobs, prepared draft payloads, and save-time GitHub
  backup snapshots (30-minute expiry), plus an in-progress GitHub device
  authorization (GitHub's code expiry).
- CacheStorage: bounded, best-effort DEM response bytes.
- Peakbagger `localStorage`: page-local filter state and the early theme mirror.

The 2D and 3D renderers hand off their validated center and equivalent zoom on
every switch; bearing and pitch stay 3D-only. Returning to 2D then destroys the
MapLibre renderer and stops its tile activity. Successful DEM responses may
remain in the bounded cache.

Freshness gates reject expired jobs, drafts, and backup snapshots on read. A
five-minute alarm performs physical cleanup outside ordinary message handling;
correctness does not depend on the alarm firing before an expired read.

## Verification boundaries

`npm test` builds and evaluates shipped IIFE bundles in jsdom. It cannot prove
that a browser accepts the real manifest, execution worlds, separately loaded
script order, or the service-worker lifecycle.

`npm run terrain:verify` renders the real MapLibre frame on the GPU, but its
showcases stub storage and the bridge protocol and intercept Mapterhorn requests
with a synthetic CORS-enabled DEM. It does not exercise the live terrain service.
`npm run verify:extension` is the only check that loads the real unpacked `dist/`;
run it after changing the manifest, build composition, execution worlds, worker,
or content-script startup dependencies.

Live Garmin, Strava, and Peakbagger DOM/export behavior still requires minimal,
read-only manual verification before release. See [development.md](development.md)
and [releasing.md](releasing.md) for exact workflows.

## Focused design notes

- [Trip-report editor markup and safety](trip-report-editor.md)
- [GitHub ascent backup](github-ascent-backup.md)
- [3D peak markers](3d-peak-markers.md)
- [Mountain-local chart time](mountain-local-time.md)
- [Dark-mode startup](dark-mode-flash.md)

These documents explain feature-specific decisions. Completed or
point-in-time research, including the
[vector-basemap provider evaluation](archive/3d-vector-basemap-investigation.md),
is kept under [archive/](archive/) and is not a source of current runtime
behavior.
