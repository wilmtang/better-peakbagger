# Release verification reliability

Owner request: fix every problem identified in the 3.9.0–3.9.2 release diagnosis.
Preserve store protections, published tags, runtime privacy boundaries, and the
exact advisory exception and expiry. This work does not consume another version.

## Work and closure ledger

### Fixed and verified

- Capture scale verification records three complete samples, timing algorithm
  phases separately from assertions. Every sample keeps all exactness, anchors,
  point-budget, draft, and yielding checks. Median CPU must be below 15 seconds;
  any 30-second sample fails, and the full test has a 120-second deadline. Both
  workflow scale jobs pin Ubuntu 24.04 and shared Node 24. All 26 focused policy,
  workflow, and documentation tests and all 14 real scale tests passed locally.
  CPU samples were 4842.9/4615.2/4701.0 ms (median 4701.0 ms). Scoped ESLint and
  diff checks passed. Remote reference-runner measurements remain pending.
- Disposable Firefox profiles no longer issue add-on uninstall before QUIT.
  Both successful QUIT and the exact known lost response require confirmed
  profile-owned process exit. Unknown errors and extension assertion failures
  remain failures; success is logged after teardown. All 68 focused lifecycle,
  resource, and release tests passed. A real minified Firefox archive passed
  hidden Firefox 157.0.1 at 1000x760, including teardown; process inspection
  afterward found no owned browser/driver. Repeated remote proof is pending.
- Browser identity now compares live capabilities with the exact installed
  version before extension installation/assertions. Missing contracts fail in
  CI. Current Chrome uses locked Playwright full-Chromium metadata; Firefox and
  floors use installer outputs. All 55 focused identity/release tests and scoped
  ESLint passed. Deliberately wrong expectations rejected real hidden Chrome
  153.0.8010.12 and Firefox 157.0.1; owned process checks were empty afterward.
- Previously repaired: enabled Buddy-action waits, rendered scroll settlement,
  deterministic AllTrails fixture deadlines, and GPX exclusion-state persistence.
  Failed remote logs and the focused fix commits were inspected again. New
  verification for this work will be recorded below.

### Intentionally not changed

- Dependency audit remains live and rejects every finding outside the existing
  exact owner-approved node-forge exception. Changing advisory data is a valid
  reason to stop a release; freezing it would conceal new vulnerabilities.
- Native browser focus, live provider exports, and asynchronous store review
  remain separate evidence boundaries.

### Changed but not fully proven

- Shared setup and the common canonical-package command are implemented.
  All 56 focused release/setup/package-order tests and scoped ESLint passed.
  Real minified archives passed hidden Chrome 153.0.8010.12 and Firefox 157.0.1
  at the maintained fixture viewports, including 1000x760. Owned process checks
  were empty afterward. Remote action execution remains pending on the final
  commit.
- Pending: run repeated exact-package checks and obtain terminal remote CI and
  read-only rehearsal evidence on the final commit. A green retry alone is not
  closure.
