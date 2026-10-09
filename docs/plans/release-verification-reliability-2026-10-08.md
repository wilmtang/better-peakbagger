# Release verification reliability

Owner request: fix every problem identified in the 3.9.0–3.9.2 release diagnosis.
Preserve store protections, published tags, runtime privacy boundaries, and the
exact advisory exception and expiry. This work does not consume another version.

Reopened on 2026-10-09 after the documentation commit's
[CI run](https://github.com/wilmtang/better-peakbagger/actions/runs/37898123779)
failed current Chrome with a stale ignored-climber sync preview. Prior verified
implementation and workflow changes are included in
`c56997338ff3bb6a54b5fa53932b79b6d252d6ae`.
[Main CI](https://github.com/wilmtang/better-peakbagger/actions/runs/37895780435)
and the [three-pass read-only rehearsal](https://github.com/wilmtang/better-peakbagger/actions/runs/37895800141)
both completed successfully on that commit. Both store jobs were skipped.

## Work and closure ledger

### Fixed and verified

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
  and fails immediately instead of retrying. All 72 focused repetition,
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
  The newly discovered ignored-climber worker race is recorded under Unreleased;
  manifests, package versions, and runtime privacy boundaries remain unchanged.
- Native browser focus, live provider exports, and asynchronous store review
  remain separate evidence boundaries. These checks ran hidden/headless with
  the maintained fixtures, including the 1000x760 base viewport and narrow
  layout cases; they do not establish native focus or window placement.

### Changed but not fully proven

- Queued automatic ignored-climber sync now rechecks enabled and review state
  on entering its operation lane. The deterministic regression reproduced an
  upload that consumed a manual review before confirmation; a second regression
  reproduced automatic work continuing after sync was disabled. Both failed
  before the fix. All 25 sync tests, the 2333-test full suite, lint, and live audit
  under the existing exception passed afterward. The rebuilt minified archives
  passed three consecutive hidden Chrome 153.0.8010.12 / Firefox 157.0.1 pairs,
  including teardown. Remote CI/rehearsal proof remains pending.
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
| Local full suite | 2330/2330 before the budget regression was added |
| Prior hosted full suite (c569973) | 2331/2331 in main CI and rehearsal |
| New worker fix, local full suite | 2333/2333; remote proof pending |
| Scale | 14/14 locally and in both final workflows |
| Lint | ESLint and extension lint passed; six existing owned warnings |
| Live audit | Passed with the existing exact advisory exception |
| Current packages | Three consecutive Chrome/Firefox pairs locally and remotely |
| Packaged floors | Three Chrome 128 and three Firefox 152 repetitions remotely |
| Wrong-browser regressions | Real hidden Chrome and Firefox rejected deliberately wrong expectations |

The [first implementation CI run](https://github.com/wilmtang/better-peakbagger/actions/runs/37894425941)
also passed both copied-runtime GPU checks on Metal renderers. Chrome reported
the Apple Paravirtual device; Firefox 155.0 reported the same hardware device at
1000x760, hidden/headless. The subsequent budget correction changed only the
release workflow, its focused test, and documentation, so those GPU jobs were
correctly skipped on c569973. The subsequent worker fix is still under validation.
