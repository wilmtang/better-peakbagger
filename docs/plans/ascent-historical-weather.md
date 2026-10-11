# Historical weather on individual ascent pages

Date: 2026-10-10. Status: investigated and proposed; runtime implementation has
not started.

## Requested outcome

Show a weather card below the GPX/map card on an individual saved ascent page.
Ascents without a GPX must show the same card. Load conditions for the saved
ascent date at the summit, select a recommended model for that location and
date, and allow choosing other eligible historical models.

This is a daily summit estimate. A date alone cannot identify the climber's
summit time, conditions along the route, or weather over a multi-day trip.
The initial card must not silently substitute a GPX date, today's weather, a
forecast, or the viewer's timezone.

## Findings before implementation

| Boundary | Current evidence | Consequence |
| --- | --- | --- |
| GPX dependency | [GPX analyzer](../../src/gpx/gpx-analyzer.js) (lines 91–100) returns immediately without a download link. | Weather needs an independent saved-ascent entry point, running in the isolated world. |
| Placement | The analyzer creates `bpb-route-explorer` and moves the map, legend, fullscreen link, and analysis into it (lines 407–448). | Mount below the whole route explorer; handle its later appearance without creating a second card or putting weather inside the chart. |
| Missing-track layout | [Saved-ascent layout](../../src/ascent/ascent-layout.js) already runs independently of GPX and backup. | Without an explorer, place weather below the native map section, or after ascent/report metadata if no map exists. Preserve native actions. |
| Date accuracy | [Ascent reader](../../src/ascent/ascent-page.js) (lines 75–98) accepts impossible dates and can fall back to arbitrary body text. A local probe returned `2024-02-31`, `2024-13-01`, and `2024-00-00`. | A weather-specific subject reader must require one authoritative, complete, valid ascent date. Keep existing backup fallback semantics unless separately changed and tested. |
| Peak identity | The ascent reader selects the first peak link anywhere in the document (lines 50–54). | Verify the ascent's native peak identity, excluding report links, menus, and unrelated map centers, before fetching summit metadata. |
| Summit metadata | [Peak links](../../src/maps/peak-links.js) (lines 14–50) already recognizes the labelled WGS84 decimal coordinate and Nation rows. The masked Rainier and Garibaldi fixtures contain both. | Read the identity-matching peak page through the existing bounded Peakbagger transport when the ascent lacks authoritative coordinates; no GPX or reverse-geocoding service is required. |
| Fixture completeness | [Ascent-reader fixture](../../test/fixtures/pages/climber-ascent.html) has date/peak identity but no map or coordinates. [Browser fixture](../../scripts/browser-verification-fixtures.mjs) (lines 350–371) has the map but lacks date/peak identity. | Add a representative combined fixture and a genuine no-GPX variant; neither existing fixture alone proves the feature. |
| Time ownership | [Mountain time](../../src/time/mountain-time.js) already resolves summit zones locally and converts civil time, including DST gaps/folds. | Reuse it for the summit's historical calendar day; do not add a second timezone resolver. |
| Request boundary | [Peakbagger transport](../../src/peakbagger/peakbagger-request.js) only accepts Peakbagger and includes site credentials. | Use a separate fixed-host weather client with credentials omitted. Do not broaden that transport. |

## Provider research and live probes

Primary references:

- [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
- [Historical Forecast API and model coverage](https://open-meteo.com/en/docs/historical-forecast-api)
- [Official model and route definitions](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/ForecastapiController.swift)
- [Usage terms and provider retention](https://open-meteo.com/en/terms)
- [Pricing and request accounting](https://open-meteo.com/en/pricing)
- [Chrome content-script requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Firefox content-script requests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)

Eleven small, unauthenticated Open-Meteo requests were run during this
investigation. These used public summit coordinates, one UTC day per request,
and at most six hourly variables. They did not use a user's ascent record or GPX.

| Probe | Observed result |
| --- | --- |
| Rainier, 2024-07-01, historical forecast `gfs_hrrr` | HTTP 200; 24 finite values each for weather code, temperature, precipitation, wind, gusts, and cloud cover. |
| Rainier, 2018-01-01, `gfs_hrrr` | HTTP 200; temperature/wind/gust/cloud arrays complete, but weather code and precipitation each had one null. HTTP success does not establish complete weather. |
| Honolulu, 2024-07-01, `gfs_hrrr` | HTTP 400, no data for the location. United States nationality does not establish CONUS coverage. |
| Rainier, 2024-07-01, archive `ecmwf_ifs` | HTTP 200; all six variables complete. |
| Rainier, 2000-07-01, archive `era5_seamless` | HTTP 200; all six variables complete. |
| Garibaldi, 2024-07-01, historical forecast `gem_hrdps_continental` | HTTP 200; all six variables complete. |
| One request to each API host with `Origin: https://www.peakbagger.com` | Both returned `Access-Control-Allow-Origin: *`. Direct CORS access is promising; actual isolated-world Chrome/Firefox requests remain a verification gate. |
| Two forecast models in one request | HTTP 200; one hourly object with model-suffixed variable keys, rather than separate model objects. |
| Rainier winter date 2024-01-15, timezone America/Los_Angeles | Returned offset −7 hours and first instant 07:00 UTC. Historical winter midnight there is 08:00 UTC. |
| Rainier DST date 2024-03-10, same timezone | Returned 24 samples starting 07:00 UTC. The actual local day starts 08:00 UTC and lasts 23 hours. |

The last two results confirm the documentation's fixed-offset caveat. Do not
build the card from provider daily aggregates or assume that `timezone=auto`
reconstructs the ascent's historical local day correctly.

Responses also report a selected grid coordinate differing from the summit
and a downscaled elevation. Validate these and retain them for source details;
do not relabel the grid coordinate as the requested summit.

## Card behavior and presentation

- Heading: **Weather**, with the saved date and **At the summit** underneath.
- Default compact summary: condition icon and plain-language condition,
  temperature range, precipitation total, maximum wind, and maximum gust.
  Use existing unit preferences, including metric/imperial formatting.
- Model control: **Auto (recommended)** plus explicit eligible model choices.
  Always show the actual model used, its resolution, and whether the result is
  an archived operational-model estimate or reanalysis.
- Provide a restrained expandable hourly view for local-time temperature,
  precipitation, and wind. This should remain useful without GPX timestamps.
  Do not synchronize weather to GPX selection in the first implementation.
- Footer: concise estimate wording and linked Open-Meteo attribution. Keep
  provider mechanics and model-selection rationale in source details.
- A day summary may say that rain or snow occurred; it must not call the whole
  day clear merely because the most frequent hourly code is clear. Condition
  precedence must be explicit and tested rather than numeric code sorting.
- Loading has a stable card skeleton and a short status. Changing models keeps
  the previous result visibly labelled while loading, then replaces it only
  after a valid response. Error copy offers Retry or another eligible model.
- Missing precipitation samples suppress a purported complete-day total or
  label it partial. Missing fields display unavailable, never zero. Optional
  fields such as snow depth must not disqualify otherwise useful models.
- Unknown/month-only/year-only/invalid dates keep an explanatory card but make
  no weather request. Dates before supported archives and future dates have
  their own unavailable states. An ascent recorded today can show a clearly
  labelled partial day, without including future hours.
- Works for a visitor's ascent and for the owner's ascent. No edit-form or
  ownership permission is needed; no Peakbagger weather fields are modified.
- Light/dark themes, keyboard operation, labelled select, visible focus,
  `aria-busy`, bounded live status, reduced motion, and narrow layouts are
  acceptance requirements. Do not add a second units or date picker.

## Model selection and availability

There is no established universal accuracy winner. **Recommended** describes a
documented product policy for date, location, archive coverage, and required
variables; it must not imply a validated ranking of every model.

The registry must be packaged code with exact endpoint/model identifiers,
display labels, archive start/end dates, resolution, native temporal interval,
domain coverage, and core/optional variable support. Do not assume that all
choices in the forecast configurator have historical data. Avoid seamless
provider aliases when the card promises a single named model.

Proposed recommendation policy:

| Location/date | Preferred candidate | Fallback |
| --- | --- | --- |
| Lower 48, from 2018, within the HRRR domain | HRRR | IFS, then ERA5-Seamless/ERA5 |
| Canada, within the documented HRDPS domain and its archive | HRDPS Continental | IFS, then ERA5-Seamless/ERA5 |
| Other supported regional domains | Appropriate regional model, after verifying domain, archive, and fields | IFS, then ERA5-Seamless/ERA5 |
| Global, including Alaska/Hawaii, from 2017 | IFS | ERA5-Seamless/ERA5 |
| 1950–2016 | ERA5-Seamless | ERA5 |
| 1940–1949 | ERA5 | Unavailable if required data are missing |

Country selects a regional preference, never proves coverage. Unknown or
multiple nations use the coordinate-based/global fallback. A broad rectangular
bounding box must not claim exact regional-grid coverage. Port documented
domain checks or conservative footprints, then treat provider refusal as
authoritative.

The dropdown should include all documented historical candidates eligible for
the date and coordinate, including overlapping regional models and global
alternatives. Older European dates can include CERRA within its finite archive.
An actual missing archive slice can still invalidate a metadata-eligible
choice. Explain that failure, disable it for this subject/session, and leave
the user's prior result intact. Do not eagerly query every model just to build
the menu, or silently display another model under the chosen model's name.

Auto may try a short, bounded fallback chain only for missing/incomplete core
data or unavailable coverage. Show the model that supplied the result. Timeouts,
HTTP 429, and server failures must not trigger a cascade of requests; preserve
the result and present the failure. An explicit model selection never silently
falls back.

Each regional recommendation beyond the two live-probed examples needs an
official domain/date reference and a small external probe before it becomes an
Auto default. Global fallback keeps the card useful while those defaults are
being verified. This is an explicit remaining coverage task, not proof that all
countries are already supported at their finest resolution.

## Correct ascent-day aggregation

1. Validate the saved date in its authoritative native row and validate the
   summit coordinate. Resolve its zone using the packaged mountain-time module.
2. Request a bounded UTC window covering the local day, using `timezone=GMT`
   and `timeformat=unixtime`. A three-UTC-day window is sufficient; the rendered
   result still represents just one ascent date.
3. Compute the start and next-day start in the historical summit zone. Retain
   instantaneous samples in that interval; do not assume 24 hours. Preserve
   repeated fall-back hours as distinct instants and disambiguate hourly labels.
4. Precipitation represents the preceding hour. Select accumulation intervals
   by their overlap with the local day, including the following midnight's
   interval and excluding the interval ending at the starting midnight. Handle
   fractional-hour zones and state any proportional-allocation estimate.
5. Aggregate only complete coverage into whole-day totals. Define completeness
   using the model's native interval and returned values, rather than treating
   interpolated hourly values as independent measurements. Never coerce nulls
   to numbers. Weather-code coverage has its own availability state.
6. Label an estimated longitude timezone when the existing offline resolver
   falls back. Reject skipped civil dates rather than moving weather to another
   day. Truncate a current day at the current instant and mark it incomplete.

## Architecture and data handling

Add a standalone isolated-world ascent weather bundle and stylesheet in
[manifest.json](../../manifest.json) and
[build configuration](../../scripts/build-config.mjs). Proposed modules:

```text
src/weather/weather-models.js       pure registry, eligibility, recommendations
src/weather/weather-day.js          pure UTC/local-day filtering and aggregation
src/weather/open-meteo-client.js     fixed-host request and response validation
src/ascent/ascent-weather-subject.js authoritative ascent and summit metadata
src/ascent/ascent-weather.js        card lifecycle, placement, selection, rendering
src/ascent/ascent-weather.css       existing visual language and theme tokens
```

The subject reader may share the existing peak-details parser after a focused
extraction with unchanged peak-link behavior. Do not couple weather startup to
the MAIN-world GPX analyzer, Chart.js, terrain activation, or backup. Prefer a
small idempotent placement observer scoped to the native map container; it must
move the existing card below a newly created route explorer and disconnect on
teardown. Guard missing maps and native table constraints.

Use direct CORS fetch from the isolated content script if both packaged
browsers confirm it works. This avoids a general-purpose worker request bridge
and new host permissions. A worker alternative is a later, explicit design
change if browser proof requires it, not an automatic broad permission grant.

Weather requests use fixed HTTPS API hosts, allowlisted model IDs/variables,
bounded dates, `credentials: omit`, `referrerPolicy: no-referrer`, and no API key.
Reuse [request deadlines](../../src/net/request-deadline.js) and bounded body
reading. Validate JSON shape, aligned arrays, units, timestamps, numeric ranges,
and returned coordinate/elevation. Use text nodes and packaged icons, not
remote code, provider HTML, or remote image assets.

The requested default is automatic display. Fetch once when the card approaches
the viewport, after subject validation, and again only for explicit model
changes/retry. Document this new automatic transfer in [PRIVACY.md](../../PRIVACY.md)
and store disclosures before shipping. Open-Meteo receives summit coordinates,
the narrow date window, requested model/fields, and ordinary request metadata
including IP; its policy says API logs may contain coordinates and are deleted
after 90 days. Send no ascent/climber IDs, names, report, GPX, account credentials,
or referring ascent URL.

Use a small bounded per-tab memory cache keyed by coordinate, elevation policy,
date/window, model, and data schema. No persistent ascent/weather history,
browser-sync cache, or GitHub export is needed. Deduplicate in-flight requests;
abort superseded requests and invalidate generations on selection/pagehide.
Reuse [page lifecycle](../../src/ui/page-lifecycle.js) for BFCache suspension
and restoration. Preserve a previously verified result on refresh failure.
Do not cache failures indefinitely or retry shared-IP rate limits automatically.

Free hosted access is limited to non-commercial use and requires attribution.
The current extension describes no advertising; retain that boundary. A future
commercial distribution needs the appropriate provider plan and credential
architecture rather than putting a shared commercial key in shipped JavaScript.

## Focused implementation sequence

Commit each completed unit after its checks pass:

1. Strict subject reader and historical-day policy, with no-GPX/date/identity/
   timezone regression coverage. Extract shared parsing only where needed.
2. Packaged model registry and fixed-host client, with data completeness,
   availability, cancellation, limits, and response-contract tests. Verify all
   Auto regional defaults against official coverage and limited live probes.
3. Independent card, placement, model selection, theme/units, and bundle wiring;
   include the privacy/attribution documentation in this coherent feature unit.
   Verify the rendered result and real manifest before committing it.
4. Broaden the browser fixture matrix and finish the source-grounded closure
   record. Fix verifier failures before calling the feature complete.

## Verification and completion criteria

- Pure tests: valid/partial/impossible dates; conflicting native identity;
  malicious report links; date-window bounds; archive cutoff/latency; overlap
  and outside-domain choices; no eligible model; null/NaN/unknown WMO codes;
  partial totals; unit conversions; timeout/body-size/429 behavior; superseded
  requests; no silent explicit-choice fallback.
- Civil-day tests: winter offset differing from the current offset; 23-/25-hour
  days; half-/quarter-hour zones; precipitation ending at midnight; date-line
  locations; skipped dates; native 3-/6-hour data; partial current day.
- Bundled DOM tests: card with GPX, broken GPX, absent GPX, absent map, and
  another climber's ascent; map/analyzer appearing later; ambiguous/missing
  summit data; invalid date performs no request; model changes during a slow
  response; theme/units changes; suspend/resume and teardown.
- Hidden real Chrome and Firefox: real unpacked `dist/`, HTTPS Peakbagger-host
  fixtures, fixed API response interception, actual isolated-world CORS,
  correct manifest/script worlds, and no credential/referrer leakage. Use
  [existing browser verifier](../../scripts/verify-extension.mjs) and its
  launch guard/teardown; never disturb the user's browser.
- Render and inspect at 375, 768, and 1440 pixels in both themes, with/without
  GPX, loading, error, partial data, and a long model name. Assert final visible
  postconditions and card geometry. Hidden screenshots do not prove native
  focus placement, browser chrome, or screen-reader speech.
- Required implementation checks: `npm test`, `npm run lint`, and
  `npm run verify:browsers`. Run further graphics checks only if map/terrain
  behavior changes. Inspect exact test processes/profile paths for teardown.
- Minimal read-only live Peakbagger inspection in the existing authenticated
  profile must confirm native subject and placement selectors before release.

## Investigation evidence and remaining proof

Established: current source boundaries and representative fixture fields;
strict-date admission problem reproduced; six core-variable model probes;
two CORS-header probes; multi-model response shape; two historical timezone
boundary probes. No runtime code has changed.

Local checks run for this documentation unit: `git diff --check` passed, and
`node --test test/project/documentation.test.mjs test/ascent/ascent-page.test.mjs test/time/mountain-time.test.mjs`
passed all 15 tests. These verify document references and existing reader/time
behavior; they do not establish a weather implementation.

Not yet established: authenticated live ascent markup, complete regional-model
eligibility/ranking, every model's historical variable coverage, actual packaged
browser CORS, weather-card layout, accessibility speech, or a rendered card.
The existing Firefox main-session connector returned no Marionette listener;
no browser was launched and no user tab was changed. These gaps remain explicit
implementation/release gates.

This investigation does not classify the requested feature as implemented,
fixed, or visually verified. After implementation, retain separate records for
fixed and verified behavior, intentional boundaries, and changes whose external
proof is still incomplete.
