# Peak and ascent card reuse audit

Date: October 24, 2026 (America/Los_Angeles). Status: remediation in progress.
The findings below preserve the original audit; current implementation status
is recorded in the closure ledger.

**Share read eligibility, chart mechanics, visual tokens and gesture handling;
keep mounting, identity, placement and provider policy with each surface.**
There is already substantial reuse. A universal card controller would obscure
important differences and is not the recommended next step.

The updated [card conventions](../card-conventions.md#reuse-across-peak-and-ascent-surfaces)
define these boundaries, list existing reusable modules and require migration
through faithful per-surface adapters. [AGENTS.md](../../AGENTS.md#repository-skills)
already requires agents to read that guide. This audit follows the new convention.

Baseline: `991ee692c790049a92338dabde73d641cbf2aa30`, including convention commit
`991ee692`. Existing uncommitted peak hourly-chart, weather test, verifier and
feature-document edits were inspected only where relevant and preserved. The
[reproduction output](evidence/card-reuse-audit.json) records the ascent source,
built bundle and current peak-chart source hashes; conclusions about peak chart
mechanics refer to that working-tree snapshot, not exclusively to HEAD.

## Findings and proposed improvements

### CR-01 · P2 · Repeated read-eligibility logic has already drifted

Peak weather, cloud, snow and ascent weather each construct their own enablement,
lazy-load observers, request cancellation and lifecycle callbacks. The shared
page lifecycle correctly distinguishes suspension from disposal, but it does not
own card eligibility. As a result, a collapsed peak weather card can still fetch,
while the cloud card checks collapse before loading. The
[Open-Meteo audit](open-meteo-peak-request-audit-2026-10-24.md#om-01--p2--collapsing-summit-weather-does-not-suppress-its-forecast-request)
reproduced one GET with both peak cards saved collapsed.

Evidence: [peak weather load/visibility](../../src/weather/peak-weather.js#L363),
[cloud eligibility](../../src/weather/summit-cloud.js#L77),
[snow enablement](../../src/snow/peak-snow.js#L138),
[ascent lazy loading](../../src/ascent/ascent-weather.js#L614),
[existing lifecycle helper](../../src/ui/page-lifecycle.js#L9).

**Extraction:** a small read-eligibility/observer helper composed with the existing
lifecycle. Inputs should include settings readiness, feature enablement, card,
optional collapse state and document visibility. It reports eligibility changes
and offers a cancellable intersection wait; the caller retains TTL, retry,
request identity and whether offscreen work should finish. Avoid a boolean that
conflates “may start a read” with “must discard retained content.”

Start with peak weather and clouds, then adapt ascent weather without adding an
ascent collapse control. Audit snow separately because station selection/map
actions and shared station clients have additional owners. Preserve explicit
read actions and do not make unit/theme/placement updates fetch again.

**Acceptance:** shared cases for settings pending, disabled, applicable collapse,
background document, suspension, resume and disposal; integration cases for
expansion and reparenting without duplicate requests. Count requests and aborts,
not merely observer callbacks. Fix the known collapse bug in a focused commit
before a larger migration, or explicitly document that intentional change.

### CR-02 · P2 · Separate weather chart engines contain a reproduced scale defect

The ascent card implements series construction, axes, SVG lines/bars, sampling,
keyboard navigation and reading labels inside its controller. Peak weather has
a separate hourly chart module with much of the same machinery. Both already
share the conditions table and weather/day math; those parts should remain the
common foundation.

With all hourly wind values set to zero and metric units, the built ascent card
renders the three numeric axis labels **`0`, `1`, `1`**. Its range becomes 0–1
km/h and its midpoint rounds to the same integer as the maximum. This is a
reproduced DOM-output defect, not a visual inspection. The current peak chart
separately reserves a larger minimum range to keep rounded labels distinct.

Evidence: [ascent chart](../../src/ascent/ascent-weather.js#L335),
[ascent range and rounding](../../src/ascent/ascent-weather.js#L392),
[peak range policy](../../src/weather/peak-weather-hourly.js#L121),
[shared series/table](../../src/weather/weather-hourly-table.js#L14),
[reproduction script](evidence/card-reuse-audit.mjs) and
[recorded output](evidence/card-reuse-audit.json).

**Extraction:** first share pure range/tick selection and series/interval math;
then consider a narrow SVG/reading controller. Inputs must state units, precision,
day bounds, metric, line/bar representation, gaps and optional reference/overlay
layers. Leave source selection, fetching and model persistence outside it.

Preserve real differences: historical instantaneous versus preceding-hour gusts;
precipitation interval boundaries; peak freezing-altitude reference lines;
historical GPX hover/selected overlays; local dates and 23/25-hour days. Do not
pass the entire card controller or GPX globals into a common chart component.

**Acceptance:** zero/calm and constant values produce distinct readable ticks in
metric/imperial units; missing samples stay gaps; interval boundaries remain
truthful; click/keyboard readings retain identity; DST and fractional-offset
fixtures keep correct instants. Keep the calm-axis fix independently reviewable.
The present probe intentionally asserts the existing defect; it is audit evidence,
not a passing correctness regression test for a future fix.

### CR-03 · P3 · Common appearance is copied through feature variables and overrides

Ascent and peak weather repeat the same light/dark colors, border/control rules,
header type and focus styling under different token names. The ascent stylesheet
first declares one palette for card/GPS details and then overrides the weather
card with the palette repeated in peak weather. Peak shared-header CSS also lists
each feature ID, so registering a card requires edits to common selectors.

Evidence: [ascent palettes and controls](../../src/ascent/ascent-weather.css#L3),
[peak weather palette](../../src/weather/peak-weather.css#L4),
[peak header selectors](../../src/ui/peak-card-layout.css#L4),
[shared hourly theme aliases](../../src/weather/weather-hourly-table.css#L1).

**Extraction:** opt-in card tokens and small shared shell/control rules, with
surface/feature aliases during migration. Keep density, header layout, peak
collapse, date navigation and GPS details styling as explicit variants. Do not
wrap inline backup/upload controls or MAIN-world Analyzer panels in an isolated
card shell. Avoid broad `section`, `button` or `table` selectors that affect the
host site. Introduce neutral shared CSS only alongside its real manifest/build
references; adding an unreferenced stylesheet provides no reuse.

**Acceptance:** weather/cards keep their current visual hierarchy, themes and
compactness; hidden controls remain unpainted and unfocusable; long model labels
fit narrow columns; 150–200% zoom and native ASP.NET forms remain usable. Run
real-extension startup after manifest/load dependency changes and inspect both
surfaces through pending, failure and retry states. No current visual defect or
pixel-equivalence claim is made solely from duplicate CSS.

### CR-04 · P3 · Peak and ascent movement share menus but maintain two gesture engines

Ascent weather supplies targets to `createCardDrag`. Peak layout independently
handles pointer ownership/thresholds, Escape, autoscroll, drop indicators and
keyboard movement; both reuse `createLayoutMenu`. This duplicates interaction
invariants and their tests, but the implementations are not interchangeable:
peak dragging uses a ghost/insertion marker and ordered table rows; ascent
dragging transforms an existing section between explicit anchor slots.

Evidence: [generic drag helper](../../src/ui/card-drag.js#L5),
[peak cancellation and target lookup](../../src/ui/peak-card-layout.js#L136),
[peak pointer handling](../../src/ui/peak-card-layout.js#L185),
[peak key handling](../../src/ui/peak-card-layout.js#L305),
[ascent adapter](../../src/ascent/ascent-weather.js#L644).

**Extraction:** extend the existing helper or extract a small gesture core with
injected target lookup, preview/lift strategy and move callback. Keep peak registry,
order/collapse and cross-column placement in its adapter. Keep ascent report/
summary/GPS anchors and settings in its adapter. Do not replace a tested ghost
with transformed table rows as an incidental refactor.

**Acceptance:** both adapters pass the same threshold, unrelated pointer,
interactive-header, Escape, blur/capture-loss, invalid-drop and disposal cases.
Retain keyboard and single-pointer move-menu alternatives. Validate empty
destinations, autoscroll, reduced motion and focus/selection preservation in both
browsers. Both current paths already have alternatives; this is maintenance work,
not a claim that users currently require dragging.

### CR-05 · P3 · Request and settings revisions repeat, but policy must remain local

Each data card maintains a controller, generation and pending state, plus guarded
success/error/finalization. Model and placement settings separately guard late
reads and queued writes. `createRetryCooldown` already shares timer/UI mechanics;
`createPeakWeatherClient` and `createWeatherClient` already share the bounded
surface-weather transport. Avoid adding another wrapper that copies them.

Evidence: [ascent request ownership](../../src/ascent/ascent-weather.js#L478),
[peak request ownership](../../src/weather/peak-weather.js#L362),
[cloud request ownership](../../src/weather/summit-cloud.js#L147),
[ascent placement revision](../../src/ascent/ascent-weather.js#L675),
[peak field-write revisions](../../src/ui/peak-card-layout.js#L53),
[shared transport/cache](../../src/weather/open-meteo-client.js#L135).

**Extraction:** only after eligibility is stable, consider a latest-read owner
for generation/abort/pending bookkeeping. Settings extraction should be separate
and limited to explicit keys/revisions; ascent serial placement writes and peak
per-field optimistic patches need not use identical reconciliation policy.

Preserve last-known-good labels and feature-specific freshness/fallback behavior.
The ascent archive permits a visit-local startup Best Match fallback; clouds
preserve an unavailable saved model. Shared request code must not collapse these
policies, combine authenticated first-party reads with public provider fetches,
or retry a worker-owned remote write. No missing-generation race was newly
reproduced here; this is a lower-priority duplication concern.

**Acceptance:** A → B selections with A completing last; failure/finally from A
while B is pending; disable/suspend during a held read; failed settings saves and
late reads after newer gestures. Importing the helper in two IIFEs does not share
cache state. Cross-page Open-Meteo deduplication remains the separate design in
the [request audit](open-meteo-peak-request-audit-2026-10-24.md#om-03--optimization--metadata-and-page-caches-have-separate-owners).

### CR-06 · P3 · Share test contracts alongside the helpers

Drag, lifecycle and card tests already cover many of these invariants, but
adapters build separate settings, pointer and timing harnesses. Keep their native
page fixtures and distinctive scenarios; share assertion contracts for the
mechanism under migration. A generic simplified card fixture alone can miss
table layout, host form submission, late column mounting and overridden `hidden`.

Evidence: [drag tests](../../test/ui/card-drag.test.mjs),
[peak layout tests](../../test/ui/peak-card-layout.test.mjs),
[ascent weather tests](../../test/weather/ascent-weather.test.mjs),
[peak chart tests](../../test/weather/peak-weather-hourly.test.mjs).

**Acceptance:** execute each shared contract against both real adapters and
retain surface-specific assertions. For reproduced bugs, prove a new correctness
assertion fails on the original behavior and passes on the fix. Unknown test
selections and zero-case runs must fail. This audit did not reorganize tests.

## Reuse inventory and boundaries

| Layer | Current shared code | Keep with surface/domain |
| --- | --- | --- |
| Columns | `createColumnResize`, `createLayoutMenu` | Peak native-table split; ascent report/summary recognition |
| Card lifetime | `createPageLifecycle`, `createRetryCooldown`, `createStableText` | Eligibility/TTL adapters; worker-write reconciliation |
| Safe content | `dom.element`, weather icons, units, offline mountain time | Native readers, supported metrics and displayed source identity |
| Weather data | One core surface-weather client; model/day validation; hourly series/table | Current peak window versus ascent historical date; pressure-profile capabilities |
| Movement | Shared move menu; ascent drag helper | Peak ordered rows and collapse; ascent docking and GPS restoration |
| Visuals | Shared hourly table CSS; peak header CSS within peak cards | Cross-surface shell/tokens still an opportunity |

The shared column resizer is the useful precedent: both table-split owners
configure it, while each still recognizes and mounts its own native structure.
See [peak split](../../src/ui/peak-table-split.js#L3) and
[ascent split](../../src/ascent/ascent-table-split.js#L14).

Saved-ascent weather currently provides one standalone movable-card example.
Its approximately 710-line module includes docking, safe GPS reparenting, strict
historical identity, GPX cursor integration and plotting. Line count is not a
defect by itself. Extract chart mechanics with two existing consumers first;
keep docking as an internal module until a second compatible ascent card needs
it. A global ascent-card registry would be speculative at this point.

Do not unify:

- Peak table-row mounting and ascent sibling-section docking.
- MAIN-world GPX/Sun & Moon ownership and isolated extension settings access.
- Current summit forecasts, historical ascent dates and pressure-profile clouds.
- Authenticated Peakbagger reads, public weather CORS, and worker-owned writes.
- Backup inline controls and add/edit form feedback with movable data cards.
- Peak portable order/collapse keys and ascent weather's existing placement keys.

## Suggested implementation order

Each step is a focused, independently verified commit; none is implemented here.

1. Add correctness regressions and fix collapsed-weather loading and calm ascent
   axis labels independently. Preserve their pre-fix evidence.
2. Share read eligibility across peak weather/clouds, then add the ascent adapter.
   Treat any snow/map-client migration as a separate integration.
3. Share pure chart range/tick/series logic between weather cards; extract display
   mechanics only where both callers retain their features and accessible input.
4. Introduce shared visual tokens/shell parts, preserving per-surface layout.
   Verify real manifest loading and both rendered surfaces together.
5. Consolidate gesture mechanics behind target/preview adapters. Keep placement
   storage and native-node ownership local.
6. Reassess request/settings bookkeeping after those extractions; defer if the
   remaining code is mostly domain policy rather than duplicated mechanism.

Extract shared test contracts with each migration. Avoid a large all-at-once
card framework rewrite. Document new APIs in the convention only when they
actually exist and identify which callers have migrated.

## Verification and proof limits

- Source inspection covered the shared UI helpers, peak layout, peak weather/
  cloud/snow controllers, historical ascent weather, shared weather data/table
  code, relevant CSS, build/manifest registration and focused tests.
- The retained axis probe executes the built ascent layout/weather bundles with
  a masked HTTPS Peakbagger fixture in jsdom. Public provider/Peakbagger transport,
  settings and 620 px chart bounds are stubbed. It confirms duplicate rendered
  numeric labels for zero wind and records source/bundle hashes.
- Existing focused chart, ascent, movement, lifecycle, stable-feedback and
  cooldown tests passed **87/87** on the built `dist/` snapshot used by the probe.
  Peak-chart working-tree edits were concurrently in progress; this is not a
  verification claim for all unrelated work or a release qualification.
- The linked Open-Meteo report retains its own 23 request-count scenarios and
  verification boundaries. They were not repeated just to perform this audit.
- Documentation/link tests passed **3/3**; `git diff --check` passed.

No browser was launched for this structural audit: there is no browser version,
renderer or real viewport to report. The 620 px value is stubbed chart geometry,
not a visual inspection. No new focus/drag/layout transition, live-provider,
native host, screen-reader or cross-world integration proof is claimed. Future
runtime changes require the real-browser checks in the convention and AGENTS.

## Closure ledger

- **Fixed and verified:** conventions document the extraction/adapter boundaries.
  CR-01's collapsed-weather defect is fixed: saved collapse suppresses loading,
  collapse cancels pending reads, and fresh retained data survives expansion.
  Both new regressions failed on the original implementation, then all 85 peak
  weather tests passed after a 53-bundle build. `git diff --check` passed.
  CR-02's calm-axis defect is fixed with a readable minimum wind range. The new
  regression failed with the original `0, 1, 1` labels; all 55 ascent-weather tests
  then passed in metric and imperial coverage. The retained axis probe now checks
  correctness by default; `--expect-regression` is for the historical bundle only.
  CR-01 now shares `createCardReadGate` across peak weather, clouds and ascent
  weather. The helper owns eligibility transitions and cancellable viewport waits;
  features retain request/TTL policy. Shared gate and integration coverage passed
  146 tests after a build. Settings/theme updates do not restart eligible reads.
  CR-02 now shares pure range/tick selection and hourly series construction across
  the ascent/peak charts. All 71 scale/chart/ascent tests and focused ESLint passed.
  The renderers retain their bar/line, GPX and reference-height differences.
- **Intentionally not changed:** native mounting, settings keys, provider policy,
  worker-write ownership and unrelated work. The remaining extractions are still
  being implemented.
- **Changed but not fully proven:** real-browser collapse/expansion and broader
  interaction/visual checks are pending. Local tests do not establish them.
