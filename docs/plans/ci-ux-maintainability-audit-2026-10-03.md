# CI, UX, and maintainability audit — 2026-10-03

Baseline: `f6a3029`, clean `codex/ignored-climbers` checkout, with fourteen
existing commits beyond `origin/main`. Audit work continues on
`codex/ci-ux-maintainability-audit`; those existing commits are preserved.

## Findings and execution

| ID | Finding | Disposition / verification |
| --- | --- | --- |
| C1 | Latest dependency CI stops before tests on `web-ext → @devicefarmer/adbkit → node-forge`. | Current npm audit reproduces three high findings for GHSA-86w9-cpqp-85rv. Registry latest versions are web-ext 10.7.0, adbkit 3.3.9, node-forge 1.4.0; no patched release is available. Keep the zero-advisory gate. |
| C2 | Firefox recovery guesses the latest run attempt's artifact, missing a verified earlier attempt after store-only reruns. | Fixed locally: select the latest unexpired exact-tag artifact across paginated attempts; preserve SHA/version/hash checks. 55 release tests and focused ESLint pass. |
| C3 | Chrome resize verification sleeps 800 ms then reads storage once. | Fixed: bounded polling waits for the exact persisted height and reports the latest value on timeout. 18 focused tests and hidden Chrome verification pass. |
| C4 | Old-tag Firefox recovery reads current main metadata and archive contracts. | Not changed: current-main metadata, archive inventory, and AMO reviewer metadata must all be bound to the target tag before historical recovery can be supported safely; documented in releasing.md. |
| C5 | Exact transitive version assertions reject compatible security patches. | Fixed: reviewed semver ranges retain minimum patched releases and dev-only checks without snapshot churn; zero-advisory gate unchanged. |
| U1 | Removing an ignored climber loses keyboard focus to BODY. | Fixed: preserve visible row/control focus through remove, Undo, pending writes, failures, and storage refreshes; leave external focus alone. |
| U2 | Favorites setup and import controls bury the actual list. | Fixed: native Buddy List disclosure and shorter copy keep the list visible; confirmation remains outside the disclosure and Cancel restores visible focus. |
| E1 | Capture core duplicates synchronous summit matching/reduction used only by tests. | Fixed: removed unused sync implementations and migrated tests to the unchanged shipped async path with explicit encounter and reduction fixtures. |
| E2 | Four map destination access pages duplicate the same permission interaction. | Fixed: shared initializer with explicit provider parameters; trusted-event permission boundaries retained. |

| E3 | The page-test helper duplicates draft routes but bypasses identity checks and differs on deletion/pruning. | Fixed: page fixtures use production mutation handlers, identity validation, tombstones, and pruning; save-confirmation lifecycle messages remain explicit fixture delegates. |

## Evidence and scope

- [Latest dependency failure](https://github.com/wilmtang/better-peakbagger/actions/runs/37172512591):
  `audit:ci` rejects adbkit, node-forge, and web-ext before application tests.
- [Earlier mainline terrain failure](https://github.com/wilmtang/better-peakbagger/actions/runs/36809788736):
  pending-drape probe sampled the wrong asynchronous event. Current source
  already waits for authoritative Fetch interception; do not redo this repair.
- Current Firefox recovery is in `.github/workflows/retry-firefox-release.yml`.
  The storage timing assumption is in `scripts/verify-extension.mjs`.
- Hidden full Chrome for Testing 153.0.8010.12 successfully loaded current
  `dist/`. At 390×844 the Favorites toolbar began at y=785; at 1024×900,
  y=579. Existing neutral palette is coherent; prioritize hierarchy and density.
- A deterministic ignored-list reproduction moved focus from an Unignore
  button to BODY while another row remained.
- Sync capture algorithms have no runtime callers; the worker calls
  `detectPeaksAsync` and `reduceTrackAsync`. Remove duplication rather than
  compressing readable code or weakening data/permission validation.

Each independent change receives appropriate checks and its own commit before
the next implementation starts. Final checks include the full unit suite,
lint, scale coverage, real-extension browser verification, and targeted visual
inspection. No push, merge, tag, or store mutation is included in this work.

## Closure ledger

### Fixed and verified

- C2: Firefox recovery searches all artifact pages and accepts an earlier
  verified attempt after a store-only rerun. Selection rejects expired,
  future, wrong-tag, and ambiguous matches; legacy fallback remains explicit.
  All 55 focused release tests, focused ESLint, and `git diff --check` passed.
- C3: replaced the 800 ms persistence assumption with the existing bounded
  async wait. The timeout reports the expected and latest stored heights.
  All 18 resource/fixture tests and focused ESLint passed. The full real
  extension verifier passed in hidden Chrome for Testing 153.0.8010.12, using
  a 1000×760 base viewport and 1200×600 / 1200×1100 resize cases. Process
  inspection confirmed the verifier and its exact disposable profile were
  removed. This storage check does not establish native focus/window placement
  or a hardware WebGL renderer.

- U1: 28 focused options tests and scoped ESLint pass. Hidden Chrome 153.0.8010.12
  verified pending removal, successor focus, and Undo restoration. Static UI
  screenshots inspected at 390×844 (light) with light/dark captures also made
  at 1024×900; no WebGL involved. Task browser/profile cleanup confirmed.
  Hidden DOM focus checks do not prove native focus or screen-reader speech.

- U2: 29 focused options tests and scoped ESLint pass. Hidden Chrome 153.0.8010.12
  verified empty/populated/long-name workspaces in both themes at 390×844 and
  1024×900, with screenshots visually inspected. The first list row fits
  without scrolling; narrow toolbar moved from y=785 to approximately y=490.
  Enter/Space disclosure operation, visible confirmation after collapse, and
  Cancel focus are verified. Dark-theme text uses the existing link color.
  Static UI only, no WebGL; no native browser chrome/screen-reader proof.
  Disposable profiles and verifier processes were removed.
  The broader Chrome/Firefox smoke flows initially attempted hidden import
  controls; they now open the disclosure through its summary. Both full
  verifiers passed afterward (hidden Chrome 153.0.8010.12, Firefox 157.0;
  base viewport 1000×760), with teardown confirmed.

- C5: 6 dependency-policy tests and scoped ESLint pass. Synthetic later
  image-size/adm-zip patches are accepted; known-old, unreviewed-major, and
  prerelease versions are rejected. The exact scoped brace-expansion override
  stays pinned; no installed dependency version was changed.

- E1: removed 128 net capture runtime lines. Before deletion, all three parity
  cases and the 8-test full-analysis scale suite passed. After migration,
  45 capture/scale tests, 2,181 full-suite tests, scoped ESLint, documentation
  checks, and full hidden Chrome/Firefox extension verification passed.
  Cancellation, mandatory points, midpoint ties, source identity, and the
  20,000-point/5,000-peak budget remain covered.

- E2: 30 focused access/manifest tests and scoped ESLint pass. Hidden Chrome
  153.0.8010.12 map-handoff verification passed against masked HTTPS fixtures
  at 1000×760 and 430×760. Light Gaia and dark CalTopo access screenshots
  inspected at 1000×760; static HTML, no WebGL. Native permission prompts
  remain uninspected; grants existed only in the disposable test manifest.
  Test browser/profile teardown confirmed.

- E3: removed 105 net lines from the draft helper by using production handlers.
  All 172 focused editor/options tests, 2,181 full-suite tests, 14 scale tests,
  and full lint passed (seven existing owned web-ext warnings). Updated stale
  physical-deletion assumptions in editor, draft-manager, and ascent-delete
  tests; verified sender identity, tombstone suppression of stale writes,
  storage failure recovery, terminal autosave cleanup, and unrelated-cache
  preservation during pruning. Save-confirmation orchestration remains
  delegated explicitly and has separate worker-route coverage.

### Intentionally not changed

- C1: no reviewed patched upstream version currently exists. Do not downgrade
  web-ext to npm's suggested 5.1.0 or waive security findings to turn CI green.
- C4: historical-tag recovery remains limited by current-main metadata and
  archive contracts, including AMO reviewer metadata. Relaxing only the version
  check would leave package validation and reviewer instructions inconsistent.
  The release guide records the limitation; no store recovery was attempted.
- Earlier terrain pending-request failure is already repaired in this tree.
- Retain privacy, cancellation, ownership, settings validation, and manual Save
  boundaries. Native/live-provider behavior requires separate evidence.

### Changed but not fully proven

- C2: selector and workflow contracts are locally verified; no recovery
  workflow or store mutation was dispatched. C4 remains a separate limitation.
- Remote CI success requires an authorized push and a terminal workflow on the
  resulting commit; local checks cannot establish it.

## Final local verification

- `npm test`: 2,181 passed, zero failed.
- `npm run test:scale`: 14 passed, zero failed.
- `npm run lint`: passed; seven existing owned web-ext warnings, no new warnings.
- Final built extension: full hidden Chrome for Testing 153.0.8010.12 and
  Firefox 157.0 verifiers passed, base viewport 1000×760 plus their responsive
  cases. Map handoffs also passed hidden Chrome with masked HTTPS fixtures.
  Targeted Favorites/ignored-list screenshots were inspected in light/dark
  and narrow/desktop states. No native permission-prompt, window-placement,
  screen-reader speech, or live-provider proof is claimed. Process and profile
  inspection confirmed teardown; no hardware WebGL result is claimed here.
- `npm run audit:ci`: failed on the same three unowned node-forge-chain findings.
  This is a real unresolved dependency gate, not evidence of a timing flake.
- Runtime source (`src/`, `options/`, `popup/`, `photos/`) is 186 lines smaller
  than the audit baseline. The duplicated draft helper is 105 lines smaller.
  Regression tests, verification tooling, and this ledger add lines overall;
  runtime and test-oracle duplication were removed without compressing code.

The plan stays active for the upstream advisory, historical-tag recovery, and
remote workflow evidence. No push, tag, release submission, or merge occurred.
