# Release verification reliability

Owner request: fix every problem identified in the 3.9.0–3.9.2 release diagnosis.
Preserve store protections, published tags, runtime privacy boundaries, and the
exact advisory exception and expiry. This work does not consume another version.

## Work and closure ledger

### Fixed and verified

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
- Pending: remove redundant temporary-add-on uninstall from disposable-profile
  teardown, prove owned process exit on successful QUIT too, and exercise
  assertion failure, protocol failure, and lingering-process boundaries.
- Pending: replace a single noisy performance sample with repeated isolated
  measurements, preserving exactness, cancellation, point limits, and the
  15-second reference-runner CPU regression threshold.
- Pending: run repeated exact-package checks and obtain terminal remote CI and
  read-only rehearsal evidence on the final commit. A green retry alone is not
  closure.
