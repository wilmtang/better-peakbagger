# Shared map Layers menu and overlays

Status: proposed, October 20, 2026. Planning only; no runtime changes.
Source baseline: `ad48f51d8810` on `main`, with a clean working tree before
this plan. Runtime evidence below refers to that tree, not to the mockup.

Requested outcome: one Layers menu on ascent maps, peak maps and BigMap, in
2D and supported 3D contexts. Move Sentinel-2 and SNOTEL into it, alongside
the proposed slope-angle and public-land overlays. Keep the selected basemap
underneath, with independent opacity for raster overlays.
The owner's follow-up requires the whole menu to be collapsible and as compact
as practical. The compact contract below supersedes the earlier always-visible
slider layout and the larger two-row conversation preview.

## Findings that determine the implementation

| ID | Current evidence | Consequence |
| --- | --- | --- |
| F1 | `src/maps/sentinel-map.js` (lines 25–90) adds `BPB_SENTINEL` to the native basemap selector and intercepts its change event. Native tiles stay underneath. `src/terrain/terrain-frame-runtime.js` (lines 1049–1070) treats Sentinel as a mutually exclusive basemap and removes the previous raster/vector basemap. | Moving the option alone would preserve different 2D/3D behavior. Make Sentinel an independent imagery overlay in both renderers, with ordinary basemap selection unaffected. |
| F2 | `src/maps/sentinel-layer.js` (lines 24–65 and 93–150) combines catalog ownership, capture selection, feedback DOM and scene installation. `src/terrain/terrain-frame-runtime.js` (lines 933–943) creates one raster layer per scene. | Separate the session model from its presentation. Apply user opacity once to the composed satellite image; per-scene alpha would make overlapping footprints more opaque. |
| F3 | `src/snow/peak-snow.js` (lines 35–43 and 106–125) creates the map source inside a peak-card bootstrap. `src/snow/snotel-map-source.js` (lines 7–35) returns up to 50 stations within 50 km of that peak. The manifest loads the card on Peak.aspx only. | SNOTEL on ascent/BigMap needs a map-independent catalog owner. The proposed common behavior is stations in the visible map area, filtered locally; this is an explicit extension of the current peak-centered behavior. |
| F4 | `src/maps/peak-snow-map.js` (lines 13–29 and 60–123) owns a separate toggle, notice, selection state and 3D snapshot. `src/snow/snotel-map-marker.js` owns marker activation, popups and the card action. | Move toggle/status ownership into the shared menu, retain renderer-specific marker code, and preserve the peak-card action only where its existing authorization and nearby-station membership hold. |
| F5 | `src/maps/big-map.js` (lines 25–28) exits outside `A`, `G`, `P`. `src/gpx/gpx-analyzer.js` (lines 804–830) requires a route for 3D initialization. | Overlays depend on a usable native map, not a GPX route or terrain subject. Give them an independent bootstrap; keep current 3D eligibility unchanged. |
| F6 | `src/terrain/terrain-basemap.js` (lines 140–170) can infer the active drape by scanning live tile layers. `src/gpx/map-frame-lifecycle.js` owns replaceable MasterMap identity. | Exclude extension-owned overlays from basemap inference. Rebind on real map/frame identity changes and dispose the former instances. |
| F7 | `src/settings/bridge.js` owns an explicit page-write allowlist; `src/terrain/terrain-map.js` validates frame relays and pending initialization. `src/snow/snotel-map-data.js` rebuilds at most 50 public station records. | Use a separate narrow overlay protocol and shared schema validation. Do not widen the analyzer settings-write allowlist, forward arbitrary URLs, or turn the menu into a generic privileged request bridge. |

These are integration constraints, not claims that the existing features are
broken. In particular, changing SNOTEL from peak-centered to viewport-based
discovery changes a product contract and must update its tests and privacy text.

## Product contract

### One control, four layer types

Use a compact **Layers** button at the map's upper-left, positioned clear of
the native basemap selector, navigation, compass, SNOTEL popups and attribution.
The button lives in the outer map-control mount so switching the renderer
does not hide, recreate or move it. Start with the entire menu collapsed; only
this button occupies map space until the user opens it. Closing the menu hides
its controls without disabling enabled map layers.

| Menu entry | Controls and initial values | Scope |
| --- | --- | --- |
| Sentinel-2 (experimental) | Toggle; opacity 100%; existing latest/dated-capture picker and capture metadata | Existing global imagery coverage, subject to the current catalog/view limits |
| Slope angle | Toggle; opacity 60%; verified slope legend | U.S. first, using a verified 3DEP rendering contract |
| Public lands | Toggle; opacity 25%; ownership legend and source/version | U.S. PAD-US fee holdings; gaps remain unknown |
| SNOTEL stations | Toggle, station count and local status; no opacity slider | Valid active NRCS stations within the visible area |

Opening the menu shows four compact single-line rows: a checkbox and layer
name, followed by a fixed-width opacity summary/disclosure for raster layers,
or a station-count/status disclosure for SNOTEL. Retain the experimental
designation in Sentinel's accessible label and compact visible treatment.
Do not show a second menu title, explanatory paragraphs, permanent legends,
sliders or capture controls in this collapsed-row overview.

At most one layer's settings can be expanded. Its explicit disclosure opens
one shared detail area **below all four rows**, keeping every row and its
toggle/disclosure in the same place when the selected layer changes. This
area contains that layer's opacity slider and concise legend, Sentinel capture
picker/metadata, or SNOTEL status/recovery as applicable. Repeating the active
disclosure collapses the detail area. Checkboxes toggle layers without
automatically opening settings. Raster values remain retained, with sliders
disabled when the layer is off. SNOTEL markers remain fully opaque and have
no opacity control.

The detail area's expansion/collapse is user-requested. Async pending, success,
empty, error and retry updates must not open it, change the selected detail,
expand another row or move its active controls. Show compact status indicators
in the overview; put full bounded feedback and Retry in the chosen detail area.
Preserve relevant status in accessible row/button names and settled live
announcements even when detailed feedback is collapsed. No automatic pop-open
or separate floating error panel.

Compactness targets for fine pointers: a roughly 80-by-32 CSS-pixel Layers
button, an overview around 232 pixels wide and 150–180 pixels high with all
four rows present, and content-sized details only when requested. These are
rendered design targets, not rigid heights or a reason to clip text. Keep
coarse-pointer hit targets around 44 pixels, ordinary readable typography and
200% zoom support. Increase height for accessibility, rather than shrinking
controls or stretching the menu across the map.

Keep existing native and 3D basemap selectors, removing only their
extension-owned Sentinel entries. Remove the separate SNOTEL map button and
the two floating Sentinel capture panels once their replacements work.
The Nearby snow card remains a separate observation surface.

All layers start off for an unrelated new map session. Persist raster opacity
preferences device-locally, outside the synced analyzer write path. Preserve
enabled layers, opacity and the pinned Sentinel pass through 2D/3D switching,
native-frame replacement and an explicit full-screen handoff. Do not broadcast
transient enablement to unrelated tabs. Persist on committed changes, not on
every slider tick; apply paint changes immediately and coalesce frame relays.

Opening the menu does not contact providers. Enabling an overlay is explicit
map-layer intent and does not enable 3D. Ordinary overlay activation does not
pan, zoom or scroll the map/page. This deliberately removes SNOTEL's current
automatic reveal of offscreen nearby stations: viewport stations are already
within the view. A popup may retain its existing minimal edge-visibility pan.

### Composition and opacity

Fixed drawing order, bottom to top:

1. Native basemap, or the selected 3D drape and existing terrain shading.
2. Sentinel imagery.
3. Public-land fill/boundaries.
4. Slope colors.
5. Native routes, extension route highlight/casing, summit and station markers,
   vector labels, popups and controls, preserving their existing relative order.

Use dedicated Leaflet panes below native vectors with raster pointer events
disabled. In MapLibre, add owned sources/layers into the existing style;
do not call `setStyle` or rebuild terrain for a layer toggle or opacity change.
Basemap swaps must preserve enabled overlays and their z-order. Extension-owned
overlays must not become inferred basemaps, routes or terrain subjects.

Apply opacity only to the intended overlay, once. A 0% overlay is invisible
and can suspend work after the drag settles; preserve its selected state/value.
Off cancels/removes that overlay's work and visible resources. Neither action
changes other overlays, the basemap, route styling or terrain exaggeration.
Opacity changes reuse loaded tiles and do not repeat catalog searches.

Labels baked into raster basemaps cannot be lifted above analytical fills.
Moderate opacity and a clear legend address this limitation; do not promise
that every native label stays unobscured at 100% opacity. Both analytical
layers can be on together without automatic opacity changes or hidden priority.

### Stable, accessible menu

- Anchor the trigger independently of panel content. Render an opaque popover
  in the outer document, with viewport collision handling; it may extend past
  a short embedded map without resizing that map or the native content below.
- The same Layers button opens and collapses the entire popover using
  `aria-expanded`/`aria-controls`; outside dismissal and Escape collapse it too.
  Reopening starts at the compact row overview. Hidden panel/detail controls
  must be unpainted, unfocusable and absent from the accessibility tree; keep
  active overlay state independent of this presentation state.
- At short browser heights, keep the Layers trigger reachable and constrain
  the detail area's scrollable content to the available viewport. Choose the
  popover placement on opening; do not repeatedly flip/re-anchor the four rows
  as async content changes. At 320 CSS pixels, fit within the available width
  without becoming a full-width drawer. Do not clip errors, long capture labels
  or attribution; allow the whole menu body to scroll only when necessary.
- Reserve appropriate feedback space inside the one expanded detail area,
  rather than four permanent empty status rows. Pending, success, empty,
  partial-coverage, error, timeout and 429 states must not repeatedly
  expand/collapse the menu. Never render raw provider errors.
- Native checkboxes, range inputs and selects have visible labels, numeric
  opacity values and keyboard support. Loading does not remove focused controls
  or close the panel. Announce settled status, not each animation frame.
- Escape closes the Layers panel before closing a station popup or leaving 3D.
  Coordinate the existing outer-document and terrain-frame Escape handlers.
  Return keyboard focus to the Layers trigger on explicit collapse; outside
  dismissal must leave map pan/zoom gestures usable. Collapsed status can use
  one fixed-size active/pending/error indicator without changing button width.
- Do not add future/coming-soon rows before their adapter is implemented.

## Ownership and data contracts

### Shared controller, separate renderers

Proposed modules below are names to create, not files already in the tree:

```text
src/maps/map-layer-core.js       normalized state, identifiers, bounds, revisions
src/maps/map-layer-control.js    reusable Layers UI, no provider/storage access
src/maps/map-layer-controller.js one map session and active-renderer ownership
src/maps/map-layer-leaflet.js    extension-owned native panes and layers
src/maps/map-layer-bridge.js     narrow isolated-world preferences/catalog service
src/terrain/terrain-overlays.js  MapLibre adapter and validated status relay
src/background/map-layer-handoff.js bounded, tab-bound full-screen handoff
```

Keep defaults, opacity bounds and message validation in the pure
`src/settings/settings-schema.js`; do not create a second settings schema.
The controller owns one versioned state snapshot, not another settings service.
Provider modules own catalog/tile work; the control renders their view models.

Each existing surface supplies its control mount, native map context, map/frame
identity events and terrain handoff hook. A guarded native MasterMap bootstrap
also supports standalone maps and BigMap contexts that the current 3D enhancer
does not enter. Use one owner handshake between parent and child so an embedded
map never gets both an inner and an outer Layers control. No new global map
registry or independent polling loops per layer.

Only the active renderer requests overlay data. On handoff, suspend the old
adapter and send the latest snapshot, including changes made while 3D boots.
Validate every boundary again, including source/origin, current frame, allowed
layer identifiers, numeric bounds and monotonic session revisions. A newer
snapshot wins over delayed initialization/status. Provider IDs map to fixed
code-owned endpoints; page messages never carry a fetch URL or executable style.

Include a validated active-view envelope for overlays. In 3D, use that frame's
visible bounds, not the hidden Leaflet map's stale bounds. Preserve the existing
Leaflet/MapLibre zoom conversion in provider adapters. Normalize world copies,
split dateline-crossing queries and retain the supported Mercator latitude limit.

Persist only opacity preferences. Use a bounded, short-lived, one-use full-screen
handoff bound to a verified source/destination map context. Carry layer IDs,
opacity and validated Sentinel pass identity, never GPX, scene catalogs, provider
URLs or account data. If the handoff is missing or inconsistent, start with
overlays off; ordinary map navigation must still work. The existing 3D one-use
activation capability remains independent and mandatory.
The isolated world must observe the trusted full-screen action; page messages
alone cannot authorize issuing a handoff. Route its bounded domain handler
through `src/background/background.js` and the existing single worker bundle.

### Sentinel migration and uniform opacity

Retain `src/maps/sentinel-core.js` for the existing 30-day search, pass grouping,
eight-scene budget, coverage estimation, cloud metadata, fixed tile URL builder
and strict pass identity. Preserve dateline/holes, native zoom 14, latest versus
pinned capture behavior, mountain-local date/time labels, 15-second deadlines,
429 cooldown and the distinction between scene cloud cover and view coverage.

Refactor `src/maps/sentinel-layer.js` into a session model and a view-model
adapter so its state machine can drive the common menu without mounting its
own panel. Only the active engine owns its catalog session. On a renderer
switch, carry the bounded pass identity and obtain that engine's own validated
catalog; do not forward a page-owned catalog or tile URLs into the frame.
Relay a bounded capture-choice/status DTO for the outer menu, with no scene
geometry, URLs or HTML. Preserve a pinned capture that is temporarily absent
as an explicit unavailable choice rather than silently selecting Latest.

For adjustable opacity, create one transparent mosaic tile from the selected
pass's intersecting scenes in deterministic order, then apply user alpha once
to the resulting raster layer. Share the composition algorithm between a
Leaflet GridLayer and an extension-origin MapLibre custom tile protocol.
Keep code/workers packaged, and prove their CSP/module-worker behavior in both
browsers before choosing a worker transport for the page-owned Leaflet path.
If a page-owned worker cannot load under the real page CSP, use a measured,
bounded main-world asynchronous composition path or an explicitly validated
extension-owned transport; do not depend on an unverified cross-origin worker.

Do not approximate uniform alpha by setting every scene layer to the slider
value: two opaque scenes at 50% produce 75% coverage in the overlap. Use a
negative-control fixture to prove that the pixel assertion catches this seam.
No partial scene may quietly replace a previously complete mosaic tile.

Before committing this unit, measure representative imagery tile sizes and
establish explicit byte, decode, concurrency and memory/LRU budgets. Cull
nonintersecting scene requests, coalesce identical tile work, close decoded
bitmaps, and propagate cancellation into fetches and composition. Retain
same-pass sources/decoded tiles through unchanged catalog refreshes and
temporary errors; mark retained imagery accurately instead of inventing fresh
coverage statistics. No new persistent satellite cache or imagery proxy.
Keep requested and painted capture identity distinct while replacement tiles
load. A failed replacement must identify the previous imagery still displayed;
the picker/status must not claim that the newly requested pass is already on
the map. Do not replay a superseded capture choice during a renderer handoff.

Translate the existing `BPB_SENTINEL` / `basemap.kind = sentinel` state once at
the migration boundary if encountered, preserving its capture and a valid
underlying native basemap. Remove only extension-owned menu options/listeners.
Native options must still reach Peakbagger's handler exactly once; the custom
Sentinel code must never reach that handler. Normal basemap changes must no
longer deactivate Sentinel. Terrain-only remains a valid underlying 3D choice.

### SNOTEL migration and viewport discovery

Reuse `src/snow/snotel-client.js` for credential-free catalog requests, its
seven-day public metadata cache, subscriber cancellation and provider backoff.
Filter the catalog locally against the validated active viewport; NRCS must
not receive the viewport, route or peak coordinates. Keep the metadata-only
payload and 50-record boundary in `src/snow/snotel-map-data.js`.

If a viewport contains more than 50 stations, show **Zoom in to show SNOTEL
stations** rather than silently displaying an arbitrary subset. Distinguish
zero stations from a catalog failure. Recompute from the cached catalog after
settled map movements, without fetching hourly/daily observations or repeatedly
downloading the national catalog. Handle Alaska/dateline world copies and
station membership invalidation after a view change.

Create one isolated catalog owner per document, explicitly composed with the
Nearby snow card on peak pages. Inject its client into the card and map source;
do not assume that importing the same module into two separately bundled IIFEs
creates a shared singleton. Maps-only ascent/BigMap bootstraps must not require
valid peak-card DOM or a subject within the card's current country/longitude gate.
Preserve `showSnotel` as the existing master opt-out; an opted-out row offers
clear Settings guidance and makes no catalog/observation requests.

Keep marker symbols, keyboard activation, one-popup ownership, NRCS links and
minimum edge-popup pan in `src/snow/snotel-map-marker.js`. On peak pages,
**Show conditions** remains available only when an actual Nearby snow card can
accept that station under the existing validated 50-km membership contract.
The isolated owner checks membership again at action time. Other stations and
map surfaces retain the NRCS link, without a dead card action. Do not expose
card observation fetching or arbitrary station IDs as a new generic page API.

Decouple `src/maps/peak-snow-map.js` from its standalone button/notice and
automatic reveal. Preserve observation-card timeout feedback, retained readings,
Refresh intent, card ordering and station-selection behavior recorded in the
[SNOTEL audit](../archive/snotel-timeout-ux-audit-2026-10-20.md).

### Slope and public lands

Use a small fixed-provider raster adapter for Web Mercator tile-to-bbox export
requests. Current drape validation requires z/x/y placeholders, so do not put
arbitrary WMS/export templates into the basemap list or relax remote URL checks.
Bound redirects, response bytes, image dimensions, concurrency, deadlines and
429 retries. Errors belong to the overlay and must not become fatal DEM errors.

- Slope: start with the [USGS 3DEP ImageServer](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer).
  Earlier HTTP probes returned a slope PNG with CORS. Its default legend
  response exposed RGB band labels, not degree thresholds. Establish a verified
  degree-to-color rendering/legend contract before presenting numeric slope
  bands. Do not infer bins from the default image colors. If a custom remap is
  needed, verify it against raw slope values and known terrain/reference cases;
  retain this as an implementation gate until proven. Label source resolution
  honestly; this is ground slope, independent of route grade and 3D exaggeration.
- Public lands: use [PAD-US fee holdings](https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-web-services)
  and verified `Own_Type` categories, with an explicit ownership renderer. The
  earlier 4.1 service/export probes succeeded with CORS. Do not substitute
  combined designations, proclamation outlines or manager type for ownership.
  Preserve holes/inholdings; distinguish any tribal/nonprofit/private-protected
  context from government ownership. Unmapped areas remain unknown, and public
  ownership does not establish access. Include source attribution/version.

These probes establish candidate endpoints, not production browser compatibility,
visual calibration, update guarantees, service capacity or worldwide coverage.
Worldwide Mapterhorn-derived slope and licensed private-parcel coverage remain
separate follow-ups. Do not add a placeholder private-land layer in this release.
The existing [avalanche plan](avalanche-forecast-links-and-layer.md) remains
separate; slope shading does not imply a forecast overlay.

## Independent implementation units

Each unit is a focused commit after its own acceptance checks. Do not remove
the old usable control before the replacement adapter and handoff work.

| Unit | Proposed commit subject | Acceptance before commit |
| --- | --- | --- |
| L1 | `feat: add shared map layer state and controls` | Complete pure schema/state, compact default-collapsed UI with four summary rows and at most one bottom detail area, one-owner bootstrap and narrow bridge contracts. Component tests cover whole-menu/detail collapse, hidden-control focus, independent enablement, malformed messages, opacity, stale status, persistence failure, collision handling and teardown. Do not expose an empty menu before a provider is registered. |
| L2 | `feat: move sentinel imagery into map layers` | Independent Sentinel over every underlying basemap in all three surfaces and supported 3D; one capture UI; correct mosaic alpha; pinned/latest handoff; retained tiles on unchanged/failed refresh; packaged composition transport works in Chrome and Firefox. Remove duplicate Sentinel controls/options only with this passing replacement. |
| L3 | `feat: share snotel map stations across map surfaces` | Viewport catalog owner and shared-menu row work in all three surfaces, including maps without GPX/card DOM; 50-record overflow is explicit; settings opt-out, cancellation and card-action membership hold. Remove the old map button/reveal behavior; preserve all observation-card regressions. |
| L4 | `feat: add slope angle map overlay` | Fixed USGS adapter, verified rendering/legend contract, independent opacity, explicit coverage/no-data/error states and no coupling to terrain exaggeration. Provider-contract and browser checks establish meaningful colors before enabling the row. |
| L5 | `feat: add public lands map overlay` | Fee ownership classification, holes, unknown areas and complete attribution; independent opacity and ordering with Sentinel/slope; no private/access inference or duplicate provider traffic. |
| L6 | `docs: document shared map layers and verification` | Maintained architecture/privacy/development/user docs describe shipped behavior, removed controls, viewport SNOTEL, handoff and persistence. Complete integrated browser/render checks and record remaining live/native proof gaps. |

Candidate existing files to extend include the surface modules above,
`src/terrain/terrain-frame-runtime.js`, `src/terrain/terrain-map.js`,
`src/settings/settings-schema.js`, `manifest.json` and
`scripts/build-config.mjs`. Add only the MAIN-world, isolated-world and packaged
worker assets each entry actually needs. Preserve stylesheet-before-theme
ordering, the single background bundle and existing host permission boundaries.

## Verification and acceptance matrix

### Focused regressions

- Extend `test/maps/sentinel.test.mjs` and `test/snow/snotel-map.test.mjs`.
  Preserve the existing catalog, pass, timeout, 429, cached-image retention,
  stale-reply, metadata, popup and cancellation cases while deliberately
  replacing tests that pin the removed control location or automatic reveal.
- Add pure/state/provider tests for all invalid alpha values, unknown IDs,
  wrong frame/origin, old revisions, wrapped bounds, pinned missing passes,
  the 51-station overflow boundary and preference/handoff failure.
- Verify that default/reopened menus have no expanded detail, selecting another
  detail replaces the previous one, and checkboxes do not open settings. Whole
  menu/detail collapse must hide controls from keyboard and accessibility
  navigation while leaving enabled overlays and their opacity unchanged.
- Test same-pass overlapping scenes at 0%, 50% and 100%, including transparent
  no-data and missing scenes. The naive per-scene alpha negative control must
  fail on actual pixels, not a missing node or a setup timeout.
- Add provider fixtures with both analytical overlays, Sentinel imagery,
  native basemap changes, route highlights, group route colors and station
  popups. Assert independent opacity and unchanged native layer identity.
- Exercise off during held headers/body/decode, rapid toggling, repeated pans,
  renderer switches during pending work, frame replacement and BFCache.
  Verify fetch/worker cancellation and absence of duplicate active owners.

### Real-browser coverage

Use the shipped `dist/` and faithful HTTPS Peakbagger-host fixtures. Existing
`scripts/verify-sentinel-map.mjs` and `scripts/verify-snow-map-fixture.mjs`
provide relevant extension/Leaflet/terrain fixture paths; add a dedicated
combined-menu verifier rather than treating the static design preview as one.
The Sentinel verifier is currently a direct script, not a registered `verify`
target: register an explicit combined target in `scripts/verify.mjs` and test
unknown selectors/zero cases rather than documenting a nonexistent command.

Cover Chrome and Firefox, with actual unpacked-extension startup and hardware
WebGL for terrain. Guard every macOS Chrome launch outside Seatbelt, use
headless isolated profiles, assert the hardware renderer for WebGL, and tear
down owned servers, contexts, processes, profiles and disposable certificates.

| Dimension | Required cases |
| --- | --- |
| Surface | Ascent before/after GPX readiness; peak with/without a snow card; BigMap A/G/P plus a native context outside the terrain allowlist; standalone/embedded MasterMap without duplicate controls |
| Renderer | Native Leaflet, supported 3D, loading switch, parked/resumed frame, renderer failure restoring 2D |
| Layout | Default button only; compact four-row overview; each single expanded detail; 320, 375, normal embedded width, full screen; minimum 240-pixel map height; short browser viewport; light/dark; 200% zoom/enlarged text; measure overview dimensions against the compactness targets |
| Interaction | Whole-menu collapse/reopen; each detail collapse/switch; checkbox without auto-expansion; pointer and keyboard checkbox/range/select, drag without map pan, outside dismissal, Escape precedence, focus through pending/disabled/error/retry; no focusable hidden controls |
| Stability | Trigger and all four row/disclosure positions, active detail controls, map bounds, following native heading/content and document scroll; before/during/after transitions within one CSS pixel except documented detail expansion/resize; async updates cannot reopen or enlarge the overview |
| Data | Slow/failed/429 responses, zero/partial coverage, long labels, missing pinned pass, dateline, 51 stations, same-scene refresh, basemap swaps with all raster overlays enabled |

Run focused checks per unit. After manifest, build entries, worlds or startup
dependencies change, run the real unpacked Chrome check before committing.
At integration, run `npm test`, `npm run lint`, `npm run verify -- browsers`,
`npm run verify -- map-controls`, `npm run verify -- map-handoffs`,
`npm run verify -- snow-map`, `npm run verify -- terrain` and
`npm run verify -- terrain firefox`, plus the newly registered combined cases.
Extend existing verifier selectors/assertions for moved controls first.
Do not claim these commands passed until they have actually run on the change.

Native focus/window placement, physical touch, screen-reader announcements,
existing-profile/live Peakbagger compatibility and live provider behavior need
separately identified evidence. Hidden fixture/GPU checks do not establish them.
Take minimal read-only live checks after fixture readiness; do not automate a
CAPTCHA or turn planning into provider load testing.

## Current verification and closure ledger

**Fixed and verified:** no runtime items. Source inspection and the written
implementation contract are complete. Planning-document checks are recorded
below after execution.

**Intentionally not changed:** all runtime behavior in this planning turn;
native basemap controls except the planned Sentinel relocation; 3D subject and
consent gates; the analyzer settings-write allowlist; the observation card's
science, timeout/Refresh and nearby membership contracts; paid private parcels,
worldwide ownership and regional avalanche overlays.

**Changed but not fully proven:** no runtime code changed. Every L1–L6 unit is
unimplemented. The earlier larger two-row preview is superseded by the owner's
compact/collapsible requirement, and is not rendered proof of the revised UI.
That preview and the HTTP provider samples do not prove the four-layer menu,
real extension messaging, uniform
Sentinel mosaic opacity, viewport SNOTEL, degree calibration or 3D behavior.
Keep these proof gaps open until their acceptance cases actually pass.

Planning checks: `node --test test/project/documentation.test.mjs` passed all
three tests (document links, repository paths and heading targets included).
`git diff --check` and `git diff --cached --check` passed.
No runtime suite or new four-layer browser check ran for this documentation-only
change.
