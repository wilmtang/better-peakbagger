# Weather

The single maintained guide for Open-Meteo weather in Better Peakbagger:
peak forecasts/history, ascent-day archives, experimental summit clouds, air
quality, request counts, data contracts and audit evidence. Updated October 25,
2026. [Privacy](../PRIVACY.md#summit-weather) owns the public transfer contract;
[card conventions](card-conventions.md) own shared UI implementation rules.

**A default peak can automatically make 5 Open-Meteo requests:** 1 for Summit
weather and 4 for Automatic Summit Cloud Cover. Loading waits until each enabled,
expanded card is on screen or within 200 px. Disabled, collapsed and distant
cards do not start hidden weather downloads. Actual network requests and the
provider's weighted quota units are different; both are explained below.

- [API calls by user action](#api-calls-by-user-action)
- [Endpoint purposes](#what-each-endpoint-does)
- [Peak forecasts and map-point weather](#peak-forecasts-and-map-point-weather)
- [Historical ascent weather](#historical-ascent-weather)
- [Summit Cloud Cover](#summit-cloud-cover)
- [Air quality](#air-quality)
- [Time, transport and privacy](#time-transport-and-privacy)
- [Provider quota and cost](#provider-quota-and-cost)
- [Implementation and verification](#implementation-and-verification)
- [Research and unimplemented options](#research-and-unimplemented-options)
- [Audit closure ledger](#audit-closure-ledger)

## API calls by user action

“Calls” in this table means actual network requests to Open-Meteo. Counts are
additional requests for that action, assuming success. “First load” means that
card/model/date has no usable result cached in this page. The default weather
model is GFS; default cloud selection is Automatic. Model choices are saved;
the selected cloud date and downloaded forecasts remain in the current page.

| What the user does or sees | New requests | What those requests are used for |
| --- | ---: | --- |
| Opens a peak; both expanded cards are near the viewport | **5 total** | 1 loads the weather forecast/history; 2 load atmospheric profiles from two cloud models; 2 check when those cloud models last updated |
| Opens a peak with both cards collapsed, disabled or still far below the viewport | **0 initially** | No hidden weather download; scroll/expansion/enabling can trigger loading later |
| Scrolls near or first expands **Summit weather** | **1** | Fills the 16-day forecast and Past 16 days from one download, including hourly readings |
| Scrolls near or first expands **Summit Cloud Cover**, model = Automatic | **4** | Compares two models: 2 profile downloads + 2 update-time checks; displays hourly cloud obstruction/inside-cloud estimates and confidence |
| First loads Summit Cloud Cover with one manually selected model | **2** | 1 model's profiles + 1 update-time check; there is no second model comparison |
| Changes cloud model to an uncached manual model | **1–2** | 1 profile download; +1 if that model's update-time record is not fresh in this card's cache |
| Changes cloud model to Automatic, with uncached profiles | **2–4** | 2 profile downloads; +0–2 update-time checks depending on cached records |
| Selects another uncached cloud date with the same Automatic models | **2 while update records are fresh; otherwise 4** | Loads that selected day's hourly profiles, rather than all dates offered by the menu |
| Selects another uncached date with a manual cloud model | **1 while its update record is fresh; otherwise 2** | Loads one model's selected day |
| Returns to a cloud model/date still cached within five minutes | **0** | Uses the downloaded result; cache holds up to 6 model/date entries |
| Clicks cloud **Earlier**, **Later**, an hour, or **Why this prediction** | **0** | Changes the view/explanation of already-loaded data |
| Clicks cloud **Refresh**, Automatic | **2 with fresh update records; otherwise 4** | Re-downloads both profiles even when profile data is cached; update records retain their five-minute cache |
| Clicks cloud **Refresh**, manual model | **1 with a fresh update record; otherwise 2** | Re-downloads that one model's profiles |
| Switches Summit weather between **16-day forecast** and **Past 16 days** | **0 weather downloads** | Both tabs were downloaded together. If Source details is open, switching to a different uncached model may add update-time requests described below |
| Opens a weather day or changes its hourly chart metric | **0** | Reads already-downloaded hourly data |
| Opens weather **Source details** for default GFS | **2 on first opening** | Shows separate GFS 13 km/25 km last-update, next-expected-update and update-interval rows |
| Reopens weather Source details within five minutes | **0** | Reuses its update-time records, unless Weather Refresh cleared them |
| Opens Source details for another selected weather model | **Usually 1; 0 for Best Match/unmapped models** | One update-time record for a mapped model; never a new weather forecast just to open the disclosure |
| Clicks weather **Refresh**, Source details closed | **1** | Re-downloads forecast/history; preserves usable old content while pending |
| Clicks weather Refresh, GFS Source details open | **3** | 1 weather download + 2 update-time records; this refresh clears the weather card's metadata cache |
| Changes the weather model to an uncached selection | **1; plus 0–2 if Source details is open** | Reloads the combined forecast/history request, then update times for the displayed model if requested |
| Selects **Air quality** for the first time | **1** | Shows hourly US AQI and PM2.5 for five days; surface regional estimates, not summit measurements |
| Reselects Air quality within five minutes | **0** | Reuses the current location's downloaded AQI forecast |
| Clicks Air quality **Refresh** | **1** | Re-downloads AQI/PM2.5 |
| Uses the map's explicit weather action for a new point | **1 weather request; +1 if AQI is active; +0–2 if Source details is open** | Shows weather/AQI for the selected point; cloud predictions remain for the summit |
| Resets from map-point weather to a fresh retained summit result | **0 weather requests** | Restores the summit's cached weather. Stale summit data needs 1 weather request; active AQI/source details can independently need their own records |
| Changes units/theme, moves a card, or browses its loaded hours | **0** | Reformats/repositions existing data |
| Collapses a card while its read is pending | **0 new requests** | Cancels the pending read and keeps retained results; a request already sent may have reached the provider |
| Re-expands a card with fresh retained data | **0** | Reuses the result; an empty/expired card loads according to its rows above |
| Returns to a browser tab with expired weather/cloud data | **Weather: up to 1 forecast + 0–2 source records; Automatic cloud: up to 4** | Eligible cards near the viewport refresh stale data. Source records require open Source details; clouds can use 2 if only their profiles expired; active AQI can add 1 |
| Reloads the page or opens the peak in another tab | **Starts the initial budget again** | Page-memory caches do not survive reload and are not shared across tabs |

There is **no unconditional five-minute polling loop**. Five minutes is a cache/
freshness threshold, not a timer that continually downloads forecasts. Settings,
visibility, lifecycle, explicit refreshes and selections decide when to load.
429 cooldowns, invalid identity/elevation and failed profiles can reduce actual
request attempts. Rapid selections, reloads and aborted requests can add attempts.

## What each endpoint does

| Request and trigger | Downloaded data | What it changes on screen |
| --- | --- | --- |
| **Summit weather:** `/v1/forecast`, when weather first loads or is refreshed/model-changed | Surface temperature, feels-like temperature, precipitation, wind/gusts/direction, weather code, day/night, total cloud cover and freezing level; past and future days together | Daily weather summaries and hourly tables/graphs in Summit weather. Total sky cloud cover here is different from the cloud-at-summit-height estimate below |
| **Cloud profiles:** `/v1/forecast`, once per selected cloud model when cloud data loads | Temperature, humidity, cloud amount, height and wind at atmospheric pressure levels, for the summit and four surrounding sample points | Summit Cloud Cover's hourly “inside cloud”, “views obstructed”, partial/clear/uncertain estimates and the measurements under Why this prediction |
| **Cloud model update check** (called “freshness” in the initial audit): `/data/<domain>/static/meta.json`, after a valid profile download unless cached | Model-run initialization time, when the run became available, and its normal update interval. No new temperature/cloud forecast is downloaded | Helps detect stale/unverified inputs and adjust confidence or mark an estimate uncertain. It runs even while Why is closed because it affects the prediction, not just explanatory text |
| **Weather Source details:** same `/data/<domain>/static/meta.json`, only when that weather disclosure is open and records are not cached | The selected weather model's provider-wide update clock(s) | Fills the Last update / Next expected / Update interval table in Source details. These records inform the source display; they do not replace the daily weather values |
| **Air quality:** `air-quality-api.open-meteo.com/v1/air-quality`, on AQI selection/refresh | Hourly US AQI and PM2.5, five days, for the current weather location | The Air quality tab's category, AQI and particle-concentration rows |

### Why are there two cloud profile requests?

**Automatic intentionally compares two different forecast models.** For the
Rainier/Washington example today, they are HRRR and GEM HRDPS. The current code
calls the cloud client once per model, so it sends one `/v1/forecast` request for
HRRR and another for HRDPS. Comparing agreement is one input to confidence.

Each of those requests already batches all **five locations** and the selected
day's hours. It is not one request per location or per hour. Choose a single
model in the dropdown and it makes one profile request instead. Two is a choice
of the current implementation, not an Open-Meteo requirement; a future combined
multi-model implementation could reduce HTTP requests without removing the
second model's data or its quota cost.

The two Automatic update-time checks also use different model-domain URLs. These
checks are separate from opening the weather card's Source details. The cards
currently have separate caches, so an overlapping domain can be requested again.

### What does “estimated weighted calls” mean?

It means **estimated usage against Open-Meteo's allowance**, not extra network
requests. A single large request can count as more than one quota call because
it asks for many variables, locations, models or days. The browser still sends
only the HTTP requests counted in the action table.

In the Washington example, one cloud request asks for 72 variables at each of
5 locations. The published calculation gives it a weight of about **36 quota
calls**, even though it is **one network request**. Two models give about 72;
the 32-day normal-weather request adds about 2.29. Thus the default page can
send **5 actual requests**, while its **3 forecast requests** represent roughly
**74.29 quota calls**. The accounting for the other 2 metadata requests has not
been verified. These are source-based estimates, not a live account-usage reading.
See [Open-Meteo pricing](https://open-meteo.com/en/pricing) and the
[calculation and source links below](#provider-quota-and-cost).

## Settings and display

**Settings → General → Show weather forecast and archive** enables peak weather
and ascent weather together, on by default. Summit Cloud Cover has its own
`showSummitCloud` switch; a missing legacy switch inherits the weather choice.
Disabling weather hides its cards, cancels reads and skips ascent summit lookup.
Disabled ascent weather restores native GPS blocks to their original positions.

Units have a general default plus independent distance, elevation, temperature,
precipitation and wind overrides. Temperature controls feels-like; wind controls
gusts; freezing altitude follows elevation. Changes reformat loaded measurements.
Model choices, layout and supported disclosures use validated portable settings
in `storage.sync.bpbSettings`, files and GitHub settings backup. Legacy local
values migrate only where no synced choice exists. Forecast responses, selected
map coordinates and ascent identity are never preference records.

## Peak forecasts and map-point weather

The isolated peak-weather bundle reads the current peak's validated name,
coordinates and elevation. There is no geocoding or extra Peakbagger page fetch.
It mounts after the native map row or in the recognized right table on mapless
peaks; ambiguous identity/layout fails closed. The shared peak layout owns
column/order/disclosure settings. Native map, legend and full-screen links stay
together. Moving a card preserves its controls, selection and downloaded data.

The initial **16-day forecast** shows today plus fifteen days forward; **Past
16 days** shows completed local days, newest first, excluding today. One padded
UTC request serves both. Compact summaries show the most severe available
condition, labelled temperature Low/High, precipitation water equivalent and
maximum wind. Missing hours remain unavailable or partial. Forecast wording
describes expected conditions; historical model output is not a station record.

Each day opens independently. Expanding another leaves existing panels open and
preserves the activated summary's position and keyboard focus. Each day retains
its data tab, pinned reading and table scroll through refresh, unit and period
changes. Conditions is the default hourly tab; the last explicit metric is a
portable preference. Old `snowfall` metric preferences open Rain/snow without
rewriting storage during mount.

| Hourly view | Meaning |
| --- | --- |
| Conditions | Local-time table with condition icons, temperature, water-equivalent rain/snow and wind; sticky labels and horizontal scrolling |
| Temperature | Responsive graph; selected readings include feels-like temperature |
| Rain/snow | Combined precipitation as liquid water equivalent, not new snow depth or snowpack |
| Freezing level | Model altitude of 0°C air above sea level, with summit/selected-height reference where known; not a snowline |
| Clouds | Total sky cloud cover, 0–100%; not cloud base or whether the summit is inside cloud |
| Wind / Gusts | Wind graph includes the direction wind comes from; gust readings preserve their interval contract |

The information button explains the active measurement in an overlay without
adding layout height; Escape closes it and returns focus. Rain/snow explains
Open-Meteo's fixed 1:7 conversion for the *snow portion* when estimating snowfall
depth: 1 cm water becomes 7 cm snow; actual snow density varies. The extension
does not request or display a separate snowfall-depth series.

Hover previews readings; click or arrows/Home/End pins them; Escape clears.
Missing values break graph lines. Nighttime clear hours use Moon icons. Tabs
support keyboard navigation, fit narrow cards and reserve selected-label width.
Unrelated settings retain nodes; necessary rerenders restore valid selections,
table scroll and focus. Expired dates clear selection and return focus to the
period tab. No automatic focus or scroll compensates for asynchronous reflow.

### Peak model selection and Source details

Both periods initially use **GFS** for its 16-day horizon. Their choices are
remembered independently as `bpbPeakWeatherModelPast` and
`bpbPeakWeatherModelForecast`. Named models are filtered by region/date/horizon.
Shorter-range models show useful days with missing boundary hours labelled.
Startup may use GFS for a saved regional model outside the new summit's domain
without overwriting the preference. Explicit in-page failures do not switch model.

**Best Match (Open-Meteo)** uses the Forecast API's automatic location-specific
blend, resolution “Automatic”. It is different from the historical ascent blend.
Two selected named models are combined in one GET, deduplicated if identical.
Replies with multiple models use validated model-suffixed columns. Retained
results identify their actual source/date separately from a pending choice.

**Source details** distinguishes requested coordinates from the returned weather
grid, then describes the displayed model, resolution, estimate type, timezone,
terrain/elevation adjustment, load time and any fractional-interval assumptions.
An automatic blend does not imply one known grid/run or per-value provenance.

Opening it fetches only the displayed period model's provider-wide update clocks.
GFS has 13 km and 25 km records; most mapped models have one; Best Match and
unmapped models make none and show “Varies by model” or unavailable. Update
interval comes from the same metadata record. Next expected is availability time
plus normal cadence, marked delayed if overdue. These clocks do not identify the
exact run behind each stitched forecast hour. Missing metadata never replaces
usable weather; last known clocks may remain labelled through a failed recheck.

### Selected map locations

Right-click the peak's 2D/3D map and activate **Forecast and archive for this
location**. Opening the menu makes no Open-Meteo request. The shared
[map location menu](map-layers.md#location-menu) can separately read approximate
terrain elevation from Mapterhorn even when weather is off. Escape/Tab/Shift+Tab
return focus to the map without moving the page; wheel/scroll/outside controls
dismiss the old location. Modified Escape stays with native/terrain controls.

The selected point uses its own offline timezone and provider terrain elevation,
never the summit's elevation. Unsupported regional choices can use visit-local
GFS without saving that fallback. Previous readings keep their actual location
through a pending/failed switch; first-load labels immediately identify the
requested point. Selecting the same failed point retries it. **Reset to summit**
cancels pending location work, restores both summit model choices and reuses a
fresh retained summit response; stale/absent data needs another request. A failed
reset remains retryable and does not erase a known cooldown. Neither action pans
the map or automatically scrolls. Reload starts at the summit; cloud prediction
always remains for the summit. See the action table for independent AQI/metadata
requests when those subviews are open.

## Historical ascent weather

The isolated archive card reads the saved ascent's strict native date/heading
peak identity, then fetches its matching Peakbagger peak page for coordinates
and elevation. Invalid/partial/impossible dates and conflicting identity fail
closed. Report prose and native weather fields are neither observations nor
fallback dates. Backup's best-effort reader is a separate contract.

The card works without GPX, map, Chart.js, terrain or ownership. It defaults
after Summary Total Data and recognized GPS details in the split summary column.
Header/grip dragging, arrow/Home/End keys and the move menu choose explicit
report/summary and before/GPS/after anchors. Late layout mounting preserves the
same card node. Only its own placement keys (`bpbAscentWeatherColumn`,
`bpbAscentWeatherSlot`) are persisted; a failed save keeps visit-local placement.
Unrecognized layouts use validated map/metadata anchors. Safe dedicated GPS
notes/download/send blocks retain handlers and stay in the summary column when
weather moves; ambiguous blocks, the map, report and GPX Analyzer are not moved.
Disable/disposal restores original GPS nodes. Reduced motion disables settling
animation.

The initial **Best Match (Open-Meteo)** uses `models=best_match` on
`archive-api.open-meteo.com/v1/archive`, blending available ECMWF IFS/ERA5/
ERA5-Land with coverage back to 1940. `bpbAscentWeatherModel` remembers explicit
choices independently of peak weather. A bounded startup read precedes the first
request. Unsupported saved date/region choices use Best Match for the visit
without saving the fallback; explicit failures never cascade through models.
Provider refusal disables a candidate until Retry. Regional admission is an
eligibility test, not proof of every available date/variable slice.

The registry includes named archived forecasts, reanalysis, surface-only and
no-precipitation alternatives; CERRA has a finite 1985–June 2021 archive.
HRRR/HRDPS use mathematical grid admission; other regional footprints are
conservative. Seamless single-provider aliases are excluded to keep names clear;
the explicit ERA5 combination is labelled. Requests use the appropriate archive
or historical-forecast endpoint, never a guessed alternate after failure.

Previous/Next day navigation starts at the saved summit-local date and respects
today, the chosen model's start/end and publication delay. It skips nonexistent
civil dates, never changes the ascent date and never becomes a future forecast.
Loading/failure retains the displayed day/source; Retry targets the failed day.
Hourly expansion and metric survive; old-day reading selection clears.

Conditions, temperature, precipitation bars and wind share the core data/table/
scale rules. Hourly opening/selection makes no request. Missing codes stay
unavailable while other fields remain usable. A keyboard/pointer reading explorer
works without GPX and is independent of GPX selection. Charts use distinct ticks
even for calm/constant wind in either unit system.

On timed GPX ascents, a validated MAIN-world timestamp/flags message provides a
separate dashed hover or solid selected cursor. Pointer exit restores selection;
hourly weather stays closed until opened. Conditions highlights the corresponding
column; an explicit tab switch may reveal it inside the table, while GPX hover
never scrolls. Invalid/suspect/constant times say GPX time unavailable; out-of-day
points say Outside ascent/displayed day. No route coordinates, tracks, privileged
actions or extra provider requests cross the cursor channel. There is no
minute-level weather interpolation or weather-to-GPX selection. BFCache clears
transient hover and requests the Analyzer's current selection on resume.

## Summit Cloud Cover

This **Experimental** peak card estimates cloud at summit height and possible
obstruction nearby. It does not estimate snowpack, blowing-snow whiteout,
visibility in metres or a guaranteed unobstructed view in every direction.
Its thresholds are uncalibrated heuristics, not measured probabilities.

### Cloud models and horizons

The dropdown is a pressure-profile capability allowlist, separate from surface
weather. Each selected model supplies five columns: summit plus four cardinal
points at max(10 km, 1.5 grid spacings). This samples regional air, not a terrain
viewshed. Hourly output may interpolate coarser native steps; unsupported fields
and horizon-boundary hours remain unavailable.

| Model | Approximate profile grid | Nominal horizon |
| --- | --- | --- |
| HRRR | 3 km | Up to 48 h; shorter runs exist |
| GEM HRDPS | 2.5 km | 48 h |
| GEM regional | 10 km | 3.5 days |
| GFS | 25 km | 16 days |
| ECMWF IFS 0.25° | 25 km | 15 days |
| ICON global | 11 km | 7.5 days |
| GEM global | 15 km | 10 days |
| UKMO global | 10 km | 7 days |
| ARPEGE world | 25 km | 4 days |
| ECMWF AIFS | 25 km | 15 days |
| JMA GSM | 55 km | 11 days |
| CMA GRAPES | 15 km | 10 days |

Automatic chooses the first two eligible HRRR/HRDPS/GFS/IFS models for the first
two local dates, then GFS + IFS with a ten-day outlook cap. Manual selection uses
one remembered model and never silently switches; an unsupported saved choice
stays unavailable. Comparison is a design choice, not required to generate a
prediction, and its accuracy benefit has not been measured. Agreement between
deterministic models is not calibrated probabilistic confidence.

GFS profiles use its 25 km product, not the finer surface grid. IFS/AIFS/JMA use
nine native pressure levels; other allowed models use twelve. Six fields per
level produce 54/72 variables. October 2026 Mount Stuart probes established
some field compatibility, including sparse brackets, not universal coverage or
forecast skill. NAM, NBM, IFS 9 km and ACCESS-G lacked required fields in those
probes and remain excluded. Most profile cloud fractions are humidity-derived,
so cloud and humidity agreement is not independent evidence.

### Cloud prediction and orographic limits

`src/weather/summit-cloud-core.js` brackets actual summit height with valid
geopotential layers above model ground. Temperature/cloud/humidity interpolate
linearly; wind interpolates by components. No extrapolation or bracket wider
than 2,200 m is accepted. Duplicate neighboring grid cells are not counted as
independent samples. Missing values never mean clear.

- Cloud fraction ≥60% and humidity ≥85% at summit height: likely inside cloud.
- At least three distinct neighboring cloudy profiles: nearby views likely blocked.
- Moist/cloudy surroundings or moist incoming lower air: partial obstruction.
- Clear requires summit and at least three distinct neighbors at cloud ≤20% and
  humidity <80%, usable airflow and no detected cloudy layer within 500 m.
  Missing neighbors/incoming-air resolution produces uncertainty.
- The orographic check looks upwind within 45° of wind **from** direction,
  wind ≥3 m/s, humidity ≥85% up to 500 m below summit, and lower model ground.
  It flags a tendency. It does not simulate parcel lifting, stability,
  condensation, ice microphysics or a terrain cross-section.
- Model disagreement or a missing Automatic comparison produces uncertainty.
  Grid >10 km, vertical gap >1,200 m, lead >48 h or missing update metadata
  lowers confidence. There is no percentage-confidence claim.
- Updates older than max(18 h, three update cycles) are uncertain. CMA additionally
  requires freshness metadata because of documented delivery interruptions.
  Provider-wide clocks cannot identify each stitched forecast hour's exact run.

Coarse grids can miss narrow ridges, shallow cap cloud, valley fog and sharp
boundaries. Accuracy work must compare archived predictions with timestamped
summit webcams and independent reports, split by mountain/season/lead/wind regime,
and measure false-clear rate/reliability. A better lifting calculation needs a
DEM, upstream thermodynamic profiles and stability. More thresholds alone do
not validate orographic prediction; ensemble spread and satellite observations
are future evidence, not current inputs.

## Air quality

The weather card's **Air quality** tab requests hourly US AQI and PM2.5 from
Open-Meteo/CAMS only on selection. It uses the current summit/map-point location
and offline local time, text categories alongside color and explicit gaps.
It is regional surface output (approximately 45 km globally, 11 km in Europe),
not a summit measurement or a separate smoke/visibility forecast.
Leaving the tab, collapse, opt-out, backgrounding or page suspension cancels
pending work. Returning reuses a five-minute page-memory result; Refresh retains
old data on failure. Results older than thirty minutes are cleared from view.

## Time, transport and privacy

UTC epochs are identities; the packaged offline mountain-time resolver supplies
civil days, repeated/missing DST hours and date-line/fractional offsets. A labelled
longitude estimate is the fallback. Provider requests use GMT/Unix timestamps
because one fixed UTC offset cannot describe a multi-day DST transition.

Peak data includes whole forecast days, including earlier hours of today. It
requests sixteen completed past days plus sixteen forecast days with UTC padding,
capped at today UTC +15 days: missing final local-day hours remain partial.
The client permits at most 33 UTC dates/792 rows, ten fields per model and two
named models. Historical ascent uses at most three UTC dates/72 rows and clips
current-day output at now; skipped dates and future dates are rejected.

Instantaneous temperature/condition/wind use `[start,end)`. Preceding-hour
precipitation includes closing midnight and excludes opening midnight, with
fractional-boundary allocation labelled estimated. Peak and archived-forecast
gusts/CERRA use preceding-hour maxima; historical IFS/ERA5 gusts are instantaneous.
Gust maxima are not prorated. Conditions associates intervals with their start;
graphs/readouts retain actual interval endpoints. Missing intervals do not become
zero totals. Severe-condition precedence prevents a clear majority hiding rain/
snow. Coarser native output remains described as provider-interpolated hourly data.

| Client | Bounds and cache |
| --- | --- |
| Surface weather | Fixed allowlisted HTTPS hosts/models; omitted credentials/referrer, redirects refused; 128 KiB, 15 s; validate grids/elevation, units, rows, ranges and epochs; 8 URL entries; five-minute peak/current-day TTL, six-hour completed historical TTL; identical flights deduplicated within its client |
| Cloud profiles | Five points; selected day ≤26 h; 1 MiB and 15 s; six model/day entries for five minutes; refresh bypasses profiles, not fresh metadata |
| Model-update records | Allowlisted domains; 16 KiB and 5 s; successes/failures cached five minutes; weather disclosure concurrency ≤3 |
| Air quality | Two hourly fields, five days/≤120 rows; 64 KiB and 15 s; four location entries with five-minute TTL |

All caches are memory-only, page/client-local; fetches use `cache: 'no-store'`.
Sharing a source module across separately bundled IIFEs does not share cache
state. Reload repeats the initial request budget. Each feature retains last
usable results and truthful source/date labels during refresh/failure.

Known HTTP 429 produces a provider-named inline warning and bounded cooldown.
Retry-After is displayed only when readable/exposed by CORS; otherwise the user
gets general wait advice. Unreadable error bodies cannot hide a known 429.
No cascading model fallback or automatic failure loop is allowed. Cooldowns
are per client, not one coordinated provider/IP budget. Cloud Automatic requests
can both leave before the first response establishes a limit. Metadata failure
does not discard valid profiles but affects confidence; invalid profiles skip
their metadata request. An aborted request may already have reached the server.

The provider receives public summit/map-point coordinates, an elevation when
applicable, requested date ranges and variable/model selections. Cloud calls add
nearby public sample coordinates; update records contain no coordinates/dates.
No GPX, climber/ascent/peak IDs, name, account data or page URL goes to Open-Meteo.
Ascent summit lookup remains a guarded first-party Peakbagger read. No API key,
new weather host permission or weather account is required for the free hosted
endpoint. Provider CORS, attribution and non-commercial hosted terms still apply;
[PRIVACY.md](../PRIVACY.md#summit-weather) owns their public disclosure.

## Provider quota and cost

“Weighted calls” estimates allowance consumption, not browser requests or dollar
charges. Open-Meteo scales larger variable/location/model/time selections. For
these deterministic hourly requests, its pinned published server implementation
uses the following per-location sum:

```text
V = requested variables × named models
quota weight = sum over locations of max(1, V/10, (V/10) × days/14)
```

| Example | Actual forecast GETs | Estimated quota weight |
| --- | ---: | ---: |
| Default GFS weather: 1 point, 10 variables, 32 UTC dates | 1 | 2.29 |
| One dense cloud model: 5 points, 72 variables, selected day | 1 | 36 |
| Default Washington weather + HRRR/HRDPS cloud comparison | 3 | 74.29, **plus 2 metadata GETs with unverified accounting** |
| Weather + one manually selected dense cloud model | 2 | 38.29, plus metadata |
| Weather + later-day GFS/IFS cloud comparison | 3 | 65.29, plus metadata |
| AQI: 1 point, 2 variables, 5 days | 1 | 1 |

Two different surface models still fit in one GET but give about 4.57 weight
for the 32-date example. A 33-date padded window is slightly larger. Reducing
cloud hours within one day or batching both model responses would not remove
the dominant variable/location weight. These estimates use source, not a live
remaining-quota meter or proof of production deployment. Metadata accounting
was not established. The free service's published limits at the audit were
600/minute, 5,000/hour, 10,000/day; the source-based free limiter uses request
address, so tabs/users sharing an address may compete. Do not induce throttling
to verify them. Check current [pricing](https://open-meteo.com/en/pricing) and
[terms](https://open-meteo.com/en/terms) for service conditions.

Pinned calculation sources, inspected October 24–25, 2026:
[weight](https://github.com/open-meteo/open-meteo/blob/7e6d03ef249f8eb24b5b24fa04f5ee777c9e18cb/Sources/App/Helper/Writer/ForecastApiResult.swift#L238-L257),
[variable/model count](https://github.com/open-meteo/open-meteo/blob/7e6d03ef249f8eb24b5b24fa04f5ee777c9e18cb/Sources/App/Controllers/ForecastapiController.swift#L294-L303),
[free limiter](https://github.com/open-meteo/open-meteo/blob/7e6d03ef249f8eb24b5b24fa04f5ee777c9e18cb/Sources/App/Helper/Vapor/RateLimiter.swift#L223-L234).

## Implementation and verification

| Owner | Responsibility |
| --- | --- |
| `src/weather/peak-weather.js`, subject/location readers, `weather-week.js` | Peak identity, selected location, periods, source display and bounded window |
| `src/ascent/ascent-weather.js`, `ascent-weather-subject.js` | Strict saved identity/day, first-party summit lookup, archive/docking/GPX adapter |
| `src/weather/open-meteo-client.js`, model registries, `weather-day.js` | Bounded surface transport, model/date policy, validation and aggregation |
| `src/weather/summit-cloud.js`, client/models/core | Cloud card, pressure-profile capabilities, sampling and prediction |
| `src/weather/peak-weather-updates.js`, AQI client/view | Separate metadata and AQI ownership/caches |
| `src/weather/weather-hourly-table.js`, `weather-chart-scale.js` | Shared interval series, conditions table and chart scale/ticks |
| `src/ui/card-read-gate.js`, `latest-read.js`, `page-lifecycle.js` | Eligibility/lazy start, superseding-read ownership, BFCache lifetime |
| `src/ui/card.css`, peak layout, drag helpers | Opt-in palette/shell and surface adapters; see card conventions |

Eligibility combines authoritative settings, feature/date policy, active
lifecycle, visible document/card, applicable collapse and lazy viewport start.
The feature retains freshness, cached results and transport policy. Gate
transitions do not turn units/theme/placement changes into fetches. Latest-read
tickets invalidate stale success/error/finalizers and abort superseded reads;
final disposal disconnects observers/subscriptions and clears client state.
MAIN-world GPX/Sun ownership and worker-owned mutations remain distinct.

| Purpose | Command after building `dist/` |
| --- | --- |
| Build / full suite | `npm test` (builds first) |
| Peak / ascent / clouds / AQI | `npm run verify -- peak-weather`, `npm run verify -- weather`, `npm run verify -- summit-cloud`, `npm run verify -- air-quality` |
| Layout / movement / pending feedback | `npm run verify -- peak-cards`, `npm run verify -- weather-interactions` |
| 3D point-weather integration | `node scripts/verify-peak-weather-3d.mjs` |
| Real manifest startup | `npm run verify -- chrome` |
| Request-count / axis probes | `node docs/plans/evidence/open-meteo-peak-request-audit.mjs`; `node docs/plans/evidence/card-reuse-audit.mjs` |
| Documentation integrity | `node --test test/project/documentation.test.mjs`; `git diff --check` |

Follow [development](development.md) and AGENTS for hidden HTTPS Peakbagger fixtures,
Chrome launch guards, real browser zoom, renderer checks when terrain is involved,
and exact owned-process/profile teardown. Do not launch visible test windows over
the user's work. Unknown verifier selections/zero cases must not pass.

The latest runtime remediation snapshot passed **3,524 tests**, ESLint, web-ext
lint with 8 owned warnings, 23 request scenarios and the distinct-axis probe.
Real unpacked extension startup passed in hidden Chrome 156.0.8078.4 at 1000×760
with BFCache. Peak/ascent matrices passed in that Chrome and Firefox 158.0.1:
ascent 375/681/768/1440 px, peak 375/1440 px with real 200% zoom, both themes.
Cloud fixtures passed 320/390/820/1440 px, both themes, simulated 150% CSS zoom.
They cover pending/success/error/retry, focus/geometry/scroll, retained results,
model memory, day/metric navigation, collapse and pointer/keyboard movement.
Reduced-motion behavior has an adapter test. Pre-fix failures established the
collapsed-request, calm-axis and dark-header regressions. Owned profiles/processes
were absent after cleanup. See [request evidence](plans/evidence/open-meteo-peak-request-audit.json)
and [card remediation evidence](plans/evidence/card-reuse-remediation-2026-10-25.json).

These counts describe that verified snapshot, not a newly run runtime suite for
this documentation merge. Current probes/check commands can refresh them.
Peak/ascent/startup use the real unpacked extension; cloud fixtures inject built
bundles and settings stubs. Provider responses are intercepted. Native CSS/SVG
weather rendering is not a WebGL accuracy claim. October 2026 public five-point
probes succeeded for GFS/HRRR/HRDPS/IFS; the sampled IFS summit hour lacked an
adequate sparse above-ground bracket. Earlier browser CORS probes used public
Rainier data. Neither establishes all model slices or forecast accuracy.

## Research and unimplemented options

The October 21 CascadeClimbers comparison inspected
[Weather Research](https://cascadeclimbers.com/forum/weather),
[Weather Lab](https://cascadeclimbers.com/forum/weather-beta) and the loaded
[application script](https://cascadeclimbers.com/forum/uploads/cc_weather.js?v=1787888861).
It used background Chrome 156 tabs at 2048×950, DPR 2, Mt. Stuart, near Whistler
and Stampede Pass; all eight weather tabs, precipitation buckets, profile hover,
UW raw image, snow-slope controls and a WRF snow frame advance were exercised.
Source baseline `1902c9f2` was point-in-time evidence, not installed/store parity.

| Reference IDs | Remaining capability / current distinction |
| --- | --- |
| W01 | Simultaneous surface-model curves, mean/spread envelope. Model selection and two-model cloud comparison do not supply that chart |
| W02–W03 | Precipitation probability and selectable multi-hour/cumulative storm totals |
| W04–W05 | Freezing level and total cloud percentage are now implemented; separate forecast snowfall depth, general cloud-layer/humidity charts remain different from the experimental pressure-profile estimate |
| W06–W09 | Solar radiation/UV, CAPE diagnostic, direct NWS point/discussion integration and official NWS/ECCC alert display |
| W10–W12 | AQI/PM2.5 now implemented; regional smoke/AQI/radar overlays remain separate. Reported wildfire overlays have their own [plan](plans/wildfire-map-overlay.md), not universal fire/hotspot parity |
| W13–W15 | Separate current snapshot, weather-first place/coordinate/geolocation workspace, and trip-window verdicts; map-point weather already exists |
| B01–B03 | Interactive time-height diagrams, UW raw products and regional WRF browsing/animation; pressure input alone is not a time-height UI |
| B04–B05 | Aspect/slope snow-surface supportability, corn/isothermal states, travel-window and snowfall-density/SLR models; station SWE/depth is not new-snow density |

These are research options, not approved implementation promises. Sun & Moon is
astronomy; Nearby snow is observed station depth/SWE; neither validates slope
illumination or snow supportability. [Snow](nearby-snow.md), [Sun](sun-position.md),
[map layers](map-layers.md) and [avalanche planning](plans/avalanche-forecast-links-and-layer.md)
retain those separate domains.

Reference limitations remain material: one displayed ECMWF series had 168 null
slots; deterministic model spread was not calibrated probability; interactive
GFS and raw UW WRF were different sources; “current observations” had no station
provenance; nearest Avalanche Canada centroid did not establish zone membership;
snowline, freezing altitude, water equivalent, snowfall and supportability were
different quantities. Live alerts/bulletins, all overlays/products, geolocation,
continuous animation, narrow/zoom/error/accessibility/Firefox were not proved by
that comparison. Do not repeat its historical “missing” claims as current facts.

## Audit closure ledger

### Fixed and verified

| Audit / IDs | Preserved outcome and evidence |
| --- | --- |
| Historical archive, October 11 | Strict subject/civil days (`aff4884`), bounded models/client (`a392b34`), card/public contract (`4317ebb`); subsequent docking, safe GPS restoration, GPX cursor and hourly Conditions integration. Initial full suite 2,474; isolated Conditions snapshot 2,490. Old country-based automatic model defaults were later replaced by explicit Best Match policy |
| Weather feature W01–W08, October 11 | Correct instant gust/precipitation boundaries; stable day activation/focus/pinned readings; keyboard ascent explorer; component dark palette; opt-out GPS restoration; stable tab widths. Snapshot `665db2e5` plus guard `8ea1adac`: 85 weather tests and Chrome 153/Firefox 157 matrices passed |
| Weather UX, October 11 | Packaged accessible icons, shared palette, Low/High/Max labels, compact model/source identity, responsive layout and graph styling; 121 weather tests and both-engine light/dark matrices passed |
| Location L1–L4 / L5–L7 | Same-point retry, failed reset, cooldown copy/model restoration (`a2c101f7`); map-menu Tab/wheel/expiry (`5138fd6c`) |
| Location L8–L12 | Native/modified Escape (`ba41a729`, `d7922815`), parked terrain messages (`f9276fec`), first-load point identity (`364ca588`), identity-free challenge fixtures (`681747b4`). Final location audit 2,666 tests, Chrome/Firefox weather and Chrome Metal 3D checks passed |
| Weather rate-limit audit, October 11 | Provider-named 429/cooldown, bounded readable Retry-After, retained weather, typed first-party lookup errors even with unreadable bodies. Build, 63 weather/helper and 19 ascent tests, focused ESLint; hidden Chrome 153/Firefox 157.0.1 at 375/681/768/1440×1100. Corrected missing fixture CORS exposure; live throttling was not induced |
| Card reuse CR-01–CR-06, October 24–25 | Collapsed reads and calm-axis defects fixed; shared eligibility, scale/series, card styles, pointer core and latest-read ownership; shared contracts exercised against both layouts. Full ledger and focused commits remain in the cross-feature [card audit](plans/card-reuse-audit-2026-10-24.md#closure-ledger) |
| Request audit OM-01 | Fixed: both saved collapsed cards issue zero requests; expansion starts one weather read and collapse aborts a held read. Current 23-scenario evidence retained |

### Intentionally not changed

- Forecast/reanalysis output remains model estimates; missing data never becomes
  favorable conditions. Explicit model failures do not silently switch source.
- Identity/settings/privacy gates, native Save ownership, authenticated reads,
  MAIN-world boundaries, time semantics and original GPS-node handlers remain.
- Card placement/setting reconciliation and chart overlays retain their surface
  policies. Snow/map clients do not become generic weather reads.
- The historical W01–W08 full snapshot had 2,576/2,578 passes: two unrelated README
  assertions were reproduced at its starting revision and left outside scope.
  An isolated Conditions run excluded concurrent Buddy edits. These historical
  exceptions do not describe the later 3,524-pass remediation snapshot.

### Open or not fully proven

- **OM-02:** Automatic cloud inputs are expensive (two five-point dense profile
  requests). Single-model/manual already works; comparison benefit needs measured
  forecast skill. Do not silently remove profile/neighborhood evidence to cut cost.
- **OM-03:** weather/cloud metadata caches can fetch the same domain twice;
  Weather Refresh clears still-fresh metadata. Caches/cooldowns are page/client-
  local, so reloads/tabs repeat downloads. A bounded shared coordinator needs exact
  model/coordinates/elevation/variables/time keys, explicit retention/privacy and
  independent-reader cancellation; importing a module in two IIFEs is insufficient.
- Live provider availability/header exposure/quota charges, forecast skill,
  authenticated native Peakbagger layouts, physical touch, screen-reader speech,
  native browser focus/Space/window placement and publication remain external
  proof gaps. Hidden rendered fixtures and one successful CORS probe cannot
  establish them. No release or quota-exhaustion experiment was performed.

### Consolidated records

This guide replaces the three feature guides, the dedicated Open-Meteo request
audit, and five weather-only archived plans/comparisons. Reproduction scripts,
JSON, inspected captures and the cross-feature card/API audits are retained.
Original detailed records remain in Git at consolidation baseline `1add5893`:

```sh
git show 1add5893:docs/peak-weather.md
git show 1add5893:docs/ascent-weather.md
git show 1add5893:docs/summit-cloud.md
git show 1add5893:docs/plans/open-meteo-peak-request-audit-2026-10-24.md
git show 1add5893:docs/archive/ascent-historical-weather.md
git show 1add5893:docs/archive/weather-feature-audit-2026-10-11.md
git show 1add5893:docs/archive/weather-card-ux-2026-10-11.md
git show 1add5893:docs/archive/peak-weather-location-audit-2026-10-12.md
git show 1add5893:docs/archive/cascadeclimbers-weather-feature-gaps-2026-10-21.md
```

## Primary references

Provider capability references underpin packaged allowlists; this documentation
merge did not re-probe their current hosted behavior.

- [Forecast API](https://open-meteo.com/en/docs), [historical weather](https://open-meteo.com/en/docs/historical-weather-api), [historical forecasts](https://open-meteo.com/en/docs/historical-forecast-api)
- [GFS/HRRR](https://open-meteo.com/en/docs/gfs-api), [GEM](https://open-meteo.com/en/docs/gem-api), [ECMWF profiles](https://open-meteo.com/en/docs/ecmwf-api)
- [Model inventory](https://github.com/open-meteo/open-data/blob/main/README.md), [model updates](https://open-meteo.com/en/docs/model-updates), [CMA delivery warning](https://open-meteo.com/en/docs/cma-api)
- [Run stitching / single runs](https://open-meteo.com/en/docs/single-runs-api), [air quality](https://open-meteo.com/en/docs/air-quality-api)
- [WMO orographic cloud influences](https://cloudatlas.wmo.int/en/orographic-influences-on-clouds.html)
