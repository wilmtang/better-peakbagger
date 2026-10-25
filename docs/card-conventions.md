# Peak and ascent card implementation conventions

Read this guide before adding or changing a card on a peak page, saved ascent,
or ascent add/edit form. It covers standalone cards and panels embedded in an
existing feature. Share common mechanisms through small helpers and keep native
mounting, placement and data policy in surface adapters. Follow the owning surface
below; one universal card controller is not required.
Repository instructions in [AGENTS.md](../AGENTS.md) remain authoritative.

## Reuse across peak and ascent surfaces

Before creating another helper or copying a block from a card, identify the
existing owner of that behavior. Reuse the mechanism when its invariants match;
keep the surface's inputs and policy explicit. A new card should primarily supply
identity, content, data policy and a placement adapter, rather than another
implementation of focus, gestures, visibility and teardown.

These shared modules already exist:

| Concern | Reuse now | Policy retained by the caller |
| --- | --- | --- |
| Safe DOM and feedback | [`dom.js`](../src/ui/dom.js), [`stable-text.js`](../src/ui/stable-text.js) | Labels, status alternatives, deliberate expansion and retained content |
| Page lifetime and cooldown UI | [`page-lifecycle.js`](../src/ui/page-lifecycle.js), [`retry-cooldown.js`](../src/ui/retry-cooldown.js) | Eligible reads, cancellation, TTL, resume and remote-write reconciliation |
| Read eligibility and lazy start | [`card-read-gate.js`](../src/ui/card-read-gate.js) | Feature/date eligibility, optional collapse, freshness, retained results and cancellation |
| Movement | [`card-drag.js`](../src/ui/card-drag.js), [`layout-menu.js`](../src/ui/layout-menu.js) | Native anchors, valid destinations, order, persistence and preview strategy |
| Weather transport and time/data math | [`open-meteo-client.js`](../src/weather/open-meteo-client.js), [`weather-day.js`](../src/weather/weather-day.js), [`mountain-time.js`](../src/time/mountain-time.js) | Forecast versus historical endpoint, date range, model capabilities and freshness |
| Weather display | [`weather-hourly-table.js`](../src/weather/weather-hourly-table.js), [`weather-chart-scale.js`](../src/weather/weather-chart-scale.js), [`weather-icon.js`](../src/weather/weather-icon.js), [`units.js`](../src/ui/units.js) | Supported fields, native-unit inference, selected source and GPX cursor integration |

`card-drag.js` is currently used by ascent weather; the peak layout still owns a
separate gesture implementation. The table describes reusable building blocks,
not a claim that all current cards have migrated. Check the implementation before
assuming a convention is already enforced.

Use the following boundaries for further extraction:

- **Card shell:** share visual tokens, safe control defaults, focus treatment,
  attribution/status slots and optional header parts. Keep a peak's table row and
  disclosure under the peak layout adapter; keep an ascent section, docking and
  native GPS-node ownership under the ascent adapter. Embedded panels opt into
  only the parts their owner needs. Do not give an ascent a collapse preference
  merely to fit an abstraction.
- **Read eligibility:** one policy should evaluate settings readiness, feature
  enablement, active lifecycle, applicable document/card visibility, collapse and
  viewport eligibility. A reusable observer may report transitions, while the
  feature decides which reads to start or abort and whether cached data is fresh.
  Observe changes in eligibility, not every attribute mutation. Never fetch on a
  move, units/theme change, local hour selection or unrelated settings update.
  A collapse gate applies only to a surface that actually supports collapse.
- **Latest request ownership:** reusable transaction bookkeeping may own the
  generation, AbortController and pending state. The feature supplies request
  identity, validation, cache policy and how to label retained results. Guard
  success, failure and finalization; aborting or superseding work must not publish
  stale content or clear a newer request's busy state. Reads and worker-owned
  writes require different contracts.
- **Chart mechanics:** share series/interval math, scales, SVG primitives,
  pointer/keyboard sampling and local-time ticks where semantics match. Keep
  supported metrics, instantaneous versus interval gusts, precipitation bars or
  lines, reference elevations, day bounds and GPX cursor overlays explicit.
  A chart helper must not fetch data, infer identity or persist a model choice.
- **Placement and settings:** adapters expose valid targets and move existing
  nodes; the shared gesture mechanism consumes those targets. Persist stable
  schema-owned identifiers only. A shared settings helper may guard revisions
  and writes, but it must not choose a default model, storage world or destination
  for the caller. Preserve existing keys and migration behavior.

Treat these as extraction contracts, not available APIs. Introduce a new shared
module only after identifying at least two concrete consumers with matching
behavior, or a reproduced defect that needs one common invariant. Prefer a small
internal extraction when only one consumer exists. Avoid a base class or an
options object containing every feature's exceptions.

Code reuse and request reuse are separate. These features ship as separate IIFE
bundles: importing the same module into both shares source, not module state,
caches or subscriptions. Cross-card/page deduplication needs an explicit owner
and protocol, bounded retention, identity-aware keys and per-reader cancellation.
Do not introduce a page-world global or broaden the settings bridge to share
privileged state.

Peak weather, Summit Cloud Cover and ascent weather use `createCardReadGate`.
Call `refresh()` after authoritative settings or lifecycle changes; use
`waitForViewport()` to start optional reads, `cancelWait()` when superseding work,
and `dispose()` on final teardown. The gate never aborts a transport or discards
results itself. Its callback lets the feature suspend/resume owned reads. Snow's
station/map client still has separate eligibility and ownership.

Both weather charts use `weatherChartRange`/`weatherChartTicks` and
`hourlyWeatherSeries`. Supply range values/references in the plotting unit system.
The ascent renderer retains precipitation bars and GPX overlays; the peak renderer
retains additional metrics and summit-height references. Shared scale/series code
does not imply one renderer or one historical/forecast data policy.

For a behavior-preserving extraction, capture the existing contract first and
migrate one consumer at a time. Reuse a parameterized test contract for common
invariants, with a fixture adapter for each surface. Keep native markup, host CSS,
late mounting and execution-world differences faithful. Check DOM identity,
focus, fetch counts, cancellation, retained source labels and geometry across
transitions; shared unit tests alone cannot establish both integrations.
Make an intentional behavior change, including a bug fix, explicit and separately
reviewable from mechanical code movement.

## Ownership and mounting

- Author plain ES modules under the feature's owning directory. Separate pure
  calculations, bounded provider clients and DOM/lifecycle ownership. Use
  `dom.element` and text nodes for provider text; do not interpolate it into HTML.
- Read identity, date and coordinates through the relevant validated page reader.
  Peak forecasts use `readPeakWeatherSubject`; the ascent weather archive uses
  `readWeatherSubject` in `ascent-weather-subject.js`. Do not infer an ascent date
  from report prose, substitute today's date, or geocode a guessed summit name.
  Do not reuse backup's best-effort reader for strict weather identity.
- Mount once, with a stable feature ID and an accessible label. Follow the
  surface-specific host structure below. Keep settings-gated UI hidden and
  requests stopped until the authoritative settings read succeeds.
- Keep native map, report, legend, form and download controls with their owners.
  Reuse existing table splits. A documented feature-specific reparenting path
  must preserve nodes and handlers and provide restoration on disposal; it is
  not permission for a new card to move arbitrary native content.

## Choose the correct layout owner

| Surface | Owner and placement | Movement and disclosure |
| --- | --- | --- |
| Standalone peak card | `peak-card-layout.js`; independent table row in the recognized peak table | Shared order, columns, grip, move menu and header collapse |
| Saved-ascent weather archive | `ascent-weather.js` within the columns from `ascent-table-split.js` | Opt-in `createCardDrag`; weather-owned placement settings; hourly/source disclosures |
| Ascent GPX Analyzer and its Sun & Moon panel | `gpx-analyzer.js` and `sun-calculator.js` | Keep their existing embedded layout, settings bridge and disclosures |
| Add/edit ascent summit picker or upload feedback | `ascent-upload.js` beside its native form controls | Form-owned interaction; no automatic registration as a movable page card |
| Saved-ascent backup control | `ascent-backup.js` beside the owner's native edit actions | Inline action/status group; background worker owns remote writes |

## Peak cards: shared header, collapse and placement

Mount a labelled `<section>` inside its own `<tr><td colspan="2">` in the
recognized peak table. Its direct header contains an `h2`; its remaining children
are body content. Initially hide both row and section until settings resolve.

[`src/ui/peak-card-layout.js`](../src/ui/peak-card-layout.js) owns card discovery,
the header disclosure, drag grip, keyboard move menu, column placement, ordering
and persistence. Register a new standalone card in its definitions and extend
`PEAK_CARD_ORDER`, column defaults and the collapse key in the shared settings
schema. Preserve existing user order; normalization appends newly introduced IDs.

The layout owner moves existing nodes into `.bpb-peak-card-body` without replacing
listeners. Keep the heading directly inside the header, or inside a removable
heading wrapper, and keep actions separate from the heading. It places actions
and supplemental header content in the body toolbar. Do not add another collapse
button, drag implementation or competing stored layout.

Use [`src/ui/peak-card-layout.css`](../src/ui/peak-card-layout.css) for shared
header geometry, typography, chevron, grip and focus treatment. Common rules use
the layout owner's `data-bpb-peak-card` marker; registering a new card does not
require another ID in those selectors. Keep feature header/button defaults at
low specificity (`:where(...)`) so shared controls retain their geometry.
The whole heading is the disclosure;
the grip is a separate control. Expansion and reordering are deliberate layout
changes. Async refresh is not.

Observe `hidden` and `data-bpb-card-collapsed` when deciding whether to load or
suspend data. The feature owns its requests and render lifecycle. The shared
layout owns the disclosure. A deliberate feature action can dispatch
`bpb:reveal-card`; ordinary refresh must not expand or scroll the card.

## Saved-ascent cards: columns and explicit docking

[`ascent-table-split.js`](../src/ascent/ascent-table-split.js) owns only the
report/summary column split. It recognizes the adjacent native report and Summary
Total Data tables, including the supported metadata-only variant without report
prose. It supplies `#bpb-ascent-report-column` and `#bpb-ascent-summary-column`,
the shared column resizer and narrow-screen stacking. It is not a card registry.
Do not register ascent cards in `PEAK_CARD_ORDER` or use peak-only destinations.

The current standalone example is
[`ascent-weather.js`](../src/ascent/ascent-weather.js). Its labelled section is
a sibling of the native table within a split column, not a peak-style table row.
It defaults to the summary column after the dedicated GPS details, where present.
Placement must tolerate the split or GPX surface mounting later, preserve the
same card node and controls, and avoid repeated reparenting/mutation loops. Its
existing fallback uses validated map/metadata anchors when the split is absent;
do not make that fallback a universal document-body mount for new cards.

For a movable ascent card, explicitly opt into
[`createCardDrag`](../src/ui/card-drag.js) and
[`card-drag.css`](../src/ui/card-drag.css). Supply the card, grip, drag surface,
status region, enabled predicate, current position, valid targets and move
callback. The helper owns pointer/keyboard gestures, move-menu behavior, preview
and cancellation. The feature owns placement and persistence; the helper neither
discovers other cards nor writes settings. Keep controls within a draggable
header usable and dispose/cancel the helper with its feature lifecycle.

The archive's settings are `bpbAscentWeatherColumn` (`report` or `summary`) and
`bpbAscentWeatherSlot` (`before`, `gps` or `after`). Targets are built from actual
anchors: before a native table, before dedicated GPS details where available,
or after the relevant table/details. Other cards need their own schema-owned
settings if movement is part of their design; never reuse weather's keys.
Persist completed moves, guard late reads/queued writes against newer gestures,
and retain usable visit-local placement when saving fails. Moving a card must
not recreate its chart, lose selection, fetch data or alter another card's state.

The weather archive's dedicated GPS-note/download blocks are a deliberate
exception: it reparents only recognized safe blocks, preserves their handlers,
keeps them in the summary column when weather moves left, and restores their
origins on disposal. The map, report and GPX Analyzer are not draggable weather
content. Do not copy this exception to other cards.

Ascent cards do not currently have a universal header-collapse controller.
Keep existing feature disclosures and do not add peak collapse attributes or
a competing global registry. See [historical ascent weather](ascent-weather.md)
for the archive's date/model semantics and GPX cursor integration.

## Embedded panels and ascent forms

Extend the existing owner when a panel belongs inside the GPX Analyzer or an
add/edit form. The Analyzer runs in the MAIN world; archive weather and form
features run in the isolated world. Keep that boundary, the narrow validated
settings bridge and each feature's established theme/units inputs intact.

Mount upload/picker feedback beside the relevant form controls, with explicit
button types and stable pending/error states. Preserve native Preview/Save and
form validation; adding a card never authorizes automatic Save. Keep identity,
ownership and draft-delivery gates fail closed. The saved-ascent backup surface
is an inline control group, not a standalone card to reorder or wrap in a new
table. Follow its existing reconciliation flow for uncertain remote writes.

## Appearance and controls

- Peak and ascent weather opt into [`card.css`](../src/ui/card.css) through
  `data-bpb-card="weather"`. Reuse its semantic palette, hidden/focus rules and
  shell; keep feature density/spacing local. Load it through the real manifest
  before feature CSS and include it in faithful fixtures. GPS details, cloud/snow
  palettes and embedded MAIN-world panels retain their existing variants.
- Scope feature CSS to the card ID. Use the existing light palette and
  `html[data-bpb-theme="dark"]` overrides for isolated page cards. Embedded
  Analyzer panels use their owner's resolved `data-theme`/palette instead of
  introducing an independent OS-theme detector.
  Reuse the shared header, system font, neutral borders, compact controls and
  packaged icons. Do not add a framework or remote assets for a card.
- Keep the card within its column: `min-width: 0`, bounded selects and tables,
  and container queries for internal layouts. Test both supported columns and
  narrow pages. Do not widen the page to fit a chart or long model name.
- Use labelled native selects and `button[type="button"]`. Give selectors an
  explicit empty `form` owner where necessary to prevent Enter from submitting
  Peakbagger's surrounding ASP.NET form. Give disclosures and buttons clear
  accessible names and visible keyboard focus.
- Honor units through `units.resolveUnits` and the owning page's native-unit
  reader (`readPeakUnitSystem` for peak pages; the archive's existing native
  elevation-text inference on ascents). Embedded panels use their owner's
  validated unit settings.
  Store raw measurements, then format them at render time. Changing units must
  reuse data.
- Resolve timezone offline with `mountainTime`. Keep UTC instants as identities;
  derive local dates and labels from the location's timezone, including repeated
  and missing DST hours. Archive weather uses the summit-local ascent date;
  track charts use their existing track-local time resolver. Never replace
  either with the browser's timezone or send a track for timezone lookup.
- For provider-backed data cards, keep a source/attribution footer and a concise,
  actionable unavailable state. Put methodological detail behind a disclosure.
  Label experiments and distinguish observations, model output and derived estimates.

## State, settings and requests

- Use [`settings-schema.js`](../src/settings/settings-schema.js) for portable
  preferences, feature gates, defaults and validation. Write through `settings`;
  do not introduce page localStorage or widen the MAIN-world settings allowlist.
  Existing column-width preferences (`pbAscentTableSplit.v1` and the peak split's
  counterpart) are explicitly owned page-local exceptions, not a precedent for
  new model/card preferences. Persist explicit choices only, not defaults during
  mount or render.
- Resolve settings before the first request. A saved unsupported selection must
  follow the owning feature's documented policy and must not overwrite the user's
  preference. Summit Cloud Cover keeps an unsupported choice unavailable; the
  historical ascent archive permits a visit-local startup Best Match fallback
  for a different ascent's date/coverage. Neither authorizes replacing an explicit
  in-page choice. Name the displayed source separately when retaining older results.
- Use `createPageLifecycle` for BFCache-aware suspend/resume/dispose. Cancel
  feature-owned reads, gestures and timers on disable, applicable collapse,
  page suspension or superseding selection; disconnect observers and unsubscribe
  on final disposal. Resume without duplicate cards or listeners. A page lifecycle
  event does not cancel a remote write already owned by the background worker:
  ascent backup invalidates page UI work and reconciles on resume without
  resubmitting that write. Do not equate hiding a card with undoing an operation.
- Load optional remote data cards lazily when visible. Bound request windows,
  response bytes, cache size and concurrency; use deadlines and AbortSignals.
  Public weather-provider requests omit credentials and referrers and use explicit
  provider URLs. First-party authenticated reads and worker-owned transfers must
  retain their existing trusted request helpers and consent/ownership gates.
  Handle 429 cooldowns through the shared rate-limit helpers and
  `createRetryCooldown`; do not automatically loop on failures.
- Every async completion needs an owner/generation check, including failures and
  finally blocks. Abort alone is insufficient. A late model/date reply must not
  replace newer intent. Keep the last usable result through refresh or failure,
  with its actual date/source still labelled.
- Missing, stale or invalid values remain unavailable. Never convert missing
  weather, elevation, snow or visibility into zero or a favorable condition.

## Stable feedback and accessibility

Use [`createStableText`](../src/ui/stable-text.js) to reserve the actual wrapping
of short alternate labels/status messages. Sizing content must be noninteractive
and hidden from accessibility output. Avoid fixed heights that clip errors,
oversized empty reservations or invisible focusable controls.

Keep control nodes, dimensions and reading position stable across idle, loading,
success, error and retry. Prefer `aria-disabled` when native disabling would lose
focus; guard pointer, keyboard and change/submit handlers as well. Preserve usable
old content rather than collapsing it during refresh. Never auto-focus or scroll
to compensate for a reflow. Use polite status announcements, not duplicate
live regions containing all hidden alternatives.

## Integration and verification

1. Register bundles/copied assets in `scripts/build-config.mjs` and their real
   manifest references/order. Keep execution worlds unchanged unless required.
2. Update feature/privacy documentation, settings UI and export/sync behavior as
   appropriate. Keep domain-specific limitations explicit.
3. Add pure algorithm/client tests and fixture-based lifecycle/interaction tests.
   Exercise cancellation, missing data, saved selection and unavailable states.
   For ascent cards, include report and summary placement, before/after/GPS slots
   where supported, late split/GPX mounting, metadata-only and no-GPX ascents,
   fallback layouts and preservation of native controls. For embedded form panels,
   exercise the native form's validation and Preview/Save boundaries.
4. Build `dist/`, then inspect the real rendered card with faithful host styles.
   Use the hidden HTTPS Peakbagger fixture workflow in `AGENTS.md`. Check Chrome
   and Firefox, light/dark, narrow columns and enlarged text. Compare geometry of
   controls, card, following content and scroll through applicable transitions.
5. Run `npm run verify -- chrome` after manifest, bundle or startup changes. A
   jsdom test or stubbed fixture does not establish real extension startup.
6. Record checks actually run, browser/viewports, hidden versus visible execution,
   remaining live-provider or native-UI gaps, and confirm process/profile teardown.

Useful examples: [`peak-weather.js`](../src/weather/peak-weather.js) for retained
source identity and local dates, [`peak-snow.js`](../src/snow/peak-snow.js) for stable
feedback and guarded native controls, the peak layout owner for persistent
collapse/order, [`ascent-weather.js`](../src/ascent/ascent-weather.js) for explicit
column docking, and [`ascent-backup.js`](../src/ascent/ascent-backup.js) for the
worker-write lifecycle boundary. These are examples, not authorization to copy
feature-specific exceptions or unrelated legacy behavior.
