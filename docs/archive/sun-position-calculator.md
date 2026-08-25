# Sun position calculator execution plan

**Status:** completed and archived on 2026-08-25. The calculator shipped in
focused local commits with pure, DOM, packaged-browser, hidden hardware-GPU,
package-inventory, privacy, and documentation evidence. The closure ledger
below preserves the intentional boundaries and external proof gaps.

**Created:** 2026-08-25

## Goal

Add a compact, offline sun position calculator to Peak pages and saved-ascent
GPX analysis without changing Peakbagger data, moving the native route, or
claiming to predict terrain shadows.

The calculator will show the Sun's apparent azimuth and elevation, the local
sunrise and sunset when those events occur, and a map-relative compass. Peak
pages use the validated summit coordinate and an editable date. GPX pages use
the selected route point and derive their date from the point's GPX timestamp,
falling back to the complete ascent date displayed by Peakbagger. The GPX
surface never presents a date picker.

All astronomy, coordinate-to-timezone resolution, and formatting remain local
to the browser. The feature adds no host permission, remote service, telemetry,
or persistent setting.

## Approved requirements

### Shared result and presentation

- The closed disclosure row reads **Sun position** on Peak pages and **Sun at
  selected point** on GPX pages. It may summarize the current result as, for
  example, `282° WNW · 17° above horizon`.
- Opening the disclosure shows:
  - the applicable date and date source;
  - a labelled mountain-time slider and current clock value;
  - a compact compass with upright `N`, `E`, `S`, and `W` labels;
  - absolute azimuth in degrees clockwise from north plus a 16-point compass
    label;
  - apparent elevation above or below the astronomical horizon;
  - sunrise and sunset, or an honest polar-day/polar-night state; and
  - the concise boundary: **Astronomical position at this location. Nearby
    terrain may block the sun.**
- The disclosure is collapsed by default. The mock was opened by default only
  to make review possible; implementation must not permanently consume the
  small map's visible area.
- The compass graphic is supplementary. Direction and elevation remain text so
  color, motion, or spatial interpretation is never the only way to read the
  result.
- Date, time, coordinate, and map bearing are page-local ephemeral state. There
  is no new Settings control and nothing is written to extension storage.

### Peak page behavior

- Use the already validated Peak-page summit latitude and longitude. Do not
  parse a second, less reliable coordinate source after the map identity check
  succeeds.
- Place the disclosure immediately below the Dynamic Map wrapper, outside the
  map overlay. It must not cover native attribution, zoom controls, the 2D/3D
  toggle, or the existing terrain compass.
- Peak pages retain a native date picker. On first creation, use the current
  calendar date and current clock time in the summit's timezone, not the
  viewer's timezone. Changing the date preserves the selected clock time.
- The 2D Peakbagger map is north-up, so the solar compass uses bearing `0°` in
  2D. While the extension's 3D view is active, it follows the authenticated live
  MapLibre bearing. Returning to 2D resets the solar compass to north-up.

### GPX ascent behavior

- Put the disclosure inside the existing GPX analysis panel after the selected
  coordinate controls and before the chart legend/chart. Do not add another
  floating control over the small map.
- The GPX calculator has **no date picker**.
- Date and time sources, in priority order, are:
  1. When the selected GPX point has a strictly valid timestamp, use that
     instant. Display its calendar date and clock time in the analyzer's
     trailhead-owned mountain timezone and label it as coming from the GPX
     point.
  2. When the selected point has no valid timestamp, use the complete ascent
     date parsed from the saved ascent page. Keep the current preview time;
     initialize it to `12:00 PM` on the first untimed selection and label the
     time as a preview rather than recorded data.
  3. If neither a valid point timestamp nor a complete `YYYY-MM-DD` ascent date
     exists, leave the calculator unavailable with **No track or ascent date is
     available.** Do not expose a date picker, use the viewer's current date, or
     turn a year-only Peakbagger date into January 1.
- Moving the route scrubber by chart click/tap, keyboard arrows, or another
  existing selection path updates the selected coordinate and recomputes the
  Sun. If the selected point has a valid timestamp, that same action also moves
  the mountain-time slider to the recorded local time and changes the displayed
  date when a multi-day GPX crosses local midnight.
- Moving the mountain-time slider recomputes only the Sun for the current route
  point and fixed date. It must not move the route scrubber, change the chart
  selection, call the route-highlight path, pan either map, or post a new 3D
  highlight.
- After a manual time preview, selecting another timestamped route point
  replaces the preview with that point's recorded time. Selecting an untimed
  point keeps the preview time and changes only the calculation coordinate.
- Partial GPX timing is admitted point by point: use a selected point only when
  its own `timeState` is `valid`. Never interpolate a missing point timestamp
  from neighbors and never treat all-equal/generated timestamps as recorded
  time.
- The GPX calculator uses the analyzer's existing trailhead-owned timezone for
  every route point so its clock agrees with the chart and stats bar even if a
  route crosses a political timezone boundary.
- The disclosure stays disabled until there is a valid selected coordinate.
  GPX load failure, retry, chart rebuild, or route invalidation clears its old
  subject and calculation instead of retaining a stale route point.

### Map orientation coupling

- Solar azimuth is an absolute north-based value and does not change when the
  user rotates the map.
- The compass is map-relative. For map bearing `B` and absolute solar azimuth
  `A`, draw the Sun at `normalize(A - B)` screen degrees. Place each cardinal
  label with the same transform, for example north at `normalize(0 - B)`.
- Use the normalized, authenticated `view` bearing already relayed from the 3D
  frame. Do not add a second frame message or read MapLibre internals from the
  page.
- Coalesce visual bearing updates to animation frames and use shortest-arc
  rotation across north. Do not put the frame-rate bearing stream in an
  `aria-live` region.
- Pitch does not change absolute Sun direction and will not pseudo-project the
  solar compass. The existing terrain compass may continue to visualize camera
  pitch; the solar compass remains flat and readable.
- Current native Leaflet maps do not rotate. Bearing coupling therefore applies
  to the extension's 3D MapLibre surface; 2D remains correctly north-up.

### Accuracy, privacy, and claims

- Use the locally bundled `suncalc` 2.x ESM API. The reviewed implementation
  target is 2.0.1, the current release on 2026-08-25. SunCalc 2 returns apparent
  altitude in degrees and azimuth clockwise from north, and returns `null` plus
  `alwaysUp`/`alwaysDown` for absent high-latitude rise/set events. See the
  [SunCalc reference](https://github.com/mourner/suncalc#readme),
  [2.0 release notes](https://github.com/mourner/suncalc/releases/tag/v2.0.0),
  and [2.0.1 package](https://www.npmjs.com/package/suncalc/v/2.0.1).
- Import the package into the two authored bundles with esbuild. Do not load its
  CDN build, publish a page global, or make runtime network requests.
- Call rise/set calculations with observer height `0`. Label them as
  astronomical/level-horizon events; do not make a misleading terrain or
  sea-horizon correction from a GPX elevation.
- Preserve the packaged `tz-lookup` resolver and longitude-estimate fallback.
  Every clock, date, rise, and set value must carry the same real or estimated
  timezone label the calculation used.
- Resolve an editable civil date/time to a UTC instant with a pure, tested
  helper. On a daylight-saving gap, snap forward to the first valid minute and
  update the visible control. On a repeated hour, choose the earlier occurrence
  and show the resulting zone abbreviation. The viewer's machine timezone must
  never influence the result.
- Fail closed on invalid coordinates, invalid dates, non-finite package output,
  an unavailable timezone formatter, or a missing DOM mount. A broken solar
  calculation must not break the map, chart, 3D lifecycle, or ordinary GPX
  analysis.

## Explicit non-goals

- No terrain-horizon, ridge-occlusion, cast-shadow, slope/aspect, or direct-light
  prediction. The feature cannot answer whether a face is actually sunlit.
- No change to the fixed relief hillshade direction and no claim that MapLibre's
  hillshade represents the selected Sun.
- No Sun ray, marker, or shadow layer drawn on Peakbagger's native 2D map or the
  extension's 3D terrain.
- No weather, cloud, smoke, or atmospheric visibility calculation.
- No calculator on Full Screen BigMap, list, profile, editor, popup, or capture
  surfaces in this scope.
- No GPX date override, timezone override, saved favorite time, autoplay, or
  animation of the route through time.
- No reverse coupling from solar time to route position.

## Current source findings

1. **Peak pages already establish a fail-closed subject.** The MAIN-world map
   coordinator requires one Dynamic Map, a Peak-type Full Screen link, bounded
   `cy`/`cx`/zoom values, and agreement between the page `pid` and map `d`
   before it creates `focusPeak` (`src/maps/peak-map.js` (lines 22–69)). The new
   calculator should consume `lat` and `lon` only after that gate and mount next
   to the wrapper created at `src/maps/peak-map.js` (lines 83–105).

2. **The GPX analyzer has one authoritative selection path.** It keeps selected
   chart identity in `selectedCoordinateIndex`/`selectedCoordinateSeries`, and
   click/tap and keyboard navigation converge on `selectCoordinateIndex()`
   (`src/gpx/gpx-analyzer.js` (lines 354–448)). That function already updates
   accessibility text, the chart point, and the route highlight. Solar state
   should be updated there; solar-time input must not call it.

3. **Selected chart points retain strict per-point time provenance.** GPX parsing
   accepts only ISO-shaped timestamps and records `timeState` independently
   (`src/gpx/gpx-parse.js` (lines 43–83)). Metrics preserve `ms`, `timeState`,
   route order, and sampled chart-point identity (`src/gpx/gpx-metrics.js`
   (lines 669–749)). The feature can therefore follow a valid selected point
   without weakening the analyzer's whole-track time-quality rules.

4. **Mountain time currently belongs to the track start.** The analyzer resolves
   the first route point through packaged `tz-lookup`, uses `Intl` for political
   timezone and DST behavior, and falls back to a labelled longitude estimate
   (`src/gpx/gpx-analyzer.js` (lines 291–343) and
   `src/gpx/gpx-analyzer.js` (lines 1501–1519)). Extracting this into a shared
   pure module is safer than implementing a second timezone policy for the Sun.

5. **The saved ascent date already has a shared parser.** `AscentPage.parseDate`
   recognizes the exact `Date:`/`Ascent Date:` label, parses month-name and ISO
   dates, and preserves year-only values as incomplete (`src/ascent/ascent-page.js`
   (lines 72–120)). Reuse it rather than scanning body text again inside the
   analyzer.

6. **3D bearing is already validated and throttled.** The frame posts bearing and
   pitch at most once per animation frame from MapLibre's `move` event
   (`src/terrain/terrain-frame-runtime.js` (lines 288–300) and
   `src/terrain/terrain-frame-runtime.js` (lines 2022–2034)). The isolated bridge
   forwards only the current frame generation (`src/terrain/terrain-map.js`
   (lines 500–528)), and the page coordinator normalizes finite view values only
   while terrain is active (`src/terrain/terrain-coordinator.js` (lines
   170–193)). The solar UI needs an optional callback from that accepted branch,
   not another message listener.

7. **The existing terrain compass already solves north-wrap motion.** It keeps an
   unbounded bearing and advances by the shortest arc before applying CSS
   rotation (`src/terrain/terrain-compass.js` (lines 63–95)). The solar compass
   should reuse the same normalization principle while independently positioning
   its Sun and cardinal labels.

8. **Both consumers are authored MAIN-world bundles.** The GPX analyzer and Peak
   map compositions are explicit in `scripts/build-config.mjs` (lines 55–65)
   and pinned in `test/project/manifest-capture.test.mjs` (lines 131–150 and
   297–323). Adding shared solar/time modules and a shared stylesheet requires
   updating those contracts and then loading the real manifest in hidden
   browsers.

## Chosen architecture

### Pure time and astronomy

Create the planned **src/time/mountain-time.js** module as the single owner of:

- coordinate-to-IANA resolution through `tz-lookup`;
- labelled whole-hour longitude fallback;
- formatting an instant into local ISO date, clock minutes, clock text, and zone
  label;
- converting a civil `YYYY-MM-DD` plus minute-of-day into a UTC instant with the
  DST gap/fold policy above; and
- local-day comparison used by both the existing GPX analyzer and solar events.

First migrate the analyzer's current formatting/day-boundary behavior to this
module with no user-visible change. This isolates regression risk before solar
UI work begins and keeps `docs/mountain-local-time.md` true.

Create the planned **src/sun/sun-position.js** module as a pure wrapper around
SunCalc. It validates inputs and returns a narrow model:

```text
{
  azimuthDeg,
  directionLabel,
  elevationDeg,
  isAboveHorizon,
  screenAzimuthDeg,
  sunriseMs | null,
  sunsetMs | null,
  daylightState
}
```

`screenAzimuthDeg` is derived from absolute azimuth and the current map bearing;
the package never sees page DOM or map state. Use a local-noon instant for the
chosen civil date when requesting that solar day's rise/set events, then format
the returned UTC instants explicitly in mountain time. Reject events that do not
belong to the intended local solar day instead of displaying an adjacent-day
result near the international date line.

### Pure interaction state

Create a small state owner in the planned **src/sun/sun-state.js** module. Its
actions make the directionality testable without DOM:

- `setPeakDate(date)` and `setPreviewMinute(minute)` change only solar time;
- `selectRoutePoint(point, ascentDate)` changes location and, when `point.ms` is
  valid, replaces date/time with the GPX instant;
- an untimed point uses the full ascent date and retains or initializes preview
  time without inventing a timestamp;
- `setMapBearing(bearing)` changes only screen-relative compass state; and
- `resetSubject()` clears stale route/date/calculation state.

There is deliberately no action that maps solar time back to a route index.

### Shared DOM component

Create the planned **src/sun/sun-calculator.js** and
**src/sun/sun-calculator.css** files for the reusable disclosure. The component
receives already validated state and exposes narrow methods such as `setSubject`,
`setPreviewMinute`, `setMapBearing`, `setTheme`, `setUnavailable`, and `dispose`.

- Build markup with DOM methods; do not insert an HTML string into Peakbagger's
  page.
- Use one native date input only in Peak mode and one native range input in both
  modes.
- Set `aria-expanded`/`aria-controls` on the disclosure and provide one concise,
  debounced textual status. Bearing frames update only the decorative compass.
- Keep cardinal text upright while changing its position around the disc.
- Respect reduced motion and shortest-arc bearing updates.
- Scope all CSS under the component root, use the existing light/dark theme
  decision, reflow below 600 px, and avoid fixed widths that could overflow the
  Peak page's legacy mobile layout.

Copy the stylesheet through `scripts/build-config.mjs` and list it on only the
Peak-map and ascent-analyzer manifest entries. Do not hide the dependency inside
terrain CSS or widen a global theme selector.

### Bearing handoff

Extend `TerrainCoordinator.create()` with an optional `onView` callback. Invoke
it only after the existing active-state, finite-number, normalization, and
generation gates accept a `view` message. Invoke `onView(null)` when terrain
fails, stops, resets, or is destroyed so each Sun component returns to bearing
`0°` with the native 2D map.

BigMap passes no callback and keeps current behavior. Peak and GPX surfaces pass
the normalized bearing to their calculator. This preserves one authenticated
view-message owner and prevents surface modules from revalidating the bridge in
slightly different ways.

## Detailed behavior matrix

| Surface/state | Coordinate | Date | Initial/route-driven time | Manual time slider | Map bearing |
| --- | --- | --- | --- | --- | --- |
| Peak page, 2D | Validated summit | Editable; defaults to summit-local today | Summit-local now | Recomputes Sun only | `0°` |
| Peak page, 3D | Validated summit | Same selected date | Same selected time | Recomputes Sun only | Follows accepted MapLibre `view` |
| GPX timed point | Selected route point | Point instant's mountain-local date | Point instant's mountain-local time | Recomputes Sun; route stays fixed | `0°` in 2D; live in 3D |
| GPX multi-day timed point | Selected route point | Changes when point crosses mountain-local midnight | Point instant | Same fixed point/date after user input | Same as above |
| GPX untimed point + full ascent date | Selected route point | Read-only ascent date | Existing preview, or noon on first selection | Recomputes Sun; route stays fixed | Same as above |
| GPX partial timing | Selected route point | GPX only when that point is valid; otherwise ascent fallback | Never interpolated | Recomputes Sun; route stays fixed | Same as above |
| GPX without usable date | Selected route point | Unavailable | Unavailable | Disabled | Compass reset/ignored |
| Polar day/night | Valid subject | Ordinary source rules | Ordinary source rules | Recomputes altitude/azimuth | Compass still follows bearing; rise/set text states no event |
| Timezone lookup failure | Valid subject | Formatted with labelled longitude estimate | Fixed estimated offset | Recomputes Sun only | Ordinary bearing rules |
| GPX reload/failure | Cleared | Cleared | Cleared | Disabled | Reset to `0°` |

## Execution steps

Each completed independent unit must be checked and committed before the next
unit. Preserve unrelated working-tree changes and use the repository's lowercase
Conventional Commit format.

### 1. Share mountain-time ownership without changing behavior

- [x] Add the planned **src/time/mountain-time.js** module with zone resolution,
  formatting, local-day, civil-to-instant, and longitude-fallback helpers.
- [x] Move the existing analyzer timezone/day formatting through that API while
  preserving trailhead ownership, labels, chart ticks, multi-day numbering, and
  camping boundaries.
- [x] Add pure tests for ordinary DST, spring gaps, fall overlaps, half-hour and
  quarter-hour zones, international-date-line dates, unknown ICU zone behavior,
  and longitude fallback.
- [x] Re-run the existing mountain-time and GPX analyzer tests before proceeding.

**Gate:** no existing chart/stat text or day-boundary fixture changes except
intentional test refactoring around the shared module.

### 2. Add the offline solar domain

- [x] Add `suncalc` 2.0.1 to the production dependency graph and lock the exact
  resolved package.
- [x] Add the planned **src/sun/sun-position.js** and **src/sun/sun-state.js**
  modules with the validation, date-source, asymmetric interaction, polar-state,
  and bearing rules above.
- [x] Test official reference vectors, all four cardinal quadrants, north wrap,
  above/below horizon, invalid package output, polar day/night, date-line solar
  days, timed/untimed/partial route points, and the invariant that a preview-time
  action never changes route identity.
- [x] Update `ACKNOWLEDGEMENTS.md`, `scripts/dependency-metadata.mjs`,
  `scripts/create-amo-metadata.mjs`, and their tests so reviewer metadata and the
  generated `THIRD_PARTY_NOTICES.txt` name the exact bundled package and BSD
  license.
- [x] Inspect the esbuild metafile/package notice inventory to prove SunCalc is
  bundled locally into only the intended consumers.

### 3. Build the reusable, responsive calculator UI

- [x] Add the shared DOM component and scoped stylesheet.
- [x] Implement collapsed summary, Peak-only date input, time slider, read-only
  GPX date/source row, compass, direction/elevation text, rise/set line, polar
  states, error state, and terrain limitation copy.
- [x] Add `aria-expanded`, labelled inputs/outputs, keyboard operation, debounced
  status announcements, dark theme, reduced motion, and cleanup.
- [x] Add component tests at Peak and GPX widths, including long timezone labels,
  below-horizon copy, absent rise/set events, and no horizontal overflow.

### 4. Integrate Peak pages

- [x] Instantiate the component only after Peak-map identity and coordinate
  validation succeeds.
- [x] Mount it below `#bpb-map-viewport`, initialize summit-local today/now, and
  forward theme changes.
- [x] Keep ordinary Peak pages working when no Dynamic Map or valid Full Screen
  Peak link is present; no calculator is safer than an unverified coordinate.
- [x] Extend Peak-map fixtures/tests for placement, default civil time, date/time
  changes, invalid identity, theme, disposal, and 2D north-up behavior.

### 5. Integrate GPX route selection and date fallback

- [x] Add `AscentPage.parseDate(document)` to the analyzer bundle rather than
  copying its DOM scan.
- [x] Mount the component inside `#bpb-gpx-analysis` in GPX mode with no date
  input.
- [x] Call the pure route-selection action from the single successful
  `selectCoordinateIndex()` path so mouse, touch, and keyboard selection behave
  identically.
- [x] Preserve point `timeState` and use only a strictly valid selected-point
  timestamp; otherwise apply the complete ascent-date/noon-or-current-preview
  behavior.
- [x] Keep manual time input one-way. Add regression spies proving it does not
  update `selectedCoordinateIndex`, call `renderRouteHighlight`, mutate the
  Leaflet marker, post a terrain `highlight`, or update Chart.js.
- [x] Reset solar state on GPX retry, unavailable data, chart rebuild, iframe
  replacement, and `pagehide`.
- [x] Cover complete, partial, absent, invalid, non-progressing, all-equal, and
  multi-day timestamps plus missing/full/year-only ascent dates.

### 6. Couple the compass to accepted 3D bearing

- [x] Add the optional coordinator `onView`/reset callback without changing
  existing terrain compass or BigMap behavior.
- [x] Forward live bearing to both solar components only while their terrain
  coordinator is active.
- [x] Render Sun and cardinal positions with `worldAzimuth - mapBearing`, using
  shortest-arc updates across `359° ↔ 0°`.
- [x] Reset to north-up on stop, Escape, load failure, coverage failure, iframe
  replacement, context loss, and ordinary 2D use.
- [x] Test invalid/stale view messages, generation replacement, frame-rate
  coalescing, no `aria-live` bearing spam, reduced motion, and unchanged absolute
  azimuth text while the visual compass rotates.

### 7. Update build contracts and maintained documentation

- [x] Add the shared modules to the GPX analyzer and Peak-map source lists, copy
  the stylesheet, and update only those two manifest entries.
- [x] Extend manifest/build-composition tests so a missing solar module,
  stylesheet, package notice, or wrong execution world fails closed.
- [x] Add the planned **docs/sun-position.md** guide as the maintained runtime
  and accuracy contract.
- [x] Update `docs/mountain-local-time.md`, `docs/3d-map.md`,
  `docs/architecture.md`, `PRIVACY.md`, `README.md`, and `CHANGELOG.md` with the
  shipped behavior and explicit terrain/privacy limits.
- [x] After implementation and verification, move this plan to `docs/archive/`,
  clear the active-plan index, and record fixed/verified, intentionally not
  changed, and changed-but-not-fully-proven outcomes.

## Verification plan

Run checks from the final candidate after a fresh build. A focused test pass is
required at each commit, followed by the complete matrix before archiving.

| Check | Required evidence |
| --- | --- |
| Pure mountain-time tests | Civil-to-instant conversion, DST gap/fold policy, unusual offsets, local dates, and longitude fallback pass independently of the machine timezone |
| Pure Sun/state tests | Reference azimuth/elevation, rise/set/polar states, date sources, asymmetric scrubbers, bearing math, invalid inputs, and route reset pass |
| `test/gpx/gpx-analyzer.test.mjs` | Every selection path drives Sun state; manual Sun time never drives route state; degraded GPX cases remain honest |
| `test/maps/peak-map.test.mjs` | Summit subject, placement, Peak-only date input, defaults, theme, invalid page gates, 2D reset, and 3D bearing pass |
| Terrain coordinator/compass tests | Accepted active bearing reaches both existing and optional consumers; stale/invalid/inactive messages do not; teardown resets |
| Build/release tests | Bundle roots, manifest CSS/worlds, reviewer metadata, dependency version, and generated full license notice are pinned |
| `npm test` | Freshly built shipped bundles and full unit/integration suite pass |
| `npm run lint:js` and `npm run lint` | Source lint and real built-extension lint pass with every new warning inspected |
| `npm run audit:ci` | The new production dependency has no unaccepted advisory |
| `npm run package` | Chrome and Firefox archives include the calculator CSS, both bundled consumers, acknowledgements, and generated SunCalc notice |
| `npm run verify:browsers` | Hidden isolated Chrome and Firefox load the real manifest, Peak page, GPX analyzer, settings bridge, and 2D/3D transitions |
| `npm run terrain:verify` | Hidden hardware-GPU Chrome rotates Peak and GPX terrain; Sun/cardinals follow bearing, absolute text stays fixed, and 2D reset succeeds |
| `npm run terrain:verify:firefox` | The same packaged bearing interaction and reset succeed in hidden Firefox |
| Visual review | Light/dark Peak map around 425 px, analyzer at 798×448 and 448×448 map sizes, and 390 px page width show no clipping, overlap, attribution coverage, or unreadable wrapping |

Browser checks must use isolated profiles, HTTPS Peakbagger-host fixtures, and
reliable teardown. Record browser/version, viewport, theme, hidden/visible mode,
renderer, and whether the check exercised 2D, 3D, or both. Hidden protocol and
screenshot checks do not prove native focus, window placement, browser chrome,
or touch-device gestures; this feature does not intentionally change those
behaviors.

## Acceptance criteria

- Peak pages with a validated Dynamic Map show one compact Sun disclosure below
  the map; invalid or ambiguous pages get no calculator.
- Peak date/time defaults use the summit's mountain timezone and remain editable
  without moving any map.
- GPX pages show no date picker. A valid selected-point timestamp owns date/time;
  otherwise a complete ascent date owns the date and an explicitly previewed
  time owns the clock.
- Every existing route-selection path updates solar location and, when present,
  recorded mountain time. Manual solar-time movement never changes route/chart/
  map selection.
- Absolute azimuth and elevation remain stable while a 3D map rotates; the Sun
  and cardinal labels move by the inverse map bearing and reset north-up in 2D.
- Sunrise/sunset, below-horizon, polar-day/night, DST transition, multi-day,
  missing-date, invalid-coordinate, and timezone-fallback states are accurate
  and labelled rather than guessed.
- The feature sends no coordinate, date, time, or result off the page and adds no
  permission, storage key, remote code, or provider request.
- The UI is keyboard accessible, theme-aware, reduced-motion aware, and visually
  verified at the relevant Peak and GPX sizes in Chrome and Firefox.
- Shipped documentation states that the calculator is astronomical only and
  does not predict terrain obstruction, cast shadows, weather, or actual direct
  sunlight.

## Completion record

### Fixed and verified

- `src/time/mountain-time.js` now owns offline zone resolution, labelled
  longitude fallback, formatting/local-day comparison, and viewer-independent
  civil-to-instant conversion. Pure tests cover ordinary DST, spring gaps,
  earlier fall folds, half-hour and quarter-hour zones, international-date-line
  dates, formatter failure, invalid input, and fallback.
- The pinned production dependency is `suncalc` 2.0.1. The pure Sun and state
  modules cover the official reference vector, all compass quadrants, north
  wrap, apparent elevation, level-horizon rise/set, polar day/night, date-line
  event ownership, invalid package output, timed/untimed/partial GPX points,
  preview asymmetry, bearing math, and stale-subject reset.
- The reusable DOM component is collapsed by default, uses a Peak-only native
  date input, exposes direction/elevation as text, keeps the graphic
  supplementary, has debounced status output, coalesces shortest-arc bearing
  updates, respects reduced motion, switches theme, disposes its work, and
  remains inside the panel at a 390 px page width.
- Peak pages consume only the coordinate admitted by the existing Peak-map
  identity gate and mount one calculator below the 425 px Dynamic Map. GPX
  pages mount after coordinate controls, expose no date input, follow the one
  authoritative route-selection path, reject all-equal timing as recorded
  time, and keep manual Sun time one-way. Load/failure/rebuild/frame/pagehide
  paths clear stale solar state.
- `TerrainCoordinator` delivers normalized bearing only from accepted active
  `view` messages and resets optional consumers on every inactive path. Peak
  and GPX solar compasses follow that bearing; BigMap remains unchanged.
- Manifest and build tests pin both MAIN-world consumers, their full authored
  module lists, and the scoped stylesheet. Build metadata showed SunCalc only
  in `content/gpx-analyzer.js` and `content/peak-map.js`. A missing package
  notice, version, reviewed license, manifest CSS, or execution world fails the
  project/release tests.
- `npm test` rebuilt all 28 bundles and passed **1,606 tests**. `npm run lint`
  passed source ESLint and built-extension lint with the same eight reviewed
  repository-owned dependency/cross-browser warnings. `npm run audit:ci`
  accepted only the two existing `image-size` advisories in the development-
  only `web-ext` lint path through 2026-09-21.
- `npm run package` plus the Firefox package derivation produced both 3.6.0
  archives. Direct inventory confirmed `css/sun-calculator.css`, both consumer
  bundles, `ACKNOWLEDGEMENTS.md`, and the generated SunCalc BSD notice in each;
  the packaged manifest assigns the stylesheet only to the two MAIN-world
  entries.
- `npm run verify:browsers` passed in isolated hidden Chrome for Testing
  151.0.7922.34 and Firefox 154 at 1000×760. It loaded the real manifest,
  observed the GPX calculator unavailable before selection, drove the real
  keyboard route-selection path, and verified the packaged Peak calculator,
  placement, styles, and surface-specific date controls.
- `npm run terrain:verify` passed hidden on Chrome 151 with the hardware ANGLE
  Metal renderer on Apple M3 Pro. `npm run terrain:verify:firefox` passed hidden
  on Firefox 153 with its reported Apple hardware renderer. Both rotated the
  Peak and GPX 3D surfaces, kept absolute Sun text fixed, moved Sun/cardinals by
  inverse bearing, and reset the completed visual transition north-up in 2D.
- Light and dark Peak and GPX screenshots were inspected around the 425 px Peak
  map, 798×448 and 448×448 Analyzer maps, and a 390 px page. The open calculator
  showed no clipping, horizontal overflow, map-control/attribution coverage, or
  unreadable wrapping.
- `README.md`, `PRIVACY.md`, `CHANGELOG.md`, and the maintained architecture,
  mountain-time, 3D, and new [Sun position guide](../sun-position.md) document
  the shipped local-only behavior and its astronomical—not terrain-lighting—
  claim. Relative-link, privacy, release, and changelog-history tests passed.

### Intentionally not changed

- No terrain horizon, ridge occlusion, cast shadows, slope/aspect, actual direct
  light, weather, smoke, or GPX-elevation observer correction was added.
- MapLibre's fixed relief hillshade and the native/3D map layers were not changed;
  no Sun ray, marker, or shadow overlay is drawn on either map.
- Full Screen BigMap, activity capture, editors, lists, the popup, and Settings
  remain outside this feature. There is no setting, persistence, new permission,
  remote request, CDN code, telemetry, or developer service.
- GPX keeps no date override or timezone override. The Sun time slider never
  changes route/chart/map selection, and no route autoplay or reverse
  time-to-route coupling was introduced.
- Native Leaflet remains north-up. Pitch is not pseudo-projected onto the flat
  solar compass, and the existing terrain compass continues to own pitch.

### Changed but not fully proven

- The isolated HTTPS fixtures and masked page fixtures do not prove that every
  current live Peakbagger page still exposes the expected Dynamic Map, ascent
  date, GPX link, or Leaflet globals. Live Peakbagger/provider behavior was not
  exercised and no rate-limited live request was needed for this implementation.
- Hidden protocol and screenshot checks do not prove native browser chrome,
  focus/window placement, screen-reader speech, touch-device chart gestures,
  physical high-DPI devices, or visible Firefox layout. No user browser window
  was opened or interrupted.
- Reference vectors and deterministic fixtures establish the implemented
  astronomy contract, but no field observation established real terrain
  visibility or direct sunlight—which the feature explicitly does not claim.
- Local packaging proves the submitted bytes can be built and run. It does not
  prove AMO/Chrome Web Store review, signing, submission, publication, legal
  sufficiency, or public availability.
