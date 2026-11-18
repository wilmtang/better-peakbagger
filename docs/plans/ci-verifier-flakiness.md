# CI verifier flakiness remediation

Status: proposed; root causes traced against `HEAD`, no verifier or runtime behavior changed yet.

Companion to [CI: Linux by default, macOS only for hardware WebGL](ci-macos-gpu-only.md).
Moving jobs off macOS reduces 5-slot runner queueing, not intermittent test
failures. This plan addresses the intermittent failures themselves without
loosening assertions, hiding errors or adding blind retries.

## Baseline audit of the last 40 `Test` runs

Window: 40 completed/cancelled runs of `.github/workflows/test.yml` through
2026-11-15 (`42280222468` to `43674957819`). Eleven runs failed. Tracing each
failed job against `git log` separates real open flakiness from issues already
remediated on `main`:

### 1. Deterministic regression, already fixed (1 run, 11 Linux jobs)

- Run `42280222468` (`955463d4`, 2026-11-06): `Node tests and lint`, both
  `Fixture preflight` cells and all eight `Interaction layout stability` shards
  failed together and were fixed 38 minutes later in `db7cf566`. Do not count
  these 11 job failures as flakiness.

### 2. Intermittent failures already fixed on `main` (6 runs, 7 job failures)

Do not re-open these unless they recur after their fix commits:

| Run / commit | Failed job | Failure | Fixed on `main` |
| --- | --- | --- | --- |
| `42289313470` (`11af0170`) | `Firefox latest extension smoke` | `ElementNotInteractableError` clicking `.favorites-buddy-options summary` before settings unhid the panel | `f9e25d43` |
| `42294607406` (`f9e25d43`) | `Firefox 152.0 extension smoke` | `Firefox real bold input did not serialize synchronously` (read before final period landed) | `64b786aa` |
| `42537287786` (`946359e9`) | `Firefox 152.0` and `Firefox latest extension smoke` | `disclosure trigger stays anchored` when opening blocked-script source caused scrollbar reflow | `09a00068` |
| `42537287786` (`946359e9`) | `Scale tests` | `1,200-photo library` startup catalog transaction count (`expected: 2` before accounting for the resume-draft catalog read) | Updated in `test/scale/photos/photo-library.scale.mts` |
| `42586707374` (`1b0eb510`) | `Peak surface (chrome, interactions)` | `repeated keyboard and pointer activation does not duplicate work` (`expected: 37`, contaminated by lazy Cloud card requests) | `26d0dffb` |
| `42592481066` (`19ec89be`) | `Chrome copied-runtime GPU smoke` | `Map mode toggle moved or resized` (`top: 390` → `378` before native zoom clearance settled) | `a18f672b` |
| `42606608776` (`008f2985`) | `Firefox latest extension smoke` | `Firefox did not download the flattened topo under its title` (`bytes: 0` before write completion) | `5fc64590` |

### 3. Still open at `HEAD` (5 failure modes across 5 runs)

| # | Run / commit | Failed job | Failure | Kind |
| --- | --- | --- | --- | --- |
| F1 | `43671220733` (`5b31a0ad`, 2026-11-15) | `Peak surface (firefox, cards)` | `network.provideResponse: no such request: Blocked request with id … not found` | Verifier BiDi lifecycle race |
| F2 | `42606608776` (`008f2985`, 2026-11-09) | `Peak surface (firefox, cards)` | `Timed out waiting for three ready cards (last value: false)` | Verifier readiness opacity + possible F1 fallout |
| F3 | `43673641996` (`8f3c4962`, 2026-11-15) | `Chrome current extension smoke` (in its packaged Firefox step) | `Timed out waiting for the opted-in Firefox Buddy removal policy (last value: false)` | Both product race and verifier postcondition gap |
| F4 | `42586707374` (`1b0eb510`, 2026-11-09) | `Chrome current extension smoke` | `light-1000-420-ignored-deep-link did not land` (`target.top: -2.28125`, `scrollBehavior: ""`, `verificationScrolling: "false"`) | Product hashchange/smooth-scroll alignment race |
| F5 | `42441998262` (`3ea18342`, 2026-11-08) and `42598239163` (`d8afeb39`, 2026-11-09) | `Chrome current extension smoke` | `draft did not Preview exactly once (Current state: 1)` and `Full Screen peak map did not create the extension-owned terrain frame` | Instrumented (`01babfb3`, `acc32703`); uncaptured root cause |

## Root causes and remediation phases

Each phase is an independent commit (or small commit pair when runtime and
verifier fixes stay separate). Follow the TypeScript policy whenever an authored
`.js` or `.mjs` file is substantively modified: convert that module to `.ts` or
`.mts` in the same focused commit and update callers and `scripts/README.md`
together.

### Phase 1 — Firefox Buddy removal sync race (F3: product + verifier)

**Root cause:**
1. **Product race in `src/favorites/climber-favorite.js` (`lines 264-305`):**
   `refreshAfterBuddyMutation` has no monotonic mutation generation guard or
   serialization. When a user (or verifier) clicks `BuddyButton` to add a
   climber and then clicks `BuddyButton` to remove them before the first
   `BuddyList` confirmation fetch finishes, both `refreshAfterBuddyMutation`
   calls run concurrently. If Remove's confirmation resolves first (setting
   `"☆"`) and Add's stale confirmation resolves second, Add calls
   `mutateFavorites({ kind: 'add' })` and overwrites the removal back to `"★"`.
2. **Verifier postcondition gap in `scripts/verify-firefox-extension.mts` (`lines 1362-1367`):**
   Climber `900002` is already `"★"` from the preceding default-removal check
   (`line 1333`). After clicking `BuddyButton` to re-add (`line 1362`),
   `lines 1363-1366` wait only for `Remove` button text and `"★"` — both of
   which are true before `refreshAfterBuddyMutation({ action: 'add' })` finishes
   fetching `BuddyList` and updating `bpbBuddyCache`. By contrast, Chrome's twin
   check in `scripts/verify-extension.mts` (`lines 2066-2078`) explicitly waits
   for `bpbBuddyCache` membership and `buddyReports >= 3` before clicking
   Remove.

**Fix:**
- Convert `src/favorites/climber-favorite.js` to TypeScript (`.ts`) and guard
  `refreshAfterBuddyMutation` with a monotonically increasing mutation revision
  so a superseded in-flight confirmation never publishes stale cache state or
  mutates custom favorites after a newer Buddy action starts. Update its entry
  in `scripts/build-config.mts` and any source-list pins.
- Add a focused unit test in `test/` that holds the first `BuddyList` fetch open
  across an Add → Remove sequence, resolves Add after Remove, and proves the
  opted-in removal stays `"☆"` (`entries` excludes the climber).
- Update `scripts/verify-firefox-extension.mts` (`lines 1363-1367`) to match
  Chrome's contract: await `fixture.requests.buddyMutations - buddyMutationBaseline.buddyMutations >= 3`,
  `fixture.requests.buddyReports - buddyMutationBaseline.buddyReports >= 3` and
  `bpbBuddyCache` containing `900002` before clicking `BuddyButton` to remove.

**Verification:** `npm test`, `npm run typecheck`, `npm run lint`,
`npm run check:typescript-policy`, and repeated local hidden runs of
`npm run verify -- firefox` and `npm run verify -- chrome`.

### Phase 2 — Settings `#ignored-github` fragment alignment (F4: product + diagnostics)

**Root cause:**
- The failure log proves this was **not** a slow runner: at failure time,
  `scrollBehavior` was `""`, `verificationScrolling` was `"false"`,
  `current` was `"#github-favorites-backup"`, `scrollTop` was `7231` (of `7738`),
  and `#ignored-github` had settled statically at `target.top = -2.28125`
  (`26.28px` above its `24px` `scroll-margin-top`, failing line 301 of
  `scripts/verify-settings-navigation.mts`: `target.top >= pane.top - 1`).
  Bumping the 5-second timeout would wait longer and still fail.
- Clicking a `.side-nav` link calls `prepareAnchorScroll` (`src/ui/section-nav.js`
  line 193)
  *before* the browser processes the anchor jump. By contrast, programmatic or
  URL-bar hash navigation (`navigate('#ignored-github')` at
  `scripts/verify-settings-navigation.mts` line 295) triggers Chromium's native
  fragment scroll while `.content` still has CSS `scroll-behavior: smooth`, and
  only afterward fires `window`'s `hashchange` listener (`src/ui/section-nav.js`
  lines 197–210).
  At `1000x420`, `smoothLimit` drops to `840px` (`2 * 420`), and programmatic
  `content.scrollTop += delta` can race an in-flight compositor smooth scroll or
  asynchronous status-height change above `#ignored-github`.

**Fix:**
- Convert `src/ui/section-nav.js` to TypeScript (`.ts`) and update its
  `hashchange` handler (`lines 197-210`) so nested-pane reconciliation cancels
  any in-flight smooth fragment scroll deterministically (`scrollBehavior = 'auto'`
  across the explicit `scrollTop` assignment when reconciling a browser-initiated
  hash change, or re-aligns on the post-hashchange frame if native fragment
  scrolling touched `.content`), while preserving smooth scrolling for nearby
  sidebar clicks.
- In `scripts/verify-settings-navigation.mts`, include `scrollHeight` and
  `targetMarginTop` in `readFrame` so if an asynchronous card above
  `#ignored-github` changes height after navigation, the failure payload names
  the layout shift directly.
- Add a regression case in the real-browser DOM tier (`test/dom/`) or existing
  section-nav tests covering direct URL-hash jumps across `1000x420` after a
  distant section.

**Verification:** `npm test`, `npm run verify -- dom`, `npm run verify -- settings-navigation`
(with `BPB_VERIFY_REPETITIONS=3`), `npm run typecheck`, `npm run lint`.

### Phase 3 — Firefox WebDriver BiDi intercept lifecycle and card-readiness diagnostics (F1 + F2)

**Root cause:**
1. **F1 (`scripts/verify-ascent-weather.mts`, lines 215–230):** In Firefox mode, every
   intercepted `network.beforeRequestSent` spawns an async IIFE that awaits
   `held` (in loading modes) and then sends `network.provideResponse`, pushing
   any thrown message into `networkErrors`. When `verify-peak-cards.mjs`
   navigates to a new URL (`open()` runs repeatedly across modes) or an
   `AbortController` cancels an older request while it is still blocked in BiDi,
   Firefox invalidates the blocked request ID and rejects `network.provideResponse`
   with `no such request: Blocked request with id … not found`. Chrome's
   `context.route` path (`lines 386-393`) does not record post-navigation route
   cancellation into `networkErrors` unless an unhandled exception escapes.
2. **F2 (`scripts/verify-peak-cards.mjs`, lines 44–49):** `ready()` polls a five-clause
   boolean (`3 cards`, sun toggle enabled, weather collapsed or 16 `.bpb-week-day`
   nodes, `#bpb-peak-weather[aria-busy="false"]`, `.bpb-snow-status` containing
   `'Hourly readings'`). Because the callback returns a bare boolean, timeouts
   report only `Timed out waiting for three ready cards (last value: false)` —
   hiding which card stalled.

**Fix:**
- Track a navigation/context epoch in `scripts/verify-ascent-weather.mts`
  around `navigate`: drain or mark pre-navigation blocked BiDi requests stale
  before `driver.get(url)`, and ignore `no such request` from `network.provideResponse`
  **only** when that request belonged to a superseded navigation epoch or was
  explicitly aborted by navigation. Unexpected `no such request` errors within
  the active page epoch must still fail `networkErrors` so broken intercept IDs
  are never masked.
- Convert `scripts/verify-peak-cards.mjs` to TypeScript (`.mts`, updating
  `scripts/README.md` and imports in `scripts/verify-ascent-weather.mts`) and
  change `ready()` to return a structured per-card state object checked via
  `isReady`, matching `waitForBuddyAdditionReady` in
  `scripts/verify-firefox-extension.mts` (lines 1280–1292). Keep every assertion and
  deadline identical.
- Add a focused unit test in `test/project/` covering the BiDi epoch filter (active-epoch
  `no such request` still fails; superseded-navigation `no such request` is
  ignored; non-cancellation BiDi errors always fail).

**Verification:** `npm test`, `npm run typecheck`, `npm run lint`, and repeated
local runs of `node scripts/verify-ascent-weather.mts --cards --firefox` and
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

**Options (owner decision, coordinate with [ci-macos-gpu-only.md](ci-macos-gpu-only.md)):**
- **Option A (keep together, clarify failure step):** Keep `verify-store-packages.mjs`
  atomic so one job produces and tests the exact paired store zips, and rely on
  Phase 1–3 fixes to remove the underlying flake. Zero workflow churn.
- **Option B (split packaged browser execution after archive creation):** Build
  and hash-verify both store zips once, upload the candidate artifact, and run
  packaged Chrome and packaged Firefox in parallel jobs (moving packaged Firefox
  to `ubuntu-24.04` immediately since Firefox does not hit the Linux Chrome
  extension-loading blocker). Cuts critical-path wall time by ~3–4 minutes and
  attributes Firefox package failures to Firefox, at the cost of updating
  `test/project/verification-setup.test.mts`, `test/project/release.test.mts`
  and `scripts/release-evidence.mts` if job/step contracts change.

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
  stays `-1`; `networkErrors` stays `[]` for active-page requests).
- **Preserve required check names** (`Chrome extension smoke`,
  `Firefox extension smoke`).

## Closure ledger

- Fixed and verified: none yet (plan only).
- Intentionally not changed: the 7 already-fixed intermittent failures from
  2026-11-06..09 and the `955463d4` deterministic regression; F5 awaits post-instrumentation
  evidence rather than speculative edits.
- Changed but not fully proven: none yet.
