# Historical weather on individual ascent pages

Investigated: 2026-10-10. Implemented and verified locally: 2026-10-11.
Status: archived implementation record; external release proof remains explicit
in the closure ledger below. Maintained runtime design: [ascent-weather.md](../ascent-weather.md).

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

## Investigation evidence before implementation

Established: current source boundaries and representative fixture fields;
strict-date admission problem reproduced; six core-variable model probes;
two CORS-header probes; multi-model response shape; two historical timezone
boundary probes. At this stage, no runtime code had changed.

Local checks run for this documentation unit: `git diff --check` passed, and
`node --test test/project/documentation.test.mjs test/ascent/ascent-page.test.mjs test/time/mountain-time.test.mjs`
passed all 15 tests. These verify document references and existing reader/time
behavior; they do not establish a weather implementation.

At this stage, not yet established: authenticated live ascent markup, complete regional-model
eligibility/ranking, every model's historical variable coverage, actual packaged
browser CORS, weather-card layout, accessibility speech, or a rendered card.
The existing Firefox main-session connector returned no Marionette listener;
no browser was launched and no user tab was changed. These gaps remain explicit
implementation/release gates.

## Implementation closure ledger — 2026-10-11

### Fixed and verified

| Work | Result and evidence |
| --- | --- |
| Authoritative subject | Dedicated strict date/summit reader rejects partial or impossible dates, conflicting native identity and mismatched peak pages. Invalid dates make no summit or API request, including after BFCache restore. Negative elevations retain their sign. |
| Independent placement | Separate isolated bundle and stylesheet mount below the whole route explorer, below the native map without GPX, or after metadata without a map. Bundled DOM and real Chrome/Firefox fixtures verify a single card and late analyzer placement. No new API host permission or worker route. |
| Model policy and transport | Registry contains 37 date/location candidates. Auto prefers eligible HRRR/HRDPS, then IFS/ERA5; explicit choices never fall back. Fixed hosts, omitted credentials/referrers, response validation, body/deadline bounds, cancellation, memory-only cache, rate-limit stop and explicit fresh Retry have regression coverage. Seven additional public API probes returned usable data for HRRR, HRDPS, IFS, ERA5 blend, ERA5 Ensemble, CERRA and IFS Assimilation. |
| Historical local day | Offline historic summit timezone, 23/25-hour days, half/quarter-hour offsets, skipped civil dates, date-line eligibility, partial current day, sparse native series and final-midnight precipitation have tests. UTC padding clips at archive boundaries. Missing measurements remain unavailable or labelled partial. |
| Card behavior and presentation | Daily condition, temperature range, precipitation, max wind/gust, actual source/model, unit changes, accessible disclosure and keyboard tabs, local hourly charts, partial/error/retry and retained results during model changes are implemented. |
| Real weather surfaces | `npm run verify:weather` passed in hidden Chrome 153.0.8010.12 and Firefox 157.0.1 at 375, 768 and 1440 CSS pixels, both themes, with GPX/no-GPX/no-map, loading, long model name, partial data, rate limit and invalid date. Screenshots were inspected for spacing, wrapping and clipping. Charts are native SVG/CSS; no WebGL weather renderer. Intercepted requests assert no cookies, authorization, referrer or ascent identity. |
| Live provider CORS | One real public-Rainier HRRR request from the packaged isolated card passed in each hidden browser at 1440×1100, without extra permissions. These establish actual browser CORS, not live Peakbagger selector compatibility. |
| Project checks and cleanup | `npm test` passed all 2474 tests; `npm run lint` passed with the existing owned warning baseline. `npm run verify:browsers` passed Chrome at 1000×760 but exposed an existing stale Firefox photo-pagination seed. A separate one-line fixture correction now uses distinct source hashes, matching Chrome; the full Firefox verifier then passed at 1000×760. Both report teardown passed; exact disposable process prefixes were checked and no test browser remained. |
| Public contract | README, architecture/development notes, focused design, privacy policy and generated Chrome store description document the automatic public-summit/date-window transfer and model-estimate limits. |

### Intentionally not changed

- Backup's best-effort date/peak reader, native weather/report fields, ownership
  controls, GPX analysis, native map layers and the user's Save flow stay unchanged.
- Date alone selects a daily summit estimate; no GPX-derived ascent time,
  route-weather synchronization or multi-day trip inference is introduced.
- Auto is a documented product recommendation, not an accuracy ranking. Outside
  the verified US/Canada regional preference, global IFS/ERA5 defaults apply;
  eligible regional alternatives remain selectable. Other regional admission
  footprints are conservative and may omit domain-edge locations.
- Forecast/reanalysis estimates remain distinct from observations. Surface-only
  and no-precipitation models expose missing fields. No persistent weather history,
  API key setting, reverse geocoding or privileged API permission is added.

### Changed but not fully proven

- **Live Peakbagger markup:** current authenticated ascent selectors and placement
  remain a pre-release manual check. Masked fixtures establish the packaged
  behavior; the available authenticated Firefox connector was unavailable and
  existing Chrome tabs did not supply an authenticated ascent. No user tab or
  login state was changed for this task.
- **All model slices and accuracy:** the registry follows official starts and
  routes, but each regional/date/variable slice and native interpolation behavior
  has not been live-probed. Provider refusal disables a candidate until Retry;
  null or sparse results are labelled partial. A finer grid does not establish
  more accurate summit wind or precipitation.
- **Native accessibility and browser UI:** hidden DOM interaction and screenshots
  do not prove screen-reader speech, native select menus, focus/window placement,
  or visible browser chrome. Firefox's broad smoke did not actually restore from
  BFCache in this run; weather suspension/restore has bundled lifecycle coverage.
- **Hosted verification/publication:** no hosted CI, push, store update or release
  was performed. Free hosted usage is subject to the provider's non-commercial
  terms and attribution documented in the public privacy contract.

Implementation commits: `aff4884` (subject/civil day), `a392b34` (models/client),
`4317ebb` (card, integration and public contract). Separate verifier repair:
`fa5ed33` (Firefox pagination fixture). These closure categories travel with the
archived plan; local green checks do not erase the external proof gaps.

## Right-column placement follow-up — 2026-10-11

The user's placement revision supersedes the original below-explorer layout:
weather now sits beneath Summary Total Data in the resizable right column,
independent of report length or a later GPX explorer. Unrecognized table layouts
retain the original map/metadata fallback. Container queries adapt the card to
the divider width, and long table text wraps instead of overlapping the other
column. Narrow pages retain the existing stacked report/summary arrangement.

Fixed and verified: 19 focused layout/weather tests, all 2475 `npm test` tests,
and `npm run lint` passed with the existing owned warning baseline. Both full
extension browser gates passed at 1000×760. The weather verifier passed in
hidden Chrome 153.0.8010.12 and Firefox 157.0.1 at 375, 681, 768 and 1440 CSS
pixels, both themes, with long reports and divider extremes. Real page/card
screenshots were inspected for wrapping and overlap. The initial divider check
exposed intrinsic report-table overflow; the wrapping correction passed the
same check in both browsers. Both verifiers reported teardown passed.

Intentionally preserved: native tables, divider bounds and interactions,
weather/model behavior, GPX analysis and user-owned browser state. The live
authenticated-markup and native accessibility proof gaps above remain open;
hidden fixture evidence does not establish those behaviors.

## GPS footer and card wording follow-up — 2026-10-11

### Fixed and verified

- Dedicated native GPS warning and download/send blocks now sit together above
  **Weather archive** in the right column. The same original nodes and handlers
  survive late layout insertion and persisted history restore. Shared footer
  paragraphs move once; report quotations and ambiguous warning blocks stay
  untouched. No map, report table or ownership control is moved into the group.
- The bottom-right credit reads **Community support by Open-Meteo**, retaining
  the provider link. Narrow layouts wrap the credit and four send buttons.
- Built-bundle checks passed all 2477 tests with
  `node --test 'test/**/*.test.mjs'`; the focused layout/weather/handoff run
  passed 34 tests. `npm run lint` passed with the existing owned warning
  baseline. Hidden Chrome 153.0.8010.12 and Firefox 157.0.1 weather fixtures
  passed at 375, 681, 768 and 1440 CSS pixels in both themes, including native
  GPS notes, real provider controls, late analysis and divider extremes. Page
  and card screenshots were inspected in both browsers. Weather charts remain
  native SVG/CSS. The full Chrome unpacked-extension verifier also passed at
  1000×760, with an actual BFCache restore. All three reported teardown passed;
  the exact weather profile paths were confirmed removed, and process inspection
  distinguished task-owned cleanup from unrelated browser checks.

### Intentionally not changed

GPX download URLs, provider consent/transfer behavior, native map placement,
model policy, lazy weather requests and the no-GPX card remain unchanged.
Unrecognized or ambiguous native content stays in place instead of moving an
entire map/report container.

### Changed but not fully proven

The existing live authenticated-markup and native accessibility gaps remain.
A single public-ascent HTML request returned HTTP 403, so no live native DOM
was used as layout proof; representative fixtures and the user's screenshots
establish the tested layout. Hidden checks do not prove screen-reader speech,
native select menus or onscreen focus/window behavior. No user tab, push or
release was changed.

## GPX hourly cursor follow-up — 2026-10-11

This requested presentation feature supersedes the initial decision to omit
GPX time synchronization. Weather requests still use the saved ascent date and
summit; the cursor does not fetch weather along the track.

### Fixed and verified

- GPX hover previews a dashed cursor, while click and arrow-key selection retain
  a solid cursor. Leaving the GPX graph restores the selected time. Hourly weather
  stays under the user's disclosure control. Measurement/model/unit changes and
  resizing preserve the cursor without rebuilding weather data on each hover.
- The MAIN/isolated channel admits only exact-shape, same-window/same-origin
  timestamp/flag messages. Updates coalesce per frame, late subscriptions request
  a snapshot, suspension clears hover, and disposal cancels listeners/frames.
  No coordinates, track objects, storage writes or privileged actions are added.
- Reliable epochs map into the summit's historical day. Missing/suspect/constant
  GPX times and points outside that day have no line, with a concise explanation.
  Regression coverage includes repeated DST hours, malformed messages, hidden
  hourly state, persistent selection, source-series removal and BFCache restore.
- All 2486 built-bundle tests passed with
  `node --test --test-concurrency=1 'test/**/*.test.mjs'`. The initial focused
  cursor/analyzer/weather/manifest run passed 104 tests, and the final
  weather/manifest/documentation/development run passed 62. `npm run lint` passed
  with six existing owned warnings; the subsequently expanded weather test also
  passed ESLint.
- Real unpacked-extension checks passed in hidden Chrome 153.0.8010.12 and
  Firefox 157.0.1 at widths 375, 681, 768 and 1440, height 1100, both themes.
  Physical pointer/click gestures crossed from the real MAIN Chart.js canvas
  into the isolated weather SVG, restored selection, retained the collapsed
  disclosure, and made no additional API requests. Selected-cursor screenshots
  were inspected in both browsers at mobile/desktop widths for clipping and
  wrapping. Weather rendering uses native SVG/CSS. Full Chrome verification
  passed at 1000×760 with an actual BFCache restore. All three reported teardown
  passed; exact weather profiles were removed and process inspection found no
  remaining task-owned verification browser.

### Intentionally not changed

Weather model policy, saved-date/summit request identity, no-GPX behavior, hourly
model values, native report fields, route geometry, settings bridge permissions,
and provider consent/transfer behavior retain their existing boundaries. No
minute-level weather interpolation or reverse weather-to-GPX selection is added.

### Changed but not fully proven

Live authenticated Peakbagger markup and native screen-reader speech remain
unverified. Hidden fixtures establish rendering and interaction, but do not prove
onscreen focus/window placement or browser chrome. No user tab, push or release
was changed.

## Hourly conditions follow-up — 2026-10-11

### Fixed and verified

- The fourth hourly tab, **Conditions**, lists local times, icons and precise
  hourly descriptions, including rain/snow intensity and heavy thunderstorm
  code 97. It uses the existing response without an additional request. Unknown
  codes and missing hours stay unavailable; models without codes explain why.
  Repeated DST clocks carry distinct zone labels. All four tabs support keyboard
  arrows and Home/End, and the list is a labelled keyboard-scrollable region.
- GPX hover/selection highlights the corresponding hourly row. Switching to
  Conditions can reveal that row inside the list; hover never scrolls. Switching
  back retains the numeric graph cursor. Phone and narrow-sidebar layouts wrap
  controls and condition descriptions without horizontal overflow.
- All 37 weather tests and 20 documentation/development checks passed. Hidden
  Chrome 153.0.8010.12 and Firefox 157.0.1 passed the real-extension weather
  fixtures in both themes at 375/681/768/1440×1100, including no-GPX, missing
  model fields, divider extremes and selected-hour highlighting. Screenshots
  were inspected at desktop, phone and minimum-sidebar widths. Rendering uses
  native HTML/CSS and the existing SVG numeric graphs. Full hidden Chrome
  verification passed at 1000×760 with BFCache restore. Exact profiles/processes
  were checked; all three browser verifiers reported teardown passed.
- Concurrent Buddy List edits changed the shared tree during its broad gates:
  two unrelated tests failed and the build could not resolve its new helper.
  Those edits were preserved. A disposable Git snapshot of `32f1c1d` with only
  the seven hourly-weather files passed `npm test` (2490/2490), full ESLint,
  and web-ext lint with six existing owned warnings.

### Intentionally not changed

Saved-date/summit requests, daily condition precedence, default Temperature tab,
model policy, native report fields, settings permissions and provider transfers
retain their existing boundaries. There is no minute-level condition inference.

### Changed but not fully proven

Combined-checkout verification with the concurrent Buddy List work remains
separate from this isolated result. Live authenticated markup, native screen-reader
speech, and onscreen focus/window behavior remain unverified by hidden fixtures.
No user tab, push or release was changed.
