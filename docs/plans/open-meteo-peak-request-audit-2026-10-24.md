# Open-Meteo requests when loading a peak

Initial audit: October 24, 2026. Updated October 25, 2026 (America/Los_Angeles)
after the card-reuse fixes. This report describes the current request behavior;
the findings retain historical evidence where marked.

**Loading a peak can automatically start 5 Open-Meteo network requests:**
**1 for Summit weather + 4 for Summit Cloud Cover in Automatic mode.** No click
is required if those enabled, expanded cards are on screen or within 200 px of
it. Cards farther down the page wait until you scroll near them. A disabled or
saved collapsed card makes no request until it becomes eligible.

## Quick answer: user action → requests → what appears

“Calls” in this table means actual network requests to Open-Meteo. Counts are
additional requests for that action, assuming success. “First load” means that
card/model/date has no usable result cached in this page. The default weather
model is GFS; default cloud selection is Automatic. Model/date choices are saved,
but downloaded forecasts are cached only in the current page.

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
[calculation and source links below](#provider-quota-estimate).

This report covers extension-originated requests on `Peak.aspx`, not Peakbagger's
own traffic, ascent pages, or requests made by opening external weather links.
The initial audit used commit `1739e18531e798920964c3e76d40acb82fd7a774`.
The probe was rerun after the card-reuse remediation: both saved collapsed cards
now make zero requests. Its output records the current audited HEAD and hashes.
Source-input and built-bundle hashes, exact default URLs, and 23 asserted scenarios
are saved in the [probe output](evidence/open-meteo-peak-request-audit.json).

## Findings

### OM-01 · P2 · Collapsing Summit weather does not suppress its forecast request

**Fixed during card-reuse remediation.** The original evidence below describes
the defect; the current shared read gate suppresses collapsed reads and cancels
pending work. See the [card reuse closure ledger](card-reuse-audit-2026-10-24.md#closure-ledger).

Before the fix, with both cards saved collapsed, the probe observed **1 weather
GET** when the weather header intersected the loading margin. Summit Cloud Cover
correctly made 0 requests. The old weather loader checked feature enablement,
lifecycle, pending work and cooldown, but omitted the card-collapse state.
The shared read gate now includes that state for all weather reads.
Evidence: [weather enablement](../../src/weather/peak-weather.js#L89),
[load guard](../../src/weather/peak-weather.js#L363),
[intersection trigger](../../src/weather/peak-weather.js#L443), contrasted with the
[cloud active guard](../../src/weather/summit-cloud.js#L77).

Implemented acceptance: both saved collapsed → 0 requests; expand weather →
exactly 1; collapse during a held response → abort without replacing retained
data. These transitions passed in hidden Chrome and Firefox as well as local
fixture tests; the closure ledger retains live-provider proof limits.

### OM-02 · Capacity concern · Automatic cloud prediction dominates usage

For Mount Rainier today, Automatic requests HRRR and GEM HRDPS. Each request batches
5 coordinates and 72 hourly variables: 6 fields at 12 pressure levels. The two
requests therefore represent about **72 weighted calls**, versus about 2.29 for
the normal weather request. Both features are enabled and expanded by default.
Evidence: [settings defaults](../../src/settings/settings-schema.js#L85),
[model selection and levels](../../src/weather/summit-cloud-models.js#L9),
[request construction](../../src/weather/summit-cloud-client.js#L21),
[parallel loading](../../src/weather/summit-cloud.js#L163).

This is an intentional data footprint, not an observed duplicate-profile bug.
Reducing it changes the evidence available to the predictor. If quota is a concern,
first evaluate a bounded shared cache, then an explicit load/compare interaction.
Do not silently remove the comparison or surrounding profiles. A smaller set of
pressure levels requires proving adequate summit and upwind bracketing across
elevations, seasons and terrain; surface cloud cover is not a substitute.

### OM-03 · Optimization · Metadata and page caches have separate owners

Selecting GFS for clouds fetches `ncep_gfs025` metadata. Opening the weather card's
GFS Source details then fetches it again, plus `ncep_gfs013`. The probe confirmed
the same metadata URL twice within five minutes. The cards construct separate
metadata clients, so their caches cannot deduplicate each other. Weather Refresh
also clears its metadata cache even when those records are still fresh.
Evidence: [weather client creation](../../src/weather/peak-weather.js#L100),
[weather refresh](../../src/weather/peak-weather.js#L377),
[cloud client creation](../../src/weather/summit-cloud-client.js#L67),
[metadata cache](../../src/weather/peak-weather-updates.js#L44).

All caches are page/client-local, and fetches use `cache: 'no-store'`. Reloading or
opening another peak page repeats the cold request budget; remembering a model
does not remember its forecast. Cooldowns are likewise per client, not a shared
Open-Meteo budget. Concurrent Automatic requests can both reach the server before
the first 429 establishes the cloud client's cooldown.

Recommended separate optimization: bounded request coordination with cache keys
that preserve model, coordinates, elevation policy, variables and time range;
domain-keyed metadata sharing; and coordinated cooldowns where the upstream limit
is shared. The bundles are separate IIFEs, so importing the same module into both
does not create shared state. Any worker/session cache needs explicit expiry,
retention/privacy review and independent subscriber cancellation. Acceptance:
overlapping metadata uses one request; warm repeated pages reuse only fresh,
matching data; one cancelled reader cannot cancel another; expired data and 429
recovery remain truthful. No cross-card/page cache was implemented by the
card-reuse remediation: sharing source code does not share downloaded responses.

## Cold-load request inventory

Conditions: valid peak coordinates/elevation, settings resolved, visible document,
both cards expanded and within 200 px of the viewport, successful responses,
Automatic clouds, default GFS weather, Source details closed, Air quality inactive.

| Consumer | Endpoint | GETs | Data in each request |
| --- | --- | ---: | --- |
| Summit weather | `api.open-meteo.com/v1/forecast` | 1 | One summit; 10 variables; past 16 days and forecast 16 days together; one default GFS model |
| Summit Cloud Cover profiles | `api.open-meteo.com/v1/forecast` | 2 | One named model per request; summit + four surrounding points; 72 variables per point for HRRR/HRDPS; selected local day only |
| Cloud model freshness | `api.open-meteo.com/data/<domain>/static/meta.json` | 2 | One model-update record per successfully decoded profile response |
| Weather Source details | Same metadata endpoint | 0 | Lazy until the disclosure opens |
| Air quality | `air-quality-api.open-meteo.com/v1/air-quality` | 0 | Lazy until the Air quality tab is selected |
| **Total** | | **5** | **3 forecast GETs + 2 metadata GETs** |

The exact default trace is GFS surface weather, HRRR profiles, HRDPS profiles,
`ncep_hrrr_conus` metadata, and `cmc_gem_hrdps` metadata. Metadata follows successful
profile decoding and is fetched even when “Why this prediction” is closed: it
affects stale-data handling and confidence, not just explanatory text.
See [metadata acquisition](../../src/weather/summit-cloud-client.js#L92) and
[freshness use](../../src/weather/summit-cloud-core.js#L62).

The weather request covers both tabs in one padded UTC date range. The probe's
fixed clock, October 24 at 18:00 UTC, produced October 8–November 8 inclusive:
32 UTC dates. Date/timezone padding can change that count; the client permits up
to 33 UTC dates. Two different saved surface models are comma-separated in that
same GET, increasing response/usage weight but not HTTP count. See
[window calculation](../../src/weather/weather-week.js#L31) and
[combined request](../../src/weather/open-meteo-client.js#L35).

The cloud date menu does **not** prefetch its entire horizon. The selected day's
23/24/25 hours are batched; the eight visible hour buttons are just a local page
through that data. Five coordinates are also batched, not five separate requests.
Sparse IFS/AIFS/JMA profiles use 9 levels × 6 fields = 54 variables instead of 72.
See [date handling](../../src/weather/summit-cloud.js#L152) and
[cloud model capabilities](../../src/weather/summit-cloud-models.js#L9).

Automatic uses the first two eligible entries from HRRR, HRDPS, GFS and IFS 0.25°
for today/tomorrow; later dates use GFS + IFS 0.25°. Thus US/Canadian/global model
identities can differ, but a successful cold Automatic cloud load remains
2 profile + 2 metadata GETs. Manual selection uses one model and has no silent
fallback. Regional admission does not guarantee live provider availability.
See [selection policy](../../src/weather/summit-cloud-models.js#L39).

## How settings and interactions change the count

The following initial-load totals were asserted with the Rainier fixture and
successful stub responses, except the explicitly named 429 case. “Near viewport”
means the controlled IntersectionObserver fired for that card.

| Initial state | Total GETs |
| --- | ---: |
| Neither card near viewport | 0 |
| Only weather near viewport | 1 |
| Both near viewport, defaults | 5 |
| Manual GFS clouds, weather enabled | 3 |
| Clouds disabled or saved collapsed, weather enabled | 1 |
| Weather disabled, clouds explicitly enabled | 4 |
| Both features disabled | 0 |
| Both cards saved collapsed, weather header near viewport | **0 after OM-01 fix** |
| Different saved past/forecast surface models, Automatic clouds | 5 |
| Both cloud profiles return 429; weather succeeds | 3; no cloud metadata |
| New page instance after an earlier successful page | 5 again |

`showWeather` and `showSummitCloud` are separate switches; migration derives a
missing cloud switch from weather. The “weather disabled, clouds enabled” row
explicitly sets both. See [settings migration](../../src/settings/settings-schema.js#L276).

| Action after successful default load | Additional GETs |
| --- | ---: |
| Switch Past/Forecast with Source details closed; select cloud hours; open Why | 0 |
| Weather Refresh, Source details closed | 1 |
| First opening of default GFS Source details | 2 |
| Weather Refresh with GFS Source details open | 3: forecast + both metadata records |
| Cloud Refresh within its metadata's five-minute TTL | 2: profiles only |
| Select tomorrow with the same Automatic models and fresh metadata | 2 |
| Return to a still-cached cloud day | 0 |
| Cloud Refresh after five minutes | 4: profiles + metadata |
| First Air quality selection | 1 |
| Switch away and back to warm Air quality | 0 |

Weather source metadata concerns only the currently displayed period's model.
GFS has two records, most mapped models have one, and Best Match/unmapped models
have none. The table above assumes GFS. Selecting a new model/location can cause
another forecast request; rapid changes can add aborted attempts. Model changes
and failed/cancelled requests therefore make 5 an initial-success budget, not a
lifetime upper bound. See [source details](../../src/weather/peak-weather.js#L107)
and [metadata domain map](../../src/weather/peak-weather-updates.js#L13).

Ordinary hourly expansion/metric changes use loaded data. Air quality's one GET
contains `us_aqi,pm2_5` for five days; its Refresh bypasses its own cache. See
[AQI request](../../src/weather/air-quality-client.js#L8) and
[AQI load/select](../../src/weather/air-quality-view.js#L50).

## Provider quota estimate

Open-Meteo's [pricing documentation](https://open-meteo.com/en/pricing) distinguishes
HTTP requests from fractional calls for large variable/time selections. The
[published server implementation](https://github.com/open-meteo/open-meteo/blob/7e6d03ef249f8eb24b5b24fa04f5ee777c9e18cb/Sources/App/Helper/Writer/ForecastApiResult.swift#L238-L257)
calculates a weight for each location. For these deterministic, hourly requests:

```text
V = number of variables × number of named models
weight = sum over locations of max(1, V / 10, (V / 10) × days / 14)
```

The [forecast controller](https://github.com/open-meteo/open-meteo/blob/7e6d03ef249f8eb24b5b24fa04f5ee777c9e18cb/Sources/App/Controllers/ForecastapiController.swift#L294-L303)
supplies variable/model counts. This is a source-based estimate, not a measurement
of the production service's deployed code or remaining quota. Metadata accounting
is unverified and excluded from the estimates below.

| Request configuration | Estimated weighted calls |
| --- | ---: |
| Default weather: 1 location × 10 fields × 1 model × 32 days | 2.29 |
| Each dense cloud model: 5 locations × 72 fields × 1 model × selected day | 36 |
| Default Rainier weather + HRRR/HRDPS clouds | **74.29**, plus unknown metadata accounting |
| Weather + manual dense cloud model | 38.29, plus metadata |
| Weather + GFS/IFS Automatic clouds on a later day | 65.29, plus metadata |
| Air quality: 1 location × 2 fields × 5 days | 1 |

Using two different surface models changes the example weather weight to about
4.57 while retaining one GET. A 33-date weather window also increases the estimate.
Reducing cloud hours within one day or merely combining the model requests would
not remove the dominant variable/location weight. Reducing fetch frequency is
the first option to evaluate while preserving prediction inputs.

The free service currently publishes 600 calls/minute, 5,000/hour and 10,000/day;
these are provider limits, not extension-wide counters. The published
[rate limiter](https://github.com/open-meteo/open-meteo/blob/7e6d03ef249f8eb24b5b24fa04f5ee777c9e18cb/Sources/App/Helper/Vapor/RateLimiter.swift#L223-L234)
uses the request address for the free API. Users/tabs sharing that address may
share pressure on the limit. See the [provider terms](https://open-meteo.com/en/terms)
for current service conditions; no quota exhaustion was induced in this audit.

## Cache, lifecycle and failure boundaries

- Weather caches up to 8 URLs for five minutes on peak pages and deduplicates
  identical in-flight requests within its client. The shared client's six-hour
  completed-history cache does not apply to the peak's `partial: true` window.
  [Implementation](../../src/weather/open-meteo-client.js#L143).
- Clouds cache up to 6 successful model/day URLs for five minutes; AQI caches up
  to 4 locations for five minutes. Metadata caches successes and failures for
  five minutes. None survives normal page disposal/reload.
  [Cloud cache](../../src/weather/summit-cloud-client.js#L67),
  [AQI cache](../../src/weather/air-quality-client.js#L40),
  [metadata cache](../../src/weather/peak-weather-updates.js#L44).
- There is no unconditional five-minute forecast polling loop. Returning to a
  visible page, resuming its lifecycle or expanding clouds can request stale
  data through the existing guards. Opening a disclosure after cache expiry can
  fetch metadata again. Background/viewport transitions were source-traced, not
  measured with native browser scheduling in this audit.
  [Weather visibility](../../src/weather/peak-weather.js#L452),
  [cloud visibility](../../src/weather/summit-cloud.js#L205).
- Failed profile validation/transport skips that model's metadata request.
  Client timeouts and aborts do not automatically retry; a 429 gates subsequent
  requests in that client. An aborted fetch may already have reached the provider.
  A failed response with fewer requests is not a successful cheaper forecast.
- Invalid peak identity/coordinates prevent mounting; missing summit elevation
  prevents cloud loading. No geocoding or Open-Meteo elevation call is needed:
  the cards read Peakbagger's peak data. There is no ascent-weather request on a
  peak page: the manifest restricts that bundle to ascent URLs. Sun/Moon and NRCS
  snow work do not add Open-Meteo requests.
  [Subject reader](../../src/weather/peak-weather-subject.js#L7),
  [cloud elevation guard](../../src/weather/summit-cloud.js#L155),
  [ascent manifest match](../../manifest.json#L218),
  [peak manifest matches](../../manifest.json#L332).

## Verification and reproduction

The [audit probe](evidence/open-meteo-peak-request-audit.mjs) executes freshly built
`dist/content/peak-weather.js`, `summit-cloud.js` and `peak-cards.js` together in
jsdom, using the masked Rainier fixture at an HTTPS Peakbagger URL. It records
every fetch, including metadata, and asserts 23 scenario totals plus request
shape and duplicate-domain checks. Clock, settings, IntersectionObserver and
provider responses are controlled. It performs no live API requests.

Run from the repository root:

```sh
npm run build
node docs/plans/evidence/open-meteo-peak-request-audit.mjs
node --test test/weather/peak-weather.test.mjs test/weather/peak-weather-updates.test.mjs test/weather/air-quality-client.test.mjs test/weather/summit-cloud-ui.test.mjs test/weather/summit-cloud.test.mjs test/weather/weather-client.test.mjs
node --test test/project/documentation.test.mjs
git diff --check
```

Results: build succeeded (53 bundles); audit probe passed all 23 scenarios;
focused weather/client tests passed **113/113**; documentation/link tests passed
**3/3**; `git diff --check` passed.

This was a DOM/transport audit, **not a real-browser network capture or visual
inspection**. No browser, renderer or viewport was used. Actual card intersection
on a particular page/window, native background scheduling, browser preflights,
live provider success/latency/payload bytes, server quota charges and deployment
of the cited upstream revision remain unverified. The full test suite, live
Peakbagger, and forecast accuracy were outside this audit.

## Closure ledger

- **Fixed and verified:** request inventory and duplicate metadata findings were
  locally reproduced. OM-01 was subsequently fixed under the card-reuse audit;
  the rerun probe verifies zero requests with both cards saved collapsed.
- **Intentionally not changed:** prediction fields, default models and feature
  switches, existing caches/cooldowns, runtime behavior and unrelated work.
  OM-02/OM-03 remain follow-up design/optimization work.
- **Changed but not fully proven:** documentation and audit evidence added;
  no claim of live request counts or metered quota verification. Browser/network
  and deployment limits are listed above.
