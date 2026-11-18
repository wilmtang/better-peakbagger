# Repository follow-up ledger

Status: opened November 6, 2026, when the completed audit and implementation
records moved to [the archive](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/README.md). This is the single list of
what those records left open. Their original evidence and limits stay in the
archived documents; add new open items here rather than reopening them.

Feature backlog is not tracked here. It stays in its own
[active plan](README.md).

## Fixed and verified

| Item | Outcome | Evidence |
| --- | --- | --- |
| Snow-legend JSON fixture missing from the privacy scan | `c1ba9599`: JSON is parsed and scanned; malformed JSON and invalid UTF-8 are rejected | Both baseline failures reproduced, then passed |
| Script inventory ignored `.mts` and missed a verifier | `6e4a3041` | Original assertion failed first |
| Moderate minimatch advisories in the lint toolchain | `01616f47`: scoped to former 10.x consumers | Nine findings removed; production audit is zero |
| Custom-overlay reorder check failed in Chrome | `7719f08d`: waits for the deep-link scroll to settle. The product did not move | Probe saw a 305px pane scroll; settled geometry matched exactly |
| Recorded editor Chrome zoom-fit and Firefox hover-help failures | Did not reproduce | Full custom-overlay runs pass in hidden Chrome 156 and Firefox 159 |
| Firefox custom-overlay GeoJSON stuck on "Loading" | No longer occurs | Same Firefox run; see the [October 27 ledger](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/codebase-audit-2026-10-27.md) |
| Intermittent climber-hover late-content timeout | Product defect, fixed in `e9a0b694`: replacement focus opened the next climber's card | Test file failed 4 of 5 runs before the fix, passed 8 of 8 after |
| `verify -- chrome` and `-- firefox` stopped at the Garmin section check | `69c7a321`: the verifier expected the section to hide, but `132303e1` keeps it available for Disconnect | Failed 4 of 4 runs before; both browsers pass after |
| Terrain visual 2D gap (41px against 40px) and Firefox Sentinel trigger | No longer occur | `verify -- terrain chrome` and `firefox` pass on Metal |
| `deepmerge` / `addons-linter` / `web-ext` dev advisories | Superseded upstream: the `web-ext` and `addons-linter` chain no longer pulls vulnerable `deepmerge` | `npm run audit:ci` passes with zero production advisories (`npm audit --omit=dev` is 0); remaining dev entries stem from `picomatch` |
| Actionable CodeQL alerts on `main` (`#62`, `#63`, `#64`, `#65`, `#67`, `#119`, `#129`) | `cc4d2787`, `83cef8b0`, `c7347111`: single-pass entity decoding and ASCII-offset-safe linear `indexOf` HTML scanning in `src/peakbagger/peakbagger-account.ts`, CSPRNG tokens in `src/ascent/ascent-upload.ts`, explicit `switch` dispatch in `src/maps/custom-overlay-data.ts`, and pre-escape newline/length-bounded pipe escaping in `scripts/probe-chrome-extension-load.mts` | Focused unit suites (`15/15` post-fix; `10/10` + `107/107` initial), full `npm test` (`4,208/4,208`), and PR #77 `CodeQL` (`44258778768` at `f599ca20`; re-gated before merge) |
| CI verifier flakiness Phases 1–3 (`F1`–`F4`) | `2effc2b7`, `bfb83e1b`, `f95a4c63`: serialized `buddyRefreshQueue` plus Firefox buddy-mutation waits (`F3`), non-clamped post-frame `hashchange` alignment in `src/ui/section-nav.ts` (`F4`), and BiDi `navigationEpoch`/`network.fetchError` scoping with structured card-readiness output (`F1`/`F2`) | Hidden Chrome/Firefox verifiers and hosted PR #77 `Test` run `44258780970` (`35/35` jobs); see [CI verifier flakiness remediation](https://github.com/wilmtang/better-peakbagger/blob/893853927c3a02c58600de32add1aa7e50196e6f/docs/plans/ci-verifier-flakiness.md) |
| Firefox verifier `-no-remote` isolation | `70738f63`: added `-no-remote` alongside `-headless` across all 13 Selenium Firefox verifiers, pinned in `test/project/verification-launch.test.mts` | `5/5` launch tests, hidden Firefox `settings-fragments`, and PR #77 `Test` run `44258780970` |
| Real-browser disappearing-row replacement focus | `f7a172e8`: `verifyDisappearingRowReplacementFocus` in `scripts/verify-climber-transitions.mts` removes a row beneath a keyboard-opened card and confirms focus stays on the next row without scrolling or opening its card past the 350ms dwell delay | Chrome `158.0.8127.18` and Firefox `159.0` (`1280` scale 1 and `390` scale 2) passed |
| Linux backup action widths and CI offload | `f599ca20`: reserved `"Backing up to GitHub…"` beside `attr(data-label)` in `src/ascent/ascent-backup.css`, switched `.bpb-profile-actions` in `src/profile/profile-backup.css` to proportional flex shrinking with `border-box` placeholder sizing, and moved `backup-layout` to `ubuntu-24.04` | `16/16` local backup cases plus hosted `Backup layout (chrome)` and `Backup layout (firefox)` on `ubuntu-24.04` in PR #77 run `44258780970` |
| Terrain tile-level warming (`verify -- terrain lod`) | `maplibre-gl` `6.17.0` passes all four tilt criteria within the unchanged 120ms budget | Headless Metal GPU (`Apple M3 Pro`): `58°->61°` `0ms visible / 32ms per tile`, `64°->67°` `0ms visible / 38ms per tile`, `67°->70°` `0ms visible / 45ms per tile`; `20/20` fixed-angle zoom cases passed |

### Acceptance & verification run — November 17, 2026

Local gates ran on Node `v26.13.1` on macOS (`Apple M3 Pro`); full browser/scale runs executed against `f599ca20` with subsequent archival/review commits re-checked locally (`npm test`, `typecheck`, `lint`, policy) and re-gated by final PR `#77` checks before merge. Hosted PR `#77` CI runs `44258780970` and `44258778768` ran on `ubuntu-24.04` / `macos-15` at `f599ca20`. Browser checks ran hidden.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed (`tsc`, `svelte-check` 593 files 0 errors/warnings, `typecheck-node`) |
| `npm run lint` | Passed with the 10 owned `web-ext` warnings |
| `npm run check:typescript-policy -- --base main` | Passed (`56` changed paths examined) |
| `npm test` | 4,208 of 4,208 passed |
| `npm run test:scale` | 14 of 14 passed (at `f599ca20`) |
| `npm run verify -- chrome` | Passed in Chrome `158.0.8127.18` at 1000×760 (at `f599ca20`) |
| `npm run verify -- layout-stability --suite=backups` | 16 of 16 cases passed in Chrome `158.0.8127.18` and Firefox `159.0` (at `f599ca20`) |
| `npm run verify -- terrain lod` | Passed on hardware Metal rendering at `f599ca20` (`4/4` tilt criteria, worst `45ms` per tile vs 120ms; `20/20` zoom cases) |
| `npm run audit:ci` | Passed: zero production advisories; 10 dev-only `picomatch` chain entries |
| Hosted PR `#77` `Test` (`44258780970` at `f599ca20`) | 35 of 35 jobs passed (including Linux `Backup layout (chrome)` & `Backup layout (firefox)`); final head re-gated before merge |
| Hosted PR `#77` `CodeQL` (`44258778768` at `f599ca20`) | Passed (`Analyze (actions)` and `Analyze (javascript-typescript)`, `0` new alerts); final head re-gated before merge |

### Historical baseline — November 6, 2026

Run on Node `24.22.2` against `69c7a321` (`npm test` `3,874/3,874`; `npm run audit:ci` failed on former `deepmerge`/`addons-linter`/`web-ext`; `verify -- terrain lod` failed 120ms gate at `158ms`/`154ms` prior to `maplibre-gl` `6.17.0`).

## Intentionally not changed

- **Development-only `picomatch` advisory chain.** Ten `npm audit` findings
  (`@typescript-eslint/*`, `fdir`, `picomatch`, `svelte-check`, `tinyglobby`,
  `typescript-eslint`) trace to `picomatch@4.0.7`, which is the newest upstream
  release on npm with no patched release available. None ship in the extension
  (`npm audit --omit=dev` reports zero vulnerabilities), and `npm run audit:ci`
  reports dev-only advisories without failing.
- **Terrain warming budget.** The 120ms budget stayed strict and unchanged when
  re-verifying `verify -- terrain lod`.
- **Historical-tag Firefox recovery.** It stays limited by current-main metadata;
  see [the release guide](../releasing.md). Supporting it is a separate decision.
- **CI flakiness Phase 4 and standalone non-CI verifiers.** Phase 4 kept Option A
  (paired store package verification inside `.github/actions/verify-package` via
  `scripts/verify-store-packages.mjs`). Ten standalone verifiers recorded in
  [codebase-reduction-2026-11-13.md](codebase-reduction-2026-11-13.md) remain
  outside `.github/workflows/test.yml` as separate non-CI debt.

## Changed but not fully proven

### Needs a decision or a person

- **Garmin distribution agreement.** The review is still open.

### Reproduced or still open

- **Instrumented CI watch items (`F5` and single-pass green cells).**
  `verify-capture-flow.mts` Preview and Full Screen peak terrain frame timeout
  instrumentation (`01babfb3`, `acc32703`) had no recurrences locally or in PR #77
  run `44258780970`, and `Peak surface (firefox, snow)` / macOS Metal GPU cells
  passed in the same run; keep passive monitoring across subsequent `main` runs.

### Local proof limits

- **Report source inspector.** Native picker keyboard navigation in Chrome and
  Firefox, Firefox popup focus return, browser chrome zoom and assistive speech
  remain unverified. Hidden fixtures prove source switching and layout stability
  with normal/doubled inspector text; the focused change handler preserves focus.
  Live provider playback and unknown server-side URL rewrites remain outside that
  evidence. See the [report protection closure ledger](https://github.com/wilmtang/better-peakbagger/blob/9bcb42a3e0572218f7fe244eeaacf6197fab54f1/docs/archive/report-protection-remediation-2026-11-07.md).
- **Hosted CI.** Moving `chrome`, all eight `peak-surfaces` cells, both
  `backup-layout` cells, and `.github/workflows/release.yml` current-browser
  compatibility to `ubuntu-24.04` (leaving only hardware Metal WebGL suites on
  `macos-15`) passed hosted PR `#77` `Test` run `44258780970` (`35/35` jobs at
  `f599ca20`; subsequent archival and review-fix commits are re-gated on PR `#77`
  before merge). Exercising the Dependabot auto-merge workflow against this
  matrix awaits the next dependency pull request.
  next dependency pull request.

### Release-only checks

Fixtures cannot establish these, so check them by hand before a release:

- Live Garmin and onX sign-in, cold start and recovery, including a truly expired
  Garmin key and a real Cloudflare challenge.
- Live Peakbagger acceptance and saved-trip persistence, and Peakbagger cookie
  isolation for signed-out users.
- Live Strava, NRCS and other provider compatibility and throttling.
- Provider-specific private-layer policies and authenticated map formats.
- Instagram's own resize, login and availability behavior.
- Actual Firefox BFCache delivery with real extension messages.
- Native permission prompts, browser menus and browser zoom.
- Screen-reader output, physical touch, and visible focus and window placement.
- Store submission and acceptance.
