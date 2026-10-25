# Peak-page card implementation conventions

Read this guide before adding or changing a standalone peak-page card. It describes
the shared implementation contract, not a new component framework. Repository
instructions in [AGENTS.md](../AGENTS.md) remain authoritative.

## Ownership and mounting

- Author plain ES modules under the feature's owning directory. Separate pure
  calculations, bounded provider clients and DOM/lifecycle ownership. Use
  `dom.element` and text nodes for provider text; do not interpolate it into HTML.
- Parse the current peak with `readPeakWeatherSubject` or the relevant validated
  page reader. Fail closed on ambiguous coordinates or an unrecognized native
  layout. Do not geocode a guessed name or mount a full-page fallback.
- Mount once, with a stable `bpb-…` root ID. A standalone card is a labelled
  `<section>` inside its own `<tr><td colspan="2">` in the recognized peak table.
  Its direct header contains an `h2`; its remaining children are the body content.
  Initially hide both row and section until settings have been resolved.
- Keep native map, legend, full-screen links and details in their owning DOM.
  Reuse the existing page/table split; do not move native nodes for a new card.

## Shared header, collapse and placement

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
header geometry, typography, chevron, grip and focus treatment. Extend its card
selectors when registering a new surface. The whole heading is the disclosure;
the grip is a separate control. Expansion and reordering are deliberate layout
changes. Async refresh is not.

Observe `hidden` and `data-bpb-card-collapsed` when deciding whether to load or
suspend data. The feature owns its requests and render lifecycle. The shared
layout owns the disclosure. A deliberate feature action can dispatch
`bpb:reveal-card`; ordinary refresh must not expand or scroll the card.

## Appearance and controls

- Scope feature CSS to the card ID. Use the existing light palette and
  `html[data-bpb-theme="dark"]` overrides, not an independent OS-theme detector.
  Reuse the shared header, system font, neutral borders, compact controls and
  packaged icons. Do not add a framework or remote assets for a card.
- Keep the card within its column: `min-width: 0`, bounded selects and tables,
  and container queries for internal layouts. Test both supported columns and
  narrow pages. Do not widen the page to fit a chart or long model name.
- Use labelled native selects and `button[type="button"]`. Give selectors an
  explicit empty `form` owner where necessary to prevent Enter from submitting
  Peakbagger's surrounding ASP.NET form. Give disclosures and buttons clear
  accessible names and visible keyboard focus.
- Honor units through `units.resolveUnits` and `readPeakUnitSystem`. Store raw
  measurements, then format them at render time. Changing units must reuse data.
- Resolve timezone offline with `mountainTime`. Keep UTC instants as identities;
  derive local dates and labels from the location's timezone, including repeated
  and missing DST hours. Never use the browser's timezone for summit forecasts.
- Keep a source/attribution footer and a concise, actionable unavailable state.
  Put methodological detail behind a disclosure. Label experiments and distinguish
  observations, model output and derived estimates.

## State, settings and requests

- Use [`settings-schema.js`](../src/settings/settings-schema.js) for portable
  preferences, feature gates, defaults and validation. Write through `settings`;
  do not introduce page localStorage or widen the MAIN-world settings allowlist.
  Persist explicit choices only, not defaults during mount or render.
- Resolve settings before the first request. A saved unsupported selection must
  not silently become another model or overwrite the user's preference. Name
  the displayed source separately when retaining older results.
- Use `createPageLifecycle` for BFCache-aware suspend/resume/dispose. Cancel
  pending work on disable, collapse, page suspension or superseding selection;
  disconnect observers and unsubscribe on final disposal. Resume without creating
  duplicate cards or listeners.
- Load lazily when visible. Bound request windows, response bytes, cache size and
  concurrency. Use deadlines, AbortSignals, omitted credentials, no referrer and
  explicit provider URLs. Handle 429 cooldowns through the shared rate-limit
  helpers and `createRetryCooldown`; do not automatically loop on failures.
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
feedback and guarded native controls, and the shared layout owner for persistent
collapse and placement. These are examples, not authorization to copy their
feature-specific exceptions or unrelated legacy behavior.
