# Summit weather on peak pages

The isolated `content/peak-weather.js` bundle adds **Summit weather** below
the native map, in a new row of the right-hand table. The existing map, Sun &
Moon panel, links and left-column metadata remain in their native flow. A peak
without a map uses its native right table. Unrecognized layouts or ambiguous
coordinates fail closed rather than mounting a full-page fallback or guessing
a location. Peak name, coordinates and elevation come from the current page;
there is no geocoding or extra Peakbagger request.

The card defaults to **7-day forecast**, covering today plus six days in forward
order. **Past 7 days** shows seven completed local days, latest first, excluding
today. Both views share one request; period tabs support arrow keys, Home and End
and retain each view's expanded day. Forecast conditions use expected rather
than past-tense rain/snow labels. Each of the seven compact rows has the
day's most severe available condition, temperature low/high, precipitation
water equivalent (rain, showers and snow), and maximum wind. Missing values
remain unavailable and incomplete hours are labelled. A native keyboard-
accessible disclosure opens one day's hourly graphs; expanding another day
closes the previous one and retains the chosen data tab. Temperature, rain/snow,
wind and gusts use responsive line graphs; conditions use an hourly timeline.
Missing values break the line rather than appearing as zero. Hover previews a
reading; clicking or using arrow keys pins it, and Escape clears it. Data tabs
support arrow keys, Home and End. Charts fit inside the card without widening
the page; the conditions timeline scrolls vertically. Units follow the existing
preference without another weather request.
Source details explain model estimates, full-day forecasts, load time and
temperature adjustment for summit elevation. The footer credits **Powered by
Open-Meteo**. An unavailable period does not hide usable data in the other view.

## Data and civil-day boundaries

The [Open-Meteo Forecast API](https://open-meteo.com/en/docs) provides recent
and forecast weather through one explicit `start_date`/`end_date` interval. Its default model
selection combines suitable regional models. The card labels this automatic
selection; it cannot name an individual model from a blended response and does
not present archived forecasts as station observations. Forecasts include the
whole local day, including earlier hours of today. Future forecast hours are
admitted explicitly by the peak window; historical ascent windows retain their
future-date rejection and cutoff at the current time.

The packaged offline timezone lookup resolves the summit's civil days, including
DST transitions and date-line offsets. A labelled longitude estimate remains
the fallback. Requests use GMT and Unix timestamps: the provider's fixed UTC
offset otherwise ignores DST changes across a date range. UTC padding includes
the final midnight's preceding-hour precipitation and gust maximum. Fractional
boundary precipitation is proportionally allocated. Hourly rain/snow and gusts
refer to the preceding hour; daily aggregation includes the ending midnight.
Their graphs show the same intervals, including the ending midnight and excluding
the starting midnight. Readouts name the interval and label fractional boundary
rain as estimated. Gust maxima are not prorated; overlapping boundary hours are
identified. Instantaneous fields exclude the ending midnight. Exact local times
and timezone labels retain repeated hours on DST days.

The separate peak client allows at most sixteen inclusive UTC dates and 384 rows,
with five fixed hourly fields. The ascent client retains its three-date/72-row
contract. Both use a 128-KiB response bound, 15-second deadline, schema/grid/unit
validation, omitted credentials/referrer, and no redirects. Results live only
in the bounded per-page cache. Requests begin near the viewport. Failed refreshes
keep both previous views and their original date labels. Known rate-limit
cooldowns disable Refresh while period tabs remain usable; failed requests
never create an automatic visibility-refresh loop. Back/forward suspension
aborts outstanding work; restoration resolves the date range again. Returning
to a tab after local midnight or five minutes refreshes the range when the card
is visible. Forecast-bearing responses expire from memory after five minutes.
No GPX, climber/peak IDs, name, account data or page URL goes to Open-Meteo.
See [PRIVACY.md](../PRIVACY.md#summit-weather).

## Verification

Pure tests cover both seven-day periods across DST, date-line and fractional-hour
zones, full future hours, midnight precipitation/gust boundaries, missing coverage and unchanged
ascent limits. Built-bundle UI tests cover native placement with/without a map,
lazy loading, hourly DST folds, line gaps, midnight intervals, tab and cursor
keyboard behavior, unit changes, resize/disposal, failed refresh and stale BFCache
requests. `npm run verify:peak-weather` loads the real manifest in hidden Chrome
and Firefox over HTTPS Peakbagger fixtures with network interception, keyboard
disclosure, forecast/past period switching without requests, data tabs, cursor interaction and screenshots at wide/narrow
viewports. It proves those fixtures, not the user's live Brave profile or
weather-provider accuracy.

The forecast addition was verified on 2026-10-11: 67 focused weather tests and
all 2,555 tests passed; full lint passed with six existing owned vendor/manifest
warnings. Real unpacked extension fixtures passed in hidden Chrome for Testing
153.0.8010.12 and Firefox 157.0.1 at 375/768/1440 × 1100, light/dark. Inspected
the wide forecast, narrow expanded forecast and live forecast/source details.
The first fixture run toggled a remembered expanded forecast closed; corrected
the verifier to respect that state, then both engines passed.

One live public Mount Rainier probe in hidden Chrome at 1440 × 1100 confirmed
CORS, accepted the combined interval, and rendered both periods and the hourly
forecast using exactly one weather HTTP request. The full real-manifest Chrome
check also passed at 1000 × 760 with BFCache restoration. All checks reported
teardown; a final process/profile inspection found no owned verification
browser, server or disposable profile. Hidden checks do not establish native
focus/window placement, screen-reader speech, the user's Brave session or
forecast accuracy.
