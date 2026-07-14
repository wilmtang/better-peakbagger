# Repository agent instructions

Act like a skeptical senior engineer. Inspect relevant code before editing, identify root causes and broken invariants, and prefer the smallest safe change. Add regression tests when practical, state exactly what was verified, and do not perform unrelated refactors.

When making code changes, commit each completed independent unit of work before starting another. Keep every commit focused and do not bundle unrelated changes. Run checks appropriate to the change before committing; do not commit knowingly broken or incomplete work merely to satisfy this rule. Preserve unrelated user-owned working-tree changes unless the user explicitly asks to include them.

## Architecture

This is a build-free Manifest V3 browser extension for Chrome and Firefox. `manifest.json` is the source of truth for permissions, entrypoints, execution worlds, and script order. See `README.md` for the full design and privacy model; keep this section focused on boundaries that code changes must preserve.

- `src/background.js` is the service-worker coordinator for activity-capture jobs, Peakbagger summit lookup, temporary session state, draft tabs, and handshakes. Keep reusable track validation, scoring, metrics, and GPX reduction in the pure `src/capture-core.js` module rather than coupling those algorithms to browser APIs.
- Peakbagger content scripts normally run in the isolated extension world, where extension APIs are available. `src/gpx-analyzer.js` and the on-demand `src/provider-page.js` run in the page's MAIN world because they need page-owned globals or authenticated same-origin page state; MAIN-world code cannot call extension APIs. Do not move code across this boundary without re-evaluating its data access and browser compatibility.
- `src/bridge.js` is the narrow settings bridge from the isolated world to the MAIN-world GPX Analyzer via `window.postMessage`. `src/settings.js` owns validation and `chrome.storage.sync` access. Do not create a second settings schema or expose privileged extension messaging directly to page-world code.
- Activity capture is an explicit, short-lived transaction started by a toolbar click and scoped by `activeTab`; there are intentionally no persistent Garmin or Strava host permissions. `src/provider-page.js` must verify ownership before fetching provider GPX and must fail closed when ownership signals or provider DOM are ambiguous.
- Raw provider GPX is parsed on the activity page and must never leave that page or be persisted. Only analysis fields may reach the background worker. The later Peakbagger Preview payload is newly serialized from an allowlist containing latitude, longitude, and segment structure only; never forward or redact the source XML in place.
- Summit lookup must be complete before results are presented: partial corridor responses are not equivalent to "no peaks." Privacy or correctness gates—including Peakbagger login, ownership, track validation, draft identity, and expected form structure—must remain fail closed.
- Prepared drafts live in `storage.session`, expire after 30 minutes, and are delivered only after `src/ascent-draft.js` and the background worker verify the sender tab plus job, peak, and climber identity. Draft filling may trigger GPS Preview exactly once, but no extension path may click either Peakbagger Save control; final review and Save always belong to the user.
- Assign Peakbagger's alphabetical suffixes only among selected drafts that share an ascent date, using track-encounter order before confidence-ranked tab opening; singleton dates keep the suffix blank. Encounter time is not a Peakbagger suffix and must not be written into `SuffixText`.
- Site settings and theme originate in `src/settings.js`. `src/theme.js` applies the theme at `document_start` using a synchronous page-local mirror to avoid a light-mode flash, then reconciles with `storage.sync`; preserve the stylesheet-before-theme invariant when changing theme startup.
- Page features stay separated by surface: `src/gpx-analyzer.js` owns ascent GPX analysis, map synchronization, and its extension-owned route overlay; `src/ascent-filter.js` owns PeakAscents filtering and in-DOM sorting; and `src/ascent-draft.js` owns validated draft filling. The route overlay must not mutate Peakbagger's native layers and must remain behind its native route and markers. Prefer extending the owning surface over adding cross-feature globals.
- Tests mirror these boundaries under `test/`: pure capture algorithms, provider adapters, background handshakes, draft privacy/exactly-once behavior, popup behavior, settings/theme, and fixture-based Peakbagger pages. Add focused regression coverage beside the affected boundary; live provider DOM and export behavior still require manual browser verification before release.

## UX bar — design like a senior Apple designer

Hold every user-facing change to the clarity, restraint, and finish a senior Apple product designer would expect. Optimize for the user's outcome, not for exposing implementation machinery, and never trap or surprise the user.

- **Clarity first.** Give each surface one obvious primary action. Use plain language, explain confidence and failure states in terms users can act on, and move technical detail to the README instead of crowding the popup.
- **Restraint.** Prefer a sensible default over another setting, control, banner, or line of copy. Reuse the extension's existing components and visual language; Strong and Probable states must stay consistent everywhere.
- **Reversible and safe.** Make consequential actions explicit, keep temporary feedback dismissible, preserve manual review before Save, and never transmit or retain activity data beyond the consent and privacy boundaries documented by the product.
- **Native browser feel.** Use familiar browser and platform affordances, keyboard navigation, meaningful focus states, accessible names, sufficient contrast, and layouts that work in both Chrome and Firefox, light and dark contexts.
- **Show, don't tell.** Prefer a concise visual cue, progress state, or actionable error over explanatory prose. Motion should be brief, purposeful, and respect reduced-motion preferences.

For UI changes, add focused behavior tests when practical and visually inspect the real rendered result at relevant popup/page sizes before calling the work complete. A passing DOM test alone does not establish that the UX is polished.
