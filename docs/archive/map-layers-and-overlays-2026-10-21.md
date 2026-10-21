# Shared map Layers menu and overlays

Status: implemented locally, October 21, 2026.
Runtime guide: [Map layers](../map-layers.md).
Source baseline: `ad48f51d8810` on `main`, with a clean working tree before
this plan. Initial findings below refer to that tree. The closure ledger records
implementation evidence; the maintained runtime guide supersedes proposed file
names and intermediate designs in this execution record.

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

Include one basemap selector above the four overlay rows. Preserve native
basemap handlers and available renderer choices, hiding the old selectors only
after the replacement is bound. Sentinel is an independent overlay. Remove the
separate SNOTEL map button and the two floating Sentinel capture panels once
their replacements work.
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
The existing [avalanche plan](../plans/avalanche-forecast-links-and-layer.md) remains
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

## Implementation and closure ledger — October 21

The compact presentation/schema foundation is `2297bb51`; the pure calibrated
USGS provider contract is `510fd400`; shared host, transports, both renderers,
Sentinel/SNOTEL relocation and regressions are `b900d73b`. The renderer and host
integration shipped as one coherent unit so an intermediate build never lost
its control owner. `795c900f` replaces raw destination URLs in handoff records
with fingerprints while preserving serialized prepare/consume ordering. Documentation is maintained in [Map layers](../map-layers.md).

**Fixed and verified:**

- One collapsed Layers button and a 232 by 170 pixel fine-pointer overview,
  including the native basemap selector and four rows. One detail well keeps
  rows anchored. Escape returns focus to Layers, and changing renderer does
  not replace the control. Controls support enlarged text and color schemes.
- Native choices use their existing handler. Sentinel and SNOTEL floating
  controls are removed from shipped surfaces. New native ownership works on
  ascent, peak, BigMap outside its 3D allowlist and standalone MasterMap; an
  embedded map has one outer owner.
- Raster opacity is independent and device-local. Sentinel mosaics apply alpha
  once; real pixels at 0/50/100% passed, including overlapping scenes and a
  naive per-scene-alpha negative control that fails the same pixel assertion.
  Unchanged passes retain their source. Provider work is bounded and cancels
  on off, renderer suspension, frame replacement and BFCache freeze.
- Latest/pinned capture state crosses 2D/3D and real one-use Full Screen
  handoffs. Frame choices/status are republished on accepted snapshots so a
  response racing an opacity change cannot leave feedback pending. Resuming a
  preserved user-selected base republishes its selector. Off while parked
  prevents a catalog replay. Stale revisions and catalog responses are rejected.
- Viewport SNOTEL uses one isolated client with the valid peak card, locally
  filters the national catalog, explicitly rejects the 51-station overflow,
  and preserves nearby-card authorization. Enabling it does not auto-frame the
  camera. Native and terrain popup/card actions and the master opt-out passed.
- USGS slope remapping and its legend share inclusive-lower degree classes.
  Live identify samples of 24, 29 and 37 degrees returned classes 1, 1 and 3;
  the composed rendering returned a PNG with the advertised palette. Both
  production USGS tile URLs returned direct HTTP 200 CORS-enabled PNGs.
  PAD-US classifies fee ownership, with an invisible unmatched symbol.

Verification evidence:

- `npm test`: all 3,033 passed, including the five new headless Sentinel session
  cases. The focused session/transport/bridge/terrain group passed 42 tests.
  The handoff fingerprint follow-up passed its four focused tests and the real
  Chrome Layers/Full Screen integration again.
- ESLint and `web-ext lint` passed; six existing owned warnings remained.
- Hidden real extension startup passed in Chrome 156.0.8078.4 and Firefox
  158.0.1 at 1000 by 760, with BFCache restoration.
- Compact component checks passed in hidden Chrome at 736/320 by 800, both
  themes. Native integration used pinned Leaflet 1.9.4 and Chrome 156 at
  1000 by 700. Actual expanded overview, SNOTEL, slope, land and 3D capture
  renders were inspected. Provider imagery/data are deterministic fixtures.
- Real SNOTEL checks passed in Chrome 156 and Firefox 158: 1440/375 by 1100,
  both themes, pending/off/ready, keyboard popups, live theme, cached toggles,
  frame replacement, errors/retry, rate limits, 200% zoom, nearby-card selection,
  renderer switching/resume and independent weather/SNOTEL opt-outs.
- Map controls passed 10 cases each in Chrome 156 and Playwright Firefox 157:
  peak/ascent/BigMap/peak-BigMap, 1280/375 by 1000, light/dark, 1x/2x text,
  keyboard focus, Escape and stable controls/map/following content/scroll.
- Verifier navigation now observes the click and new-page promises together.
  A deliberate missing-link probe reached the expected navigation assertion and
  resource-stack teardown; a final process/profile audit found no remaining
  owned map/snow/terrain profiles or browser processes. One profile from the
  earlier unhandled-promise probe was identified and removed after confirming
  its browser process had exited.
- Hardware rendering used ANGLE Metal on Apple M3 Pro. The full Firefox 157
  terrain fixture passed at 1000 by 760 plus narrow/resize checks, including
  authorization negatives, terrain/base/route/peaks, gestures, Sun/Moon bearing,
  capture selection/suspend/resume and warning geometry. Hidden rendering does
  not establish native OS focus or window placement.

**Intentionally not changed:** paid private parcels, worldwide ownership,
regional avalanche overlays, existing 3D eligibility/consent, native basemap
handlers, raw GPX/privacy boundaries, analyzer settings-write allowlist, and the
card's observations/timeout/Refresh/50 km contract. A failed station replacement
restores the prior station; Refresh refreshes that displayed station. Retrying
the replacement requires explicitly selecting it again.

The pre-existing 3D-toggle spacing assertion is also outside this change. The
unmodified Chrome terrain verifier stops at an ascent gap of 41 pixels against
its 40-pixel upper bound. A read-only run with the original parent/native
fixtures and zero Layers controls reproduced exactly 41 pixels (Chrome
156.0.8078.48, 1000 by 900). No product spacing was changed to silence it.

**Changed but not fully proven:**

- The unmodified full Chrome terrain verifier is not green because of that
  baseline assertion. A disposable copy allowing only the initial 41-pixel
  ascent gap passed WebGL2-unavailable, coverage-gap, held-drape and 12-resize /
  zero-blank-frame probes, then stopped at the same 41-versus-40 BigMap native
  gap. Later cases in that broad Chrome verifier were not established by that
  run; the dedicated Layers hardware check and full Firefox terrain check passed.
- The separate saved-GPX provider-handoff verifier stopped at its existing
  "send controls sit beside the download" assertion. Its captured 450-pixel
  GPX region wraps the four send controls below the link. Those controls and
  their placement code were not changed; later provider cases in that command
  did not run. Native Full Screen overlay-state/pass handoff is a separate path
  and passed in the dedicated Layers verifier.
- Real natural-color Sentinel performance/representative download benchmarks,
  live authenticated Peakbagger compatibility, current provider data accuracy,
  physical touch, screen-reader speech, native menus, OS focus/window placement,
  hosted CI and store/release acceptance remain separate proof limits. Provider
  HTTP/degree samples and synthetic fixture pixels do not prove these.
- Tile work uses bounded asynchronous main-world composition, with engine-owned
  coalescing/cache lifetimes; no cross-origin module-worker transport or new
  persistent satellite cache was introduced. Existing legacy Sentinel/SNOTEL UI
  modules remain as unshipped regression helpers; the shared session and actual
  shipped menu have their own focused and browser coverage.

## Follow-up: separate basemap and overlay corners

The user's layout correction supersedes the combined-selector design above.
The native basemap selector remains untouched at the upper-right; the terrain
frame again owns its own upper-right picker. The collapsed Layers control now
contains only overlays, aligned 10 pixels inside the visible map's left edge,
including Full Screen 3D. Its fine-pointer overview is 232 by 134 pixels.

**Fixed and verified:** the new test first failed against the combined menu,
and the real-extension fixture first failed on the hidden native selector.
The corrected native corners passed on ascent, peak, BigMap and standalone
MasterMap. Hidden Chrome 156 and Firefox 157 hardware-Metal fixtures passed
10 map-control cases each at 1280/375 by 1000, including light/dark themes,
enlarged picker/trigger text, focus, Escape, pending/cancel, active/return and
renderer-error/retry. The overlay component passed eight 736/320 by 800 cases
at normal/double text, including opacity, disclosures, collapse, and stable
rows/map/following content through loading/error/recovery. Enlarged-text status
indicators reserve their footprint to prevent an observed row-height shift.
The real unpacked Chrome integration passed native corners, independent
basemap/overlay selection, opacity pixels, pinned captures, Full Screen handoff
and parked-renderer resume. The real-manifest Chrome startup/BFCache check,
3,046 tests, scoped ESLint and web-ext lint (eight owned warnings) also passed.

**Intentionally not changed:** basemap handlers, provider work, opacity and
capture persistence, SNOTEL behavior, and existing 3D consent/eligibility gates.

**Changed but not fully proven:** these fixture checks do not reproduce the
live authenticated Peakbagger page, native browser menus, physical touch,
screen-reader speech, or OS focus/window placement. The broader pre-existing
verification gaps recorded above remain separate.

## Follow-up: persistent Layers disclosure

The user's next interaction correction supersedes the earlier Escape/outside-
click dismissal behavior. Layers has a decorative caret pointing down when
collapsed and up when expanded. Only its button toggles the whole menu, through
pointer or Enter/Space activation. Map clicks, page controls, native/3D basemap
interaction and Escape preserve its open state and selected detail; Escape
retains the map's normal popup/3D behavior. Automatic dismissal was removed
from the component, native-frame owner, terrain frame and isolated relay.

**Fixed and verified:** new tests first reproduced outside-click collapse and
the missing caret. All 3,048 tests passed after the change. Hidden Chrome 156
component checks passed eight 736/320 by 800 cases across both themes and normal/
double text, including caret direction, anchored trigger geometry, persistent
disclosures, opacity/status changes, and Enter/Space toggling. Chrome 156 and
Firefox 157 hardware-Metal fixtures passed 10 map-control cases each at
1280/375 by 1000. The real unpacked Chrome integration passed sticky native
menus on all four surfaces, basemap/page clicks, 3D map clicks, Escape returning
to 2D, pinned captures and renderer changes at 1000 by 700. Rendered caret and
menu states were visually inspected.
The real-manifest Chrome startup/BFCache check, scoped ESLint and web-ext lint
(eight owned warnings) also passed.

**Intentionally not changed:** overlay enablement/opacity, provider work,
basemap ownership, one-use Full Screen state handoff and 3D eligibility.

**Changed but not fully proven:** fixture results do not establish live-site
compatibility, native browser menus/OS focus, physical touch or screen-reader
speech. The earlier broad verification gaps remain separate.

## Follow-up: preserve Sentinel and SNOTEL interactions

The user's parity correction supersedes the viewport-only, no-auto-zoom
SNOTEL decision above. Explicit activation reveals up to three stations within
50 km when the current view contains none, reusing the original reveal helper.
Visible stations preserve the camera. A user pan cancels a pending reveal;
later pans and renderer switches never rearm it. Discovery stays local to the
cached national catalog and carries only validated station metadata to maps.

Sentinel captures again share the legacy date/cloud formatter, including zero
and unknown cloud coverage, Latest naming, and full date/time/cloud tooltips
on options and the selected capture. Choosing a capture updates its tooltip
immediately, including before a 3D-frame reply.

**Fixed and verified:** new assertions first failed on missing capture metadata
and offscreen-station discovery. All 3,057 tests passed. The component passed
eight hidden Chrome cases at 736/320 by 800 in both themes and normal/double
text. Real unpacked Chrome integration passed activation zoom on ascent, peak,
BigMap and standalone MasterMap at 1000 by 700. Chrome 156.0.8078.4 and Firefox
158.0.1 each passed 12 snow-map cases at 1440/375 by 1100, both themes and 200%
zoom, including native/3D reveal, visible-station camera preservation, pan during
loading, later pans, retry, opt-out and card selection. Hardware rendering was
ANGLE/Metal on Apple M3 Pro. Native and 3D reveal screenshots were visually
inspected; map/control/following-content geometry stayed anchored. The hidden
real-manifest Chrome startup/BFCache check passed at 1000 by 760. Scoped ESLint
and web-ext lint passed (eight existing warnings).

**Intentionally not changed:** 50 km station discovery, public metadata/data
consent, observation-card selection/Refresh, overlay persistence and native
basemap ownership. Offscreen discovery is requested only for activation/retry.

**Changed but not fully proven:** public provider responses are fixture-backed
in browser checks; live authenticated Peakbagger, physical touch, native select
menus, screen-reader speech and OS focus/window placement remain unproven.
The earlier broad verifier gaps remain separate.

## Follow-up: distinguish BLM for camping research

The Public lands overlay now paints BLM-managed federal fee land gold and other
federal fee land green. It retains state/local/district/tribal colors and the
transparent default for unknown and other ownership. The same filtered PAD-US
export drives native maps and terrain, with opacity applied once after service
composition. Classification requires both `Own_Type = FED` and `Mang_Name = BLM`:
live fee samples included BLM-owned parcels managed by other entities, so owner
name alone would misidentify current management. Designation boundaries are not
used. The existing detail adds an official BLM camping-rules link; the four-row
overview remains 232 by 134 pixels at normal text size.

Sources: [USGS PAD-US fee schema](https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/0?f=pjson),
[Esri export order/filter contract](https://developers.arcgis.com/rest/services-reference/enterprise/export-map/),
and [BLM camping guidance](https://www.blm.gov/programs/recreation/camping).
BLM describes dispersed camping as generally available subject to local closures
and restrictions. The overlay indicates land classification, not current camping
permission, road access, fire restrictions or suitable campsite locations.

**Fixed and verified:** new tests first failed on the missing BLM class and
camping link. All 3,059 tests passed, as did scoped ESLint and web-ext lint
(eight existing warnings). Three bounded live USGS attribute/export probes
matched gold BLM pixels at Alabama Hills, green federal pixels at Mount Rainier
National Park, and transparent unclassified ocean. Native fixtures checked
0/50/100% BLM pixels on ascent, peak, BigMap and standalone MasterMap; hardware
MapLibre checked gold rendering and zero-alpha removal. These real-extension
checks ran hidden in Chrome 156.0.8078.4 at 1000 by 700, ANGLE/Metal Apple M3 Pro.
Chrome 156 and Firefox 157 each passed eight component cases at 736/320 by 800,
both themes and normal/double text, including the guidance link, legend, anchored
rows/map/following content and pending/error/recovery transitions. Native, terrain,
narrow/dark and doubled-text land details were visually inspected. The hidden
real-manifest Chrome startup/BFCache check passed at 1000 by 760; unknown
component-verifier selections were rejected before launch.

**Intentionally not changed:** default 25% land opacity, the compact overview,
basemap ownership, other overlay behavior, device-local persistence, existing
provider hosts and privacy boundaries. No new camping settings or provider exist.

**Changed but not fully proven:** the three live probes do not establish nationwide
boundary completeness or current camping permissions. Browser map tiles are
synthetic outside those probes. Live authenticated Peakbagger, physical touch,
screen-reader speech, native menus and OS focus/window placement remain unproven.
The earlier broad verifier gaps remain separate.

## Follow-up: prioritize BLM and USFS colors

The user's palette request supersedes the prior BLM/federal palette. BLM is now
saturated gold (`#e69f00`), USFS deep blue (`#0072b2`), and both lead the legend.
Other federal land is muted gray, state purple, local/district rose and tribal
green. BLM and USFS each require federal fee ownership plus matching management;
the two filtered agency passes and ownership fallback remain one export shared
by native and terrain maps. Unknown ownership stays transparent.

**Fixed and verified:** the new regression first failed because the legend and
service had no distinct USFS category. All 3,060 tests passed, along with scoped
ESLint and web-ext lint (eight existing warnings). Four bounded live USGS
attribute/export probes confirmed exact gold BLM pixels at Alabama Hills, blue
USFS pixels in Deschutes National Forest, gray NPS pixels at Mount Rainier, and
transparent unclassified ocean. Native real-extension fixtures verified all
three colors and alpha at 0/25/50/100% on ascent, peak, BigMap and standalone
MasterMap. Hardware terrain verified warm BLM and cool USFS surfaces and their
removal at zero alpha. Terrain lighting shifts the blue toward cyan; an initial
overly strict blue-hue assertion rejected that visible surface, so the final
assertion recognizes the shaded cool tint and separately requires its removal.
Exact provider and native RGB assertions remain unchanged.

These map checks ran hidden in Chrome 156.0.8078.4 at 1000 by 700 on ANGLE/Metal
Apple M3 Pro. Chrome 156 and Firefox 157 each passed eight component cases at
736/320 by 800, light/dark and normal/double text, including the six-entry
legend, compact 232-by-134 overview, persistent disclosure, keyboard controls,
and stable rows/map/following content through pending/error/recovery. The hidden
real-manifest Chrome startup/BFCache check passed at 1000 by 760. Native default-
opacity, hardware terrain, narrow/dark and doubled-text details were visually
inspected.

**Intentionally not changed:** 25% default opacity, menu size and interaction,
basemap placement, Sentinel/SNOTEL behavior, other overlays, privacy boundaries,
provider hosts and camping-permission semantics.

**Changed but not fully proven:** these samples do not establish nationwide
boundary completeness or camping permission. Live authenticated Peakbagger,
physical touch, native menus, screen-reader speech and OS focus/window placement
remain outside the hidden fixture proof. Earlier broad verifier gaps remain
separate.

## Follow-up: BC and Alberta public-land coverage

The user prioritized BC and Alberta. Both use the existing Public lands row,
opacity, native/terrain compositor and context-sensitive detail. Explicit
provincial Crown ownership is gold; other recorded ownership is muted. Blank
areas remain unknown. No source is presented as camping permission.

BC uses the [provincial ParcelMap service](https://maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_cadastre/MapServer/0)
with an explicit OWNER_TYPE renderer. Private, mixed, unclassified and untitled
records are excluded. [LTSA defines untitled records](https://help.ltsa.ca/parcelmap-bc/owner-type)
as lacking an active title, which alone does not prove public ownership. The
parcel fabric is partial and does not fill unsurveyed Crown backcountry.
Alberta uses [the government's regional ownership layer](https://geospatial.alberta.ca/arcgis/rest/services/Hosted/Land_use_owndership_NN_project/FeatureServer/10),
explicit provincial/municipal classifications only, with its southwestern query
extent and Calgary exclusion documented. Mineral rights, parks, PLUZ boundaries
and Crown dispositions were not substituted for surface ownership.

**Fixed and verified:** coordinate-only BC worker requests require optional host
consent, reject foreign/invalid senders, enforce PNG dimensions/bytes and job
limits, propagate cancellation and preserve provider cooldowns. The packaged
terrain frame has a dedicated read-only sender gate; privileged extension UI
matchers remain unchanged. Alberta bounds paging, bytes, vertices, identities and
deadline; incomplete pages never publish a partially colored tile. Public-domain
Natural Earth outlines route providers only, including avoiding BC requests from
a Banff view. Ownership always comes from the parcel source.

Firefox's documented user-action restriction means a normal page click cannot
request permission in its worker. That rejection now opens/reuses an extension
setup tab with its own explicit Allow action; a grant acknowledgement is accepted
only from that exact packaged page. The setup assertion rejects an in-memory
reproduction of the prior handler (which only returned failure), then passes
the final handler. No user files were reset for this negative control.

All 3,079 tests passed, along with scoped ESLint and web-ext lint (eight owned
warnings). The build produced 50 bundles and includes the Natural Earth notice.
A bounded live BC ownership query/export confirmed Crown Provincial ownership
and visibly gold output; an earlier export showed municipal/federal colors.
The service ignored a requested centroid, so the successful probe used one
bounded polygon instead. One live Alberta tile passed through the shipped parser
in one request, rendering two Crown polygons and 20 vertices. These samples do
not establish complete or current coverage.

Hidden Chrome 156.0.8078.4 real-extension fixtures at 1000 by 700 verified BC and
Alberta on ascent, peak, BigMap and standalone MasterMap, opacity, Alberta holes,
private/unsupported areas, permission pending/denial/retry, the actual packaged
setup tab/grant acknowledgement, and both providers in hardware MapLibre on
ANGLE/Metal Apple M3 Pro. Existing Sentinel, SNOTEL, US agency palette, basemap,
menu and handoff checks passed in the same run. Chrome 156 and Firefox 157 each
passed eight component cases at 736/320 by 800, light/dark and normal/double
text. Setup idle/pending/denial/retry/success retained action focus and guarded
duplicate keyboard activation; heading/card/action geometry and document scroll
remained stable after establishing the initial focused reading position. The
first Chrome assertion included a one-pixel native focus reveal before its
baseline; the final assertion measures async transitions after focus, without
loosening the geometry comparison. The initial setup fixture lacked static
assets; the final fixture explicitly serves its built HTML, scripts and styles.
Native Canadian maps, hardware terrain, narrow/dark/double-text details and setup
pages were visually inspected. Real-manifest Chrome startup/BFCache passed at
1000 by 760. Verifiers reported teardown, and process/profile cleanup was audited.

**Intentionally not changed:** the compact overview, separate basemap corners,
25% default opacity, persistence, Sentinel cloud metadata, SNOTEL auto-reveal,
other overlays and activity-data boundaries. No private-parcel inference,
camping-allowed classification or coverage in other Canadian provinces exists.

**Changed but not fully proven:** provider responses and permission decisions are
stubbed in browser fixtures. The browser's native optional-permission prompt,
full Canadian map/worker integration in Firefox, live authenticated Peakbagger,
Canadian-specific BFCache recovery, physical touch, screen-reader speech and OS
focus/window placement remain unproven. Partial provincial coverage, parcel
currency, roads, closures and camping permissions remain source/product limits;
the earlier broad verification gaps remain separate.

## Follow-up: match layer selection and clarify opacity

The checkbox changed enablement while only the disclosure changed the selected
detail. Enabling Public lands could therefore leave Slope angle's slider open.
Toggling any layer now selects its matching settings, including a disabled
slider when turning it off. A tinted row and downward chevron identify which
settings are open. Multiple overlays remain independent; async provider replies
cannot select another detail or move focus. Each raster summary names Opacity,
and the slider has Clear/Solid ends and a spoken opacity value.

**Fixed and verified:** the new regression first failed on the unfixed module
with visible `Slope angle settings` instead of `Public lands settings`, then
passed after the change. All 3,081 tests passed, as did scoped ESLint and web-ext
lint (eight owned warnings). Chrome 156.0.8078.4 and Firefox 157 each passed
eight hidden component cases at 736/320 by 800, both themes and normal/double
text. Checks cover keyboard toggles, matching settings, one selected row,
unrelated async updates, focus, caption containment, and anchored rows/map/
following content through detail and feedback states. The overview remains
232 by 134 normally and approximately 232 by 283 at double text. An initial
caption width made double-text rows taller; the final widths preserve the
original compact dimensions without clipping the labels.

Hidden real-extension Chrome fixtures at 1000 by 700 passed all native map
surfaces, auto-selected Sentinel/SNOTEL/Canadian land details, opacity pixels,
Full Screen handoff and renderer transitions. Hardware 3D used ANGLE/Metal on
Apple M3 Pro. Immediate detail opening exposed a fixture assumption that dates
had already loaded; metadata checks now wait for the dated choices themselves.
The real-manifest startup/BFCache check passed at 1000 by 760. Native, terrain,
narrow/dark and doubled-text results were visually inspected. Disposable browser
processes/profiles and task artifacts were checked and cleaned up.

**Intentionally not changed:** compact reopen, persistent Layers disclosure,
separate basemap corners, overlay ordering, device-local opacity, provider
requests, permissions, agency colors, Sentinel metadata and SNOTEL auto-reveal.

**Changed but not fully proven:** browser providers/permission decisions remain
stubbed. Live authenticated Peakbagger, native browser/OS focus behavior,
physical touch and screen-reader speech remain outside the hidden checks.
The prior Canadian coverage and Firefox integration gaps remain separate.

## Follow-up: readable loading and recovery

Rows previously appended an ellipsis or exclamation mark without explaining
the state. Disabled layers could retain those warnings, analytical overlays
did not publish tile completion, and successful terrain retries could leave an
error showing. Sentinel also finished its loading indicator when the capture
catalog arrived, before imagery finished loading.

**Fixed and verified:** compact secondary lines now show named opacity, station
counts, Loading with a small spinner, Couldn't load, Needs access or Service
busy. Settings retain the explanation and an anchored Retry/Allow action.
Retry blocks duplicate activation during work; a focused successful Retry
becomes a working Reload until focus leaves, with plain success feedback.
Actual queued tile/body/decode work drives progress and completion; cancelled
older work cannot clear a newer request. Known provider cooldowns survive 3D
revision changes and resume. Disabled/transparent layers suppress stale row
warnings. Sentinel's dated choices remain usable while imagery tiles load.
Reduced motion disables spinner animation and hover transitions.

The readable-loading regression first failed against the unmodified control.
A successful-retry assertion also failed against the read-only HEAD terrain
module, then passed against the fix. All 3,088 tests, scoped ESLint and web-ext
lint passed (eight owned warnings). The headless MapLibre unit fixture never
requests protocol tiles; it now expects Loading imagery rather than claiming
that a catalog response proves rendered imagery.

Hidden Chrome 156.0.8078.4 and Firefox 157 each passed eight component cases at
736/320 by 800, both themes and normal/double text. Failure, held loading,
repeated keyboard activation, successful recovery, focus, reduced motion,
action/panel/row/map/following-content geometry and scroll were checked.
The overview remains 232 by 134 normally and approximately 232 by 245 at
double text. Loading, error and narrow/enlarged results were visually inspected.
Hidden real-extension Chrome at 1000 by 700 passed native map surfaces and
hardware 3D on ANGLE/Metal Apple M3 Pro, including real HTTP failure, held retry
body, completion and anchored recovery. Existing Canadian, Sentinel metadata,
SNOTEL, opacity, palette, basemap and renderer-handoff checks passed.
The real-manifest Chrome startup/BFCache check passed at 1000 by 760. All
verifiers reported teardown; remaining test process/profile paths were audited.

**Intentionally not changed:** collapsible persistent menu, separate basemap
corners, independent overlays, device-local opacity, provider/permission and
activity-data boundaries, land colors, cloud metadata and SNOTEL auto-reveal.

**Changed but not fully proven:** providers and permission decisions remain
stubbed in browser fixtures. Live authenticated Peakbagger, physical touch,
screen-reader speech and native browser/OS focus behavior remain unproven.
The prior partial Canadian coverage and full Firefox map-integration gaps
remain separate.

## Follow-up: slope tile availability and partial recovery

The screenshot showed valid slope shading behind an unavailable warning.
Inspection reproduced a renderer-wide sticky failure: one rejected tile kept
the layer in error after later tiles succeeded. Native Retry also redrew all
tiles, clearing good shading alongside the holes. There was no automatic retry
for a temporary dynamic-export failure.

The production USGS Slope Degrees rule returned valid PNGs for three bounded
probes. The Shasta zoom-12 probe took 2.7 seconds; neighboring Gilbert zoom-14
probes took 8.8 and 6.5 seconds, with public CORS and a 12-hour HTTP cache policy.
These samples establish reachable, sometimes slow dynamic exports; they do not
identify the precise rejected request in the user's screenshot. Existing live
Chrome tabs had no matching failing overlay state; Firefox's main-session
debugger was unavailable. No user tab was refreshed or brought forward.

**Fixed and verified:** slope retries temporary network/timeout and HTTP
408/500/502/503/504 failures once after 350 ms within the existing four-tile
concurrency budget. Each attempt retains its 15-second deadline. Permanent
errors and rate limits are not replayed; turning the layer off cancels the wait.
Retained tile outcomes distinguish partial shading from a wholly failed layer.
Unloaded native tiles and tiles outside the new terrain viewport cannot retain
old warnings, and late failures cannot poison the new view. Partly loaded
shading has an explicit explanation. Native Retry requests only failed tiles,
including neighbors aborted by a rate limit, while keeping good canvases.
Terrain refreshes the existing raster source and keeps successful textures.

The temporary-failure assertions failed against the original compositor. A
read-only original Leaflet adapter also failed the regression with visible
painted content cleared (`0 !== 1`), while the fixed adapter passed. All 3,095
tests passed; the final strengthened native fixture also passed separately.
Scoped ESLint and web-ext lint passed with eight owned warnings.

Hidden Chrome 156.0.8078.4 and Firefox 157 each passed eight component cases at
736/320 by 800, both themes and normal/double text, including partial feedback,
focus, Retry geometry, scroll and unchanged overview dimensions. Hidden Chrome
at 1000 by 700 passed all native surfaces, an actual temporary HTTP failure,
bounded automatic recovery, one missing-tile-only native retry and unchanged
good canvases. Hardware 3D on ANGLE/Metal Apple M3 Pro retained at least 90% of
the already-painted slope pixels during held recovery, then cleared the error.
The surrounding Sentinel, land, SNOTEL, opacity and handoff checks passed too.
The expanded fixture now restores the selected layer before Canadian checks
and reads capture metadata atomically with its readiness condition; earlier
runs exposed those fixture assumptions. Native, hardware, narrow/dark and
double-text partial/loading states were visually inspected.
The final real-manifest Chrome startup/BFCache check passed at 1000 by 760.
All browser verifiers reported teardown; disposable processes and exact profile
paths were checked and absent before committing.

**Intentionally not changed:** slope classification, 3DEP coverage/resolution,
no-data transparency, opacity, compact menu, other provider retry policies and
privacy/permission boundaries. No persistent cache or alternative slope source
was added. USGS HTTP caching handles successful response reuse.

**Changed but not fully proven:** the original screenshot's exact network
failure was not captured. Provider availability, load-time distribution and
coverage cannot be guaranteed by local recovery. Browser fixtures stub provider
responses and permission decisions; full live authenticated reproduction,
physical touch, screen-reader speech and native OS focus remain unproven.
Prior Canadian coverage and full Firefox map-integration gaps remain separate.

## Follow-up: share raster recovery across overlays

**Fixed and verified:** all three raster overlays now use retained tile outcomes,
one bounded transient retry, current-view error retirement and recovery that
keeps valid native canvases/terrain textures. Sentinel imagery retry reuses the
selected capture and catalog; search failures have a separate summary. Valid
land provider results remain visible when another regional source fails. Each
Alberta pass still requires complete, valid pagination before publication.
BC's narrow worker relay distinguishes temporary failures from permission and
validation failures. US, BC and Alberta cooldowns remain separate, validated
service deadlines through frame snapshots and Full Screen handoffs.

All 3,105 tests passed, as did scoped ESLint and web-ext lint (eight owned
warnings). New land/imagery automatic-recovery and same-capture assertions failed
against read-only original modules, then passed the fix. Existing renderer stubs
now model source refresh without inventing another catalog response. Hidden
Chrome 156.0.8078.4 and Firefox 157 passed eight component cases each at 736/320
by 800, both themes and normal/double text. The overview remains 232 by 134
normally and approximately 232 by 245 at doubled text; focus, Retry/Allow
geometry, scroll, partial permissions and capture-search feedback passed.

Hidden real-extension Chrome at 1000 by 700 passed all native map surfaces,
missing-imagery-only native recovery without a catalog request, US/BC partial
coverage and explicit access recovery. Hardware 3D on ANGLE/Metal Apple M3 Pro
kept the selected imagery pass and painted textures while recovering. Existing
land, slope, cloud metadata, SNOTEL, palette, alpha and handoff checks passed.
The new boundary check waits for actual full-opacity pixels after status is
published, rather than treating metadata as rendered output. An initial run
also exposed a real mixed-state issue: rows now show Loading while neighboring
requests are still active, then show partial/failure feedback when settled.
The final real-manifest Chrome startup/BFCache check passed at 1000 by 760.
Native boundary, terrain, dark/narrow and enlarged partial feedback was visually
inspected. Browser verifiers reported teardown.

**Intentionally not changed:** provider coverage, agency colors, opacity,
capture identity/cloud labels, permissions and activity-data boundaries. No
persistent tile cache, extra host permission or automatic capture-date switch
was added. SNOTEL metadata recovery is a separate follow-up unit.

**Changed but not fully proven:** provider responses and permission decisions
are stubbed in browser fixtures. Live provider failure distributions, native
permission prompts, screen-reader speech, physical touch and OS focus remain
unproven. Prior partial Canadian coverage and full Firefox map-integration gaps
remain separate.

## Follow-up: SNOTEL metadata recovery and retained locations

**Fixed and verified:** station catalog requests share the bounded transient
retry helper. Temporary network/timeout and HTTP 408/500/502/503/504 failures
retry once after 350 ms; cancellation stops the wait. Invalid catalogs,
permanent errors and rate limits are not automatically replayed. A failed
viewport refresh retains loaded markers and reports **Refresh failed** with
**Showing loaded locations** only when known stations remain in the current
view. An unknown view is not reported as an empty result. Overflow reports
**Zoom in**. Turning the layer off clears retained-location feedback, including
during a service cooldown. Successful passive refresh and Retry do not repeat
the activation-only reveal.

All 3,112 tests passed, along with scoped ESLint and web-ext lint (eight owned
warnings). The metadata recovery and native/3D retained-location assertions
first failed against the unfixed implementation for the intended defects. The
off/on cooldown assertion likewise failed before its fix. New coverage also
checks cancellation, permanent/invalid responses and overflow.

Hidden Chrome 156.0.8078.4 and Firefox 157 each passed eight menu cases at
736/320 by 800, both themes and normal/double text. The SNOTEL description stays
present through failure, pending and success; Retry/Reload, the panel, overview,
following content and scroll stay anchored. Focus and duplicate keyboard
activation guards passed. Narrow dark and doubled-text light failure states
were visually inspected. Hidden real-extension Chrome at 1000 by 700 passed
all four native map surfaces after an initial NRCS 503, exactly one automatic
retry and later local catalog reuse. The hardware 3D and existing raster
recovery, Canadian coverage, capture/cloud metadata, opacity and handoff checks
also passed on ANGLE/Metal Apple M3 Pro. Native SNOTEL and terrain captures were
visually inspected. The final real-manifest startup/BFCache check passed in
hidden Chrome at 1000 by 760. All browser verifiers reported teardown; process
command lines and disposable profile paths were checked and absent.

**Intentionally not changed:** observation-request retry policy, cache TTLs,
catalog persistence limits, station limits, one-time activation zoom and map
privacy. No map coordinates are sent to NRCS, no new permission or setting was
added, and observation freshness is not implied by retained station locations.

**Changed but not fully proven:** NRCS responses are stubbed in browser fixtures;
live availability and service recovery timing remain unproven. Full Firefox
map integration, physical touch, screen-reader speech and native OS focus
remain outside these hidden checks. Existing Canadian coverage gaps remain.
