# Release hardening — 2026-09-30

## Findings

The 3.8 integration exposed separate product and verification defects. Required
checks correctly prevented publication; auto-merge was queued correctly.
The worker's delayed readiness timer required a runtime correction. The exact
lint count, async storage predicates, closed-jsdom timers, stale geometry, TLS
attachment, page-load waits, and camera settlement were verification defects.
Their corrections and evidence are recorded in
[the integration ledger](../archive/dependabot-integration-2026-09-29.md).

PR #37 passed all jobs and merged as `26a6898`. Its
[main run](https://github.com/wilmtang/better-peakbagger/actions/runs/36809788736)
failed only the Chrome GPU probe: a paused raster request was already observed,
but an immediate assertion required its separate Network event to arrive too.

## Work and verification

1. Gate the pending-raster regression on its authoritative Fetch interception.
   Exercise delayed Network delivery and absent interception in regression
   tests, then run the hidden hardware-GPU verifier.
2. Compute the disposable certificate SPKI once in the shared fixture helper.
   Apply launch-time trust to Chrome fixture checks, including extension-created
   tabs. Keep trust scoped to the generated certificate. Verify the real browser
   and capture flows, and test certificate cleanup and fingerprint generation.
3. Retain useful, bounded browser failure evidence in CI, with failures still
   failing the job. Include screenshots, current page state, and logs where the
   verifier supports them; exclude credentials and provider payloads.
4. Add a read-only release rehearsal that uses the release package gates before
   a tag triggers publication. Validate listing metadata early, build packages
   once, preserve their identity, and keep store jobs exclusive to release tags.
5. Run focused checks before each commit. Follow the authorized PR and main CI
   runs to terminal success, then continue the 3.8 release checklist.

## Fixed and verified

- The prior independent corrections are recorded in the integration ledger.
- PR #37's actual merge has two parents and preserves its full source name.
- The pending-raster probe uses a fresh Fetch interception after navigation,
  instead of requiring immediate delivery of a separate Network event. The
  delayed-Network regression fails against the previous probe and passes with
  the correction; absent interception still fails. All five focused tests and
  focused ESLint passed. Hidden Chrome terrain passed on M3 Pro ANGLE Metal at
  798×448 and 448×448, including pending drape and twelve canvas resizes.

- Disposable certificate trust is computed once and applied at Chrome launch,
  scoped to that certificate's public key. Ten fixture consumers use the shared
  helper. Certificate generation, fingerprint failure, and cleanup regressions
  passed; all 160 project tests and focused ESLint passed. Nine hidden browser
  checks passed: desktop Chrome and Firefox, capture readiness, toolbar capture,
  multi-summit drafts, GPX handoffs, report photos, backup lifecycle, and Chrome
  terrain on M3 Pro ANGLE Metal. The separate LOD and showcase renderers were
  structurally checked but not separately rendered for this change.

- Browser CI retains failure logs and Chrome terrain screenshots for seven
  days. Chrome records bounded fixture requests, structural page state, and
  at most three screenshots with form fields masked; Firefox records its current
  fixture's structural state. Diagnostics preserve the original failure and run
  before teardown. All 51 focused tests, focused ESLint, and YAML parsing passed.
  An intentional hidden Chrome 153 failure at 1280×720 retained the original
  error and a screenshot; visual inspection confirmed form values were masked.

## Intentionally not changed

- Required checks, zero-advisory policy, GPU renderer assertions, runtime
  deadlines, release-tag protection, and store reviewer protection remain.
- Store mutations are not retried automatically after ambiguous outcomes.
- Live authenticated browser checks remain separate from fixture evidence.

## Changed but not fully proven

- Release rehearsal remains pending.
- Main CI has not yet passed after the latest merge.
- Live authenticated desktop Firefox capture remains pending; its debugging
  connection is unavailable and its profile has no provider login.
- Version 3.8 has not been tagged or submitted to either store.
