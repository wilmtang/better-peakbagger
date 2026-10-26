# Dependency verification latency — 2026-10-25

Baseline: [Test run 40244861651](https://github.com/wilmtang/better-peakbagger/actions/runs/40244861651)
took **19m09s** from creation to completion. Each browser's layout job ran 96
serial fixture cases for about 13 minutes, followed by roughly four minutes of
snow/card checks. Package/capture verification took 7m49s; Node/lint took 2m35s.
The actual privileged merge-queue runs took 10–13 seconds. Raising timeouts only
prevented premature cancellation and did not reduce this critical path.

## Fixed and verified

- Plan deterministic layout shards. Tests prove that every existing browser,
  surface, theme and viewport appears exactly once across the eight shards;
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
- Workflow contract tests verify that all eight Linux layout shards and all eight
  independent macOS surface jobs remain required. Tests execute the actual shell
  selections and failure paths, reject unknown engines/surfaces, and confirm
  only the chosen fixture browser is downloaded. All 23 focused checks passed.

## Intentionally not changed

- Required status names, strict advisory/provenance gates, monthly manual Actions
  cadence and fortnightly npm schedule remain unchanged.
- Real-manifest/native toolbar and GPU jobs retain their existing browser and
  macOS boundaries. These fixture shards do not replace that proof.
- No broad test retries, result reuse across changed commits, or reduced
  assertions. Browser-binary caching is not assumed to outperform downloads.
- Preserve concurrent custom-overlay work in this shared checkout; it is outside
  this CI change's commits and validation scope.

## Changed but not fully proven

- Hosted Linux rendering, runner contention and combined wall time require a
  terminal run after publishing. Local protocol checks do not prove native
  onscreen focus, window placement or live providers.
- The first full local unit run passed 3,593 of 3,595 checks and caught two stale
  repository contracts (setup-consumer count and new-script inventory). Both were
  corrected and all 48 release/inventory checks then passed. Final published
  unit/lint results are recorded in the handoff, not inferred here.
