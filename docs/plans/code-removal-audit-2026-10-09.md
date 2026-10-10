# Code-removal audit — 2026-10-09

Baseline: `c9a1a26`, clean main checkout. Work is isolated on
`codex/code-removal-audit`; no push, merge, or release is included.

## Scope and findings

Count useful behavior, not presumed authorship or a target deletion percentage.
The audit scanned all 414 tracked JavaScript files for references, runtime
imports, duplicate blocks, and unused exports. Expanded ESLint checks covered
412 files; the baseline `npm test` passed all 2,385 tests. Every runtime module
is reachable from the build/import graph, so no whole runtime file was proven
unnecessary. Static analysis produces candidates, not proof of every possible
simplification.

| ID | Finding and evidence | Acceptance |
| --- | --- | --- |
| R1 | Eleven unused namespace exports repeat already-consumed named exports; internal API objects also expose members with no outside reference. Examples: `src/capture/provider-timing.js` (lines 15–21), `src/peakbagger/peakbagger-origin.js` (lines 75–81), and `src/reports/report-markup.js` (lines 1379–1402). | Remove unconsumed exports, retain internally used implementations and the deliberate provider page-world global. Lint, focused tests, full integration, real-extension startup. |
| R2 | `computeRouteDistanceM` in `src/gpx/gpx-metrics.js` (lines 291–327) has no production caller and duplicates segment preparation for the live metrics pipeline. | Remove it; move both gap/join regression cases onto `computeMetricsForSegments`. Verify invalid-coordinate splits, nearby joins, full metrics/capture suites, scale coverage. |
| R3 | Small test-only compatibility helpers expose behavior already available through the live APIs: ascent ownership, backup folder paths, style validity, and relative local days. | Remove wrappers and move assertions onto production readers, loaders, and local-day numbers. Preserve independent expected values and edge cases. |
| R4 | Static imports still have presence checks and fallback branches from the former global-module loading arrangement. Examples: `src/terrain/terrain-map.js` (lines 246–248 and 358–374), `src/maps/big-map.js` (line 427), and `options/options.js` (lines 85–87). | Remove impossible missing-import branches. Retain failed reads, stale generations, external browser/MapLibre capabilities, consent, and identity gates. Focused tests and real-extension verification. |
| R5 | `scripts/release-bump.mjs` (line 13) explicitly returns at the end of `die`. | Remove the redundant return; release tests and lint. |

Each independent removal receives its own focused commit after its checks pass.
Finish with the full unit suite, lint, scale coverage, and hidden real-extension
verification. Archive this ledger after disposition; preserve unrelated active
plans.

## Closure ledger

### Fixed and verified

- R1: removed 11 unused namespace exports, 55 unconsumed internal API entries,
  and the obsolete peak-zoom constant exposed only by an unused entry. Named
  exports with callers, internal implementations, and `BPBProviderPage` remain.
  All 2,385 unit tests and runtime ESLint passed; `git diff --check` passed.
  Real-extension startup remains part of final verification.
- R2: deleted the unused route-distance implementation and moved both
  coordinate-gap/join regressions onto the live `computeMetricsForSegments`
  pipeline. All 84 focused metrics, capture, and full-analysis scale tests,
  scoped ESLint, and `git diff --check` passed.
- R3: removed four test-only compatibility wrappers. Ownership tests now
  assert the production reader's owner flag and null edit URL; date-line tests
  assert the live local-day values. Existing folder-name and valid-style-loader
  tests retain the other behavior. All 44 focused tests, scoped ESLint, and
  `git diff --check` passed; no test case was deleted.
- R4: removed obsolete module-presence fallbacks in Settings cache usage,
  ascent filtering, BigMap route limiting, terrain setup/consent, and theme
  injection. Failed settings reads, feature-write confirmation, stale revisions,
  runtime browser capabilities, and externally supplied MapLibre remain guarded.
  The build, 353 focused options/filter/map/terrain/theme tests, scoped ESLint,
  and `git diff --check` passed. Real-browser integration remains pending.

### Intentionally not changed

- Keep readable helpers, comments explaining invariants, independent test
  oracles, and provider-specific interactions. No large exact duplicate
  function was found by the normalized-AST scan.
- Keep permission, ownership, settings validation, cancellation, stale-result,
  serialization, and manual Save boundaries. Similar shapes across a data
  export and a recovery identity do not prove interchangeable semantics.
- Keep `markUnreachable` for the photo model's supported persisted state and
  recovery tests; the UI intentionally does not infer remote health from an
  image load failure.
- Keep the two one-line tile-coordinate primitives: they support independent
  Web Mercator reference tests. Replacing those test entry points with an
  enumeration harness would add complexity for two deleted runtime lines.
- Keep the stale-generation branch in the terrain message handler. Its return
  was flagged as syntactically redundant, but the branch protects later cases;
  deleting it would accept stale messages.
- Script exports with only local callers still serve their CLI implementations.
  An unused export modifier alone is not an unused implementation.

### Changed but not fully proven

- Pending final verification. Local tests cannot establish live-provider DOM,
  native focus/window behavior, screen-reader speech, remote CI, or stores.
