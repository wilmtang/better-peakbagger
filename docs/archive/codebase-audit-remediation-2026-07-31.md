# Codebase audit remediation — 2026-07-31

Status: **implementation complete; automated and hidden-browser verification
passed, with the remaining proof gaps recorded below.** This archived plan
reassessed seven findings from an external audit against clean local `main` at
`fb6733e`, 47 commits ahead of `origin/main`. The report's broad claim that
every security boundary was correct was not treated as proof; each accepted
finding was scoped to the current source and received focused regression
coverage.

## Reassessed findings and disposition

| ID | Priority | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | P1 | capture starts can pass the in-flight guard before the process is registered | Fixed in `05e8b26` |
| F2 | P1 | detached tab-removal and periodic cleanup promises can reject unobserved | Fixed in `12fac46` |
| F3 | P2 | MAIN-world settings snapshots are accepted without schema validation | Fixed in `1b67601` |
| F4 | P2 | ascent-page metrics and route geometry accept finite but impossible coordinates | Fixed in `cff1a61` |
| F5 | P3 | options labels contain more than one labelable descendant | Fixed in `6329726` |
| F6 | P3 | theme startup duplicates the schema default | Fixed in `c1d63da` |
| F7 | P3 | the `mask-icon` branch is unreachable after all links are ignored | Fixed in `7770d2a` |

Priority describes product impact, not implementation effort. P1 is a material
reliability or recovery defect, P2 is a bounded trust/correctness defect, and P3
is accessibility or maintainability debt.

The packaged Chrome verifier also had a pre-existing assumption that manual
settings transfer always included credentials. Commit `dfaaddb` makes the check
explicitly opt into the one-shot credential transfer and verifies that the
choice resets after export; it does not weaken the product's safer default.

## Closure ledger

### Fixed and verified

- **F1 — capture admission:** capture setup is serialized per source tab until
  the provider process is registered. Concurrent starts now converge on one job
  and one provider execution without holding the queue for the entire capture.
  A deterministic background-bundle regression overlaps the admission window.
- **F2 — detached cleanup:** tab-removal photo cleanup, capture/draft cleanup,
  and periodic expiry cleanup now have explicit rejection boundaries. Fault
  injection proves one failed cleanup is reported without hiding independent
  cleanup work.
- **F3 — settings trust boundary:** every fallback, ordinary push, successful
  acknowledgement, and late acknowledgement received by the MAIN-world client
  is cleaned through the shared settings schema before becoming confirmed or
  optimistic state. Same-window spoofing regressions cover invalid known keys.
- **F4 — analyzer coordinates:** metrics and map routes now share one geographic
  coordinate predicate. Invalid points are rejected, and valid point groups are
  kept separate so distance, gain, grade, smoothing, and rendered geometry do
  not bridge a discarded gap.
- **F5 — options semantics:** route appearance uses a non-label grouping and the
  beta trip-report checkbox and word threshold have distinct labels. A
  structural test prevents any label from acquiring multiple labelable
  descendants.
- **F6 — theme default:** synchronous theme startup now reads the shared schema
  default. The schema-drift test guards against reintroducing a local literal.
- **F7 — dead mask branch:** the unreachable mask-icon exception was removed
  while preserving the established all-links-ignored behavior. A behavior test
  pins mask-icon attributes as untouched.

Verification evidence:

- Focused suites passed after each commit: 40 then 41 background capture tests,
  18 settings tests, 82 GPX/analyzer tests, 42 options tests, 19 theme/settings
  tests, and 5 dynamic-inline-colors tests.
- `npm test`: **1,115 passed, 0 failed**.
- `npm run lint:js`: passed.
- `npm run lint`: passed with the six owned cross-browser/vendor warnings.
- The real unpacked `dist/` passed in hidden Chrome for Testing 149 and hidden
  Firefox 153.0.1 at 1000×760. The credential-transfer verifier repair also
  passed as part of Chrome's packaged-extension run.
- The changed options sections were visually inspected from the real unpacked
  extension in hidden Chrome for Testing 149.0.7827.55 at 1000×760 and 480×760,
  including the lower scroll position at the narrow viewport. Route controls,
  beta controls, and reset actions remained legible, reachable, and free of
  overlap.
- Teardown inspection found no surviving audit browser process or disposable
  `better-peakbagger-extension-*`, `better-peakbagger-firefox-*`, or
  `better-peakbagger-audit-visual-*` profile.

### Intentionally not changed

- Provider and local-file capture retain their stricter validation owner in
  `capture-core.js`. Adding parser-level bounds would duplicate that policy and
  would not fix the separate ascent-analyzer path identified by F4.
- The page remains the owner of its MAIN-world DOM. Revalidation was added at
  the untrusted message receiver, but the settings allowlist was not widened and
  no privileged extension capability was exposed to page scripts.
- All stylesheet links remain ignored by dynamic inline-color processing. Only
  the dead mask-icon exception was removed; no icon behavior was invented.
- The audit's claim that clicking the beta threshold number input toggled the
  checkbox was not reproduced. The invalid multi-control label structure was
  still corrected because its accessible-name ownership was ambiguous.

### Changed but not fully proven

- Capture concurrency is proven with deterministic background-bundle tests and
  packaged worker startup, but not by racing two starts against a live Garmin or
  Strava activity page.
- Detached cleanup is proven with injected storage failures, but a real browser
  storage failure was not forced during native tab closure or an alarm event.
- Settings validation is proven through same-window message injection and the
  packaged cross-world bridge, but no hostile script was injected into a live
  Peakbagger page.
- Coordinate rejection is proven in pure and fixture-based tests, but a live
  malformed Peakbagger GPX response was not used.
- Options semantics are structurally tested and visually inspected, but were
  not exercised with a screen reader or other assistive technology.
- All browser work was hidden and isolated. It does not prove native toolbar
  grants, browser chrome, permission prompts, focus/window placement, touch, or
  physical-device behavior. Firefox Android was not tested.
