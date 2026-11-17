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
The largest single macOS source is the current-Chrome smoke, which depends on
phase 2. Before starting, check the logs of those failures to see whether they
are runner-specific or ordinary flakiness that would follow the job to Linux.

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

- Reproduce first: on `ubuntu-24.04`, run `npm run verify -- chrome` with the
  current locked Chrome for Testing, and record whether the content script
  injects. Chrome has moved past 151, so the old result may be stale.
- If it still fails, try loading the extension through the CDP
  `Extensions.loadUnpacked` command instead of `--load-extension`. This needs
  `--enable-unsafe-extension-debugging` and a pipe debugging connection. It is
  a candidate, not something I have checked, and would go in the shared
  `scripts/verification-launch.mts` so every verifier uses it.
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
- Moving a flaky job to Linux keeps it flaky. Check the baseline logs first.
- Hidden Linux runs do not prove anything about the macOS native toolbar or focus
  behaviour. No current Linux candidate job claims to.

## Closure ledger

- Fixed and verified: none yet.
- Intentionally not changed: GPU jobs stay on macOS. The Chrome 128 floor stays on
  Linux.
- Changed but not fully proven: none yet.
