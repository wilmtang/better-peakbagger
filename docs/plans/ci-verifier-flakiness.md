# CI verifier flakiness remediation

Status: completed (Phases 1–3 landed and verified alongside hosted PR #77 `Test` run `44258780970`, 35/35 jobs passed; Phase 4 kept Option A; F5 and standalone verifier watch items carried to the follow-up ledger).

Companion to [CI: Linux by default, macOS only for hardware WebGL](https://github.com/wilmtang/better-peakbagger/blob/86c975a09f884e3726a726e05dc248048f589240/docs/plans/ci-macos-gpu-only.md).
Moving jobs off macOS reduces 5-slot runner queueing, not intermittent test
failures. This plan addresses the intermittent failures themselves without
loosening assertions, hiding errors or adding blind retries.

## Baseline audit of the last 40 `Test` runs

Window: 40 runs of `.github/workflows/test.yml` through 2026-11-15 (`42280222468`
to `43674957819`). Eleven runs failed. Comparing failed-job logs from GitHub
Actions against `main`'s `git log` (note: three runs executed on remote
Dependabot pull-request heads absent from local `main`) separates real open
flakiness from issues already remediated:

- **1 run (`42280222468`)** was a deterministic regression across 11 Linux jobs.
- **4 runs (`42289313470`, `42294607406`, `42537287786`, `42592481066`)** had
  intermittent failures that are all fixed on `main`.
- **2 runs (`42586707374`, `42606608776`)** were mixed: each contained one
  intermittent job failure now fixed on `main` and one failure mode still open.
- **4 runs (`43671220733`, `43673641996`, `42441998262`, `42598239163`)**
  contained only still-open or watch-list failures.

Counting individual non-aggregate failed jobs across the 10 intermittent runs:
**8 job failures** are already fixed on `main`, and **6 job failures** (spanning
5 failure groups, `F1`–`F5`) remain open or under observation (`8` macOS + `6`
Linux = `14` total intermittent job failures).

### 1. Deterministic regression, already fixed (1 run, 11 Linux job failures)

- Run `42280222468` (`955463d4`, 2026-11-06): `Node tests and lint`, both
  `Fixture preflight` cells and all eight `Interaction layout stability` shards
  failed together and were fixed 38 minutes later in `db7cf566`. Do not count
  these 11 job failures as flakiness.

### 2. Intermittent failures already fixed on `main` (8 job failures across 6 runs)

Do not re-open these unless they recur after their fix commits:

| Run / commit | Failed job(s) | Count | Failure | Fixed on `main` |
| --- | --- | --- | --- | --- |
| `42289313470` (`11af0170`) | `Firefox latest extension smoke` | 1 | `ElementNotInteractableError` clicking `.favorites-buddy-options summary` before settings unhid the panel | `f9e25d43` |
| `42294607406` (`f9e25d43`) | `Firefox 152.0 extension smoke` | 1 | `Firefox real bold input did not serialize synchronously` (read before final period landed) | `64b786aa` |
| `42537287786` (`946359e9`) | `Firefox 152.0` and `Firefox latest extension smoke` | 2 | `disclosure trigger stays anchored` when opening blocked-script source caused scrollbar reflow | `09a00068` |
| `42537287786` (`946359e9`) | `Scale tests` | 1 | `1,200-photo library` startup catalog transaction count (`expected: 2` before accounting for the resume-draft catalog read) | Updated in `test/scale/photos/photo-library.scale.mts` |
| `42586707374` (`1b0eb510`) | `Peak surface (chrome, interactions)` | 1 | `repeated keyboard and pointer activation does not duplicate work` (`expected: 37`, contaminated by lazy Cloud card requests) | `26d0dffb` |
| `42592481066` (`19ec89be`) | `Chrome copied-runtime GPU smoke` | 1 | `Map mode toggle moved or resized` (`top: 390` → `378` before native zoom clearance settled) | `a18f672b` |
| `42606608776` (`008f2985`) | `Firefox latest extension smoke` | 1 | `Firefox did not download the flattened topo under its title` (`bytes: 0` before write completion) | `5fc64590` |

### 3. Still open at `HEAD` (5 failure groups across 6 runs / 6 job failures)

| # | Run / ref | Failed job | Failure | Kind |
| --- | --- | --- | --- | --- |
| F1 | `43671220733` (Dependabot PR head `5b31a0ad`, 2026-11-15) | `Peak surface (firefox, cards)` | `network.provideResponse: no such request: Blocked request with id … not found` | Verifier BiDi lifecycle race |
| F2 | `42606608776` (`008f2985`, 2026-11-09) | `Peak surface (firefox, cards)` | `Timed out waiting for three ready cards (last value: false)` | Verifier readiness opacity + possible F1 fallout |
| F3 | `43673641996` (Dependabot PR head `8f3c4962`, 2026-11-15) | `Chrome current extension smoke` (in its packaged Firefox step) | `Timed out waiting for the opted-in Firefox Buddy removal policy (last value: false)` | Both product epoch race and verifier postcondition gaps |
| F4 | `42586707374` (`1b0eb510`, 2026-11-09) | `Chrome current extension smoke` | `light-1000-420-ignored-deep-link did not land` (`target.top: -2.28125`, `scrollBehavior: ""`, `verificationScrolling: "false"`) | Product hashchange/smooth-scroll alignment race |
| F5 | `42441998262` (Dependabot PR head `3ea18342`, 2026-11-08) and `42598239163` (`d8afeb39`, 2026-11-09) | `Chrome current extension smoke` | `draft did not Preview exactly once (Current state: 1)` (`F5a`) and `Full Screen peak map did not create the extension-owned terrain frame` (`F5b`) | Instrumented (`01babfb3`, `acc32703`); uncaptured root cause |

## Root causes and remediation phases

Each phase is an independent commit (or small commit pair when runtime and
verifier fixes stay separate). Follow the TypeScript policy whenever an authored
`.js` or `.mjs` file is substantively modified: convert that module to `.ts` or
`.mts` in the same focused commit and update callers, pins and `scripts/README.md`
together.

### Phase 1 — Firefox Buddy removal sync race (F3: product + verifier)

**Root cause:**
1. **Product FIFO epoch race in `src/favorites/climber-favorite.ts` (originally JS) and `src/favorites/buddy-cache.js` (lines 29–35):**
   `refreshAfterBuddyMutation` is not serialized. In each call,
   `beginBuddyCacheRead` (`line 267`) captures `snapshot = E1` before fetching
   `BuddyList`, and `publishBuddyCache` (`line 289`) runs **before**
   `mutateFavorites` (`lines 290–302`), enforcing compare-and-swap on
   `bpbBuddyCacheEpoch`. (If Remove resolved *before* Add, Remove would advance
   `E1 -> E2` and Add's `publishBuddyCache` would throw `buddy-cache-stale`
   before reaching `mutateFavorites`, so out-of-order completion is *not* what
   breaks F3.) What actually breaks F3 is **normal in-order (FIFO) overlap**:
   when Remove starts while Add's `BuddyList` fetch is still in flight, both
   calls read `snapshot = E1`; Add finishes *first*, publishes `[900002]` and
   advances `bpbBuddyCacheEpoch` to `E2`; **Remove finishes *second*** with
   stale `snapshot = E1`, throws `buddy-cache-stale` at `publishBuddyCache`
   (`line 289`), lands in `catch {}` (`line 304`), and **skips
   `mutateFavorites({ kind: 'remove', cid: pageCid })` (`line 301`)**, leaving
   `"★"` stuck.
2. **Two unawaited refresh steps in `scripts/verify-firefox-extension.mts`:**
   - **Click 2 (`lines 1329–1342`, default removal before navigating to `favoritesUrl`):**
     Unlike Chrome (`scripts/verify-extension.mts` lines 2031–2044, which keeps
     `climberPage` open in a separate tab and awaits `buddyReports >= 2` plus
     `bpbBuddyCache` clearing `900002`), Firefox uses one tab: `lines 1330–1334`
     wait only for `Add` button text and `"★"` (already `"★"`!) and immediately
     call `driver.get(favoritesUrl)` at `line 1342`, unloading
     `climber-favorite.js` after `bpbPendingBuddyMutation` in `sessionStorage`
     was already cleared (`climber-favorite.js` line 237) and aborting
     `buddyReports` #2.
   - **Click 3 (`lines 1362–1367`, re-add before opted-in removal):**
     Climber `900002` is already `"★"` from `line 1333`. `lines 1363–1366` wait
     only for `Remove` button text and `"★"` — already true before
     `refreshAfterBuddyMutation({ action: 'add' })` finishes fetching `BuddyList`
     — and immediately click `BuddyButton` to remove at `line 1367`, triggering
     the FIFO `buddy-cache-stale` overlap above. Chrome (`scripts/verify-extension.mts`
     lines 2066–2078) explicitly waits for `bpbBuddyCache` membership and
     `buddyReports >= 3` before clicking Remove.

**Fix:**
- Convert `src/favorites/climber-favorite.ts` from `.js` and serialize
  `refreshAfterBuddyMutation` (coalescing to the latest queued mutation so a
  subsequent Remove runs `beginBuddyCacheRead` *after* the preceding refresh
  settles, or supersedes an older unconfirmed refresh before it publishes).
  Update `scripts/build-config.mts`, `test/project/manifest-capture.test.mts`
  (line 416), `test/settings/settings-read-policy.test.mts` (line 25) and
  `docs/architecture.md` (lines 179, 1288, 1615).
- Add a focused unit test in `test/` that starts Add while holding its
  `BuddyList` fetch open, triggers Remove while Add is still in flight, resolves
  **Add first and Remove second** (FIFO), proves the regression test fails
  against unfixed logic (`buddy-cache-stale` skips removal), and passes with
  serialized refresh (`"☆"`, `entries` excludes `900002`).
- Update `scripts/verify-firefox-extension.mts` at **both** steps:
  - After Click 2 (`lines 1330–1341`, before `driver.get(favoritesUrl)`): await
    `buddyMutations >= 2`, `buddyReports >= 2` and `bpbBuddyCache` excluding
    `900002`.
  - After Click 3 (`lines 1363–1367`, before clicking Remove): await
    `buddyMutations >= 3`, `buddyReports >= 3` and `bpbBuddyCache` containing
    `900002`.

**Verification:** `npm test`, `npm run typecheck`, `npm run lint`,
`npm run check:typescript-policy`, and repeated runs via
`BPB_VERIFY_REPETITIONS=3 node scripts/verification-repetitions.mjs firefox` and
`BPB_VERIFY_REPETITIONS=3 node scripts/verification-repetitions.mjs chrome`.

### Phase 2 — Settings `#ignored-github` fragment alignment (F4: product + diagnostics)

**Root cause:**
- The failure log proves this was **not** a slow runner: at failure time,
  `scrollBehavior` was `""`, `verificationScrolling` was `"false"`,
  `current` was `"#github-favorites-backup"`, `scrollTop` was `7231` (of `7738`),
  and `#ignored-github` had settled statically at `target.top = -2.28125`
  (`26.28px` above its `24px` `scroll-margin-top`, failing line 301 of
  `scripts/verify-settings-navigation.mts`: `target.top >= pane.top - 1`).
  Bumping the 5-second timeout would wait longer and still fail.
- Clicking a `.side-nav` link calls `prepareAnchorScroll` (`src/ui/section-nav.ts`
  before conversion) *before* the browser processes the anchor jump. By contrast,
  programmatic or URL-bar hash navigation (`navigate('#ignored-github')` at
  `scripts/verify-settings-navigation.mts` line 295) triggers Chromium's native
  fragment scroll while `.content` still has CSS `scroll-behavior: smooth`, and
  only afterward fires `window`'s `hashchange` listener (`src/ui/section-nav.ts`).
  At `1000x420`, `smoothLimit` drops to `840px` (`2 * 420`), and
  programmatic `content.scrollTop += delta` can race an in-flight compositor
  smooth scroll or asynchronous status-height change above `#ignored-github`.

**Fix:**
- Convert `src/ui/section-nav.ts` from `.js`, updating
  `scripts/build-config.mts` (lines 128, 135 for `options/options.js` and
  `photos/guide.js`), `options/options.js` (line 17), `photos/guide.js` (line 11),
  `test/photos/photo-guide.test.mjs` (line 26), `scripts/verify-garmin-ui.mts`
  (line 15) and `docs/architecture.md` (lines 180, 260).
- Update `section-nav`'s `hashchange` handler (`lines 197–210`) so nested-pane
  reconciliation cancels any in-flight smooth fragment scroll deterministically
  (`scrollBehavior = 'auto'` across the explicit `scrollTop` assignment when
  reconciling a browser-initiated hash change, or re-aligns on the
  post-hashchange frame if native fragment scrolling touched `.content`), while
  preserving smooth scrolling for nearby sidebar clicks.
- In `scripts/verify-settings-navigation.mts`, include `scrollHeight` and
  `targetMarginTop` in `readFrame` so if an asynchronous card above
  `#ignored-github` changes height after navigation, the failure payload names
  the layout shift directly.
- Add a regression case in the real-browser DOM tier (`test/dom/`) covering
  direct URL-hash jumps across `1000x420` after a distant section.

**Verification:** `npm test`, `npm run verify -- dom`, `npm run verify -- settings-navigation`
(which runs `scripts/verify-settings-fragments.mts`), and
`BPB_VERIFY_REPETITIONS=3 node scripts/verification-repetitions.mjs chrome` plus
`npm run verify -- firefox` (note: `scripts/verify-settings-navigation.mts` at
`1000x420` runs inside `scripts/verify-extension.mts` and
`scripts/verify-firefox-extension.mts`, not under the `settings-navigation`
target, and `BPB_VERIFY_REPETITIONS` is read by
`scripts/verification-repetitions.mjs` and `scripts/verify-packaged-extensions.mts`),
plus `npm run typecheck` and `npm run lint`.

### Phase 3 — Firefox WebDriver BiDi intercept lifecycle and card-readiness diagnostics (F1 + F2)

**Root cause:**
1. **F1 (`scripts/verify-ascent-weather.mts`, lines 215–230):** In Firefox mode,
   every intercepted `network.beforeRequestSent` spawns an async IIFE that awaits
   `held` (in loading modes) and then sends `network.provideResponse`, pushing
   any thrown message into `networkErrors`. Two legitimate browser actions
   invalidate a blocked BiDi request ID before `network.provideResponse` lands:
   - **Cross-navigation invalidation:** `scripts/verify-peak-cards.mts` calls
     `open()` repeatedly across modes while an earlier blocked request is still
     settling.
   - **In-page `AbortController` cancellation:** In `weather-read-gate`
     (`scripts/verify-peak-cards.mts`), the verifier holds
     `.bpb-week-refresh` in `loading` mode, clicks `#bpb-peak-weather .bpb-peak-card-toggle`
     to collapse the card **within the same page without navigating** (which
     calls `reads.cancel()` → `AbortController.abort()` in
     `src/weather/peak-weather.js`), and then calls `release()`. Whenever Gecko
     processes that channel abort before `release()` sends
     `network.provideResponse`, Firefox rejects `network.provideResponse` with
     `no such request: Blocked request with id … not found` **in the active
     navigation epoch**.
2. **F2 (`scripts/verify-peak-cards.mts`):** `ready()` polls a
   five-clause boolean (`3 cards`, sun toggle enabled, weather collapsed or 16
   `.bpb-week-day` nodes, `#bpb-peak-weather[aria-busy="false"]`,
   `.bpb-snow-status` containing `'Hourly readings'`). Because the callback
   returns a bare boolean, timeouts report only
   `Timed out waiting for three ready cards (last value: false)` — hiding which
   card stalled.

**Fix:**
- In `scripts/verify-ascent-weather.mts`, track **both** a navigation epoch
  around `navigate` **and** per-request browser cancellations via BiDi
  `network.fetchError` (`bidi.subscribe('network.fetchError')`, recording request
  IDs aborted by the browser). Ignore `no such request` from
  `network.provideResponse` **only** when the request belonged to a superseded
  navigation epoch or its request ID was already observed in `network.fetchError`.
  Any `no such request` for an active-epoch, non-aborted request ID (or any
  other BiDi error) must still push to `networkErrors` so broken intercept IDs
  are never masked.
- Convert `scripts/verify-peak-cards.mts` from `.mjs` (updating
  `scripts/README.md` and imports in `scripts/verify-ascent-weather.mts`) and
  change `ready()` to return a structured per-card state object checked via
  `isReady`, matching `waitForBuddyAdditionReady` in
  `scripts/verify-firefox-extension.mts` (lines 1280–1292). Keep every assertion
  and deadline identical.
- Add a focused unit test in `test/project/` covering the BiDi error filter:
  superseded-epoch `no such request` is ignored, `network.fetchError`-aborted
  in-page `no such request` is ignored, active non-aborted `no such request`
  still fails, and non-cancellation BiDi errors always fail.

**Verification:** `npm test`, `npm run typecheck`, `npm run lint`, and three
consecutive local runs each of
`node scripts/verify-ascent-weather.mts --cards --firefox` and
`node scripts/verify-ascent-weather.mts --cards`.

### Phase 4 — Structural isolation of the packaged Firefox gate inside `jobs.chrome`

**Problem:**
- In `.github/workflows/test.yml`, `jobs.chrome` (`Chrome current extension smoke`)
  invokes `.github/actions/verify-package`, which runs `scripts/verify-store-packages.mjs` —
  executing **both** packaged Chrome (`verify-extension.mts`) and packaged
  Firefox (`verify-firefox-extension.mts`) sequentially before four capture
  verifiers (`10.8` minutes total, the single critical path of the workflow).
- Consequently, F3 (a Firefox-only Buddy race) failed `Chrome current extension smoke`
  while all Firefox jobs were green.

**Options (owner decision, coordinate with [CI: Linux by default, macOS only for hardware WebGL](https://github.com/wilmtang/better-peakbagger/blob/86c975a09f884e3726a726e05dc248048f589240/docs/plans/ci-macos-gpu-only.md)):**
- **Option A (keep together, rely on Phase 1–3 fixes):** Keep
  `verify-store-packages.mjs` atomic so one job builds and tests the exact
  paired store zips. Zero workflow churn.
- **Option B (split packaged browser execution after archive creation):** Build
  and hash-verify both store zips once, upload the candidate artifact, and run
  packaged Chrome and packaged Firefox in parallel jobs (`jobs.chrome` now
  already runs on `ubuntu-24.04`, so both jobs run on Linux). Cuts critical-path
  wall time by ~3–4 minutes and attributes Firefox package failures to Firefox,
  at the cost of updating `test/project/verification-setup.test.mts`,
  `test/project/release.test.mts` and `scripts/release-evidence.mts` if
  job/step contracts change.

### Phase 5 — Instrumented watch items and standalone verifier debt

- **Monitor F5 (`verify-capture-flow.mts` Preview timeout and Full Screen peak
  map terrain frame):** Both received targeted instrumentation/observers on
  2026-11-08/09 (`01babfb3`, `acc32703`) and have not recurred in the runs
  since. Do not guess a second patch without a post-`01babfb3`/`acc32703`
  failure log.
- **Standalone verifiers outside PR CI (separate scope):**
  [codebase-reduction-2026-11-13.md](codebase-reduction-2026-11-13.md) records
  ten standalone verifier invocations that already failed at its baseline
  (`inline-buddies` in both browsers, `ascent-weather --peak` in both browsers,
  `climber-list-ui`, `custom-layer-settings` in both browsers,
  `peak-link-order --firefox`, `photo-library-status`, and intermittent
  `custom-overlays --firefox`). None of those run in `.github/workflows/test.yml`,
  so they are not causing PR CI churn, but they must not be forgotten when
  touching those surfaces; track them as a separate follow-up after Phases 1–3.

## Non-goals and guardrails

- **No workflow-level retries** (`nick-fields/retry`, loop wrappers or Playwright
  `retries: 2`). `AGENTS.md` is explicit: *"Treat a check that passes on re-run
  as a bug in the check, not as noise."*
- **No loosened geometry or timing tolerances** (`target.top >= pane.top - 1`
  stays `-1`; `networkErrors` stays `[]` for active non-aborted requests).
- **Preserve required check names** (`Chrome extension smoke`,
  `Firefox extension smoke`).

## Closure ledger

- **Fixed and verified:**
  - `F3` (`2effc2b7`): serialized `refreshAfterBuddyMutation` on `buddyRefreshQueue` in `src/favorites/climber-favorite.ts`, added FIFO overlapping Add+Remove regression coverage in `test/favorites/climber-favorite.test.mts`, and awaited `waitForBuddyRequests` + `waitForBuddyStorage` in `scripts/verify-firefox-extension.mts`. Verified via `npm run verify -- firefox` (Firefox 160.0) and hosted PR #77 `Test` run `44258780970`.
  - `F4` (`bfb83e1b`): converted `src/ui/section-nav.ts`, cleared `pendingLinkClick` on `hashchange` with a 1000ms TTL, forced synchronous `scrollBehavior = 'auto'` + post-frame `alignPaneToSection` alignment on non-click `hashchange`, added `scrollHeight`/`targetMarginTop` failure diagnostics in `scripts/verify-settings-navigation.mts`, and added `1000x420` `#ignored-github` regression coverage in `test/dom/options-scroll-spy.dom.mts`. Verified via `npm run verify -- dom` (10/10), `npm run verify -- settings-navigation`, `npm run verify -- chrome`, and hosted PR #77 `Test` run `44258780970`.
  - `F1` & `F2` (`f95a4c63`): added `createBidiRequestLifecycle` in `scripts/verify-ascent-weather.mts` with `navigationEpoch` and `network.fetchError` scoping, converted `scripts/verify-peak-cards.mts` with structured per-card readiness diagnostics, and added `test/project/weather-bidi-lifecycle.test.mts`. Verified via `node scripts/verify-ascent-weather.mts --cards --firefox`, `node scripts/verify-ascent-weather.mts --cards`, and hosted PR #77 `Test` run `44258780970`.
- **Intentionally not changed:**
  - The 8 already-fixed intermittent job failures from 2026-11-06..09 and the deterministic regression `955463d4`.
  - Phase 4 kept Option A (single paired package gate in `.github/actions/verify-package` via `scripts/verify-store-packages.mjs`).
  - No speculative runtime edits were made to `F5` (`verify-capture-flow.mts` Preview timeout and Full Screen peak terrain frame) while `01babfb3`/`acc32703` instrumentation had no recurrences.
  - Standalone non-CI verifiers listed in [codebase-reduction-2026-11-13.md](codebase-reduction-2026-11-13.md) stay out of scope for this CI flakiness plan and remain tracked separately.
- **Changed but not fully proven:**
  - `F5` watch items (`verify-capture-flow.mts` Preview and Full Screen terrain) and existing single-pass cells such as `Peak surface (firefox, snow)` and macOS Metal GPU runs passed hosted PR #77 `Test` run `44258780970` (`35/35`), and remain passively watched on `main` via [the follow-up ledger](follow-ups.md).
