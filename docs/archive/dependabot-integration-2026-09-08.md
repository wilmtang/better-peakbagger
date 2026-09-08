# Dependabot integration and recurrence investigation — 2026-09-08

## Evidence and cause

Auto-merge was successfully enabled on both open npm PRs. The four-check main
ruleset correctly blocked their failing checks. Tooling PR #21 was merged by
`github-actions` on September 6, confirming that the queue path works.

- [Editor PR #19 test run](https://github.com/wilmtang/better-peakbagger/actions/runs/34008062466):
  `npm ci` failed with `ERESOLVE`, before application tests ran. Most TipTap
  packages resolved to 3.30.6, but extension-link and extensions resolved to
  3.31.3 with exact 3.31.3 peers. Two manifest ranges remained at `^3.30.5`.
- [Dependabot updater run](https://github.com/wilmtang/better-peakbagger/actions/runs/34007935413):
  its job definition says `command: recreate`, group `editor`, former
  `editor`/`vendored` rules, and `requirements-update-strategy: null`. The
  default branch already contains the renamed groups and `increase` strategy.
  This recreation therefore retained configuration predating the earlier fix;
  inspecting only the current YAML would miss the recurrence mechanism.
- [MapLibre PR #20 test run](https://github.com/wilmtang/better-peakbagger/actions/runs/34007976080):
  ordinary Node/scale/browser checks passed, while both copied-runtime GPU jobs
  failed readiness. Chrome timed out on the dark 448×448 terrain surface;
  Firefox reported frame opacity 0 and mapLoaded false, despite route, peaks,
  and basemap objects existing. Those logs do not establish a renderer defect
  or a specific timing cause. Both checks passed locally with MapLibre 6.6.0.

## Fixed and verified

- `ce80d68`: merged `origin/main`, including the already auto-merged tooling
  update, while preserving all 18 pre-existing local commits.
- `339c5f2`: real two-parent merge of
  `dependabot/npm_and_yarn/editor-a5f38f0bb7`. All direct TipTap dependencies
  are now exact 3.30.6 pins; every nested and top-level lockfile resolution must
  match. CodeMirror updates are included. Fresh `npm ci`, 1,822 tests, seven
  dependency-policy tests, and hidden real-extension Chrome verification passed.
- `e511bad`: real two-parent merge of
  `dependabot/npm_and_yarn/vendored-d2e2e9d766`, updating MapLibre to 6.6.0.
  Fresh installation, 101 terrain/project tests, and both hidden terrain GPU
  checks passed. All three source heads are ancestors of local main.
- `fa4dada`: shared read-only timeout diagnostics now report current toggle
  failure text, frame opacity, theme, canvas, renderer/context loss, and
  per-source readiness. Ten diagnostic/showcase tests and focused ESLint passed.
- `8c5f0ff`: updated js-yaml from 4.3.1 to 4.3.2 for
  [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
  Fresh installation, seven dependency-audit tests, and full lint passed
  (eight owned web-ext warnings).

Final combined-tree validation passed all 1,824 tests and 14 scale tests.
Local commands used Node 26.8.1/npm 12.0.2; hosted CI's Node 24 was not rerun.

Chrome extension verification used hidden Chrome for Testing 151.0.7922.34 at
1000×760, with the verifier's additional narrow-surface checks.
The separate terrain run reported ANGLE Metal on Apple M3 Pro; the Firefox
153.0 terrain run reported “Apple M1, or similar” at 1000×760, including a
448×448 resized canvas. Chrome exercised 1000×760/1000×900 pages and narrow
terrain surfaces; its dark screenshot was inspected. These fixture checks
prove no native window placement, browser chrome, or live provider behavior.
The final process inspection found no remaining test-profile browser processes.

## Intentionally not changed

- Required checks, hardware-renderer assertions, provenance checks, and the
  privileged auto-merge workflow remain enforced. There is no admin bypass,
  retry-until-green loop, or relaxed npm peer resolution.
- No new audit exception was added. Current `audit:ci` still rejects
  [GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)
  through `web-ext → firefox-profile → adm-zip`. Registry latest is still
  affected 0.6.0. Existing image-size exceptions remain unchanged. The
  js-yaml repair does not make the overall audit green.
- No push, remote PR closure, branch deletion, or ruleset change was performed.

## Changed but not fully proven

- Hosted GPU readiness failures were not reproduced locally. The diagnostics
  are tested, but their output from the original hosted failure is unavailable.
- A fresh Dependabot scheduled job must demonstrate the current grouping and
  version strategy; the old recreation is not that evidence. Exact TipTap pins
  prevent silent caret drift but do not prove every future updater run succeeds.
- GitHub still has the old open PR heads and failing checks. Local integration
  is complete; remote CI and subsequent auto-merge are not proven. A fresh CI
  run would also encounter the unaccepted adm-zip advisory until it is repaired
  or separately reviewed.
