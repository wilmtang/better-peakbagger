# Weather feature audit — 2026-10-11

Audit baseline: `a3ad2c9`; remediation starts from `8a1412b`, preserving the
sixteen-day forecast and history windows. Scope: summit weather, ascent weather,
shared provider/data code, settings and GPX presentation integration.

## Findings and implementation ledger

| ID | Priority | Broken invariant | Status |
| --- | --- | --- | --- |
| W01 | P2 | Historical instantaneous gusts use preceding-hour day boundaries | Fixed; contract and boundary regressions verified |
| W02 | P2 | Ascent rain graph plots raw boundary accumulations instead of the amounts used in the daily total | Fixed; totals, tooltips and rendered graph verified |
| W03 | P2 | Native asynchronous day disclosure switching renders an intermediate empty expansion and moves the clicked heading | Fixed; both-engine frame geometry and activation verified |
| W04 | P2 | Unrelated settings and refreshes replace focused controls and discard pinned readings | Open |
| W05 | P2 | Numeric ascent hourly values have no keyboard reading interface | Open |
| W06 | P2 | Global dark button repaint overrides weather component selection styling | Open |
| W07 | P3 | Disabled weather still reparents native GPS notes and controls | Open |
| W08 | P3 | Selected font weight changes intrinsic tab width and wrapping | Open |

Implement and verify each independent fix before starting the next. Preserve
fail-closed subject/settings checks, request cancellation and generation guards,
missing readings, bounded model fallback, per-page caches and native Save ownership.

## Fixed and verified

- W01: packaged model timing travels with validated data. Historical IFS/ERA5
  use instantaneous boundaries; forecasts/CERRA retain interval boundaries.
  Ran 28 day/client/week tests and focused ESLint successfully. Provider docs
  checked on 2026-10-11; live model slices remain outside this local proof.
- W02: clipped precipitation intervals carry allocated amounts and missing slots.
  Bars use interval widths; boundary tooltips identify estimates and next midnight.
  Ran 11 day tests, the fractional-zone bundle regression and focused ESLint.
  Hidden Chrome 153 at 1440×1000 confirmed 25 intervals sum to the displayed
  24.0 mm; inspected the screenshot. Concurrent Best Match changes are preserved
  separately and are not part of this commit.
- W03: summary click handles pointer and native keyboard activation synchronously.
  Scroll compensation preserves the clicked heading; queued native toggles cannot
  dispose its replacement chart. Ran 20 peak bundle tests and focused ESLint.
  Hidden Chrome 153 and Firefox 157 each passed 27 day-switch cases across
  1440/768/375×1000, Conditions/temperature/rain, pointer/Enter/Space and both
  directions: no empty or double expansion, heading displacement ≤1 px.
  Inspected the narrow Chrome expanded-day screenshot.

## Intentionally not changed

- Estimates remain model output, not station observations or route conditions.
- Severe-condition precedence and conservative regional model admission remain.
- Unavailable authoritative settings reads make no weather request.
- Weather data remains in page memory, excluded from settings and backups.

## Changed but not fully proven

None yet. Local fixture verification cannot establish live provider accuracy,
native browser/OS focus behavior, physical touch or screen-reader speech. Record
specific outstanding evidence here after implementation.

## Data contracts

- [Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api):
  gusts are instantaneous except CERRA's preceding-hour maximum.
- [Forecast API](https://open-meteo.com/en/docs): gusts are preceding-hour maxima;
  precipitation is preceding-hour water equivalent.

## Verification strategy

Use pure boundary regressions and shipped-bundle fixtures for data/state changes.
Use the real unpacked extension in hidden Chrome and Firefox over HTTPS
Peakbagger fixtures for day-switch geometry, keyboard interaction, dark selected
styles, wrap thresholds, opt-out restoration and visual inspection. Keep tests
condition-driven and ensure owned browser/profile/server cleanup.
