# Mainline and dependency integration — 2026-10-03

## Findings

PRs [#41](https://github.com/wilmtang/better-peakbagger/pull/41),
[#42](https://github.com/wilmtang/better-peakbagger/pull/42), and
[#43](https://github.com/wilmtang/better-peakbagger/pull/43) each had native
merge-commit auto-merge queued. All three failed `Node tests and lint` before
application tests on the same advisory. Their browser and scale checks passed.
The queue workflow and required checks behaved correctly.

The chain is `web-ext@10.7.0 → @devicefarmer/adbkit@3.3.9 → node-forge@1.4.0`.
Raw npm audit reports three high entries, propagated from one advisory,
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
Registry queries found no patched published version; upstream
[forge PR #1152](https://github.com/digitalbazaar/forge/pull/1152) remains open.
The proposed npm force-fix downgrades web-ext to 5.1.0 and was rejected.

The vulnerable RSA verification is in adbkit's TCP/USB bridge server.
web-ext uses the ordinary ADB client rather than `createTcpUsbBridge`.
The installed package remains vulnerable in development. Risk acceptance does
not establish a patch or zero-advisory result.

The [fresh updater run](https://github.com/wilmtang/better-peakbagger/actions/runs/37172391696)
still used the former editor/vendored groups and a null requirement-update
strategy despite the maintained config. This platform configuration mismatch
did not cause the audit failures. A future fresh updater job must be inspected
to establish that the current grouping and strategy actually ran.

## Owner decision

The owner explicitly approved the exact expiring development-only CI exception
and requested completion of the GitHub merges. Ordinary Test CI opts in through
`--allow-reviewed-development-advisory`. The default command and release
workflows still require zero advisories.

The exception expires at midnight October 17, 2026 in America/Los_Angeles
(`2026-10-17T07:00:00Z`). It requires the recorded advisory source, three exact
development-only versions, their dependency edges and single locations, severity
and counts. New findings, changed versions or paths, production resolutions,
duplicate installations, and expiry fail closed. Output names the accepted
advisory and deadline. Do not extend the exception automatically; install a
reviewed upstream patch and remove it when available.

This later owner decision supersedes the audit branch's original instruction to
retain the strict gate for C1 only in ordinary Test CI. Its recorded observation
that no published fix exists remains accurate. Release audits remain blocked.

## Closure ledger

### Fixed and verified

- Integrated both recent local branches and all three dependency branches with
  real two-parent merges whose subjects preserve their full source names.
  The audit branch includes compatible patched-version ranges and bounded
  persistence polling, reducing avoidable automatic-merge failures.
- Clean-worktree verification caught the last Gaia-domain test being removed by
  the shared access-test move. Kept the Gaia-owned stylesheet test under
  `test/gaia`; shared per-provider interaction coverage stays under `test/ui`.
- Combined runtime on Node 24.21.0: 2,181 tests, full lint with six owned
  warnings, and all 14 scale checks passed. Hidden real-extension Chrome
  153.0.8010.12 and Firefox 157.0 checks passed at a 1000×760 base viewport.
  Focused light/dark UI at 1024×900 and 390×844 was rendered and inspected.
- MapLibre 6.11.2 passed hidden hardware-GPU terrain verification in Chrome
  (798×448/448×448) and Firefox 155.0 (1000×760, resized canvas 748×448).
  Both asserted M3 Pro ANGLE Metal. The initial missing Firefox executable was
  resolved by installing its isolated Playwright build before verification.
- The approved CI exception passed a fresh live audit; the strict default
  rejected the same three entries as expected. Sixteen exception regressions
  cover scope, expiry and release separation. The resulting full Node 24.21.0
  suite passed all 2,197 tests; full lint passed with six owned warnings.
  Test, release and auto-merge workflow YAML parsed successfully.
- The first integration PR run passed Node, scale, Firefox and GPU checks but
  Chrome 128 timed out after the ignored-report Favorites click. Its artifact
  had no page state because scope cleanup ran before the outer failure handler.
  The verifier now waits for the independently loaded custom Favorites source
  as well as ignored climbers, and retains bounded diagnostics before closing
  that fixture page. Five focused tests, targeted lint and the complete hidden
  Chrome 128.0.6613.137 check at 1000×760 passed on macOS.
- Hosted reproduction still failed after the readiness change. A bounded
  activation trace then established that no pointer-down, pointer-up or click
  reached the report document while Playwright acknowledged the click. The
  Explicit tab activation and native Enter also failed on the new target.
  Window-level traces established that neither frame received keyboard or
  pointer events; all preceding checks had passed. The scenario now reuses the
  Peak page target that already proved native interaction, navigates it afresh,
  and requires a trusted pointer click for Favorites plus native Enter for
  ignored reveal. Active-tab, focus, filter and persistence assertions remain.
  It does not retry activation or substitute a synthetic event. The full hidden
  Chrome 128.0.6613.137 verifier and targeted lint passed locally with target reuse.

### Intentionally not changed

- July Strava-sync and peak-label prototypes remain separate at the owner's
  request. Source branches are retained; no unrelated checkout edits included.
- Signed Dependabot provenance, four required CI checks, runtime privacy,
  manual Save, and strict release audit boundaries remain enforced.
- Keep the maintained Dependabot grouping, strategy and cooldown. Its actual
  updater job remains a platform proof gap; changing healthy YAML arbitrarily
  would not establish a fix.

### Changed but not fully proven

- The unpatched development advisory is accepted temporarily in ordinary CI,
  not fixed. Raw npm audit and strict release audits still fail.
- Local tests cannot establish remote CI. The integration is to be submitted
  through a PR and merged only after its required checks succeed; the live PR
  and workflow records supply that later evidence.
- The hosted Chrome 128 input-delivery failure did not reproduce in 25 focused
  local attempts. The platform's underlying reason for dropping protocol input
  is not established; hosted CI must verify the reused native-input target.
- Hidden browser checks do not establish native focus, window placement,
  permission prompts, screen-reader speech or live authenticated providers.
  Historical-tag release recovery and live ignored-list synchronization gaps
  remain in the original audit and feature ledgers. No store write occurred.
