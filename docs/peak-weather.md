# Summit weather on peak pages

**Settings → General → Show weather cards** controls both summit weather and
the ascent weather archive. It is on by default, saved in `storage.sync`, and
included in settings export/import and GitHub settings backup. Turning it off
hides both cards on open pages and cancels pending weather work. Disabled pages
make no weather requests; summit lookup for the archive is also skipped.

The isolated `content/peak-weather.js` bundle adds **Summit weather** below
the native map, in a new row of the right-hand table. The existing map, Sun &
Moon panel, links and left-column metadata remain in their native flow. A peak
without a map uses its native right table. Unrecognized layouts or ambiguous
coordinates fail closed rather than mounting a full-page fallback or guessing
a location. Peak name, coordinates and elevation come from the current page;
there is no geocoding or extra Peakbagger request.

The card defaults to **16-day forecast**, covering today plus fifteen days in forward
order. **Past 16 days** shows sixteen completed local days, latest first, excluding
today. Both views share one request; period tabs support arrow keys, Home and End
and retain each view's expanded day. Forecast conditions use expected rather
than past-tense rain/snow labels. Each compact row has the
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
The forecast view warns that estimates may be inaccurate, especially farther
ahead or at mountain summits, and prompts users to check local mountain forecasts.
**Models & source details** names possible sources: NOAA HRRR and GFS with DWD
ICON fallback for US coverage, and ECMWF IFS or regional models elsewhere. The
copy says these models may be used, not that a particular hour has a proven source.
Examples were checked against Open-Meteo's [published selection code](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/ForecastapiController.swift).
It also explains full-day forecasts, incomplete final-day hours, load time and
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
the final midnight's preceding-hour precipitation and gust maximum where the
API horizon allows it. The request's last UTC date is capped at today UTC plus
fifteen days: requesting padding beyond that limit would be rejected. Summaries
still expect full civil-day coverage, so missing final-day hours or midnight
accumulations remain incomplete, never filled with zero or extrapolated. Fractional
boundary precipitation is proportionally allocated. Hourly rain/snow and gusts
refer to the preceding hour; daily aggregation includes the ending midnight.
Their graphs show the same intervals, including the ending midnight and excluding
the starting midnight. Readouts name the interval and label fractional boundary
rain as estimated. Gust maxima are not prorated; overlapping boundary hours are
identified. Instantaneous fields exclude the ending midnight. Exact local times
and timezone labels retain repeated hours on DST days.

The separate peak client allows at most thirty-three inclusive UTC dates and 792 rows,
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

Pure tests cover sixteen completed days and sixteen forecast days across DST,
date-line and fractional-hour zones, full future hours, the UTC forecast cap,
midnight precipitation/gust boundaries, missing coverage and unchanged ascent
limits. Built-bundle UI tests cover native placement with/without a map,
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

The sixteen-day extension was verified on 2026-10-11: 74 focused weather tests
and all 2,567 tests passed. Full lint passed with the same six owned warnings;
the verifier's final wait change also passed ESLint. Real unpacked extension
fixtures passed in hidden Chrome for Testing 153.0.8010.12 and Firefox 155.0
at 375/768/1440 × 1100 in light and dark themes. Inspected the wide forecast,
narrow warning, expanded model details and final-day graph. The first Chrome
run read the remembered final-day graph while the first-day disclosure was
settling; its wait now requires the specific first-day graph and one open day,
and the rerun passed. One live public Rainier request accepted the maximum
combined interval and rendered both views from exactly one HTTP request.
The full `npm run verify:chrome` check passed, including BFCache restoration.
Final process and disposable-profile checks found no owned verification
browser or profile remaining. Hidden fixtures and the live CORS probe do not
establish forecast accuracy, screen-reader speech or the user's Brave session.

Matching history to the forecast was verified on 2026-10-11: 74 focused weather
tests passed, as did ESLint for the changed JavaScript and the build. Regression
coverage includes sixteen completed local days across spring/fall DST, year and
date-line boundaries, complete oldest-day hourly data, and the 33-date/792-row
transport cap. Hidden real-extension fixtures passed in Chrome for Testing
153.0.8010.12 and Firefox 155.0 at 375/768/1440 × 1100 in light and dark themes.
Visually inspected wide light history and narrow dark history with an expanded
hourly graph. One live public Rainier probe rendered both sixteen-day periods
from exactly one weather HTTP request; the real-manifest Chrome check passed at
1000 × 760 with BFCache restoration. Final process/profile inspection found no
owned test browser or disposable profile remaining. The full suite passed
2,565 of 2,567 tests; two photo-documentation assertions fail because the
separately rewritten README omits its encoded-source budget and saved-key
disclosure wording. Those omissions are also present in HEAD independently of
the weather length edits. Hidden verification does not establish the user's
Brave session, native focus/window placement, screen-reader speech or provider
accuracy.
