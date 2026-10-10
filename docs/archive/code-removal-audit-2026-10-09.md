# Code-removal audit — 2026-10-09

Baseline: `c9a1a26`, clean main checkout. Completed locally on
`codex/code-removal-audit`; no push, merge, or release occurred. This ledger
records the audit begun on October 9 and closed on October 10.

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
| R6 | Final scale verification exposed an unchanged stale Favorites backup stub: it supplies only a commit URL, while the live UI requires the repository and content signature. Its readiness condition also watches a container that becomes visible before authentication finishes. | Match the worker acknowledgement, await the enabled Backup button, and rerun scale and acknowledgement tests. Preserve production confirmation checks. |

Implementation commits: `56897e5` (R1), `a312a52` (R2), `87f4040` (R3),
`a7ed9cd` and `01f2e71` (R4), `d6499e3` (R5), and `65e1c12` (R6).
Each was committed after its focused checks passed.

## Closure ledger

### Fixed and verified

- R1: removed 11 unused namespace exports, 55 unconsumed internal API entries,
  and the obsolete peak-zoom constant exposed only by an unused entry. Named
  exports with callers, internal implementations, and `BPBProviderPage` remain.
  All 2,385 unit tests and runtime ESLint passed; `git diff --check` passed.
  Final hidden Chrome and Firefox startup/integration checks also passed.
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
  and `git diff --check` passed. Final hidden Chrome/Firefox integration passed.
  A final scan also removed the initial filter-settings read's presence guard;
  its read/validation fallback remains. All 57 filter tests and scoped ESLint
  passed, and the presence-candidate scan now returns no matches.
- R5: removed the redundant end-of-function return in release error reporting.
  All 46 release tests, scoped ESLint with `no-useless-return`, and
  `git diff --check` passed.
- R6: updated the stale scale acknowledgement with the repository and exact
  favorites signature; await the enabled Backup button. All 10 focused
  Favorites scale/backup-acknowledgement tests, scoped ESLint, and
  `git diff --check` passed. The runtime confirmation boundary is unchanged.

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

- The removals are locally verified. Live-provider DOM, native browser chrome,
  focus/window placement, screen-reader speech, remote CI, and store acceptance
  remain outside this audit's evidence. No hosted workflow or store action ran.
- Static scans and inspected candidates do not establish that every possible
  simplification in the repository has been found, or identify code authorship.

## Final verification and size

- `npm test`: 2,385 passed, zero failed. No test case was removed.
- `npm run test:scale`: 14 passed, zero failed after the R6 fixture repair.
- `npm run lint`: passed with six owned web-ext warnings; no ESLint errors.
- `npm run verify:browsers`: passed on the final runtime code in hidden Chrome
  for Testing 153.0.8010.12 and Firefox 157.0.1, base viewport 1000×760 plus
  their responsive cases. Real manifests, worker startup, cross-world settings,
  form/draft identity, exactly-once Preview, and manual Save boundaries passed.
- `node scripts/verify-terrain-visual.mjs` with a disposable output directory:
  passed in hidden Chrome 155.0.8059.39 on ANGLE Metal / Apple M3 Pro. Wide
  798×448 and default 448×448 maps, 1280×950 and 1000×900 page states, resize,
  degraded DEM coverage, pending drape, and failure recovery passed. Light
  wide and dark default screenshots were visually inspected. This fixture
  check supplements the real-extension bridge check; it does not replace it.
- Process command lines and all recorded disposable-profile paths were checked
  after teardown. No owned browser/verifier process or profile remained;
  disposable screenshots and the audit's temporary bookkeeping were removed.
- `cloc 2.10`, with the same exclusions as the initial count: product source
  is 178 physical lines / 158 effective lines smaller, from 52,027 to 51,869
  effective lines. Tooling lost one effective line; the fixture repair adds
  four test lines, for 155 fewer effective lines overall. Documentation is
  recorded separately and excluded from that metric.

## Documentation and test consolidation — 2026-10-10

### Fixed and verified

- Shortened overlapping guides and superseded archive instructions in
  `4b96b0d`, `b5b6032`, and `5a79840`; all six affected closure records are unchanged.
- Shared terrain setup and capture storage faults in `5c33c5e` and `f2a2f62`;
  all 1,213 assertion expressions in the affected suites remain unchanged.
- `npm test`: 2,385/2,385. Photo/documentation checks: 21/21. Lint passed with
  the same six owned warnings; documentation links/anchors and diff checks passed.

### Intentionally not changed

- Runtime source, distinct failure models, regression cases, and historical proof gaps.

### Changed but not fully proven

- This documentation/test-harness follow-up ran no new native UI, real-browser,
  or live-provider checks; it does not extend the earlier browser evidence.
