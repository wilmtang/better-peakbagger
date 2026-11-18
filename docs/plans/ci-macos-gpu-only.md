# CI: Linux by default, macOS only for hardware WebGL

Status: implemented and verified on hosted GitHub Actions (2026-11-17..18); backup layout (2 cells) and hardware WebGL jobs remain on macOS by design.

## Goal

Run every CI check that does not need a GPU on standard Linux runners. Keep
macOS only for the jobs that need hardware WebGL, because a public repository
on a personal account has no free Linux GPU runner. GitHub GPU runners need a
Team or Enterprise organization and are billed per minute.

Do not drop or weaken any check to get there. A job moves only after it passes
on Linux. If it cannot pass, the owner decides whether it stays on macOS.

## Why each job is on macOS today

`.github/workflows/test.yml` runs 13 macOS cells on every pull request, plus 2
more when the copied runtime changes. `release.yml` adds 2 on `workflow_dispatch`.

| Job | Cells | Runner | Why it is on macOS | Blocker for Linux |
|---|---|---|---|---|
| `chrome` (current Chrome smoke, packages) | 1 | `macos-15-intel` | Chrome for Testing 151 ignored `--load-extension` on hosted Linux, in both new headless and Xvfb (`8248a30a`) | Chrome extension loading |
| `peak-surfaces` Chrome | 4 | `macos-15-intel` | Loads the real `dist/` in current Chrome for Testing (`verify-ascent-weather.mts`) | Chrome extension loading |
| `peak-surfaces` Firefox | 4 | `macos-15-intel` | Nothing recorded. It was grouped with the Chrome cells | None known |
| `backup-layout` | 2 | `macos-15-intel` | Uses native font metrics. Linux fallback fonts shift widths by 1.2–1.6px ([follow-ups](follow-ups.md)) | Product width defects |
| `snow-map` | 2 | `macos-15` | Needs hardware WebGL | No free Linux GPU |
| `chrome-terrain`, `firefox-terrain` | 2, conditional | `macos-15` | Needs hardware WebGL | No free Linux GPU |
| `release.yml` current Chrome | 1 | `macos-15-intel` | Same as `chrome` | Chrome extension loading |
| `release.yml` current Firefox | 1 | `macos-15-intel` | Grouped in the `compatibility` matrix (`chrome: none`, runs `--browser firefox`) | None known |

### Baseline: where failures actually happen

Of the last 40 `Test` runs, 11 failed:

- One run (`955463d4`) was a deterministic regression across 11 Linux jobs
  (`Node tests and lint`, both `Fixture preflight` cells and all 8 `layout`
  shards), fixed 38 minutes later in `db7cf566`.
- Across the remaining 10 intermittent runs (excluding the two aggregate jobs):
  - macOS: current Chrome smoke ×4, Firefox cards surface ×2, Chrome
    interactions surface ×1, Chrome GPU ×1 (`8` job failures).
  - Linux: Firefox smoke ×5, scale ×1 (`6` job failures).

Four of those ten intermittent runs are completely fixed on `main`, two runs
were mixed (one fixed failure and one open failure each — `8` fixed job failures
total), and six runs contain the five failure groups (`6` job failures) still
open or under observation at `HEAD`. See the companion
[CI verifier flakiness remediation](ci-verifier-flakiness.md) plan.

## Research findings (2026-11-16..17)

### None of the macOS failures were caused by macOS

I read the failed-step logs of all 8 macOS failures. Every one was a timing
race or a test/product interaction bug that would follow the job to any runner:

| Job | Failure |
|---|---|
| Current Chrome smoke | `deep-link did not land`: `#ignored-github` settled at `top: -2.28px` |
| Current Chrome smoke | `draft did not Preview exactly once`: state stuck at 1 |
| Current Chrome smoke | Full Screen peak map did not create the terrain frame |
| Current Chrome smoke | Failed in its **Firefox** package step (Buddy removal policy timeout). This job also runs packaged Firefox |
| Firefox cards ×2 | `Timed out waiting for three ready cards`; a WebDriver BiDi cancellation race (`network.provideResponse: no such request`) |
| Chrome interactions | `repeated keyboard and pointer activation does not duplicate work`: count mismatch (fixed in `26d0dffb`) |
| Chrome GPU | `Map mode toggle moved or resized` by 12px: a layout check, not a GPU problem (fixed in `a18f672b`) |

The Linux failures are the same kind: Firefox `ElementNotInteractableError`,
bold serialization, a 0-byte topo download, and disclosure anchoring. **The
maintenance cost is flaky verifiers, not macOS.** Moving jobs off macOS reduces
runner queueing, not flakiness; flakiness is addressed in
[ci-verifier-flakiness.md](ci-verifier-flakiness.md).

### macOS is also a throughput limit

The GitHub Free plan allows 20 concurrent jobs, of which at most 5 can be macOS
(GitHub usage-limits docs, via web search). Each PR queues 13+ macOS cells
behind 5 slots, which is why `peak-surfaces` has `max-parallel: 4`. In the last
green run (2026-11-15, 11 minutes wall time), the critical path was the macOS
current-Chrome smoke at 10.8 minutes. The Linux Chrome 128 smoke took 4.3
minutes, but it runs fewer steps (no package and capture-flow verifiers), so
this does not prove Linux would be faster.

### What actually failed on Linux in August

On 2026-08-22, about 20 consecutive runs failed over two hours before
`8248a30a` moved current Chrome to macOS. Logs are still available until about
2026-11-20:

- Current Chrome for Testing 151 on `ubuntu-latest` failed at the first check:
  `chrome://extensions-internals/` never listed a `COMMAND_LINE` "Better
  Peakbagger" record within 15s (`verify-extension.mjs:139`, run 32560178145).
  An earlier attempt timed out with the analyzer never appearing, which also
  suggests the extension was not loaded.
- In the same runs, the Linux **Chrome 128** floor loaded the extension and
  failed later on unrelated checks (helper lease, backup surface, Buddy import).

So the evidence supports "current Chrome for Testing did not register the
command-line extension on hosted Linux". But it covers one version (151) and one
detection method (and note `chrome://extensions-internals/` is static
`text/plain`, so `waitForFunction` without reloading only sampled startup state
once). macOS now runs `156.0.8078.4`, so it may no longer reproduce.

### A sanctioned alternative to `--load-extension`

Inspecting `playwright-core` 1.64.1 revealed two relevant implementation facts:

1. Playwright's default `chromiumSwitches()` always passes `--disable-extensions`
   unless `ignoreDefaultArgs` includes `'--disable-extensions'`, and Playwright
   already launches persistent Chromium contexts over `--remote-debugging-pipe`.
2. Sending CDP `Extensions.loadUnpacked` over `browser.newBrowserCDPSession()`
   with `ignoreDefaultArgs: ['--disable-extensions']` and
   `--enable-unsafe-extension-debugging` loads `dist/` directly in Playwright
   without switching to Puppeteer. Verified locally on macOS arm64 in hidden
   Chrome for Testing `156.0.8078.4` (`1000x760`): `chrome://extensions-internals/`
   records `"location": "UNPACKED"` (rather than `"COMMAND_LINE"`), both
   `document_start` and `document_idle` content scripts inject on the HTTPS
   Peakbagger fixture, and the MV3 worker answers `CAPTURE_STATUS`.

If Linux adopts `cdp-load-unpacked` inside `scripts/verification-launch.mts`,
three caller contracts must be updated together:
- **Six `location === 'COMMAND_LINE'` readers** plus one test pin must accept
  `'UNPACKED'` (or consume an exported extension-ID helper from the launcher):
  `scripts/verify-extension.mts` (line 272, pinned by
  `test/project/resource-stack.test.mts` line 254),
  `scripts/verify-capture-popup.mts` (line 112),
  `scripts/verify-photo-editor.mts` (line 39),
  `scripts/verify-photo-library-status.mts` (line 75),
  `scripts/verify-photo-output.mts` (line 88) and
  `scripts/verify-popup-photo-entry.mts` (line 48).
- **`ignoreDefaultArgs` merging in `chromeLaunchOptions`**
  (`scripts/verification-launch.mts` lines 42–54): callers passing their own
  `ignoreDefaultArgs` (such as `scripts/verify-extension.mts` line 231 and
  `scripts/verify-ascent-weather.mts` line 379) currently overwrite defaults via
  `...options`; `chromeLaunchOptions` must merge `'--disable-extensions'` with
  caller `ignoreDefaultArgs`.
- **Keep CLI `--load-extension` for `chromeBinary` (Chrome 128 floor):** Chrome
  128 already loads CLI extensions on Linux and may predate
  `Extensions.loadUnpacked`.

Branded Chrome 137+ ignores `--load-extension`, but Chrome for Testing still
honours it, so branded-Chrome restrictions do not explain the August Linux
result.

`scripts/probe-chrome-extension-load.mts` and the manual workflow
`.github/workflows/probe-linux-chrome-extension.yml` (`workflow_dispatch` only,
covered by `test/project/chrome-extension-load-probe.test.mts`) are committed
locally so one hosted `ubuntu-24.04` dispatch tests `cli-default`,
`cli-ignore-disable-extensions` and `cdp-load-unpacked` (plus optional `Xvfb`)
in about a minute once pushed to `main` (GitHub requires a `workflow_dispatch`
file to exist on the default branch before it can be triggered).

## Plan

### Phase 1: Firefox peak surfaces and `release.yml` current Firefox to Linux (low risk)

- Split `peak-surfaces` in `.github/workflows/test.yml` into two jobs: Chrome
  stays on `macos-15-intel`, Firefox runs on `ubuntu-24.04`. Keep the matrix,
  environment, evidence upload and failure semantics. Add both jobs to
  `chrome-required`.
- Move the `firefox` `current` row in `.github/workflows/release.yml`
  (`lines 109–113`, `chrome: none`, runs `--browser firefox`) from
  `macos-15-intel` to `ubuntu-24.04`.
- Revisit the `max-parallel: 4` capacity comment for the Linux surface job.
- Update the workflow pins in `test/project/verification-setup.test.mts`,
  `test/project/release.test.mts` (line 562 pins the exact `setup-verification`
  count in `test.yml`), `test/project/browser-verification-evidence.test.mts`
  (lines 145–146 pin exact `Retain browser failure evidence` and
  `BPB_VERIFY_ARTIFACTS` counts in `test.yml`),
  `test/project/release-rehearsal.test.mts` (line 38 pins the `release.yml`
  `compatibility` matrix runners), and the surface wording in
  `docs/development.md`.
- Done when one hosted run passes all 4 Firefox surface cells on Linux (and a
  rehearsal or workflow check confirms the `release.yml` Firefox row), with no
  assertion changed.

### Phase 2: current Chrome extension loading on Linux (spike, may fail)

All Chrome cells except GPU depend on this, so time-box it.

- Once `.github/workflows/probe-linux-chrome-extension.yml` is on `main`,
  dispatch it (`mode=all`) on `ubuntu-24.04`: it installs current Chrome for
  Testing through `setup-verification`, runs
  `scripts/probe-chrome-extension-load.mts` across `cli-default`,
  `cli-ignore-disable-extensions` and `cdp-load-unpacked`, reloads
  `chrome://extensions-internals/` while polling, checks both `document_start`
  and `document_idle` content scripts plus the MV3 worker reply, and uploads
  the JSON report.
- If `cli-default` fails on Linux but `cli-ignore-disable-extensions` or
  `cdp-load-unpacked` passes, adopt the passing strategy in
  `scripts/verification-launch.mts` — including `ignoreDefaultArgs` merging,
  preserving CLI `--load-extension` when `chromeBinary` is set, and updating all
  six `location === 'COMMAND_LINE'` readers plus
  `test/project/resource-stack.test.mts` when using `Extensions.loadUnpacked`.
- Try `use_xvfb=true` in the same workflow only if all three headless modes
  fail. The August notes say Xvfb also failed on 151, so expect little from it.
- Exit criteria: `BPB_VERIFY_REPETITIONS=3 node scripts/verification-repetitions.mjs chrome`
  and three consecutive runs of each Chrome `verify-ascent-weather.mts` surface
  pass on Linux (`npm run verify -- chrome` and `verify-ascent-weather.mts` do
  not read `BPB_VERIFY_REPETITIONS` directly), with content-script injection and
  worker round-trip proven.
- If it passes: move `chrome`, the Chrome `peak-surfaces` cells and the
  `release.yml` current Chrome row to Linux. Update the pins in
  `test/project/verification-setup.test.mts`, `test/project/release.test.mts`
  and `test/project/release-rehearsal.test.mts`. Keep the Chrome 128 floor job
  unchanged. Remove `.github/workflows/probe-linux-chrome-extension.yml` (or
  retain only if still wanted for Chrome upgrades).
- If it fails, owner decision:
  - **A.** Keep the current-Chrome smoke and the Chrome surfaces on macOS
    (5 cells, plus 1 in `release.yml`).
  - **B.** Keep only the current-Chrome smoke on macOS, and move the Chrome
    surfaces to the Linux Chrome 128 floor if they pass there.
  - **C.** Run current-Chrome extension checks only in `release.yml`.

### Phase 3: backup layout (owner decision)

These are real width defects on Linux fonts, which Windows users may also hit.
Choose one:

- **A.** Fix the width defects as a separate product change, then move both
  cells to Linux.
- **B.** Keep the 2 macOS cells.
- **C.** Run them only at release.

### Phase 4: keep and label the GPU jobs

- Keep `snow-map`, `chrome-terrain` and `firefox-terrain` on `macos-15`
  unchanged. They already fail closed on software rendering.
- Change the workflow comments so they say macOS is kept only for hardware
  WebGL.
- Optional, owner choice: merge them into one GPU job per browser (updating
  `test/project/browser-verification-evidence.test.mts` counts and converting
  `test/project/dependabot-auto-merge.test.mjs` to `.mts`). This saves setup
  time but mixes evidence. Do not do it unless runner queueing is an actual
  problem.

### Phase 5: closeout

- Required check names (`Chrome extension smoke`, `Firefox extension smoke`)
  must not change.
- Update `docs/development.md`, the `follow-ups.md` entries for Linux backups
  and hosted CI, and the workflow comments.
- `test/project/dependabot-auto-merge.test.mjs` pins the terrain runners. If
  phase 4 changes it, convert it to `.mts` in the same commit (repository
  TypeScript policy).

## Expected result

| Outcome | macOS cells per PR (`test.yml`) | macOS cells in `release.yml` |
|---|---|---|
| Today | 13 (+2 conditional) | 2 |
| Phases 1–4, phase 2 passes, backups fixed | 2 (+2 conditional) | 0 |
| Phase 2 fails (option A), backups stay on macOS | 9 (+2 conditional) | 1 |
| Shipped (phases 1, 2 & 4; phase 3 option B: backups stay on macOS) | 4 (+2 conditional) | 0 |

## Execution outcome (2026-11-17..18)

Hosted verification ran on fast-forward test branch `ci/verify-linux-offload`
without altering `origin/main` or dropping any assertion:

- **Hosted probe run `44236927706` (uncovered root cause of August 2026 Linux
  failure):** GitHub's `ubuntu-24.04` runner image pre-sets
  `CHROME_BIN=/usr/bin/google-chrome` (branded Google Chrome Stable
  `157.0.8103.50`, which ignores `--load-extension`). That caused Chrome 151+
  extension tests on hosted Linux to silently launch branded Chrome instead of
  Playwright's Chrome for Testing build.
- **Hosted probe run `44237662003` (after `8c01e57e`):** Clearing `CHROME_BIN`
  and `FIREFOX_BIN` in `.github/actions/setup-verification/action.yml` whenever
  Playwright supplies the browser made `ubuntu-24.04` launch Chrome for Testing
  `156.0.8078.4`. All three loading modes (`cli-default`,
  `cli-ignore-disable-extensions`, and `cdp-load-unpacked`) passed in ~1.5–1.7s
  each with `document_start`, `document_idle`, and MV3 worker replies verified,
  so `scripts/verification-launch.mts` retained CLI `--load-extension` without
  needing `Extensions.loadUnpacked`.
- **Full `Test` run `44238155967`:** Proved packaged Chrome (`156.0.8078.4`)
  and Firefox (`160.0.1`) via `npm run release:verify-packages` (5m30s) and peak
  surfaces on `ubuntu-24.04`, while exposing two Linux-specific issues:
  `globalThis.chrome.action.openPopup()` in
  `scripts/verify-capture-popup.mts` (line 144) threw
  `Error: Could not find an active browser window.` under Ozone `--headless=new`
  (fixed in `72656840` by activating the control tab via
  `activateToolbarTarget` and triggering the toolbar popup via CDP
  `Extensions.triggerAction`, keeping `viewport: null` native sizing), and 6
  concurrent Linux jobs stalled (`exit code 124` at `305s`) against
  `us-east-2.ec2.archive.ubuntu.com` via Ubuntu 24.04 DEB822
  `/etc/apt/sources.list.d/ubuntu.sources` and `/etc/apt/apt-mirrors.txt`
  (fixed in `4b708f01` by rewriting `azure`, `*.ec2`, and `*.clouds` mirrors
  to `archive.ubuntu.com` across `apt-mirrors.txt`, `sources.list`, and
  `sources.list.d/ubuntu.sources`, plus explicit `Acquire` retry/timeout settings
  in `apt.conf.d/99-bpb-retry`).
- **Full `Test` run `44241028916` (green):** Passed **35 of 35 jobs** in ~9m22s
  (`Chrome current extension smoke` on `ubuntu-24.04` passed all five
  `verify-package` steps: `release:verify-packages`, `verify-capture-popup.mts`,
  `verify-capture-readiness.mts`, `verify-capture-flow.mts`, and
  `verify-multi-summit.mts`; all eight `Peak surface` cells, `Fixture
  preflight`, `Browser DOM tier`, `Scale tests`, and all eight `Interaction
  layout stability` shards passed on Linux; ten concurrent Linux jobs hit
  the throttled EC2 mirror with `exit 124`, failed over via `install-playwright-browser.sh`
  to `archive.ubuntu.com`, and succeeded).

## Risks

- Linux runners are not a single, stable font environment. Reference screenshots
  for moved surfaces must be regenerated or confirmed to be geometry-only, never
  loosened.
- Moving a flaky job to Linux keeps it flaky. The research above shows the
  current flakiness is not runner-specific; address it through
  [ci-verifier-flakiness.md](ci-verifier-flakiness.md).
- Hidden Linux runs do not prove anything about the macOS native toolbar or focus
  behaviour. No current Linux candidate job claims to.

## Closure ledger

- **Fixed and verified:**
  - `15492d88`, `c6ba2a6d`: Moved `peak-surfaces` (`chrome` and `firefox`, 8
    cells total), `chrome` (`Chrome current extension smoke`), and both rows of
    the `.github/workflows/release.yml` `compatibility` matrix from
    `macos-15-intel` to `ubuntu-24.04`, updated `docs/development.md` and
    workflow comments labeling retained Metal WebGL jobs (`snow-map`,
    `chrome-terrain`, `firefox-terrain` on `macos-15`), and updated
    `test/project/verification-setup.test.mts`, `test/project/release.test.mts`,
    and `test/project/release-rehearsal.test.mts`.
  - `5eff7922`, `6a6cac80`: Added manual `workflow_dispatch` diagnostic probe
    `.github/workflows/probe-linux-chrome-extension.yml`,
    `scripts/probe-chrome-extension-load.mts`, and
    `test/project/chrome-extension-load-probe.test.mts`.
  - `8c01e57e`: Cleared pre-set runner-image `CHROME_BIN` and `FIREFOX_BIN`
    in `.github/actions/setup-verification/action.yml` when Playwright browsers
    are active; verified by hosted probe run `44237662003` (vs `44236927706`)
    and `test/project/verification-setup.test.mts`.
  - `72656840`: Switched `verifyNativeSizing` in
    `scripts/verify-capture-popup.mts` to CDP `Extensions.triggerAction` +
    `activateToolbarTarget`; verified locally (hidden Chrome `156.0.8078.4` 4
    native sizing cases, 105 Chrome + 105 Firefox `157.0` layout cases, clean
    teardown) and in hosted `Test` run `44241028916`.
  - `4b708f01`: Updated `.github/actions/setup-verification/install-playwright-browser.sh`
    for `ec2`/`clouds`/DEB822 `ubuntu.sources` mirror failover + APT retry
    timeouts with regression coverage in `test/project/browser-install-retry.test.mts`
    (`6/6` passed); verified live under 21-job concurrency across 10 failing
    mirrors in hosted `Test` run `44241028916` (35/35 jobs passing vs
    `44238155967`).
- **Intentionally not changed:**
  - `backup-layout` (`chrome` and `firefox`, 2 cells) stays on `macos-15-intel`
    (Phase 3 Option B) because Linux fallback fonts trigger real width shifts
    tracked under `Linux backup actions` in [follow-ups.md](follow-ups.md).
  - `snow-map` (2 cells) and conditional `chrome-terrain` / `firefox-terrain`
    (2 cells) stay on `macos-15` for hardware WebGL via Metal; no free Linux GPU
    runner is available for a personal-account public repository.
  - Required check names (`Chrome extension smoke`, `Firefox extension smoke`),
    the Linux `chrome_128` floor job, and `scripts/verification-launch.mts`
    (`--load-extension`) stay unchanged.
  - `.github/workflows/probe-linux-chrome-extension.yml` (`workflow_dispatch`
    only) is retained for diagnosing future Chrome/Playwright upgrades.
- **Changed but not fully proven:**
  - `.github/workflows/release.yml` `compatibility` matrix moves current Chrome
    and Firefox to `ubuntu-24.04` and shares the verified `ubuntu-24.04`
    setup/package actions (pinned by `test/project/release-rehearsal.test.mts`),
    but its manual `workflow_dispatch` rehearsal cannot run on GitHub Actions
    until the commits land on `main`.
  - All commits are currently local on `main` (unpushed because `origin/main`
    diverged prior to this work); hosted CI proof ran via fast-forward commits
    on `ci/verify-linux-offload`.
