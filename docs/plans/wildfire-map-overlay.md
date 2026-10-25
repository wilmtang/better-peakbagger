# Wildfire map overlay

Status: researched and proposed on October 24, 2026. Documentation only; no
wildfire runtime, settings, permissions or UI have been implemented.

## Recommendation and findings

Add an opt-in **Wildfires** row to the existing **Overlays** menu on peak,
ascent, BigMap/Full Screen and standalone native maps, with the same selection
in supported 3D views. Start with **US reported wildfire locations and available
perimeters from NIFC/WFIGS**. Add Canadian reported locations after proving the
new CWFIF service's current-record query. Treat worldwide satellite hotspots as
a separate, later overlay.

The proposed first release needs no API key, backend or additional map library.
Public-service probes support trying ordinary CORS requests before considering
any host permission. Actual requests from Peakbagger's MAIN world and the
packaged terrain frame remain a browser verification gate.

1. **A perimeter-only layer hides unmapped fires.** The
   [NIFC dataset description](https://www.arcgis.com/home/item.html?id=d1c32af3212341869b3c810f1a215824)
   explicitly describes incomplete perimeter availability. Its current views
   also remove incidents according to reporting and age rules. An empty result
   cannot establish absence of fire, closures or danger. Use incident points
   plus available polygons; label the product as reported fires.
2. **Fresh delivery does not mean fresh mapping.** A bounded live probe returned
   a perimeter with a much older `poly_DateCurrent` than its incident's
   `attr_ModifiedOnDateTime_dt`. Keep fetched time, incident update, perimeter
   edit time and perimeter observation time distinct. Never label all geometry
   “updated just now” because a download succeeded.
3. **Canada's “active” service can return historical fires by default.** The
   [June 2026 service catalogue](https://cwfis.cfs.nrcan.gc.ca/downloads/docs/en/references/cwfif/cwfis-data-placemat.pdf)
   replaces the legacy active-fire layer with
   `public:cwfif_national_activefires` on the new CWFIF GeoServer. Its WMS
   capabilities default time to `CURRENT`, but a bounded WFS request without a
   temporal filter returned 2010 records. Adding `record_end IS NULL` returned
   zero records in the same BC/Alberta box. Neither query proves current
   membership; do not ship either as the current-fire adapter.
4. **The existing architecture is suitable, but adding an ID is insufficient.**
   The shared schema and menu enumerate layers, while native rendering,
   terrain rendering, recovery copy and zoom rules contain raster-specific
   branches. A naive addition could say “Loading slope shading,” apply the
   wrong zoom gate or never render anything. Add an explicit vector path.
5. **Satellite detections are a different observation.**
   [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/mapserver/wms-info/)
   offers time-windowed detections through WMS, requiring a free MAP_KEY for
   that service. A hotspot is not an incident perimeter. Keep this out of the
   initial reported-fire layer; do not ship a shared embedded key.

Scope is deliberately phased because the request did not specify geography.
US-first delivery is the recommendation, not an assumption that the extension
should permanently exclude Canada or the rest of the world.

## Existing integration points

| Existing owner | What to extend |
| --- | --- |
| [map-layers.js](../../src/maps/map-layers.js), especially `apply`, `onToggle`, `onRetry` and renderer lifecycle | One page-owned selection; start/cancel the active renderer's wildfire session, forward bounded status and retain menu state. Do not couple fire requests to weather/SNOTEL settings. |
| [map-layer-control.js](../../src/maps/map-layer-control.js) | Reuse row, disclosure, status, accessible busy feedback and anchored Retry. Currently every non-SNOTEL layer receives raster opacity controls; wildfire needs an explicit fixed-style/count presentation. |
| [settings-schema.js](../../src/settings/settings-schema.js), especially `MAP_OVERLAY_IDS` and its readers | Add the allowlisted wildfire state once. First release uses fixed styling, so normalize its opacity field to 100 and omit an opacity slider; do not introduce a second schema. |
| [map-overlay-providers.js](../../src/maps/map-overlay-providers.js) | Add reviewed wildfire availability and a separate zoom policy. Existing `OVERLAY_MIN_ZOOM = 8` belongs to rasters and must not silently govern incidents. |
| [map-overlay-leaflet.js](../../src/maps/map-overlay-leaflet.js) | Add extension-owned polygon/point groups independently of raster tiles. Existing native raster panes are at 250/260/270. Preserve host routes, markers and layers. |
| [terrain-overlays.js](../../src/terrain/terrain-overlays.js) | Add bounded GeoJSON source(s), fill/outline/point layers and popup lifecycle. Existing terrain sources/protocol are raster-only. Keep terrain style and camera intact. |
| [map-layer-protocol.js](../../src/maps/map-layer-protocol.js), [map-layer bridge](../../src/maps/map-layer-bridge.js), [terrain runtime](../../src/terrain/terrain-frame-runtime.js) | Revalidate the new ID and typed counts, freshness and component outcomes, with the existing source/origin/generation/revision checks. No arbitrary service URL, filter expression, remote style or provider HTML crosses the bridge. |
| [Full Screen handoff](../../src/background/map-layer-handoff.js) | Carry only validated selection and bounded provider cooldowns under the existing one-use, 30-second contract. Refetch in the destination; never hand off feature collections, bounds or route data. |
| [build configuration](../../scripts/build-config.mjs), [manifest](../../manifest.json), [privacy contract](../../PRIVACY.md) | Bundle shared imports into native and terrain entries; declare any genuinely necessary new packaged assets. Document viewed-area disclosure before shipping. Keep MAIN-world code free of extension APIs. |

## Data-source decision

| Source | Appropriate use | Proposed disposition |
| --- | --- | --- |
| [NIFC current incidents](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0) and [current perimeters](https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0) | Reported US wildfire points and mapped outlines. Both expose GeoJSON and pagination, with a 2,000-record service limit. | First release. Query only `WF`, excluding prescribed burns and unrelated incident categories. Review provider coverage for Alaska, Hawaii and territories independently; do not infer worldwide coverage from service extents. |
| [CWFIF WMS capabilities](https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows?service=WMS&version=1.3.0&request=GetCapabilities) and [WFS schema](https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows?service=WFS&version=2.0.0&request=DescribeFeatureType&typeNames=public%3Acwfif_national_activefires) | Canadian agency-reported active locations; capabilities describe daily updates and exclude prescribed burns. | Follow-up after current-time filtering, pagination, agency status semantics and reuse terms are established. Show Canada as unsupported until that gate passes. |
| CWFIS `public:m3polygons`, listed in the catalogue above | Satellite-derived perimeter estimates. | Separate possible enhancement. Do not present these as surveyed agency perimeters or join them to incidents by proximity. Provincial official perimeters require their own adapter review. |
| [NASA FIRMS WMS](https://firms.modaps.eosdis.nasa.gov/mapserver/wms-info/) | Global satellite hotspots with selectable observation windows. | Later, separately labelled **Satellite hotspots**. Evaluate user-owned keys or the documented GIBS alternative, its dates and semantics before choosing transport. No global-coverage claim for the first release. |

Prefer vector data over a raster-only shortcut: it supports bounded feature
validation, source dates, incident/perimeter association and keyboard-operable
details. This adds adapter work; it avoids an opaque image whose age and missing
incidents cannot be explained. Reuse Leaflet and MapLibre already present in the
product. Do not add the ArcGIS JavaScript SDK or scrape a commercial fire map.

The NIFC item exposes public queries and a data-quality disclaimer. Retain
source attribution and its limitations; public reachability alone does not
establish every redistribution arrangement. Record the reviewed Canadian
licence/attribution and current service terms in its adapter gate.

## Data, freshness and request contract

Proposed small modules, colocated with the existing map code: `wildfire-core.js`
for pure normalization/validation, `wildfire-client.js` for fixed provider
queries, and `wildfire-session.js` for viewport ownership and refresh. Names are
proposed; no corresponding files exist yet. Avoid a general overlay-framework
refactor.

- Normalize only namespaced provider IDs, optional incident IDs, bounded names,
  point/polygon geometry, source dates, size/units and optional reported status.
  US point `IrwinID` and perimeter `poly_IRWINID`/`attr_IrwinID` allow association
  after UUID validation and normalization. Never join by fire name or nearest
  coordinate. Preserve disjoint polygons and holes; conflicting IDs remain
  visibly unassociated. Missing point/perimeter counterparts are valid states.
- Request fixed allowlisted fields with `inSR=4326` and `outSR=4326`. Validate
  finite longitude/latitude, Point/Polygon/MultiPolygon types, ring closure,
  nesting and total vertices before rendering. Do not silently “repair” an
  invalid footprint or replace it with a bounding box. Escape names with text
  nodes and build links from verified, allowlisted destinations.
- Start with US coverage and an effective native zoom of 7 for fetches; use the
  existing native/MapLibre zoom conversion. Treat that threshold as a proposed
  performance default to validate, not a provider limit. Split antimeridian
  bounds, deduplicate wrapped features and handle border views. Coverage remains
  an offline eligibility rule, never a conclusion drawn from clear pixels.
- Debounce settled viewport changes using the existing 300 ms pattern. Each
  component is one complete transaction: stable ordered pagination, unique IDs,
  monotonically advancing pages and explicit truncation checks. ArcGIS GeoJSON
  can place `exceededTransferLimit` under collection `properties`; the probe did.
  Follow the [query contract](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/).
  Detect inconsistent pages and fail without publishing a truncated collection;
  service edits during pagination remain a consistency risk to test.
- Initial proposed client budgets: 500 records/page, four pages/component,
  4 MiB/page, 12 MiB total per viewport transaction, 100,000 total vertices and
  20 seconds through all bodies/pages/validation, with at most two simultaneous
  component requests. Enforce limits before allocation where possible. These
  are implementation budgets, not measured production capacity. On overflow,
  retain a labelled prior view where applicable and show **Zoom in**; never
  silently discard small fires, vertices or pages. Assess bounded server-side
  generalization separately before adopting it.
- Fetch only while explicitly enabled in the active renderer. Use credential-
  and referrer-free requests, fixed HTTPS endpoints and no arbitrary proxy.
  Reuse the bounded-body, deadline, cancellation and transient-retry helpers.
  Allow at most one transient retry inside the total budget; honor HTTP 429 and
  ArcGIS JSON error bodies. Use a five-minute fallback cooldown when the server
  gives no usable deadline. Preserve the longest provider deadline across
  renderer switches and Full Screen; extend only the typed cooldown contract.
- Keep complete validated results in bounded page memory. Proposed refresh is
  every five minutes while enabled and visible, with revalidation on resume
  when due; hidden documents/renderers perform no polling. Coalesce identical
  requests. No persistent fire cache, alarms or provider tabs. Cancellation must
  abort transport, pagination, retry waits and timers, and invalidate late work
  on pan, disable, frame replacement, renderer switch and page disposal.
- Preserve a complete prior collection during refresh failure, visibly dated
  and labelled **Refresh failed**. Never count it as a successful current query
  for a newly panned area. A successful complete replacement, including empty,
  replaces it atomically. After 30 minutes without successful revalidation,
  remove the retained display and show unavailable; do not imply fresh data.
  This is a client availability rule, independent of source observation age.
- Record fetch time separately from each source timestamp. Prefer
  `poly_PolygonDateTime` for observed perimeter time when supplied; label
  `poly_DateCurrent` as the source edit time and incident modification as an
  incident update. Missing dates say unknown. Display old source dates even
  after a successful refresh; containment of 100% never means a route is open.

Incidents and perimeters publish independently only after each component is
complete. If one fails, retain the other and say **Partly loaded**, explicitly
identifying the missing component. An empty success from both means **No
reported fires in this view**, with coverage limitations in the detail. A
timeout, truncated response or unsupported country must never produce that
empty-success message.

## User experience and rendering

- Default off in unrelated sessions; opening Overlays makes no fire requests.
  Preserve enablement through 2D/3D and explicit Full Screen using existing
  lifetimes. No new popup card, feature setting, auto-fit, auto-scroll or camera
  movement. Canadian support joins the same row after its adapter passes.
- Use restrained, fixed translucent fire fill, a visible perimeter outline and
  a distinct point symbol with a casing. Keep slope colors, native routes,
  selected GPX points and peak labels legible. Do not color severity from
  containment or suggest a burn polygon is an evacuation boundary. First
  release omits an opacity slider; the row shows a count/status like SNOTEL.
- Add a native vector pane above analytical rasters but below native routes and
  markers; verify actual host pane ordering instead of assuming it. In 3D,
  drape polygons without extrusion and retain route/peak/highlight priority.
  Style/theme reloads recreate only extension-owned layers and sources. Confirm
  pitched terrain does not introduce elevated/floating fire points.
- Clicking or keyboard-activating a fire opens concise details: reported name,
  source, incident update, perimeter date when available, optional reported size
  and containment, and a verified official source link. Avoid fetching details
  on hover. Keep native peak/route interactions and the right-click location
  menu working. Provide keyboard access to perimeter-only records too, through
  a bounded **Fires in view** disclosure if no focusable point represents them.
- The detail says **Reported locations and mapped perimeters. Reports may lag;
  check official closures.** Keep full provider caveats in Sources/docs. Current
  fire data is always current reporting, even on an old ascent page; do not
  imply reconstruction of conditions on the ascent date.
- Cover off, loading, complete-empty, ready, partially loaded, refresh failed,
  service busy, zoom required, no coverage and retry. Keep the row, trigger,
  recovery button, surrounding panel and following native content stable during
  asynchronous transitions. Preserve focus, guard duplicate Retry activation,
  respect reduced motion and retain readable long names/dates at 200% zoom.

## Implementation sequence and acceptance

Each completed independent unit should be checked and committed before starting
the next. The US feature is complete only after both renderers and their
integration checks pass; a dormant data module alone is not a shipped feature.

1. **US source and transaction core.** Add the pure model, fixed query builder,
   bounded transport and session ownership. Tests cover WF-only filtering,
   namespaced identity, point/perimeter mismatches, missing dates, malformed
   geometry, holes, wrapped bounds, HTTP-200 error bodies, pagination flags,
   repeated/mutating pages, all resource limits, cancellation, retry/cooldown,
   stale results and atomic empty replacement. Use deterministic public-data
   fixtures rather than making ordinary tests depend on live fires.
2. **US overlay across native and 3D maps.** Extend the shared schema/control,
   renderer sessions, typed status/cooldown messages and Full Screen snapshots
   together. Add focused tests beside the existing map/schema/protocol tests.
   Validate no requests while off, menu-only, hidden or suspended; one active
   renderer; partial failures; stable recovery; cancellation; handoff expiry;
   and preservation of host layers. Update privacy, map-layer and regional
   coverage docs in this unit, including viewed-area network disclosure and
   memory-only retention. Do not widen privileged messaging or settings writes.
3. **Canadian reported locations, separately gated.** Establish documented
   latest/current time semantics against the official map, nonempty and empty
   cases, year/season rollover, duplicate historical versions, status codes,
   pagination and coordinate-axis order. Pin a bounded successful example and
   terms review. Never infer “current” from a layer name, WMS default, latest
   calendar year or null end date. Then add adapter/coverage and mixed US/Canada
   failure tests. Keep unsupported feedback until this is proven.
4. **Optional future scope.** Evaluate Canadian agency perimeters, global
   satellite hotspots, historical burns and smoke as separately named products
   with their own dates, provenance and coverage. No alerts, route-intersection
   warnings, evacuation inference or closure modelling in this feature.

## Verification gates

Before UI implementation, confirm the existing HTTPS Leaflet fixture and real
packaged MapLibre frame can render the intended vector primitives. The current
[map-layer verifier](../../scripts/verify-map-layers.mjs) loads real unpacked
`dist/`, pinned Leaflet and hardware MapLibre; it is a suitable starting point,
not evidence that wildfire rendering has already been inspected.

- Run focused model/client/session, map-control, schema, protocol, handoff and
  renderer tests, then `npm test` and `npm run lint` on implementation.
- Extend `npm run verify -- map-layers` and the Firefox component matrix;
  explicitly add real Firefox wildfire rendering/interaction coverage because
  the existing map-layers integration entry is Chrome-based. Run
  `npm run verify -- browsers` after load dependencies or packaging change.
  Exercise hardware 3D in both browsers and prove renderer provenance.
- Cover all four native map surfaces, native frame replacement, 2D/3D round
  trips, basemap/theme changes, Full Screen and reload. Check desktop and narrow
  viewports, light/dark, 200% zoom, slow/mixed responses, repeated updates, long
  names, keyboard activation and busy/error/retry focus in both browsers.
- Add geometry assertions for trigger/action/panel, following content and scroll
  through intermediate states. Inspect actual pixels for holes, stacking,
  native route readability, terrain drape and popup clipping. Use negative
  controls for layout shifts, missing incidents, stale completions and an
  incomplete pagination result; reject unknown case selectors and zero cases.
- Keep fixtures on HTTPS Peakbagger hostnames. Launch headless full Chrome for
  Testing through the approved path and launch guard, with real GPU rendering;
  preserve the user's focus and browsers. Tear down owned profiles, servers and
  processes and check exact leftovers. Report browser, renderer, viewport and
  hidden/visible method with the evidence.
- Perform minimal read-only live checks of source attribution, current data,
  CORS/CSP from both execution origins and actual Peakbagger interaction. CORS
  response headers alone do not prove page CSP, browser extension behavior,
  provider completeness, native focus or screen-reader output.

## Evidence and remaining proof

Inspected the current map/settings/protocol/renderer sources and existing
verification infrastructure on branch `main` at `e02b0fc4`. No runtime tests or
browser rendering were run for this plan.

Documentation verification: `node --test test/project/documentation.test.mjs`
passed all three checks, including maintained and archived relative links.
`git diff --check` passed for the plan and index.

Read-only public probes on October 24, 2026 (Los Angeles date):

| Probe | Observed result | What remains unproven |
| --- | --- | --- |
| NIFC layer metadata, incident query and generalized perimeter query | HTTP 200, CORS `*`, point/polygon GeoJSON, pagination support; small result limits correctly reported truncation. | Full pagination consistency, production geometry sizes, actual browser requests and complete geographic coverage. |
| NIFC item metadata | Current-view selection/fall-off rules, source attribution, disclaimer and missing-perimeter caveat available. | No guarantee of source completeness or a fresh perimeter for every incident. |
| CWFIF capabilities and schema | HTTP 200, CORS `*`, new active-fire layer, temporal fields and WMS `CURRENT` dimension present. | WFS current membership and full provider integration. |
| Bounded CWFIF WFS queries in BC/Alberta | Unfiltered query reported 63,336 matches and returned two 2010 points; `record_end IS NULL` returned zero. | Correct current-time filter, current nonempty example and official-map agreement. These are open adapter gates. |

The initial direct probes could not resolve hosts inside the sandbox; the
successful probes used approved read-only network access. No browser was
launched, user tab altered, credential requested or activity data transmitted.

Tracking categories for later implementation:

- **Fixed and verified:** no runtime implementation yet. Research and repository
  documentation are the deliverables of this planning request.
- **Intentionally not changed:** existing overlays, settings, permissions,
  renderers and map behavior. Global hotspots, smoke, alerts and historical
  fire reconstruction remain outside the initial feature.
- **Changed but not fully proven:** documentation only. All wildfire runtime,
  Canadian current-record, browser/CSP, visual/accessibility and live-source
  gates above remain open.
