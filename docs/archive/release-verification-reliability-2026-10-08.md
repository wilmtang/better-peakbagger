# Release verification reliability

Closed on 2026-10-09 with the historical evidence limits below retained.

Owner request: fix every problem identified in the 3.9.0–3.9.2 release diagnosis.
Preserve store protections, published tags, runtime privacy boundaries, and the
exact advisory exception and expiry. This work does not consume another version.

The latest runtime corrections are included in
`ac7df77d45ffc402239f9708231b566362dcf11f`.
[Main CI](https://github.com/wilmtang/better-peakbagger/actions/runs/37910720275)
completed successfully on that snapshot: 2342 tests, lint, live audit, scale,
current/floor browsers, exact-package execution, and both hardware-GPU checks.
The [replacement three-pass rehearsal](https://github.com/wilmtang/better-peakbagger/actions/runs/37910756804)
also completed successfully. All three current Chrome/Firefox pairs and three
repetitions of each browser floor passed with teardown and verified archive
identity at that commit. Both store jobs were skipped. The earlier diagnostic rehearsal
[37909228004](https://github.com/wilmtang/better-peakbagger/actions/runs/37909228004)
was cancelled after two current-browser pairs passed and the third began,
to replace its obsolete source snapshot. It is not counted as a passing
rehearsal.

The combined tree preserves the separately committed captured-trip date names
(`138f3180ab6fea33cc5b85ef67d026f2edf1ce5e`) and summit-draft Save preparation
guard (`62523d3cd1ca04cfd53b5a97f960b2ca236d82b3`). This task did not modify
their files or bundle them into its focused commits.

Reopened again on 2026-10-09 after
[final documentation CI](https://github.com/wilmtang/better-peakbagger/actions/runs/37904401979)
caught Firefox seeding the newly opened drafts-manager tab while it was still
`about:blank`. Its new window handle had appeared before navigation completed.
The previous three-pass rehearsal below remains successful evidence for its
snapshot, rather than proof that this later failure is resolved.

The ledger was previously reopened after the documentation commit's
[CI run](https://github.com/wilmtang/better-peakbagger/actions/runs/37898123779)
failed current Chrome with a stale ignored-climber sync preview. Prior verified
implementation and workflow changes are included in
`c56997338ff3bb6a54b5fa53932b79b6d252d6ae`.
[Main CI](https://github.com/wilmtang/better-peakbagger/actions/runs/37895780435)
and the [three-pass read-only rehearsal](https://github.com/wilmtang/better-peakbagger/actions/runs/37895800141)
both completed successfully on that commit. Both store jobs were skipped.

The subsequent worker and sidebar corrections are included in
`629875bacc1cf52727a5e30b918ef980a9cdfbf7`.
[Main CI](https://github.com/wilmtang/better-peakbagger/actions/runs/37902037015)
completed successfully, including 2334 tests, lint, live audit, scale, and
current/floor browser checks. Its
[three-pass read-only rehearsal](https://github.com/wilmtang/better-peakbagger/actions/runs/37902040566)
also completed successfully. Both store jobs were skipped. All three current
Chrome/Firefox pairs and three repetitions of each browser floor passed,
including teardown, against archives whose identity was verified at that commit.

## Work and closure ledger

### Fixed and verified

- Settings keydown handling armed duplicate-click suppression for modifier
  keys alone, although those keys cannot activate the button. The click handler
  then swallowed a real pointer click until a zero-delay timer ran; it also
  swallowed a separate pointer action after modified keyboard activation.
  Suppression now requires Enter or Space and consumes only keyboard-generated
  clicks (`detail === 0`). Two controlled delayed-timer regressions failed
  against the old shipped bundle and both passed after rebuilding; all 57
  ascent-filter tests passed. The full suite passed 2342/2342; full lint passed
  with six existing owned warnings, and the live audit passed under the exact
  existing advisory exception. Trust checks and native tab/window intent are
  preserved. Both exact minified packages passed hidden Chrome 153.0.8010.12
  and Firefox 157.0.1, including trusted Settings actions and owned-process
  teardown. Main CI passed all 11 jobs at the repaired commit, followed by
  the successful three-pass current/floor package rehearsal.
- Both browser verifiers now wait for the exact drafts-manager URL, complete
  document, heading, list surface, and extension storage before seeding a draft.
  Firefox previously read `about:blank` immediately after the new window handle;
  Chrome's load-state wait could likewise accept the initial blank document.
  The worker already requests the correct URL; product code is unchanged.
  A deterministic regression rejected the old truthiness-only condition wait
  for an early blank window. Shared readiness tests exercise delayed navigation,
  loading/interactive documents, missing extension APIs and list elements, and
  live failure diagnostics; the timeout diagnostic uses a controlled clock.
  The full suite passed 2336/2336, all six focused fixture tests and scoped
  ESLint passed, and both minified packages passed hidden Chrome 153.0.8010.12
  and Firefox 157.0.1, including teardown.
  [Combined-tree CI](https://github.com/wilmtang/better-peakbagger/actions/runs/37906234900)
  passed at `1e04cb9770469bb2a9c0c415a031d329b82d755a`, including 2337 tests,
  scale, lint, audit, all browser jobs, and both GPU checks. Main CI also passed
  at the latest repaired snapshot above, as did its three-pass current/floor
  package rehearsal. The failed rehearsal on the earlier
  snapshot is recorded separately below.
- Queued automatic ignored-climber sync now rechecks enabled and review state
  on entering its operation lane. The deterministic regression reproduced an
  upload that consumed a manual review before confirmation; a second regression
  reproduced automatic work continuing after sync was disabled. Both failed
  before the fix. All 25 sync tests, the then-2333-test full suite, lint, and live
  audit under the existing exception passed afterward. The rebuilt minified
  archives passed three consecutive hidden Chrome 153.0.8010.12 / Firefox
  157.0.1 pairs locally, including teardown.
  [Worker-fix CI](https://github.com/wilmtang/better-peakbagger/actions/runs/37900162206)
  passed the full suite, scale, current/floor browsers, and both GPU checks.
  Its first rehearsal stopped before browser checks on the sidebar fixture
  below. After that fixture correction, final main CI and the replacement
  three-pass rehearsal passed the 2334-test suite and current/floor browsers.
- The sidebar fixture no longer assumes that native hash navigation and scroll
  restoration finish within five milliseconds. The failed
  [rehearsal](https://github.com/wilmtang/better-peakbagger/actions/runs/37900330405)
  asserted before the asynchronous hash handler restored the inline override.
  The fixture now waits for the hash event and final style, with a controlled
  animation-frame case that asserts the override survives the first frame and
  clears after the second. That frame case failed deterministically with the
  old sleep; both cases and all 40 options tests passed after the correction.
  Product navigation timing is unchanged. The full suite passed 2334/2334,
  scoped ESLint and diff checks passed. Main CI and the replacement rehearsal
  also passed 2334/2334, followed by successful real-package checks.
- The Chrome helper-lease fixture now loads both probe tabs before durable
  worker adoption/release barriers and removes the adopted tab only after
  scratch cleanup. This removes direct fixture lease injection across queued
  tab creation/removal writes. Timeout diagnostics include the live tab, lease,
  and alarm. The ordering regression failed before the change and all 15
  resource-stack tests passed afterward, with scoped ESLint and diff checks.
  Both unchanged minified archives then passed three consecutive hidden
  Chrome 153.0.8010.12 / Firefox 157.0.1 runs, including teardown. No owned
  browser or driver processes remained. The original timeout did not include
  the missing lease state; the identified ordering hazard is source-confirmed,
  rather than inferred from a captured failing payload.
- Capture scale verification records three complete samples, timing algorithm
  phases separately from assertions. Every sample keeps all exactness, anchors,
  point-budget, draft, and yielding checks. Median CPU must be below 15 seconds;
  any 30-second sample fails, and the full test has a 120-second deadline. Both
  workflow scale jobs pin Ubuntu 24.04 and shared Node 24. All 26 focused policy,
  workflow, and documentation tests and all 14 real scale tests passed locally.
  CPU samples were 4842.9/4615.2/4701.0 ms (median 4701.0 ms). Scoped ESLint and
  diff checks passed. Both remote scale jobs passed all 14 tests: main CI CPU
  samples were 10181.7/9176.4/9297.9 ms (median 9297.9 ms); rehearsal samples
  were 10171.1/9154.1/9384.2 ms (median 9384.2 ms).
  The final main CI and rehearsal also passed 14/14 with CPU medians of
  7051.8 ms and 9606.5 ms respectively; all three samples were retained.
- Disposable Firefox profiles no longer issue add-on uninstall before QUIT.
  Both successful QUIT and the exact known lost response require confirmed
  profile-owned process exit. Unknown errors and extension assertion failures
  remain failures; success is logged after teardown. All 68 focused lifecycle,
  resource, and release tests passed. A real minified Firefox archive passed
  hidden Firefox 157.0.1 at 1000x760, including teardown; process inspection
  afterward found no owned browser/driver. The remote rehearsal then passed
  three current Firefox 157.0.1 runs and three Firefox 152.0 floor runs, each
  reporting success after confirmed owned-process teardown.
- Browser identity now compares live capabilities with the exact installed
  version before extension installation/assertions. Missing contracts fail in
  CI. Current Chrome uses locked Playwright full-Chromium metadata; Firefox and
  floors use installer outputs. All 55 focused identity/release tests and scoped
  ESLint passed. Deliberately wrong expectations rejected real hidden Chrome
  153.0.8010.12 and Firefox 157.0.1; owned process checks were empty afterward.
- Previously repaired: enabled Buddy-action waits, rendered scroll settlement,
  deterministic AllTrails fixture deadlines, GPX exclusion-state persistence,
  and the critical shell-quote dependency update to 1.12.0. Failed remote logs
  and the focused fix commits were inspected again. The repaired behavior is
  covered by the full suite and current/floor browser checks recorded below.
- Hosted main CI's exact-package step passed in 6 minutes 21 seconds. The new
  three/five-pass rehearsal modes could exceed the original 25-minute job
  budget after setup, tests, and lint. The current-package job now allocates
  25/45/65 minutes for one/three/five passes; tagged releases keep 25 minutes.
  Assertion and CPU limits are unchanged. The workflow regression failed with
  the old constant budget; all 59 focused release, shared-setup, and documentation
  tests passed afterward, with scoped ESLint and diff checks. The corrected
  three-pass workflow executed successfully. The preceding rehearsal
  [37894437624](https://github.com/wilmtang/better-peakbagger/actions/runs/37894437624)
  was explicitly cancelled after one successful pair while the second ran,
  to replace its obsolete budget; it is not counted as a passing rehearsal.
- Consecutive exact-package verification is implemented, defaults to three in
  manual rehearsals, and applies to both current and floor browser jobs. It
  fingerprints canonical archives between browser runs, uses fresh profiles,
  and stops on a verifier error without rerunning a failed repetition. All 72 focused repetition,
  release, and documentation tests passed, with scoped ESLint and diff checks.
  A real run passed repetition 1 and correctly stopped at repetition 2 on the
  Chrome helper-lease fixture's unadopted-tab cleanup timeout. After the ordering
  repair above, all three consecutive exact-package runs passed locally and
  remotely. The remote floor jobs each passed three repetitions after verifying
  the downloaded archive identity for version 3.9.2 at the implementation
  commit. Live versions matched installed Chrome 153.0.8010.12, Firefox 157.0.1,
  Chrome 128.0.6613.137, and Firefox 152.0.
- Shared setup and the common canonical-package command are implemented.
  All 56 focused release/setup/package-order tests and scoped ESLint passed.
  Real minified archives passed hidden Chrome 153.0.8010.12 and Firefox 157.0.1
  at the maintained fixture viewports, including 1000x760. Owned process checks
  were empty afterward. Main CI and rehearsal executed the shared setup and
  command successfully, with exact live browser-version contracts enforced.

### Intentionally not changed

- Dependency audit remains live and rejects every finding outside the existing
  exact owner-approved node-forge exception, expiring at
  `2026-10-17T07:00:00Z`. Both final workflows passed the live audit under that
  exception. Raw npm audit still reports three high findings; the default audit
  remains strict. New advisories are valid release blockers.
- Published 3.9.2 tags and store submissions were not changed or repeated.
  The newly discovered ignored-climber worker and Settings input races are
  recorded under Unreleased; manifests, package versions, and runtime privacy
  boundaries remain unchanged.
- Native browser focus, live provider exports, and asynchronous store review
  remain separate evidence boundaries. These checks ran hidden/headless with
  the maintained fixtures, including the 1000x760 base viewport and narrow
  layout cases; they do not establish native focus or window placement.

### Changed but not fully proven

- [Rehearsal 37906237779](https://github.com/wilmtang/better-peakbagger/actions/runs/37906237779)
  stopped during its first Firefox run on an unlabelled five-second Selenium
  condition. The error did not identify a caller and its artifact omitted
  extension documents, retaining no page state. This is not the newly labelled
  drafts-page readiness wait. Diagnostic changes now name the short waits and
  retain structural state only for the explicitly registered isolated extension,
  stripping credentials, queries and fragments and taking no extension images.
  The evidence regression failed before the correction; all 12 focused evidence
  and fixture tests and scoped ESLint passed. Five hidden Firefox 157.0.1 runs
  against an isolated build of the failed source passed with these diagnostics;
  the original caller remains unknown, and those passes are not credited as
  proving its repair. The source-confirmed Settings suppression race above can
  fail a short Settings activation wait, but the old log cannot establish that it
  caused this historical timeout.
- The original helper timeout did not capture internal lease/alarm state.
  Its precise historical mechanism cannot be proven retroactively. The known
  source-ordering hazard was removed, its regression failed before the fix,
  and repeated real-browser passes verified the repaired flow. Future timeouts
  include current tab, lease, and alarm state.
- One- and three-pass execution were verified in real browsers. Five-pass
  orchestration and its job budget have focused contract coverage, but a
  five-pass hosted rehearsal was not run. Finite successful repetitions do not
  prove the absence of every future browser or runner failure.

## Verification record

| Check | Result |
| --- | --- |
| Latest local full suite | 2342/2342 |
| Prior hosted full suite (c569973) | 2331/2331 in main CI and rehearsal |
| New worker fix, full suite | 2333/2333 locally and in main CI |
| Prior hosted full suite (629875b) | 2334/2334 in main CI and rehearsal |
| Latest hosted full suite (ac7df77) | 2342/2342 in main CI and rehearsal |
| Scale | 14/14 in both latest workflows; CPU medians 8802.7 and 9490.3 ms, all three samples retained |
| Lint | ESLint and extension lint passed; six existing owned warnings |
| Live audit | Passed with the existing exact advisory exception |
| Latest local packages | One minified Chrome 153.0.8010.12 / Firefox 157.0.1 pair, including teardown |
| Latest hosted current packages | Three consecutive Chrome 153.0.8010.12 / Firefox 157.0.1 pairs, including teardown |
| Latest packaged floors | Three Chrome 128.0.6613.137 and three Firefox 152.0 repetitions, including teardown |
| Wrong-browser regressions | Real hidden Chrome and Firefox rejected deliberately wrong expectations |

The [first implementation CI run](https://github.com/wilmtang/better-peakbagger/actions/runs/37894425941)
also passed both copied-runtime GPU checks on Metal renderers. Chrome reported
the Apple Paravirtual device; Firefox 155.0 reported the same hardware device at
1000x760, hidden/headless. The subsequent budget correction changed only the
release workflow, its focused test, and documentation, so those GPU jobs were
correctly skipped on c569973. The subsequent worker fix passed both GPU jobs in
main CI on the same Metal hardware renderer: full Chrome for Testing
153.0.8010.12 and copied-runtime Firefox 155.0, hidden/headless at the maintained
viewports (Firefox 1000x760). The final sidebar correction changed only its unit
fixture and this ledger, so GPU jobs were correctly skipped on 629875b.

Latest main CI at ac7df77 again passed both copied-runtime GPU checks. Chrome
reported the ANGLE Metal Apple Paravirtual renderer at 798x448 wide and 448x448
default frame sizes. Firefox 155.0 reported the same hardware renderer,
hidden/headless at 1000x760. These copied-runtime terrain checks are separate
from exact minified-extension checks in current Chrome 153 and Firefox 157.
After the local exact-package run, process command-line inspection found no
remaining test-owned Chrome, Firefox, or driver. No disposable verification
profile or package-extraction directory remained. The completed isolated
diagnostic source copy was removed; failure logs remain as task evidence.
