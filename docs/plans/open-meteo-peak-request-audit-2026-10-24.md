# Open-Meteo requests when loading a peak

Date: October 24, 2026 (America/Los_Angeles). Status: audited; no runtime changes.

**A successful cold load makes 5 Open-Meteo HTTP GET requests once both enabled,
expanded cards enter their loading margin: 3 forecast requests and 2 model-metadata
requests.** Before either card approaches the viewport, the count is 0. The default
Washington example represents approximately **74.29 weighted forecast API calls**
under Open-Meteo's published server calculation, excluding metadata. HTTP request
count and provider quota consumption are different measures.

This report covers extension-originated requests on `Peak.aspx`, not Peakbagger's
own traffic, ascent pages, or requests made by opening external weather links.
It audits commit `1739e18531e798920964c3e76d40acb82fd7a774`. Unrelated work was
committed during the investigation; the final probe ran against that commit.
Source-input and built-bundle hashes, exact default URLs, and 23 asserted scenarios
are saved in the [probe output](evidence/open-meteo-peak-request-audit.json).

## Findings

### OM-01 · P2 · Collapsing Summit weather does not suppress its forecast request

With both cards saved collapsed, the probe still observed **1 weather GET** when
the weather header intersected the loading margin. Summit Cloud Cover correctly
made 0 requests. The weather loader checks feature enablement, lifecycle, pending
work and cooldown, but does not check `peakWeatherCollapsed` or
`data-bpb-card-collapsed`. Only its air-quality subview observes collapse.
Evidence: [weather enablement](../../src/weather/peak-weather.js#L89),
[load guard](../../src/weather/peak-weather.js#L363),
[intersection trigger](../../src/weather/peak-weather.js#L443), contrasted with the
[cloud active guard](../../src/weather/summit-cloud.js#L77).

Recommended separate fix: use the existing card-collapse state to gate initial
weather loading and suspend pending work; resume lazily on expansion. Acceptance:
both saved collapsed → 0 requests; expand weather → exactly 1; collapse during a
held response → abort without replacing retained data. Exercise these transitions
in Chrome and Firefox before treating the fix as complete.

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
recovery remain truthful. No such cache was implemented in this audit.

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
| Both cards saved collapsed, weather header near viewport | **1 — OM-01** |
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

- **Fixed and verified:** no runtime fixes; request inventory and the collapsed
  weather/duplicate metadata findings were locally reproduced; report/probe only.
- **Intentionally not changed:** prediction fields, default models and feature
  switches, existing caches/cooldowns, runtime behavior and unrelated work.
  OM-01 remains an open bug; OM-02/OM-03 are follow-up design/optimization work.
- **Changed but not fully proven:** documentation and audit evidence added;
  no claim of live request counts or metered quota verification. Browser/network
  and deployment limits are listed above.
