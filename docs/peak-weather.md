# Summit weather on peak pages

**Settings → General → Show weather forecast and archive** controls both summit weather and
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
today. Both views share one weather request; period tabs support arrow keys, Home and End
and retain each view's expanded day. Forecast conditions use expected rather
than past-tense rain/snow labels. Each compact row has the
day's most severe available condition, temperature low/high, precipitation
water equivalent (rain, showers and snow), and maximum wind. Missing values
remain unavailable and incomplete hours are labelled. A native keyboard-
accessible disclosure opens one day's hourly graphs; expanding another day
closes the previous one and retains the chosen data tab. **Conditions** is the
initial data tab; the last explicit data-tab selection is saved in extension-local
storage on this device and restored across peak pages and reloads. Missing or
invalid saved selections fall back to Conditions. Temperature, rain/snow,
wind and gusts use responsive line graphs; Conditions shows a horizontally scrollable hourly table of condition icons,
temperature, feels-like, rain/snow, wind, gusts and wind direction. Row labels
stay visible while scrolling; clear hours use a Moon icon at night.
Both weather cards share packaged SVG illustrations and the Sun & Moon palette:
amber sun and temperature graphs, blue rain/snow, and muted violet wind graphs.
Daily temperature ranges use normal text color and label **Low** and **High**; wind is
labelled **Max wind**. The selected model is named once; a separate **Using**
label appears when retained readings belong to a different model during loading
or after a failed model change. The range and model control sit side by side
where space allows and stack within narrow cards.
Missing values break the line rather than appearing as zero. Hover previews a
reading; clicking or using arrow keys pins it, and Escape clears it. Data tabs
support arrow keys, Home and End. Charts fit inside the card without widening
the page; the Conditions table scrolls horizontally. **Settings → General → Units**
provides a default plus independent distance, elevation, temperature, precipitation,
and wind choices. For example, miles/feet can stay paired with Celsius and millimeters.
Temperature also controls feels-like values; wind also controls gusts. Changing units
reuses the loaded weather data without another weather request.
Day activation closes the previous panel and mounts the new graph in one update,
preserving the activated summary's viewport position and keyboard focus when
the panel fits there. Otherwise one immediate scroll reveals the full panel
(or its start if taller than the viewport).
Unrelated preferences retain weather controls. Necessary unit/data refreshes
restore valid pinned source instants, Conditions horizontal scroll position and focused
controls; an expired date clears selection and returns focus to the period tab.
Metric and period labels reserve their selected font width so selection cannot
change wrapping.
The forecast view warns that estimates may be inaccurate, especially farther
ahead or at mountain summits, and prompts users to check local mountain forecasts.
Each period has a **Weather model** dropdown, initially set to **GFS** for its
sixteen-day forecast horizon. Each period's last selected model is saved
in extension-local storage on this device, separate from synced settings and
backups. A saved regional model that does not cover a newly opened summit falls
back to GFS at startup; an explicit choice on an open page never silently changes.

**Best Match (Open-Meteo)** is the first option in both period lists. It uses
`models=best_match` on the [Forecast API](https://open-meteo.com/en/docs), which
automatically combines suitable models for the location, with up to sixteen
forecast days. This is distinct from the ascent card's Historical Weather API
archive blend. Its resolution is **Automatic**; underlying model resolution,
availability and update times vary. Source details do not claim a fixed grid
resolution, a single run, or the source of each value. The update table labels
the blend's clocks **Varies by model** without requesting individual-model metadata.

Named alternatives are filtered by geographic coverage and date availability.
History excludes delayed reanalyses that cannot cover yesterday. Forecast
options show their published run horizon. Selecting a shorter-range model
shows the available forecast days, including partial boundary days; interior
missing days remain visible. **Using [model]** identifies the model behind the
currently displayed data. Each period keeps an independent choice.
Switching periods or expanding hourly graphs makes no weather request. A model change
requests the two selected models together, deduplicated when they match, and
can reuse the exact cached selection. An explicit choice never silently falls
back; a failure preserves the previous dated/model-labelled result. Model
changes abort superseded requests; known rate-limit cooldowns disable both
Refresh and the model dropdown while period tabs remain usable.

**Source details** uses one compact paragraph for the displayed model and
resolution, forecast or historical estimate type, summit timezone, response grid,
elevation adjustment and load time. Best Match identifies its automatic blend;
combined responses disclose that model grids may differ, and estimated timezone
or partial-hour precipitation remains labelled. Default selection, saved-choice
behavior and summary calculation explanations stay in this documentation.
Hourly values may be interpolated from coarser native output, and forecast
horizons are measured from the model run. The named API fields establish which
requested model or Best Match blend supplied each period, without claiming exact
run initialization or sub-grid provenance. Horizons were checked against Open-Meteo's
[Forecast API and provider tables](https://open-meteo.com/en/docs) and named
model routing against its [published selection code](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/ForecastapiController.swift).
Opening **Source details** also loads update times for the model supplying
the displayed weather in the active period, shown in summit local time. Other eligible models are not requested. Switching periods or models
updates the table; a failed model change retains clocks for the displayed weather.
The [metadata API](https://open-meteo.com/en/docs/model-updates) reports availability
and cadence. **Update interval** displays `update_interval_seconds` from the same
metadata response (for example, **Every 6 h**), with no additional request. It is
the usual model-update cadence, distinct from `temporal_resolution_seconds`,
which describes weather-data spacing. Updates overdue relative to the last
availability time plus that cadence remain marked delayed in **Next expected**,
which displays that calculated time alongside the interval. GFS lists its 13 km and 25 km products
separately, so GFS needs two metadata requests; other mapped models need one.
Best Match and unmapped models make no metadata requests. Missing or unavailable
metadata is labelled unavailable rather than guessed (BOM has no mapping in the provider's published update table).
These are provider-wide clocks, not proof of the exact model run behind each
forecast or historical hour. Metadata requests contain no coordinates or dates;
they are limited to three concurrent requests, a five-second deadline and
16 KiB per response, with successes/failures cached in page memory for five
minutes. Closing the disclosure, disabling weather or suspending the page
cancels pending work. Update failures do not hide usable weather.

Incomplete days are labelled in the daily rows and status. The footer credits
**Powered by Open-Meteo**. An unavailable period does not hide usable data in the other view.

## Data and civil-day boundaries

The [Open-Meteo Forecast API](https://open-meteo.com/en/docs) provides recent
and forecast weather through one explicit `start_date`/`end_date` interval. The card explicitly sends one or two allowlisted model IDs. Multi-model replies
use model-suffixed hourly columns, validated and split before grouping into the
two local periods. Recent archived forecasts are model estimates rather than
station observations. Forecasts include the
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
identified. Conditions places rain/snow and gusts under the start of each interval alongside
instantaneous readings at that time; missing boundary readings stay unavailable.
Instantaneous fields exclude the ending midnight. Exact local times
and timezone labels retain repeated hours on DST days.

The separate peak client allows at most thirty-three inclusive UTC dates and 792 rows,
with eight fixed hourly fields per model and at most two named models. The ascent client retains its three-date/72-row
contract. Both use a 128-KiB response bound, 15-second deadline, schema/grid/unit
validation, omitted credentials/referrer, and no redirects. Results live only
in the bounded per-page cache. Requests begin near the viewport. Failed refreshes
keep both previous views and their original date labels. Known rate-limit
cooldowns disable Refresh and model selection while period tabs remain usable; failed requests
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

The model-selection change was verified on 2026-10-11: the build, changed-file
ESLint and all 91 weather tests passed. The full shipped-bundle suite passed
2,582 of 2,584 tests; the two existing photo README assertions still fail for
omitted encoded-source-budget and exact saved-key disclosure wording. Earlier
runs encountered concurrent ascent/verifier edits; their targeted rechecks now
pass. An isolated source snapshot confirmed the final weather tests and real
unpacked extension fixtures independently of ongoing workspace edits.

Hidden Chrome for Testing 153.0.8010.12 and Firefox 155.0 passed at
375/768/1440 × 1100 in light/dark, including independent model choices, a
short-range forecast, named-response reuse, rate-limit controls and responsive
graphs. Inspected the narrow short-range selection, default forecast, wide
history and live source disclosure. One live public Rainier request rendered
HRRR history and GFS forecast through the combined endpoint. The hidden
real-manifest Chrome check passed at 1000 × 760 with BFCache restoration.
Owned profile/process inspections confirmed teardown. These checks do not
prove the user's Brave session, native focus/window placement, screen-reader
speech or model accuracy.

The hourly-table, local-model and update-clock changes were verified on
2026-10-11: 104 weather tests passed. The full shipped-bundle suite passed
2,595 of 2,597 tests; the two photo README assertions for the encoded-source
budget and saved-key disclosure were already failing before these changes.
Full lint passed with six existing owned warnings, and changed-file ESLint
passed after the final request-failure regression was added.

Real unpacked extension fixtures passed in hidden Chrome for Testing
153.0.8010.12 and Firefox 157.0.1 at 375/768/1440 × 1100 in light and dark;
day-switch checks also used those widths at 1000 pixels tall. Inspected the
horizontal table and the expanded update list, including all three update
columns at 375 pixels. Frame traces allow at most one immediate movement to
reveal a below-fold day; a panel that fits at the clicked heading stays put.
HTML/SVG fixtures do not require WebGL. A live public Rainier probe confirmed
one weather request plus sixteen coordinate-free metadata requests. A separate
GFS/IFS request validated eight hourly fields in 60,769 bytes. The full hidden
real-manifest Chrome check passed at 1000 × 760 with BFCache restoration.
A final process/profile inspection found no owned verification browser or
disposable profile remaining. Hidden checks do not prove the user's Brave session,
native window focus or placement, screen-reader speech, model accuracy or a
promised next update.

The Best Match option was verified on 2026-10-11: build, focused ESLint and all
124 weather tests passed. Hidden real-extension Chrome 153.0.8010.12 and
Firefox 157.0.1 fixtures passed selection/persistence, combined and deduplicated
requests, blend source details and responsive layout at 375/768/1440×1100.
Inspected narrow and wide Best Match renders; charts/icons use SVG, not WebGL.
The real-manifest Chrome check passed hidden at 1000×760 with BFCache restoration.
Two live public Mount Rainier API probes validated Best Match alone (36,026 bytes)
and alongside GFS (62,705 bytes), each with 792 hourly timestamps and the expected
plain/model-suffixed fields. These establish the transport contract, not forecast
accuracy, native dropdown-menu behavior or screen-reader speech.
