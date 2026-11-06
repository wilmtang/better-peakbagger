# Dependabot auto-merge investigation — 2026-10-25

All three current GitHub PR heads are merged into local `main` with real merge
commits. The initial investigation was local-only. The follow-through was
authorized to push main, finish the remote checks, close integrated PRs, and
delete branches whose exact heads are ancestors of main. Publishing and remote
CI results belong to the final handoff; local checks alone do not establish them.

## Remote evidence

- [PR #58](https://github.com/wilmtang/better-peakbagger/pull/58), editor:
  [Test run 40156233568](https://github.com/wilmtang/better-peakbagger/actions/runs/40156233568).
- [PR #59](https://github.com/wilmtang/better-peakbagger/pull/59), vendored:
  [Test run 40156243997](https://github.com/wilmtang/better-peakbagger/actions/runs/40156243997).
- [PR #60](https://github.com/wilmtang/better-peakbagger/pull/60), tooling:
  [Test run 40156274060](https://github.com/wilmtang/better-peakbagger/actions/runs/40156274060).

The privileged auto-merge runs succeeded and all three PRs had native auto-merge
enabled. Required checks blocked them. Node tests never ran remotely because the
advisory step failed first. #58/#59 also contained real fast-uri and undici
advisories that local unpublished `main` had already repaired. #58's Firefox jobs
clicked a `ProseMirror-separator` image; the Chrome package job failed when it
subsequently ran that same Firefox check. #60's Firefox 152 job lost its browser
connection during the narrow analyzer case.

## Closure ledger

### Fixed and verified

- **Locale spelling in the last interaction gate:** [the fifth published run](https://github.com/wilmtang/better-peakbagger/actions/runs/40243363662)
  passed the repaired Firefox card and placement matrices. Its last interaction
  check rejected the Intel browser's resolved `en` against requested `en-US`.
  Compare maximized canonical locales and report observed spellings. Two focused
  tests accept the default-region alias while rejecting different regions,
  scripts, languages and hour-cycle extensions. The complete screenshot-enabled
  Chrome 156 and Firefox 158 interaction matrices passed at 375/1440px, both
  themes and normal/200% zoom; Firefox also passed with generic English requested.
  This changes verifier spelling equivalence, not product formatting or coverage.
- **Screenshot-enabled Firefox input ownership:** [the fourth published run](https://github.com/wilmtang/better-peakbagger/actions/runs/40241538978)
  passed both full layout matrices and the entire Chrome snow/card suite. Its
  Firefox card check then timed out on Sun's keyboard disclosure. Persistence
  polling switched to Settings and back immediately before Enter. With the
  CI screenshot path enabled, a new guard reproduced those hidden/visible
  transitions on the former read. Read the extension's Settings context over
  BiDi without switching tabs; the guard and full screenshot-enabled Chrome
  156/Firefox 158 card matrices then passed at 375/1440px in both themes.
  Firefox placement and interaction matrices also passed through 200% zoom.
  Include live focus/visibility in disclosure failures. Native onscreen focus
  is not established by these hidden runs.
  The successful Chrome job took 18m15s. Increase only the layout job budget
  from 20 to 30 minutes for measured setup, timeout-path and cleanup headroom.
  The budget regression failed first; all seven setup tests passed afterward.
- **Final fixture follow-up:** [the third published run](https://github.com/wilmtang/better-peakbagger/actions/runs/40239868354)
  passed Chrome current/128, Firefox current/152, Node/scale, and both browsers'
  terrain and snow GPU checks. Its layout jobs exposed timestamp stubs missing
  `storage.local`, correctly rejected by Settings. Complete the API stubs rather
  than relaxing readiness. All 16 hidden Chrome/Firefox timestamp cases passed,
  including slow/error/retry paths, both themes, 390/1280px and simulated 150%
  zoom. Reports and captions also passed all eight cases each.
  Proactively running the later gates exposed obsolete Snow/Weather adjacency
  and an offscreen forecast wait. Require their ordering in the same stack and
  visit the lazy forecast before waiting. Two focused placement tests and the
  full 28-case snow matrix passed in both browsers at 375/681/1440px, both themes
  and 200% zoom. Finally, finish the expanded forecast read before the next
  placement case measures collapsed-card requests. Both browsers passed the
  full card, placement and interaction matrices with the no-hidden-read and
  geometry assertions preserved. These runs used isolated headless Chrome
  156.0.8078.4 and Firefox 158.0.1 with synthetic providers; teardown passed.
- **Later matrix failures:** [the second published run](https://github.com/wilmtang/better-peakbagger/actions/runs/40237887393)
  passed all 3,582 tests, scale checks, Firefox 152/current, and both browsers'
  GPU checks. Its later card cases exposed a real enlarged-text defect: a 216px
  hidden status reservation left a 104px keyboard action in a 47px body. Cap
  that reservation after reserving one full action and recovery controls; long
  status copy remains keyboard-scrollable. Preserve all geometry/readability
  assertions and include live bounds on failure. All 19 card tests and all
  eight Chrome/Firefox climber matrices passed afterward, including 540px
  subcases, both themes and doubled text; detail renders were inspected.
  The capture-flow observer now uses the authorized popup path, distinguishes
  itself from the native toolbar target, and explicitly clicks Capture after
  proving popup opening starts no provider read. Its full Chrome flow passed
  all export/privacy/cancellation/Preview/no-Save cases. Finally, Chrome 128
  hides the active extension-tab URL when no toolbar gesture granted activeTab;
  the popup inspection now selects a host-permitted HTTPS fixture instead.
  The original failure reproduced in pinned Chrome 128 and its complete real
  extension check then passed, including teardown, with no permission change.
- **Published-head follow-up:** [the first published Test run](https://github.com/wilmtang/better-peakbagger/actions/runs/40237076937)
  passed Node/scale checks but exposed additional browser failures. A duplicate
  final Settings scroll notification replaced the correct near-bottom fragment
  selection with About; the regression failed before the fix and all 49 Options
  UI tests and the full hidden Chrome extension check passed afterward. The
  capture readiness fixture incorrectly issued popup-only messages from
  Settings; using the actual popup passed hidden Chrome/Firefox readiness and
  signed-out gates without relaxing worker authorization. Map stability now
  measures capture selection after deliberate field reveal, preserving native
  page geometry and reading position; all eight Chrome/Firefox map cases passed.
  Terrain matrix setup now waits for applied fonts and stable native picker
  metrics. Snow-popup checks wait for settled native geometry and the actual
  rendered arrow after restoring the negative control; the full Firefox GPU
  matrix passed at 375/1440px, both themes and 200% zoom. These local results do
  not substitute for a terminal result on the next published head.
- **Exact PR ancestry:** the initial local integration contained equivalent
  dependency commits with different SHAs. Verified their complete trees match
  the GitHub heads, merged those exact heads, retained the combined manifest
  and lockfile repairs, and verified each merge left the tree unchanged.
- **Queue transitions:** serialize privileged runs per PR, reject stale event
  heads before mutation, propagate reset failures, and confirm queue removal
  and the final exact-head merge request. Execute the real workflow shell
  against an isolated CLI stub; the new checks failed on the former workflow
  and all 13 queue/policy tests passed after the repair. Required checks and
  single signed Dependabot commit validation remain intact.
- **Monthly manual group:** GitHub Actions checks run on the first day of each
  month at 09:00 UTC. npm keeps `0 9 * * mon%2`; all group patterns, cooldowns,
  and manual-versus-automatic merge policy are preserved. The schedule
  regression failed before the change and passed afterward.
- **Audit parent version:** replace the exact web-ext 10.7.0 requirement with
  stable compatible releases from the same floor. Keep the exact node-forge
  advisory, vulnerable dependency versions, development-only locations, edges,
  duplicate rejection, counts, severity, and expiry. The new regression failed
  before the fix and passed afterward; the final live opt-in audit passed.
- **Editor spacers:** Firefox interactions and caption assertions now select
  the extension-owned resizable photo. The spacer regression and both caption
  assertions failed with the old selectors and passed after correction. Hidden
  Firefox 158.0.1 extension verification passed at 1000×760 after the editor merge.
- **Minimum Firefox revalidation:** the third published run passed both Linux
  Firefox 152 and current Firefox. The original connection loss's precise cause
  remains unknown; passing revalidation is not proof of its root cause.
- **MapLibre compatibility:** 6.14.0 retains the identical distributed terrain
  update method from 6.13.0 and still omits the source LOD callback. Explicitly
  approve 6.14.0 for the existing patch. Build and shipped-method checks passed;
  hidden Firefox 157.0 terrain verification passed at 1000×760 using Apple M3 Pro
  Metal. This is an intentional vendor guard, not an arbitrary version assertion.
- **Mode placement assertion:** replace the stale 40px native-control gap limit
  with action position and size comparisons across successful activation and
  WebGL2-unavailable fallback, allowing one CSS pixel rounding. Preserve overlap
  checks. Chrome hardware checks exercised the transition, provider recovery,
  resize, and popup paths. The 2D/3D screenshots were inspected.
- **Test keychain isolation:** direct Chrome launches lacked Playwright's mock
  keychain/password-store defaults, causing a visible macOS Safe Storage prompt.
  All direct fixture launchers now use those defaults; showcase screenshots also
  use an owned disposable profile. The new guard failed before the fix; 30 launch,
  resource, and showcase checks passed afterward. Browser process arguments prove
  the flags are passed; hidden protocol verification does not establish native
  prompt absence or window-placement behavior.
- **Terrain credits:** the current renderer deliberately wraps attribution
  around anchored controls and moves its informational scale to clear credit
  text. Replace the stale fixed 60px exclusion with actual painted-text
  containment/collision checks, retaining action, heading, following-content
  and scroll stability. Four focused tests and all eight hidden Chrome layout
  and failure/retry cases passed; desktop and narrow enlarged-text renders were
  inspected. No runtime layout change was necessary.
- **Sentinel cooldown verifier:** reproduced the previous timeout. The shared
  control replaces session copy with `Service busy. Retry after …`; the probe
  now requires that visible feedback, disabled Retry, and an intercepted
  catalog HTTP 429. The full hidden Chrome terrain verifier passed on Apple
  M3 Pro Metal, including the earlier failed case. Eleven focused verifier
  tests passed. Requests and data remain synthetic.

### Intentionally not changed

- The default audit remains strict. The reviewed development-only exception
  still expires at **2026-10-31 00:00 America/Los_Angeles**. npm still reports the
  same three high findings; node-forge's registry latest was 1.4.0 during this run.
- Unreviewed MapLibre releases and changed/ambiguous patch input still stop the
  build. Future updates require reviewing the vendor workaround.
- Required checks, provenance validation, and manual review of GitHub Actions
  updates were not weakened. No blanket retries or bypasses were added.
- Unrelated documentation work in this shared checkout was preserved.

### Changed but not fully proven

- Queue behavior is tested with CLI stubs; a future genuine Dependabot update
  must still exercise the changed privileged workflow against GitHub. A green
  test suite cannot guarantee that new dependency versions or advisories pass.

## Local integration

| Source branch | Merge commit |
| --- | --- |
| `dependabot/npm_and_yarn/editor-5e8c75a09f` | `0086ffa0` |
| `dependabot/npm_and_yarn/vendored-8f42b2fb74` | `b81e563d` |
| `dependabot/npm_and_yarn/tooling-3bd57b00f0` | `ff7ec417` |

The current heads' adjacent manifest conflicts were resolved by retaining all
three groups' updates and subsequent repairs. Each exact remote head is an
ancestor of local `main`; the three follow-through merges changed ancestry only.

Follow-through combined checks: `npm ci`, all **3,576** tests, **14** scale tests,
`npm run lint` (eight owned warnings), and the reviewed-advisory gate passed.
The subsequently added five focused terrain assertions passed separately;
the full terrain verifier passed. All 20 immutable changelog sections passed.
After the later card and capture-fixture repairs, the full local **3,582** tests
and `npm run lint` passed again (the same eight owned warnings). Final published
CI is checked separately; do not infer its result from these local runs.
After the timestamp, snow and placement fixture repairs, all **3,584** tests,
lint (the same eight owned warnings), the exact reviewed-advisory gate and all
20 immutable changelog sections passed again. The next published run remains
the terminal check for the combined head.
The initial investigation's real unpacked extension passed hidden Chrome for Testing
156.0.8078.4 verification at 1000×760, including analyzer controls at
1600/800/390px, both themes, and enlarged text. Teardown passed. That earlier
result does not establish the final published head's CI result, native
focus/window placement, or keychain-prompt absence.
