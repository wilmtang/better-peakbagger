# Repository audit and remediation — 2026-10-21

Baseline: `main` at `ed36f52e12f02a9cf687179f0696090722203037`, version 4.0.2.
The archive-index edit and CascadeClimbers research note present at the start
belong to the owner and are excluded from these commits.

## Scope and method

This is a repository-wide boundary audit, followed by authorized fixes. Review
covered the manifest/build graph, worker routing and sender policy, capture and
draft identity, settings/credential transactions, backup and photo persistence,
report URL/markup handling, GPX/time/solar validation, shared request lifetimes,
weather/snow/map state, CI, and packaging. The baseline builds 50 bundles; all
3,131 tests and source/package lint passed, with eight owned web-ext warnings.
Existing plans and closure ledgers were reconciled before implementation.

Source review was directed at trust, ownership, resource bounds, cancellation,
failure recovery, and recent changes. It is not a claim that every line or
every live provider behavior was exhaustively proven. Module size alone did
not justify a refactor. All findings below have deterministic reproductions;
findings were reported before source edits.

## Confirmed findings

| ID | Priority | Broken invariant and reproduction | Fix commit |
| --- | --- | --- | --- |
| F1 | P2 | BC's worker assigns an absent reset header directly to its cooldown. Two tabs therefore issue two requests after a headerless 429. A later in-flight short refusal also shortens an existing deadline. | `0c24845b` |
| F2 | P2 | Ten provider readers return/throw on HTTP or metadata rejection without relinquishing the unread body. Open-stream probes finish with zero cancellation callbacks, including paths that retry. | `cb526a8f` |
| F3 | P2 | Weather, model metadata, vector styles, and DEM clients likewise bypass their cooldown on headerless 429 responses. Concurrent weather, metadata, snow, and DEM refusals can shorten a longer deadline. | `adf89f2b` |
| F4 | P2 | A readable HTTPS photo at `ridge%view.png`, `ridge%FF.png`, or a truncated UTF-8 escape downloads successfully, then fails with `URIError` while decoding its display filename. | `2418fd1c` |

F1 is the cross-tab worker boundary; F3 covers the independent per-client
request owners. Neither is an automatic write-retry change.

Source evidence:

- F1: `src/background/bc-land-routes.js`, `createBCLandRoutes` and its GET handler.
  The original header-only gate had neither a fallback nor monotonic retention.
- F2: `src/weather/open-meteo-client.js`, `src/weather/peak-weather-updates.js`,
  `src/snow/snotel-client.js`, `src/maps/sentinel-core.js`,
  `src/maps/canadian-land.js`, `src/background/bc-land-routes.js`,
  `src/maps/map-overlay-tiles.js`, `src/maps/peak-markers.js`,
  `src/terrain/terrain-style.js`, and `src/terrain/terrain-cache.js`.
  Their pre-read response checks could exit after clearing a deadline while
  leaving the body unread. The shared bounded text reader already cleaned up
  streams it acquired; rejection before acquiring that reader was the gap.
- F3: the `limited`/`limitedUntil` owners in the weather, metadata, snow, style,
  and DEM clients above. Direct two-request probes produced two provider calls
  after a headerless refusal in all four affected services.
- F4: `src/photos/photo-source-url.js`, `readPhotoSourceUrl`. URL parsing and
  image validation succeed before the unconditional filename decode fails.

## Closure ledger

### Fixed and verified

- **F1:** A five-minute worker backoff covers absent/invalid reset headers;
  concurrent refusals retain the longest deadline. Both new tests failed on
  the original source. All 11 BC route tests, focused ESLint, whitespace checks,
  and hidden real-extension Chrome verification passed before its commit.
  Coverage includes malformed/zero/excessive headers, another tab, exact expiry,
  valid provider deadlines, and out-of-order responses.
- **F2:** Every confirmed reader relinquishes its response in `finally` using
  the existing best-effort cancellation helper. The three manual stream readers
  release their locks. Cancellation is not awaited, so a stalled cancellation
  cannot replace or delay the original result. All 26 new disposal assertions
  failed before the change and pass afterward; they exercise open native
  `ReadableStream` bodies, 404/503 responses, pre-read metadata rejection,
  cancellation before retry, and cancellation that never settles. The corrected
  focused suite passed 191/191; after extending metadata coverage, the full
  suite passed 3,159/3,159. Source ESLint and hidden Chrome verification passed.
  The older DEM fixture now distinguishes acquiring a reader from cancelling
  the body, preserving its zero-read assertion and adding a cancellation check.
- **F3:** Missing/unusable resets receive the same bounded five-minute local
  backoff already used by snow and the BC worker. Valid provider deadlines
  remain authoritative; concurrent readers preserve the longer deadline.
  Twelve new leaf cases failed on the old implementation. All 155 focused tests
  passed, including explicit reset handling, cross-model/domain/station/tile
  gating, exact expiry, and out-of-order refusals. Build, focused ESLint and
  hidden Chrome/Firefox real-extension checks passed. Firefox remounted rather
  than restoring from BFCache in this run. The combined run exposed one old
  integration assertion expecting an immediately available Refresh after a
  headerless refusal; `1ebc1265` updates it to require retained partial readings,
  settled busy state and zero duplicate requests. All 65 integrated weather
  cases passed. A final consistency probe reproduced retained long deadlines
  paired with the later short response's explanation; `69a74a2e` retains the
  complete longer-lived error. Its three explanation assertions failed before
  that correction; all 83 focused tests and scoped ESLint pass afterward.
- **F4:** Decode the filename when possible, retaining its URL spelling on an
  invalid escape. Three malformed-name cases failed before the fix. All 10
  photo-source tests passed afterward, including valid escaped spaces, Unicode,
  unnamed sources, unchanged bytes/MIME, and the existing HTTPS, credentials,
  response-size, empty-body, and refusal checks. Focused ESLint and patch checks
  passed before its commit.

Combined final checks are recorded below.

### Intentionally not changed

- The strict dependency audit still fails on the three high development-chain
  findings for GHSA-86w9-cpqp-85rv: `web-ext → @devicefarmer/adbkit → node-forge`.
  Registry checks found node-forge 1.4.0 and adbkit 3.3.9 unchanged; newer web-ext
  10.8.0 still depends on adbkit 3.3.9. No available upstream upgrade removes
  this chain. The exact existing reviewed gate passes through October 24, 2026
  at 00:00 Los Angeles (07:00 UTC); its expiry and scope were not extended.
  `npm audit --omit=dev` reports zero, but shipped libraries also live in
  devDependencies, so that subset does not establish a clean shipped graph.
  The [October 3 plan](../plans/ci-ux-maintainability-audit-2026-10-03.md)
  continues to own the advisory and historical-tag recovery limitation.
- Preserve minimum permissions, raw-provider-GPX privacy, sender and draft
  identity checks, exactly-once Preview, manual Save, and existing cache and
  consent policy. No destructive remote operation, publication, push or merge
  is included in this audit.
- Preserve live provider validation, native accessibility, and hardware/LOD
  proof gaps in earlier ledgers. Proposed feed export, Imgur, and avalanche
  expansion are product work, not defects to implement under this request.
- No visual structure or styling was changed. A URL filename is display
  metadata, not an additional reason to reject successfully validated pixels.

### Changed but not fully proven

- Stream tests prove cancellation invocation, lock release through existing
  success/error tests, and prompt local settlement. They do not measure real
  socket lifetime, garbage collection, or provider bandwidth under an outage.
- Cooldown expiry uses deterministic clocks; native fetch/permission decisions
  and provider replies in browser fixtures remain stubbed. No live provider
  requests, account writes, store submission or hosted CI run were performed.
- Hidden browser focus/geometry and screenshots do not establish OS focus,
  window placement, screen-reader speech, native menus or permission prompts,
  physical touch, Android, or other operating systems.
- The [October 19 terrain warming/LOD measurement and native Firefox BFCache
  limits](../plans/codebase-audit-2026-10-19.md#changed-but-not-fully-proven)
  remain open. Passing overlay hardware tests below must not be substituted
  for that private framebuffer/LOD probe or native cache delivery evidence.

## Combined verification

- Final rebuilt unit suite: 3,190/3,190 passed after all runtime corrections.
- Full lint passed with eight existing owned web-ext warnings; the final
  explanation correction also passed focused ESLint. Documentation checks
  passed 3/3, whitespace checks passed, and all 20 immutable changelog sections
  were verified.
- Fresh minified Chrome and derived Firefox archives passed the production
  inventory/version/options-presentation validator, 108 entries each.
  One exact-package repetition passed in hidden Chrome for Testing 156.0.8078.4
  and Firefox 158.0.1, base 1000 × 760 plus responsive/doubled-text cases.
  Both reported successful teardown; Chrome restored BFCache, Firefox remounted.
  The archives contain all runtime corrections, including the filename helper
  and retained refusal explanation. No signing/publication was attempted.
- Scale tests: 14/14 passed, against the rebuilt provider-fix bundles.
- Real unpacked extension: hidden Chrome for Testing 156.0.8078.4 and installed
  Firefox 158.0.1 passed at a 1000 × 760 base viewport, with the verifiers'
  1600/800/390 widths and doubled-text cases; both reported successful teardown.
  This pair includes F1–F3; the final filename helper is covered by its unit
  regressions and the final package checks below.
- Affected map integration passed with real Leaflet 1.9.4 and the real unpacked
  extension in hidden Chrome 156.0.8078.4 at 1000 × 700. ANGLE/Metal on Apple
  M3 Pro was asserted; software rendering was rejected. It covers all four
  native map surfaces, the real worker/isolated/MAIN relay, 2D/3D ownership,
  partial and transient recovery, retained good tiles, rate limits, pending
  body reads, guarded Retry and focused recovery, fixed geometry, BC access
  pending/denial/retry, imagery capture selection, regional availability,
  opacity pixels and one-use Full Screen handoff. Provider/DEM responses and
  permission decisions are fixtures. Native loading, terrain slope loading and
  settled imagery screenshots were inspected; no clipping or new layout defect
  appeared in those samples. The verifier reported successful teardown.
- Final process command-line inspection found no owned browser, verifier or
  geckodriver process. All extension, Firefox, overlay and package temporary
  profile prefixes were absent. Disposable probes, screenshots, logs and
  archives were removed after recording this evidence. User browsers were not
  closed, and the owner's pre-existing documentation edits remain untouched.

All four new findings have implementation changes. The unresolved advisory and
the separately named external/measurement gaps remain explicit; this ledger
does not certify the repository as free of defects.
