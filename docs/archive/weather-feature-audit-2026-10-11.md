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
| W04 | P2 | Unrelated settings and refreshes replace focused controls and discard pinned readings | Fixed; focused controls and valid pinned instants verified |
| W05 | P2 | Numeric ascent hourly values have no keyboard reading interface | Implemented; keyboard and visual behavior verified, speech unproven |
| W06 | P2 | Global dark button repaint overrides weather component selection styling | Fixed; component palettes and selected controls verified |
| W07 | P3 | Disabled weather still reparents native GPS notes and controls | Fixed; original placement and handlers verified |
| W08 | P3 | Selected font weight changes intrinsic tab width and wrapping | Fixed; width sweep and responsive rendering verified |

All eight findings have implementation and local verification, in eight focused
runtime commits. Preserve fail-closed subject/settings checks, cancellation and
generation guards, missing readings, explicit model choice, per-page caches and
native Save ownership. Concurrent archive/forecast model changes were preserved
and excluded from remediation commits.

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
- W04: unrelated weather preferences retain nodes. Necessary unit/data renders
  restore the selected source instant, Conditions scroll position and focused
  control; expired dates clear selection and focus the active period tab.
  Ran 26 peak/hourly tests and focused ESLint. Frozen-snapshot Chrome 153 and
  Firefox 157 verified unchanged node identity for unrelated settings, new-unit
  readouts, focus and pinned readings after refresh. Firefox settings now use a
  separate hidden tab, preserving the page under test. Initial mixed-worktree
  checks and the old Firefox navigation setter were unsuitable for this proof.
- W05: numeric graphs expose a focusable hourly explorer and polite keyboard
  readout, missing slots and interval labels. Weather reading selection remains
  separate from GPX selection. Ran 25 ascent bundle tests and focused ESLint.
  Hidden Chrome 153 and Firefox 157 verified Tab entry/exit, Home/End/Escape,
  existing GPX behavior and responsive layout. Inspected light/dark 375×1000
  readout screenshots and corrected focus-outline spacing.
- W06: weather buttons opt out of the generic native-site repaint. Ascent
  selected tabs use the component accent and a restrained border; disclosures
  stay flat and focus rings remain visible. Ran 29 theme tests and focused
  ESLint. Both cards passed computed selected/unselected styles in hidden
  Chrome 153 and Firefox 157, light/dark and 375/768/1440 viewports. Inspected
  final narrow Chrome light/dark ascent screenshots after the accent refinement.
- W07: authoritative opt-in gates GPS reparenting; position markers restore the
  original native blocks on disable/disposal. Enabling again moves the same nodes.
  Ran 25 ascent bundle tests covering startup, live transitions, late reads,
  BFCache, shared/ambiguous notes and click-handler preservation, plus focused
  ESLint. Hidden Chrome 153 and Firefox 157 confirmed initial zero weather
  requests, no wrapper while disabled and exact node/parent/next-sibling
  restoration. Inspected the native download/send controls after opt-out.
- W08: metric/period buttons reserve the semibold label width without changing
  inactive text weight; explicit accessible names avoid duplicate labels.
  Ran 26 peak/hourly tests and focused ESLint. Hidden Chrome 153 and Firefox 157
  swept card widths 280–500 px in 2 px steps in both themes: metric selection
  changed no row count and caused no horizontal tab overflow. Existing keyboard,
  state and day-switch regressions also passed; inspected the 375 px day graph.

## Intentionally not changed

- Estimates remain model output, not station observations or route conditions.
- Severe-condition precedence and conservative regional model admission remain.
- Unavailable authoritative settings reads make no weather request.
- Weather data remains in page memory, excluded from settings and backups.
- Two photo-documentation tests fail on README text: encoded-source budgets and
  saved-key disclosure wording. Reproduced both using the starting `8a1412b`
  README; they are outside this weather audit and were left unchanged.

## Changed but not fully proven

- W05: keyboard interaction and live-region DOM are verified; screen-reader
  speech has not been exercised. Local fixtures also do not establish live
  provider accuracy, native browser/OS focus behavior or physical touch.

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

## Final checks — 2026-10-11

Committed remediation snapshot: `665db2e5`, plus launch-guard correction
`8ea1adac`. Final verification ran on frozen source/bundles, excluding concurrent
uncommitted forecast model work.

| Check | Observed result |
| --- | --- |
| `npm test` | 2,576 / 2,578 pass; the two README assertions above fail |
| `node --test test/weather/*.test.mjs` | All 85 pass |
| `npm run lint` | Pass; six existing owned web-ext warnings |
| Real manifest Chrome verifier | Pass; Chrome 153.0.8010.12, hidden 1000×760, BFCache restored |
| Ascent and peak real-extension fixtures | Chrome 153.0.8010.12 and Firefox 157.0.1 pass |
| Targeted day switching | 27 cases per engine; pointer/Enter/Space, three metrics, 375/768/1440×1000 |
| Tab wrapping | 280–500 px card sweep in 2 px steps, light/dark, both engines; stable selection geometry |
| Final launcher guard | Both tests and ESLint pass |

Visually inspected fractional rain intervals, keyboard readouts/focus spacing,
dark selected ascent pills, native GPS controls after opt-out and the narrow
expanded peak graph. Existing page fixtures also check wide/narrow light/dark
layouts at 375/681/768/1440×1100. Weather graphics are SVG; no WebGL renderer
claim is made. Hidden DOM focus/geometry does not establish native browser/OS
focus placement, physical touch, screen-reader speech or live weather accuracy.

The first full snapshot run lacked a Git index required by fixture-privacy
tests; added an isolated fixture index and reran, eliminating those environment
failures. Corrected the new launcher's guard position rather than weakening the
repository structural test. No push or release was performed.

Final documentation check passed. All 20 recorded disposable weather profiles
were absent at handoff; exact-profile process inspection found no owned browser
or fixture process. The real-manifest verifier also reported successful teardown.
Saved selected screenshots and verification logs in the task's artifact folder;
removed the temporary source and documentation-baseline snapshots.
