# Repository bugs, engineering, and UX audit — 2026-10-19

Baseline: clean `main` at `5187c0f6a78fb359f61e71a13f5ac3ff4aaab014`, version
4.0.2. Findings and baseline evidence below describe that audited tree.
Remediation was subsequently authorized; the closure ledger records completed
changes and their verification without rewriting the original reproductions.

## Findings

P1 threatens a required capture correctness gate. P2 is a confirmed functional,
verification or cleanup defect. P3 is a demonstrated engineering improvement
whose ordinary-user impact has not been established. Do not equate failed
test tooling with a broken product, or a synthetic stress case with a measured
everyday performance regression.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | P1 | Save is allowed before the first capture-draft handshake settles. | Both native Save controls submit with blank suffix/trip while the worker reply is held; reproduced in Chrome and Firefox. |
| F2 | P2 | Automatic units ignore metric-first peak pages, and snow uses a different policy from weather. | Shipped weather/snow bundle probes with metric-first native headings. |
| F3 | P2 | The full unit suite fails because a report-backup fixture now disables its own Save button. | Full run and isolated test both fail; an ordinary-form handshake restores the expected snapshot. |
| F4 | P2 | Firefox's broad verifier still requires Sun & Moon's obsolete map-cell placement. | Actual unpacked Firefox run fails on `sunAfterLegend:false`; Chrome and the focused card matrices pass. |
| F5 | P2 | Strict UTF-8 rejection releases an unfinished response stream without cancelling it. | Production reader rejects an invalid first byte, but the stream's cancellation callback never runs. |
| F6 | P3 | The terrain tile cap bounds returned requests after expensive enumeration and allocation. | Production helper returns 32 tiles after a synthetic frame-admissible stress input takes about 2.1 seconds and the Node process reaches about 671 MiB peak RSS. |
| F7 | P2 | A waiting capture draft loses its retry when restored from Back/Forward Cache. | Actual hidden Chrome BFCache restore: the deadline passes, Save stays disabled, and no second handshake occurs. |

### F1 — The initial handshake leaves captured forms temporarily saveable

**Trigger and reproduction.** Hold the first `DRAFT_READY` response on a fresh
summit form, then resolve it as `action: 'wait'`. Before that reply, both Save
controls are enabled, the suffix and trip sequence are blank, and there is no
preparation banner. Clicking the first Save and pressing Enter on the second
each reaches the native form's submit handler. Only the later wait reply
disables the controls.

The shipped ascent-editor bundle reproduced this in hidden Chrome for Testing
156.0.8078.4 and Playwright Firefox 157.0: eight variants per browser at
1000/390 × 760, light/dark extension feedback and 100/200% CSS zoom. Every case
recorded two native submissions before the reply. Native submission was
intercepted locally; no ascent was sent to Peakbagger. A jsdom probe independently
confirmed the same transition. This proves a client-side gate bypass, not that
Peakbagger would accept every incomplete form.

**Root cause.** `blockedSaveMessage` starts empty, and the document's click and
submit guards return immediately in that state:
`src/ascent/ascent-draft.js` (lines 35–38 and 77–91). `runInitialize` awaits the
worker without first entering a pending state (lines 578–589). Blocking begins
only after an error, wait, preview-error or apply result arrives (lines 595–643).
The existing recovery verifier explicitly holds this first reply but starts
its blocking assertions after releasing it:
`scripts/verify-draft-recovery.mjs` (lines 69–89 and 111–125).

**Impact.** A slow worker wakeup or draft lookup creates a window in which a
queued summit can bypass suffix/trip preparation and GPS Preview sequencing.
That contradicts the prepared-draft invariant even though later error/wait
states correctly block Save.

**Smallest safe direction and acceptance.** Establish the pending Save gate
synchronously before the first awaited handshake on applicable forms. Preserve
original native disabled states, leave unrelated forms alone, restore ordinary
forms on an explicit ignore response, and keep captured forms blocked until
their existing readiness rules authorize Save. Missing replies, document
replacement, repeated handshakes and unknown actions must not open a gap.
Do not solve this by trusting a page-owned flag or weakening error handling.

Extend `test/ascent/ascent-draft.test.mjs` and
`scripts/verify-draft-recovery.mjs`: hold the initial reply and attempt both
Save buttons, keyboard activation and implicit submission before releasing
wait/apply/error/ignore responses. Assert zero native submissions while
unresolved, then verify the correct recovery path. Include native content,
control geometry, scroll and focus across the new pending state. Run those
assertions against this baseline first; the current bypass is already
reproduced. Commit this correctness fix independently and first.

### F2 — “Follow Peakbagger” has incompatible unit probes on the same page

**Trigger and reproduction.** With `units: 'auto'` and default per-measurement
overrides, change the native peak heading to
`Elevation: 4391.0 meters, 14,406.2 feet`. The shipped weather bundle displays
`14406 ft`, Fahrenheit and mph. The snow bundle displays
`Paradise · 4.8 mi away · 5150 ft` and `36.0 in`. The metric-first heading's
word spelling is supported by the summit metadata reader and matches the
native fixture's spelled-out unit style with the order reversed.

With the abbreviated heading `Elevation: 4391.0 m, 14,406.2 ft`, weather instead
uses `4391 m`, Celsius and km/h, while snow still uses miles, feet and inches.
Both variants were exercised through the built bundles with controlled
provider responses. This is a unit-selection defect; numeric conversions in
the shared units module were not shown to be wrong.

**Root cause.** Weather's probe accepts only `m` immediately after the first
elevation, so `meters` falls through to imperial:
`src/weather/peak-weather.js` (lines 158–161). Snow supplies a constant imperial
probe even though it is on that same peak page:
`src/snow/peak-snow.js` (lines 121–124). The shared resolution contract explicitly
delegates native-page detection to the owning surface:
`src/ui/units.js` (lines 29–42). Existing snow/browser matrices choose explicit
metric/imperial settings and do not establish automatic detection.

**Smallest safe direction and acceptance.** Share one narrow peak-page unit
probe between weather and snow, accepting supported full/abbreviated native
spellings and reading which unit is primary. Keep resolution and numeric
conversions in the existing shared units module; preserve explicit global and
per-measurement overrides and the fallback for unavailable native metadata.
Avoid guessing from an arbitrary mention of meters elsewhere in a report.

Add metric-first and imperial-first fixture variants, both spellings,
commas/decimals, unavailable headings and mixed overrides beside
`test/weather/peak-weather.test.mjs` and `test/snow/peak-snow.test.mjs`. Assert
weather and snow agree on automatic units, with no request caused by a unit
change. Inspect both rendered cards at narrow/desktop sizes and enlarged text.
Keep this one focused unit-policy change.

### F3 — A report-backup test supplies a worker failure instead of an ordinary form

**Evidence.** `npm test` runs 2,957 tests: 2,956 pass and one fails. The failure
is “Add and Edit saves capture the identities used by the backup handoff even
when the editor is disabled” at
`test/reports/report-editor-mount.test.mjs` (lines 336–366). Running that file
alone reproduces the timeout; it is not load-dependent evidence.

**Root cause.** The fixture replaces `sendMessage` with a logger that returns
undefined for every delegated message (line 353), including `DRAFT_READY`.
The newer fail-closed draft behavior deliberately disables Save for that
response. The test waits 10 ms and clicks the now-disabled control
(lines 356–360), so no backup snapshot can arrive. In a disposable probe,
undefined produced `disabled:true, backups:0`; returning `action:'ignore'`
for the ordinary-form handshake produced `disabled:false, backups:1`.

**Smallest safe direction and acceptance.** Model the ordinary noncapture
worker response in this fixture and wait for the relevant readiness condition.
Keep missing/error reply coverage in the draft tests. Do not remove the Save
guard, merely increase the timeout, or claim the backup implementation is
broken from this failure. Retain Add and Edit identity assertions with the
enhanced report editor disabled. Run the focused file and the full suite;
commit the test repair separately from F1.

### F4 — The Firefox smoke gate asserts a layout the product deliberately replaced

**Evidence.** `node scripts/verify-firefox-extension.mjs` fails on the Peak
surface in hidden installed Firefox 158.0. It reports native frame preservation,
the four expected links, a working Sun/Moon panel and valid Moon state, but
`sunAfterLegend:false`. The preceding full Chrome 156.0.8078.4 verifier passes.
Focused real-extension peak-card checks pass in both Chrome and Firefox,
including reorder, collapse, reload, pending/error/retry and 200% CSS zoom.

**Root cause.** Firefox requires the calculator to be the map cell's last child
and immediately follow the full-screen link:
`scripts/verify-firefox-extension.mjs` (lines 2223–2224 and 2240–2247).
`src/ui/peak-card-layout.js` (lines 157–163) intentionally moves it into an
independent row. Chrome already verifies that new contract while preserving
the native map and link:
`scripts/verify-extension.mjs` (lines 4138–4143).

**Smallest safe direction and acceptance.** Update the Firefox assertion to
the independent-card contract, retaining the native map/legend/link ownership
checks and all solar/lunar checks. Assert user-visible relationships rather
than the obsolete immediate-parent relationship. Add a focused contract guard
so future Chrome-only assertion updates do not leave Firefox stale. Run the
full Firefox verifier to its terminal result; later checks were not reached
in this audit run. Commit independently from the unit-fixture repair.

### F5 — Decoder errors do not terminate unfinished response bodies

**Reproduction.** Pass an open `ReadableStream` whose first chunk is byte
`0xff` to the production `readBoundedResponseText` with `fatalUtf8:true` and a
1000-byte limit. It rejects with the UTF-8 error, releases the reader lock,
and leaves `cancelled:false`. Explicitly cancelling the stream afterward
does invoke the source's callback.

**Root cause.** `src/net/bounded-text.js` (lines 43–60) cancels only for byte
overflow, character overflow or an aborted signal. A decoder exception at
line 51 takes the ordinary `releaseLock` branch without reaching end-of-stream.
The real strict caller is GitHub raw-text backup reads:
`src/github/github-api.js` (lines 198–205 and 223–229). That caller clears the
deadline on invalid UTF-8, removing the later timeout teardown as well.

**Impact and limit.** Invalid content is correctly rejected and does not become
a valid backup. Explicit cleanup of the unfinished transport is missing,
however, so the helper no longer guarantees cancellation on early rejection.
The deterministic stream callback was measured; a real browser's remaining
socket/download lifetime and garbage collection were not measured.

**Smallest safe direction and acceptance.** Track successful end-of-stream
and cancel any unfinished read on exceptional exit, preserving the original
error and promptly settling even if cancellation itself is slow or fails.
Retain normal lock release after a complete read. Add focused tests in
`test/net/bounded-text.test.mjs` and the GitHub raw-blob boundary for an invalid
first chunk with an open tail, malformed trailing UTF-8, body-read errors,
normal completion and existing size/abort paths. The invalid-first-byte
cancellation assertion must fail against this baseline. Commit separately.

### F6 — A small output budget does not bound tile-planning work

**Evidence.** The production helper was called with the frame's actual warming
options at camera zoom 17: maximum zoom 18, offsets -3 through -8, expansion 2, expansion
step 2, a 1100 × 700 viewport, shedding finest levels, and cap 32. Bounds were
43–44°N and 122–32°W. This input passes the frame's positive-span/at-most-90°
longitude checks. Even the unexpanded finest level contains 262,208 tiles.
The helper returns 32 tiles, but the isolated Node run takes approximately
2.1 seconds and reaches approximately 671 MiB peak process RSS. These are
single stress observations, not browser benchmarks or an isolated allocation
delta. No ordinary camera gesture producing that rectangle was demonstrated.

**Root cause.** `src/terrain/terrain-tiles.js` (lines 161–189) allocates every
tile in every expanded rectangle and constructs deduplication strings. Only
after that does it shed/coarsen, repeatedly enumerating candidate sets
(lines 195–212). The frame invokes this synchronously on its rendering thread:
`src/terrain/terrain-frame-runtime.js` (lines 1666–1683). The cap is an honest
network-traffic limit, but it offers no corresponding CPU/allocation bound.

**Smallest safe direction and acceptance.** Count grid cardinalities before
materializing them, reject/shed/coarsen over-budget candidates cheaply, and
enumerate only the selected bounded set. Validate budget/options inputs and
preserve deterministic tile selection, deduplication, source zoom bounds,
coverage policy and both cap policies. Avoid arbitrary sleeps or a larger cap.
Extend `test/terrain/terrain-tiles.test.mjs` with large finite rectangles and an
independent bound on work/materialized entries, not just output length or a
machine-specific elapsed-time threshold. Run terrain tests and hardware GPU
warming/interaction verification before implementation closure. This item
remains a boundedness improvement with a live-camera reproduction gap.

### F7 — Back/Forward Cache restoration never rearms a parked draft's retry

**Trigger and reproduction.** Have the first draft handshake return a wait
response with a future `retryAt`. Navigate to another local fixture and return
with Back. In hidden Chrome 156.0.8078.4 at 1000 × 760,
the original form was restored with `pageshow.persisted:true`. After the retry
deadline passed, `DRAFT_READY` calls remained at one and Save remained disabled.
The actual browser cache was used; this was not a synthetic `pagehide` event.
The fixture loaded the shipped bundle and stubbed worker replies. It does not
prove delivery semantics for real extension messages to cached documents.

**Root cause.** The wait branch arms `leaseRetryTimer`:
`src/ascent/ascent-draft.js` (lines 621–630). `pagehide` unconditionally clears
it (line 679). There is no `pageshow` revalidation or retry rearming. A new
`DRAFT_PROCEED` message can recover the form (lines 665–666), but returning to
the cached document does not itself request one, and the scheduled deadline
is already gone.

**Impact.** A user who leaves a queued summit to review another page can return
to a stale waiting form. It needs a reload or another live worker notification
to make progress, even after its advertised lease retry time. Save correctly
stays blocked; this is a recovery/liveness defect, separate from F1's early
submission gap.

**Smallest safe direction and acceptance.** Give this document an explicit
suspend/resume lifecycle: park retry work while cached, invalidate stale
asynchronous ownership as needed, and revalidate readiness on persisted
restoration before authorizing Save. Use the existing page-lifecycle owner
where appropriate. Retain exactly-once Preview, rollback and explicit discard;
do not merely enable Save or replay a Preview on Back.

Add wait/deadline/BFCache coverage beside `test/ascent/ascent-draft.test.mjs`
and the browser recovery verifier, including expiry while away, an expired or
discarded capture, in-flight application, and repeated Back/Forward. Assert
the renewed handshake, eventual correct readiness, no duplicate Preview, and
stable form fields/focus/geometry. The actual-cache baseline above must fail
the new recovery assertion. Verify Firefox separately before closure. Commit
this lifecycle fix independently, after F1 establishes the pending gate.

## Additional improvements

- **O1, P3 — Coalesce identical in-flight SNOTEL catalog reads.** Two concurrent
  `client.stations()` calls on an empty cache make two whole-network requests;
  the production-client probe observed both before either response settled.
  `src/snow/snotel-client.js` (lines 44–69) caches completed catalogs but has no
  shared in-flight owner. The card and map legitimately share that client, and
  `test/snow/peak-snow.test.mjs` (lines 62–76) currently expects two concurrent
  requests. Consider one bounded flight with independent caller cancellation;
  cancelling the map must not cancel an active card consumer. Do not add an
  extension-wide observation cache or widen retained data. This is an optional
  traffic/validation-cost reduction, not proof of quota exhaustion.
- **O2, P3 — Put the newer peak-card/snow matrices on a maintained CI path.**
  The cases are available through `scripts/verify.mjs` (lines 26–28), but the
  required layout case map omits them:
  `scripts/verify-layout-stability.mjs` (lines 1199–1202). The Test workflow's
  layout job in `.github/workflows/test.yml` invokes only that generic matrix
  (lines 138–143); neither that
  workflow nor its package action invokes the snow, snow-map or peak-cards
  targets. The focused matrices passed locally in this audit where run, but
  their existence does not establish CI coverage. Add appropriately scoped
  jobs or cases, with exact browser identities, nonzero executed counts,
  retained failure evidence and teardown. Snow-map needs a hardware renderer;
  ordinary card checks do not. Keep this separate from F4's immediately
  failing gate and do not claim hosted success without an authorized push.

## Verification and coverage

The breadth pass covered the manifest/build graph, settings and execution-world
bridges, capture/provider parsing and draft sequencing, GPX/math, report/draft
and photo persistence, GitHub/profile/list operations, map/terrain/weather/snow
surfaces, options/popup code, dependency policy, packaging/release scripts and
CI ownership. Deep probes focused on transaction readiness, shared resource
cleanup, new unit/layout contracts and current failing checks. This is not a
claim that every line, live provider or every UI transition is proven correct.
Recent archive ledgers were reconciled; their closed findings are not counted
again without new evidence.

| Check on the baseline | Result / scope |
| --- | --- |
| `npm test` | **Failed:** 2,956 passed, one failed, 2,957 total; F3. |
| `node --test test/reports/report-editor-mount.test.mjs` | **Failed:** same F3 timeout in isolation. |
| `npm run lint` | Passed, with six existing owned web-ext warnings. |
| `node --test --test-concurrency=1 "test/scale/**/*.scale.mjs"` | Passed, 14/14. The baseline `dist/` had already been rebuilt. |
| Strict `npm run audit:ci` with registry access | **Failed:** the known node-forge development chain, three high findings. |
| `npm run audit:ci -- --allow-reviewed-development-advisory` | Passed under the existing exact exception through October 23, 2026 in Los Angeles; raw findings remain. |
| `npm audit --omit=dev --json` | Zero findings in npm's production subset. Several shipped libraries are build/dev dependencies; this result alone does not audit all shipped code. |
| Full unpacked Chrome extension verifier | Passed, hidden Chrome for Testing 156.0.8078.4, base 1000 × 760 and built-in responsive cases; BFCache restored, teardown passed. |
| Full unpacked Firefox extension verifier | **Failed:** hidden installed Firefox 158.0, F4. Remaining later steps unexecuted. |
| Real-extension peak-card matrices | Passed in hidden Chrome 156.0.8078.4 and installed Firefox 158.0: 375/1440 × 1100, light/dark, header hit areas, collapse, keyboard/pointer reorder, cancellation, reload, refresh/error/retry, feature toggles, long station names, expanded dragging/autoscroll and 200% CSS zoom. |
| F1 held-handshake browser probe | Reproduced in 16 variants; hidden Chrome 156.0.8078.4 and Playwright Firefox 157.0, 1000/390 × 760, light/dark feedback, CSS zoom 1/2. Worker replies and native submission were stubbed; shipped bundle used. |
| F7 actual BFCache recovery probe | Reproduced in hidden Chrome 156.0.8078.4 at 1000 × 760, `pageshow.persisted:true`; no renewed handshake after the retry deadline. Runtime replies were stubbed. |
| Full generic layout transition matrix | Passed, 128/128 cases (64 per browser), hidden Chrome 156.0.8078.4 and Playwright Firefox 157.0; 390/1280 × 900, light/dark, 16 surfaces. Static DOM/fixture coverage, not hardware terrain proof. |
| F2/F5/F6/O1 deterministic probes | Reproduced using production modules or rebuilt bundles; no runtime edits. |
| Documentation/link checks and patch whitespace | Passed: 3/3 documentation tests and `git diff --check`. |

Firefox card screenshots were visually inspected for narrow dark expanded snow,
desktop light weather-error/retained-results and 200% zoom. The F1 narrow
Chrome waiting state was also inspected. The card screenshots showed no new
overlap or clipped feedback in those sampled states; geometry assertions cover
the broader listed transitions. Native map imagery/icons in these fixtures
are stubbed or unavailable, not live rendering defects. Card/handshake checks
are static DOM rendering; no WebGL renderer claim is made. A full hardware
terrain/snow-map run and exact store-package rehearsal were not performed.

Owned browser processes were checked after verification; none remained.
The exact disposable fixture/profile paths were confirmed removed. No existing
user browser was closed. Disposable probe artifacts were removed after recording
their evidence here.

## Remediation order and commit boundaries

1. F1: close the initial capture handshake gate and add a failing-before-fix
   browser regression. Preserve manual review/Save and ordinary-form recovery.
2. F7: restore readiness revalidation after BFCache suspension without replaying
   Preview or allowing Save before the renewed handshake.
3. F3 and F4: repair each failing verification contract in its own commit;
   obtain a terminal full unit suite and Firefox result afterward.
4. F2: align peak-page automatic unit detection and verify rendered layouts.
5. F5: correct shared stream cleanup, with focused transport regressions.
6. F6: bound tile planning before allocation; retain synthetic/live proof
   distinctions and verify hardware behavior.
7. O1/O2: optional, separately reviewable traffic and CI-coverage improvements.

Run checks appropriate to each independent change before committing, then
run the combined unit/lint/scale, actual-manifest browser and affected visual
checks once the relevant groups are complete. Do not push, merge, tag or
publish as part of this audit. Archive this plan only after its ledger records
the disposition and remaining proof for every accepted item.

## Closure ledger

Combined local checkpoint after all seven findings and both improvements:

| Check | Result |
| --- | --- |
| Rebuilt full unit suite | 2,996/2,996 passed. |
| Scale tests | 14/14 passed. |
| `npm run lint` | Passed with the six existing owned web-ext warnings. |
| Reviewed dependency gate | Passed with the unchanged exact node-forge exception, expiring 2026-10-24 07:00 UTC; raw audit still has three high development findings. |
| Local minified archives | Chrome/Firefox archive validation passed, 103 entries each. |
| Exact-package browser gates | One full repetition passed in hidden Chrome 156.0.8078.4 and Firefox 158.0, with exact version contracts, base 1000 × 760 plus responsive cases, and teardown passed. No signing/publication or hosted CI run occurred. |
| Documentation and immutable changelog | Three documentation checks and 20 immutable history sections passed. |

These results do not override the more specific native/cache/terrain limits
below. The original verification table above remains the audit baseline.

### Fixed and verified

- **F1:** Gate Save synchronously before queuing the initial or renewed draft
  handshake. Explicit ignore restores native disabled/title state and removes
  stale pending feedback; unknown replies stay fail closed. Six new unit cases
  failed against the audited bundle with two native submissions each; the
  browser assertion failed with seven submissions. After the fix, all 53 draft
  tests and focused ESLint pass. Hidden Chrome 156.0.8078.4 and Playwright
  Firefox 157.0 recovery matrices cover 8 variants each at 1000/390 × 760,
  light/dark feedback and 100/200% CSS zoom, including initial pending,
  rollback/error/retry/reload/discard, native submission attempts, focus,
  control/heading/following-content geometry and scroll (0.75 CSS-pixel rounding
  tolerance). Keyboard focus is established before the geometry baseline so
  intentional focus scrolling is not mislabeled as reflow. Narrow screenshots
  are inspected separately; live native postbacks remain a proof gap below.
- **F3:** The Add/Edit backup fixture returns explicit ordinary-form readiness,
  publishes its configured settings after subscribers mount, and waits for
  native Save availability instead of sleeping 10 ms. Both identity paths now
  pass with the enhanced editor disabled. The focused file passes 16/16, the
  rebuilt full suite passes 2,968/2,968, and focused ESLint passes. No production
  Save guard or backup behavior was weakened.
- **F4:** Chrome and Firefox now serialize the same independent-row placement
  probe. It retains the native map table, row order and full-screen link checks;
  solar/lunar assertions remain intact. A focused contract test rejects the
  old map-cell placement, wrong row order and a missing native link, and pins
  both protocols to the shared probe. All 16 shared-fixture/placement tests and
  focused ESLint pass. `npm run verify -- browsers` reaches terminal success
  with the real unpacked extension in hidden Chrome 156.0.8078.4 and Firefox
  158.0 at 1000 × 760 plus built-in responsive cases; both report teardown
  passed. Chrome actually restores BFCache; Firefox cleanly remounts instead.
- **F2:** Weather and snow share the native peak-heading unit probe. It accepts
  full/abbreviated first-unit spellings, signed values and comma/decimal numbers;
  missing, ambiguous or unrelated metadata remains inconclusive. Explicit
  global and measurement overrides still use the shared resolver. Three shipped
  bundle integration cases fail before the fix; all 96 focused unit/probe/card
  tests now pass, including eight native-heading cases and no-refetch checks.
  Focused ESLint and the real-extension card matrices pass in hidden Chrome
  156.0.8078.4 and Firefox 158.0 at 1440/375 × 1100, both asserted themes, and
  the existing 200% zoom/interaction cases. The new browser case explicitly
  transitions imperial → automatic metric before checking both cards. Narrow
  automatic-unit screenshots were inspected in both browsers; selectors and
  feedback fit without overlap. Provider responses remain fixtures.
- **F5:** The bounded reader records end-of-stream, cancels every unfinished
  read on exit and always releases its lock. Cancellation is idempotent and
  best effort, so a rejected or stalled cancel cannot mask/delay the original
  decoder/read error. Already-aborted reads now use the same cleanup path.
  Six new cleanup assertions fail before the fix; all 40 bounded-reader,
  GitHub API and SNOTEL-client tests now pass, including valid completion,
  truncated UTF-8, invalid open tails, read errors, size limits, cancellation
  and deadlines. Build, focused ESLint and patch checks pass. Real socket
  lifetime/garbage collection remains outside this deterministic proof.
- **O1:** Card/map catalog readers now share one disk/network flight with
  independent cancellation. A remaining reader keeps the transport alive;
  the last cancellation or explicit clear aborts it immediately, and stale
  completions cannot detach or populate a replacement flight/cache. Only public
  catalog metadata persists. The concurrent-read regression fails before the
  change; all 49 snow tests now pass, including partial/final cancellation,
  clear, late replies, retry and existing privacy/expiry checks. Build, focused
  ESLint and hidden real-extension snow matrices pass in Chrome 156.0.8078.4
  and Firefox 158.0: 14 cases each at 375/681/1440 pixels, both themes and 200%
  browser zoom; each reports teardown passed. Provider replies remain fixtures.

### Intentionally not changed

- F1–F7 and O1/O2 have implementation changes. F6/F7 and hosted CI retain the
  verification gaps below; no implementation item is silently left open.
- Preserve raw-provider-GPX privacy, source/sender identity, waypoint budgets,
  exactly-once Preview, current settings validation and manual Save boundaries.
- Missing/error draft replies remain fail closed. F3 must repair its ordinary
  fixture rather than weaken that product gate. Broad ordinary-form behavior
  during worker failure is an existing consequence, not a separately counted
  new finding here.
- The node-forge chain and historical-tag Firefox recovery limitation are
  carried by the [October 3 plan](ci-ux-maintainability-audit-2026-10-03.md).
  The current advisory exception expires at 2026-10-24 00:00 Los Angeles
  (07:00 UTC). Reassess the exact upstream path before expiry; do not silently
  extend the exception or describe the complete graph as clean.
- Existing minimal host permissions, 3D activation consent, weather/source
  disclosures and mapless/region-limited behavior remain intentional. Large
  module sizes alone are not findings and do not justify unrelated refactors.

### Changed but not fully proven

- **O2:** The always-run per-browser layout job now runs snow and peak-card
  matrices against its completed build; a separate always-run macOS GPU matrix
  runs snow-map on Chrome/Firefox. The existing required aggregate waits for both
  paths and rejects failed/skipped results. Surface verifiers check the launched
  browser version and retain bounded fixture-only failure evidence before
  teardown. The missing-wiring assertion fails before the change; 26 focused
  workflow/evidence/browser-identity/documentation tests pass, including actual
  Bash execution proving engine selection, unknown-engine rejection and failure
  propagation through either `tee` pipeline. All 46 release-contract tests also
  pass with the additional shared browser setup. Both local hardware snow-map runs
  pass: hidden Chrome 156.0.8078.4 and Firefox 158.0, ANGLE/Metal on Apple M3 Pro,
  16 map cases each at 1440/375 × 1100, light/dark and 200% zoom, plus Settings
  checks. Fixture NRCS/DEM data replace live providers; teardown reports passed.
  This also proves the changed terrain bundle can render and switch modes in
  both real extensions, but does not establish F6's full warming/LOD criteria.
  The workflow has not been pushed or run on hosted runners; CI success is not
  claimed.
- **F6:** Tile planning counts clamped grid ranges before shedding/coarsening
  and materializes only the bounded final set. Duplicate expanded rungs retain
  their nested-union counts and established output order; invalid budgets,
  source zoom limits and nonfinite dimensions fail closed. The allocation-budget
  and malformed-option regressions fail before the fix. All 103 terrain tests
  pass; 200 deterministic finite-view comparisons match the historical output
  exactly, including both cap policies and duplicate offsets. Build and focused
  ESLint pass. The audited stress input returns 32 tiles in about 0.03 ms in a
  single warmed Node probe; this is not a browser benchmark or live-camera proof.
  Hardware validation was attempted, not passed: hidden installed Chrome
  156.0.8078.36 reports ANGLE/Metal on Apple M3 Pro. The broad visual suite stops
  at its 2D-control gap assertion (41 px versus a 40 px limit), at 1000 × 900.
  The LOD suite's 1240 × 1020 host never retains its intended 1100 × 700 3D frame;
  live diagnostics show activation occurred, then the existing “3D elevation
  data could not be loaded” fallback. Neither run reaches the required warming
  or camera criteria. Their assertions were not weakened; native/live terrain
  performance remains unproven and these verifier failures need separate work.
- **F7:** The shared page lifecycle now invalidates queued/in-flight draft
  ownership on suspension/disposal, cancels the parked timer, rolls back owned
  incomplete writes and starts a fresh guarded handshake on persisted resume.
  An unresolved old runtime promise cannot hold up that new lookup; late replies
  and Preview acknowledgments cannot authorize Save or replay Preview. Optional
  day-stat writes use the same ownership checks. All 60 draft/lifecycle tests,
  32 verification-runner/documentation checks and focused ESLint pass. Five
  lifecycle tests failed before the fix; the historical F1-only bundle also
  fails the fresh-handshake assertion after actual Chrome BFCache restoration.
  Hidden Chrome 156.0.8078.4 verifies two actual cached restores with lease expiry
  while away, preserved manual edits and zero Preview submissions. Playwright
  Firefox 157.0 verifies two explicitly simulated persisted transitions plus
  the eight existing recovery variants; its controlled navigation reloaded
  instead of restoring. Actual Firefox native-cache delivery, including real
  extension messages, remains unproven. [Playwright documents the cache
  limitation](https://playwright.dev/docs/next/navigations).
- The combined unit/lint/scale and actual-package browser checks above pass;
  the original audit's failing unit/Firefox results remain historical evidence.
- F1's native submissions were intercepted. Live Peakbagger acceptance,
  saved-trip persistence, live Garmin/Strava/NRCS compatibility and throttling,
  provider import previews and hosted CI/store publication remain unverified.
- Hidden DOM focus/geometry and screenshots do not establish OS focus/window
  placement, native browser menus/permission dialogs, screen-reader speech,
  physical touch feel, or cross-platform results.
- F5's real network lifetime and F6's ordinary pitched-camera occurrence remain
  explicit limits. General matrix success cannot close the newer matrices'
  CI integration gap or the currently failing Firefox smoke gate.
