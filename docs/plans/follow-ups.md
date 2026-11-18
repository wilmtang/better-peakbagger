# Repository follow-up ledger

Status: opened November 6, 2026, when the completed audit and implementation
records moved to [the archive](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/README.md). This is the single list of
what those records left open. Their original evidence and limits stay in the
archived documents; add new open items here rather than reopening them.

Feature backlog is not tracked here. It stays in its own
[active plan](README.md).

## Intentionally not changed

- **Development-only `picomatch` advisory chain.** Ten `npm audit` findings
  (`@typescript-eslint/*`, `fdir`, `picomatch`, `svelte-check`, `tinyglobby`,
  `typescript-eslint`) trace to `picomatch@4.0.7`, which is the newest upstream
  release on npm with no patched release available. None ship in the extension
  (`npm audit --omit=dev` reports zero vulnerabilities), and `npm run audit:ci`
  reports dev-only advisories without failing. Origin:
  [modern-stack-adoption.md](modern-stack-adoption.md) (`M1`).
- **Historical-tag Firefox recovery.** It stays limited by current-main metadata;
  see [the release guide](../releasing.md). Supporting it is a separate decision.
  Origin:
  [CI/UX maintainability audit (October 3, 2026)](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ci-ux-maintainability-audit-2026-10-03.md)
  (`C4`) and
  [October 10 follow-up](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ci-ux-maintainability-audit-2026-10-10.md).
- **CI flakiness Phase 4 and standalone non-CI verifiers.** Phase 4 kept Option A
  (paired store package verification inside `.github/actions/verify-package` via
  `scripts/verify-store-packages.mjs`; see
  [CI verifier flakiness remediation](https://github.com/wilmtang/better-peakbagger/blob/893853927c3a02c58600de32add1aa7e50196e6f/docs/plans/ci-verifier-flakiness.md)).
  Ten standalone verifiers recorded in
  [codebase-reduction-2026-11-13.md](codebase-reduction-2026-11-13.md) remain
  outside `.github/workflows/test.yml` as separate non-CI debt.

## Changed but not fully proven

### Needs a decision or a person

- **Garmin distribution agreement.** The review is still open. Origin:
  [Garmin inbox audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/garmin-inbox-audit.md).

### Reproduced or still open

- **Instrumented CI watch items (`F5` and single-pass green cells).**
  `verify-capture-flow.mts` Preview and Full Screen peak terrain frame timeout
  instrumentation (`01babfb3`, `acc32703`) had no recurrences locally or in `main`
  `Test` run `44266845670` (`35/35` jobs at `65783d5e`), and
  `Peak surface (firefox, snow)` / macOS Metal GPU cells passed in the same run;
  keep passive monitoring across subsequent `main` runs. Origin:
  [CI verifier flakiness remediation](https://github.com/wilmtang/better-peakbagger/blob/893853927c3a02c58600de32add1aa7e50196e6f/docs/plans/ci-verifier-flakiness.md).

### Local proof limits

- **Report source inspector.** Native picker keyboard navigation in Chrome and
  Firefox, Firefox popup focus return, browser chrome zoom and assistive speech
  remain unverified. Hidden fixtures prove source switching and layout stability
  with normal/doubled inspector text; the focused change handler preserves focus.
  Live provider playback and unknown server-side URL rewrites remain outside that
  evidence. Origin:
  [report protection closure ledger](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/report-protection-remediation-2026-11-07.md).
- **Hosted CI (`release.yml` and Dependabot auto-merge).** The `ubuntu-24.04` /
  `macos-15` `test.yml` matrix passed `main` `Test` run `44266845670` (`35/35`
  jobs at `65783d5e`), leaving two untriggered hosted workflows unexercised:
  `.github/workflows/release.yml` current-browser compatibility on `ubuntu-24.04`
  (awaiting a `workflow_dispatch` rehearsal or release tag) and the Dependabot
  auto-merge workflow against the updated matrix (awaiting the next dependency
  pull request). Origins:
  [CI: Linux by default, macOS only for hardware WebGL](https://github.com/wilmtang/better-peakbagger/blob/86c975a09f884e3726a726e05dc248048f589240/docs/plans/ci-macos-gpu-only.md)
  and
  [Dependabot auto-merge](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/dependabot-auto-merge-2026-10-25.md).

### Release-only checks

Fixtures cannot establish these, so check them by hand before a release (see
[the release guide](../releasing.md) and each originating archived audit):

- Live Garmin and onX sign-in, cold start and recovery, including a truly expired
  Garmin key and a real Cloudflare challenge
  ([Garmin inbox audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/garmin-inbox-audit.md),
  [onX export reliability](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/onx-export-reliability-2026-10-27.md)).
- Live Peakbagger acceptance and saved-trip persistence, and Peakbagger cookie
  isolation for signed-out users
  ([Garmin personal API draft inbox](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/garmin-personal-api-draft-inbox.md),
  [Signed-out Peakbagger feature gates](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/signed-out-peakbagger-audit-2026-10-23.md)).
- Live Strava, NRCS and other provider compatibility and throttling
  ([External API rate-limit audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/2026-10-11-external-api-rate-limit-audit.md),
  [October 19 codebase audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-19.md)).
- Provider-specific private-layer policies and authenticated map formats
  ([Private custom-layer relay](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/custom-layer-private-relay-2026-10-26.md)).
- Instagram's own resize, login and availability behavior
  ([Instagram embed display audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/instagram-embed-audit-2026-10-26.md)).
- Actual Firefox BFCache delivery with real extension messages
  ([October 12 codebase audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-12.md),
  [October 22 follow-up](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-22-followup.md)).
- Native permission prompts, browser menus, browser zoom, screen-reader output,
  physical touch, and visible focus and window placement
  ([October 12 codebase audit](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-12.md),
  [report protection closure ledger](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/report-protection-remediation-2026-11-07.md)).
- Store submission and acceptance
  ([the release guide](../releasing.md),
  [CI/UX maintainability audit (October 10, 2026)](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/ci-ux-maintainability-audit-2026-10-10.md)).
