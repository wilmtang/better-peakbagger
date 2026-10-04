# CI, UX, and maintainability audit — 2026-10-03

Baseline: `f6a3029`, clean `codex/ignored-climbers` checkout, with fourteen
existing commits beyond `origin/main`. Audit work continues on
`codex/ci-ux-maintainability-audit`; those existing commits are preserved.

## Findings and execution

| ID | Finding | Disposition / verification |
| --- | --- | --- |
| C1 | Latest dependency CI stops before tests on `web-ext → @devicefarmer/adbkit → node-forge`. | Current npm audit reproduces three high findings for GHSA-86w9-cpqp-85rv. Registry latest versions are web-ext 10.7.0, adbkit 3.3.9, node-forge 1.4.0; no patched release is available. Keep the zero-advisory gate. |
| C2 | Firefox recovery guesses the latest run attempt's artifact, missing a verified earlier attempt after store-only reruns. | Fix exact-tag artifact selection across attempts; preserve SHA/version/hash checks. |
| C3 | Chrome resize verification sleeps 800 ms then reads storage once. | Replace the timing assumption with bounded polling and live diagnostics. |
| C4 | Old-tag Firefox recovery reads current main metadata and archive contracts. | Investigate a safe tagged-contract validation path; retain explicit limitation if it cannot be proven. |
| U1 | Removing an ignored climber loses keyboard focus to BODY. | Restore focus after list mutation, with deferred-mutation regression coverage. |
| U2 | Favorites setup and import controls bury the actual list. | Native disclosure for uncommon Buddy List options; simplify copy and inspect both themes at narrow and desktop sizes. |
| E1 | Capture core duplicates synchronous summit matching/reduction used only by tests. | Pin expected behavior, migrate tests to the shipped async functions, then remove unused implementations. Preserve cancellation and cooperative work coverage. |
| E2 | Four map destination access pages duplicate the same permission interaction. | Share the initializer with explicit per-provider parameters and preserve trusted-event permission boundaries. |

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

Pending implementation.

### Intentionally not changed

- C1: no reviewed patched upstream version currently exists. Do not downgrade
  web-ext to npm's suggested 5.1.0 or waive security findings to turn CI green.
- Earlier terrain pending-request failure is already repaired in this tree.
- Retain privacy, cancellation, ownership, settings validation, and manual Save
  boundaries. Native/live-provider behavior requires separate evidence.

### Changed but not fully proven

No implementation yet. Remote CI success requires an authorized push and a
terminal workflow on the resulting commit; local checks cannot establish it.
