# CI: Linux by default, macOS only for hardware WebGL

Status: proposed, no changes made yet.

## Goal

Run every CI check that does not need a GPU on standard Linux runners. Keep
macOS only for the jobs that need hardware WebGL, because a public repository
on a personal account has no free Linux GPU runner. GitHub GPU runners need a
Team or Enterprise organization and are billed per minute.

Do not drop or weaken any check to get there. A job moves only after it passes
on Linux. If it cannot pass, the owner decides whether it stays on macOS.

## Why each job is on macOS today

`.github/workflows/test.yml` runs 13 macOS cells on every pull request, plus 2
more when the copied runtime changes. `release.yml` adds 2.

| Job | Cells | Runner | Why it is on macOS | Blocker for Linux |
|---|---|---|---|---|
| `chrome` (current Chrome smoke, packages) | 1 | `macos-15-intel` | Chrome for Testing 151 ignored `--load-extension` on hosted Linux, in both new headless and Xvfb (`8248a30a`) | Chrome extension loading |
| `peak-surfaces` Chrome | 4 | `macos-15-intel` | Loads the real `dist/` in current Chrome for Testing (`verify-ascent-weather.mts`) | Chrome extension loading |
| `peak-surfaces` Firefox | 4 | `macos-15-intel` | Nothing recorded. It was grouped with the Chrome cells | None known |
| `backup-layout` | 2 | `macos-15-intel` | Uses native font metrics. Linux fallback fonts shift widths by 1.2–1.6px ([follow-ups](follow-ups.md)) | Product width defects |
| `snow-map` | 2 | `macos-15` | Needs hardware WebGL | No free Linux GPU |
| `chrome-terrain`, `firefox-terrain` | 2, conditional | `macos-15` | Needs hardware WebGL | No free Linux GPU |
| `release.yml` current Chrome and Firefox | 2 | `macos-15-intel` | Same as `chrome` | Chrome extension loading |

### Baseline: where failures actually happen

Of the last 40 `Test` runs, 11 failed. Counting failed jobs, excluding the two
aggregate jobs:

- macOS: current Chrome smoke ×4, Firefox cards surface ×2, Chrome
  interactions surface ×1, Chrome GPU ×1.
- Linux: Firefox smoke ×5, layout shards ×8 (all in a single run), preflight
  ×2, scale ×1, node ×1.

Linux jobs fail too, so moving to Linux will not remove maintenance on its own.

## Research findings (2026-11-16)

### None of the macOS failures were caused by macOS

I read the failed-step logs of all 8 macOS failures. Every one was a timing
race or a test-logic problem that would follow the job to any runner:

| Job | Failure |
|---|---|
| Current Chrome smoke | `deep-link did not land`: scroll timing, 5s `waitForFunction` |
| Current Chrome smoke | `draft did not Preview exactly once`: state stuck at 1 |
| Current Chrome smoke | Full Screen peak map did not create the terrain frame |
| Current Chrome smoke | Failed in its **Firefox** popup step (Buddy removal policy timeout). This job also runs Firefox |
| Firefox cards ×2 | `Timed out waiting for three ready cards`; a WebDriver BiDi race (`network.provideResponse: no such request`) |
| Chrome interactions | `repeated keyboard and pointer activation does not duplicate work`: count mismatch |
| Chrome GPU | `Map mode toggle moved or resized` by 12px: a layout check, not a GPU problem |

The Linux failures are the same kind: Firefox `ElementNotInteractableError`,
bold serialization, a 0-byte topo download, and disclosure anchoring. **The
maintenance cost is flaky verifiers, not macOS.** Moving jobs off macOS reduces
runner queueing, not flakiness. Reducing flakiness would be a separate plan.

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
detection method. macOS now runs 156.0.8078.4, so it may no longer reproduce.

### A sanctioned alternative to `--load-extension`

Puppeteer's documented `enableExtensions` option loads extensions over a pipe
connection with the CDP `Extensions.loadUnpacked` command, which needs
`--enable-unsafe-extension-debugging`. Playwright has no equivalent option. The
same command could be sent through `browser.newBrowserCDPSession()` from the
persistent context that `scripts/verification-launch.mts` already creates. I
have not checked that this works with Playwright persistent contexts.

Branded Chrome 137+ ignores `--load-extension`, but Chrome for Testing still
honours it, so this does not explain the Linux result.

## Plan

### Phase 1: Firefox peak surfaces to Linux (low risk)

- Split `peak-surfaces` into two jobs: Chrome stays on `macos-15-intel`, Firefox
  runs on `ubuntu-24.04`. Keep the matrix, environment, evidence upload and
  failure semantics. Add both jobs to `chrome-required`.
- Revisit the `max-parallel: 4` capacity comment for the Linux job.
- Update the runner pins in `test/project/verification-setup.test.mts`, and the
  surface wording in `docs/development.md`.
- Done when one hosted run passes all 4 Firefox cells on Linux, with no
  assertion changed.

### Phase 2: current Chrome extension loading on Linux (spike, may fail)

All Chrome cells except GPU depend on this, so time-box it.

- Reproduce first with one throwaway workflow-dispatch job on `ubuntu-24.04`:
  install current Chrome for Testing the same way `setup-verification` does,
  launch through `verification-launch.mts`, then dump
  `chrome://extensions-internals/` and the browser's stderr. That separates "not
  registered" from "registered but slow" in a single short run, instead of
  running the full 10-minute verifier.
- If it is still not registered, try `Extensions.loadUnpacked` (see research
  above) in `scripts/verification-launch.mts`, so every verifier picks it up.
- Also try `xvfb-run` with `headless: false` only if both of the above fail. The
  August notes say Xvfb also failed on 151, so expect little from it.
- Exit criteria: `verify -- chrome` and the Chrome peak surfaces pass on Linux
  across repeated runs (`BPB_VERIFY_REPETITIONS`), with the injection probe
  proving the extension loaded rather than an empty target list.
- If it passes: move `chrome`, the Chrome `peak-surfaces` cells and the
  `release.yml` current rows to Linux. Update the pins in
  `verification-setup.test.mts`, `release.test.mts` and
  `release-rehearsal.test.mts`. Keep the Chrome 128 floor job unchanged.
- If it fails, owner decision:
  - **A.** Keep the current-Chrome smoke and the Chrome surfaces on macOS
    (5 cells).
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
- Optional, owner choice: merge them into one GPU job per browser. This saves
  setup time but mixes evidence. Do not do it unless runner queueing is an
  actual problem.

### Phase 5: closeout

- Required check names (`Chrome extension smoke`, `Firefox extension smoke`)
  must not change.
- Update `docs/development.md`, the `follow-ups.md` entries for Linux backups
  and hosted CI, and the workflow comments.
- `test/project/dependabot-auto-merge.test.mjs` pins the terrain runners. If
  phase 4 changes it, convert it to `.mts` in the same commit (repository
  TypeScript policy).

## Expected result

| Outcome | macOS cells per PR |
|---|---|
| Today | 13 (+2 conditional) |
| Phases 1–4, phase 2 passes, backups fixed | 2 (+2 conditional) |
| Phase 2 fails (option A), backups stay on macOS | 9 (+2 conditional) |

## Risks

- Linux runners are not a single, stable font environment. Reference screenshots
  for moved surfaces must be regenerated or confirmed to be geometry-only, never
  loosened.
- Moving a flaky job to Linux keeps it flaky. The research above shows the
  current flakiness is not runner-specific. This plan reduces macOS queueing,
  not test maintenance.
- Hidden Linux runs do not prove anything about the macOS native toolbar or focus
  behaviour. No current Linux candidate job claims to.

## Closure ledger

- Fixed and verified: none yet.
- Intentionally not changed: GPU jobs stay on macOS. The Chrome 128 floor stays on
  Linux.
- Changed but not fully proven: none yet.
