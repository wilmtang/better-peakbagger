# Dependency verification latency — 2026-10-25

Baseline: [Test run 40244861651](https://github.com/wilmtang/better-peakbagger/actions/runs/40244861651)
took **19m09s** from creation to completion. Each browser's layout job ran 96
serial fixture cases for about 13 minutes, followed by roughly four minutes of
snow/card checks. Package/capture verification took 7m49s; Node/lint took 2m35s.
The actual privileged merge-queue runs took 10–13 seconds. Raising timeouts only
prevented premature cancellation and did not reduce this critical path.

## Fixed and verified

- Plan deterministic layout shards. Tests prove that every existing browser,
  surface, theme and viewport appears exactly once across the full selection;
  focused enlarged-text cases remain intact. Unknown/duplicate/empty selections
  fail before launch. Each case reports duration and the executed count is exact.
- Add an early fixture preflight using actual worker authorization tests, locale
  and evidence tests, and the production popup/timestamp/Settings/map fixtures.
  Explicit lifecycle disposal exposed a missing popup cleanup-listener stub;
  the new guard failed before correction. All four cases passed in hidden Chrome
  156 and Firefox 157 afterward. The failed page was retained before teardown.
- Suppress passing intermediate screenshots in CI, preserving selected reference
  states, failure captures and all geometry assertions. The full Firefox 158 card
  matrix passed with four reference images; focused Chrome popup retained one.
- Workflow contract tests verify that all eight Linux layout shards, both native-font backup jobs and all eight
  independent macOS surface jobs remain required. Tests execute the actual shell
  selections and failure paths, reject unknown engines/surfaces, and confirm
  only the chosen fixture browser is downloaded. All 23 focused checks passed.

- All 192 local layout cases passed through the new planner in hidden Chrome 156
  and Firefox 157. The clean exact-commit checkout passed all 3,596 tests and lint
  with eight owned warnings. A plain archive lacks Git metadata needed by some
  tests; the successful validation used an isolated shared-object checkout.
- [First qualification run](https://github.com/wilmtang/better-peakbagger/actions/runs/40248812491)
  passed Linux preflight and began reporting independent surface results early.
  Linux backup checks exposed existing font-specific width defects. Preserve
  their original macOS tests in two separate required jobs; move only the other
  22 surfaces to Linux. Tests prove 176 Linux plus 16 macOS cases exactly equal
  the original 192, with no duplicates or weakened assertions. All 60 focused
  planner/workflow/release tests and all 16 local backup cases passed afterward.

- The second run showed a real setup bottleneck: Ubuntu's package mirror spent
  about four minutes downloading Firefox OS packages, while the browser archive
  itself downloaded in three seconds. Keep preflight independently required in
  the aggregate, but remove it as a startup dependency of every suite. This
  overlaps installations instead of serializing two setup waves; retain an
  eight-minute bounded preflight budget for OS package and cleanup headroom.

- The independent Chrome card job reported a pending-refresh timeout at 375px
  in the reduced-screenshot path. Its retained failed page showed the focused
  Refresh control and rendered forecast. The fixture lacked an explicit settled,
  expanded forecast precondition after disclosure. Require expanded, idle,
  populated, enabled and focused state before activation; report live status,
  action and focus on pending timeout. Both complete hidden Chrome 156 and
  Firefox 158 card matrices passed after this change without screenshot delays.
  The original CI failure is retained; deterministic local reproduction of that
  timing race remains unproven, so the next complete run is still required.

## Intentionally not changed

- Required status names, strict advisory/provenance gates, monthly manual Actions
  cadence and fortnightly npm schedule remain unchanged.
- Real-manifest/native toolbar and GPU jobs retain their existing browser and
  macOS boundaries. These fixture shards do not replace that proof.
- Linux backup portability remains a known product risk: fallback fonts caused
  a 1.2–1.6px ascent action-width shift and equal-width primary/secondary profile
  actions. This infrastructure change retains baseline macOS coverage and does
  not claim to fix those Linux UI defects. They need a separate product change.
- No broad test retries, result reuse across changed commits, or reduced
  assertions. Browser-binary caching is not assumed to outperform downloads.
- Preserve concurrent custom-overlay work in this shared checkout; it is outside
  this CI change's commits and validation scope.

## Changed but not fully proven

- Hosted rendering of the remaining 22 surfaces, runner contention and combined wall time require a
  terminal run after publishing. Local protocol checks do not prove native
  onscreen focus, window placement or live providers.
- The first full local unit run passed 3,593 of 3,595 checks and caught two stale
  repository contracts (setup-consumer count and new-script inventory). Both were
  corrected and all 48 release/inventory checks then passed. Final published
  unit/lint results are recorded in the handoff, not inferred here.
