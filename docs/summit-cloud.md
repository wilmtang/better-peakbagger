# Summit Cloud Cover (experimental)

The peak-page card estimates cloud at summit height and in surrounding profiles.
It does not predict snow conditions, whiteout from blowing snow, visibility in
metres, or an unobstructed view in every direction. These are **uncalibrated
heuristics**, not measured probabilities or a validated mountain forecast.

## Inputs and model selection

Open-Meteo provides temperature, relative humidity, geopotential height, cloud
fraction and wind at pressure levels. Each selected day requests five profiles:
the summit and four cardinal points at max(10 km, 1.5 model grid spacings). This
samples distinct regional air columns; it is not a terrain viewshed. Coarse grids
can miss a narrow ridge, shallow cap cloud, valley fog or sharp cloud boundary.

The dropdown is a profile capability allowlist, separate from surface weather:

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

Regional models appear only within their existing conservative coverage bounds.
Automatic compares HRRR and HRDPS where both cover the summit for the first two
local dates; elsewhere it fills from GFS and IFS. Beyond that it compares GFS and
IFS, with a ten-day outlook cap. Manual selection never silently switches model.
The API may lack some hours near a nominal horizon; those stay unavailable.
Hourly output can be interpolated from coarser native timesteps.

Field availability was probed at Mount Stuart in October 2026, including the
850/700/600 hPa brackets for IFS, AIFS and JMA. This establishes API compatibility,
not forecast skill or complete geographic/horizon coverage. NAM, NBM, IFS 9 km
and ACCESS-G returned missing profile fields and are excluded. GFS pressure
profiles use the 25 km product, not its finer surface grid. IFS/AIFS/JMA use
sparser native levels. Most feeds derive pressure-level cloud from humidity;
agreement between those two fields is therefore not independent evidence.

## Calculation and failure boundaries

`summit-cloud-core.js` brackets the real summit elevation using valid geopotential
heights above model terrain. It linearly interpolates cloud, humidity and
temperature, and interpolates wind components. No extrapolation or brackets over
2,200 m are accepted. Missing cloud is never zero cloud.

Current deliberately simple thresholds:

- Cloud fraction >=60% and relative humidity >=85% at summit height: likely in cloud.
- At least three distinct neighboring cloudy profiles: nearby views likely blocked.
- Other moist/cloudy profiles, or moist incoming lower air: partial obstruction possible.
- Clear requires cloud <=20% and humidity <80% at the summit and at least three
  distinct neighbors, usable airflow, and no detected nearby cloudy layer within
  500 m. Missing neighbors or unresolvable incoming air produce uncertainty.
- The orographic check looks upwind (within 45 degrees of wind **from** direction,
  at least 3 m/s) for humidity >=85% up to 500 m below the summit and lower model
  terrain. It flags a tendency only. It does not simulate parcel lifting,
  stability, condensation, ice microphysics or a terrain cross-section.
- Model disagreement or a missing automatic comparison produces uncertainty.
  Grid spacing >10 km, vertical gaps >1,200 m, lead times >48 h or missing update
  metadata lower confidence. No percentage confidence is shown.
- Provider updates older than max(18 h, three update cycles) are uncertain. CMA
  additionally requires update metadata because its provider documents delivery
  interruptions. Metadata is provider-wide, not proof of a particular hour's run:
  the standard API stitches model runs.

Requests contain public summit coordinates and nearby sample points only, with
credentials omitted and no referrer. A day is bounded to 26 hours, the response
to 1 MiB, and the per-card memory cache to six entries for five minutes. Requests
have deadlines, cancellation and 429 cooldowns. Nothing is stored as observation
history. Model preferences use the shared extension settings schema.

## Evidence still needed for accuracy

Run `npm run verify -- summit-cloud` for the hidden Chrome/Firefox card fixture
checks. They exercise the built bundles, host table/layout, keyboard refresh,
all-hours navigation, retained results and state-dependent geometry. Forecast
and settings transports are stubbed. `npm run verify -- chrome` separately
checks real unpacked-extension startup; neither check validates forecast skill.

Implementation verification (October 24, 2026): the working-tree suite passed
3,490 tests; ESLint/build and the owned web-ext lint gate passed. Hidden Chrome
for Testing 156.0.8078.4 and Firefox 158.0.1 exercised 1440, 820, 390 and 320 px
content viewports, light/dark themes and 150% CSS zoom. The fixture checked
pending/success/error/retry focus and geometry, changing expanded explanations,
all-hour navigation, saved model restoration and collapse. An initial narrow
explanation assertion failed on a 17 px height change before its fix and passed
afterward. Provider and settings responses were stubbed; native browser zoom,
screen-reader speech and onscreen focus/window placement were not established.
The separate real unpacked-extension Chrome check passed at 1000×760 hidden.
Live Mount Stuart five-point requests succeeded for GFS, HRRR, HRDPS and IFS;
IFS's sparse above-ground bracket was unavailable for the sampled summit hour.

Do not describe this feature as validated. Evaluate archived forecasts against
timestamped summit webcams and independent summit reports, split by mountain,
season, lead time and wind regime. Measure false-clear rates and reliability
before tuning thresholds. A later terrain-aware lifting calculation needs a DEM,
upstream thermodynamic profiles and stability; adding a wind threshold alone
does not solve orographic cloud prediction. Ensemble spread and satellite cloud
observations could improve uncertainty and short-term verification.

## Primary references

- [Open-Meteo GFS/HRRR fields and grids](https://open-meteo.com/en/docs/gfs-api)
- [GEM models](https://open-meteo.com/en/docs/gem-api)
- [ECMWF profiles](https://open-meteo.com/en/docs/ecmwf-api)
- [Model inventory](https://github.com/open-meteo/open-data/blob/main/README.md)
- [CMA availability warning](https://open-meteo.com/en/docs/cma-api)
- [Provider update metadata](https://open-meteo.com/en/docs/model-updates)
- [Forecast run stitching](https://open-meteo.com/en/docs/single-runs-api)
- [WMO: orographic influences on clouds](https://cloudatlas.wmo.int/en/orographic-influences-on-clouds.html)

Implementation must also follow [card conventions](card-conventions.md).
