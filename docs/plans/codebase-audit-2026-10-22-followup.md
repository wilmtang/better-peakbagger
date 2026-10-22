# Repository bugs, performance, engineering, and UX audit — October 22 follow-up

Status: **F1–F4 implemented and verified locally; dependency follow-up D1 remains open.** This is separate from the earlier
[October 22 Gemini audit](../archive/codebase-audit-2026-10-22.md) and
[terrain audit](../archive/3d-map-audit-2026-10-22.md).

## Findings first

P2 denotes a reproduced functional or interaction defect. P3 denotes measured
avoidable work with no demonstrated ordinary-user latency regression. No new
P0/P1 defect was established; that is not a claim that the repository is free
of higher-severity defects.

| ID | Priority | Category | Finding and evidence |
| --- | --- | --- | --- |
| F1 | P2 | Correctness / provider load | A Peakbagger 429 without a usable reset time leaves no retained cooldown. A second capture tab immediately performs another summit request and reaches `ready`. |
| F2 | P2 | Keyboard UX | Activating summit-weather Refresh loses focus to `BODY`; focus remains lost after completion. Reproduced in hidden Chrome and Firefox. |
| F3 | P2 | Layout stability | Delayed model-update timestamps enlarge the source table and move the footer and following snow card about 32 CSS pixels at 375 px width. Reproduced in both browsers. |
| F4 | P3 | Performance / engineering | Hourly-chart pointer events redraw unchanged selections. A 120-event same-position probe produces 360 child-list mutation records with no readout change. |

The existing dependency advisory is tracked separately as D1 below. It is not
a newly discovered runtime vulnerability or an unexplained CI failure.

## Audited tree and scope

The starting tree was clean `main` at `181826e4`, version 4.0.2. Source line
references below refer to that commit. Weather changes appeared during the
audit and were subsequently committed independently as `521feeda` (removing
the redundant snowfall display). They were preserved. Remaining reproductions
used a disposable `git archive` of `181826e4` with its own built `dist/` and
the installed dependency tree. The relevant cooldown, Refresh, metadata-row,
and pointer-handler logic was compared with `521feeda` and remains present;
the new weather presentation itself was not independently re-audited here.

The review reconciled the active-plan index and recent closure ledgers, then
inspected manifest/build ownership, the Peakbagger request scheduler and
capture cooldown, request deadlines/readers, weather and SNOTEL clients,
weather summaries/charts, card placement/dragging, column resizing, and map
location/elevation handling. Existing unit and scale suites supplied broader
coverage of capture, GPX, photos, settings, and storage boundaries. This was a
risk-based review, not a line-by-line proof of every module or a release audit.

## F1 — Headerless Peakbagger refusals do not survive the next capture

**Trigger and reproduction.** Use the built-worker harness in
`test/background/background-capture.test.mjs` with two supported activity
tabs and one signed-in Peakbagger helper. Return a summit-lookup response with
HTTP 429 and a structured `rate-limit` error, omitting `retryAt`. Immediately
start capture from the second activity tab with the same clock and no forced
retry. The first lookup fails, but the second lookup runs and succeeds:

```text
first.phase = error
first.error.code = rate-limit
first.error.message = Peakbagger request limit reached. Wait a few minutes, then try again.
second.phase = ready
summit responses = 2
```

A disposable regression assertion requiring one response **failed with
`2 !== 1`** on the shipped bundle. It reached the user-visible defect; this was
not a fixture setup error. No live Peakbagger requests were made.

**Root cause.** `src/peakbagger/peakbagger-request.js` (lines 64–68) attaches
`retryAt` only when the response header produces a valid time.
`src/background/background.js` (lines 403–410 and 435–438) preserves only a
validated timestamp. The worker stops its current scheduler batch, but writes
the session cooldown only when that timestamp exists (lines 476–484).
`ensurePeakbaggerRequestsAllowed` then resumes an idle stopped scheduler when
there is no stored cooldown (lines 441–458). The refusal therefore stops the
current batch without enforcing the displayed wait for the next capture.

The existing restart test in `test/background/background-capture.test.mjs`
(lines 2985–3060) always supplies a valid future `retryAt`. It does not cover
missing, malformed, expired, or out-of-range reset information.

**Smallest safe direction.** Give a confirmed Peakbagger rate-limit refusal a
bounded fallback deadline at the worker's cooldown owner when provider timing
is unusable. Keep a valid provider deadline authoritative, retain the longest
applicable deadline, and preserve it across jobs and worker restarts. Keep an
in-memory deadline if persistence fails; a failed storage write must not make
the next admission immediately resume traffic. Do not change Cloudflare
recovery or turn generic network failures into rate-limit refusals.

**Acceptance and commit boundary.** One focused worker/transport-policy commit:

- Extend the existing built-worker test with missing, invalid, past, and
  over-24-hour reset times. Cover the same worker, a second tab, restart,
  ordinary retry, and forced retry before expiry.
- Assert zero additional Peakbagger requests during the fallback; advance the
  injected clock and prove recovery after expiry. Keep valid shorter/longer
  provider times and concurrent-refusal retention explicit.
- Cover session-write failure without losing the worker's active deadline.
  Keep ownership/login gates and capture cancellation unchanged.
- Run focused capture/request tests, the full suite, and the real-manifest
  Chrome check because this changes the worker. Add Firefox coverage for the
  final release gate; local harness proof is not live rate-limit proof.

## F2 — Refresh removes the keyboard user's current control

**Reproduction.** On a loaded summit-weather card, focus Refresh and press
Enter while holding the fixture's weather response. In Chrome 156.0.8078.4 and
Firefox 158.0.1, focus becomes `BODY` and remains there after success. Both
1440 × 1100 and 375 × 1100 were exercised. Chrome can briefly report the
disabled button before its blur settles; the settled outcome is still lost
focus. This concerns document focus in a hidden browser, not macOS window
focus or assistive-technology announcements.

**Root cause.** `src/weather/peak-weather.js` sets native `disabled` on Refresh
both in the cooldown callback (line 142) and synchronously at request start
(line 323), then re-enables it without restoring focus. The load guard already
checks `pending` and cooldown (line 319). The nearby snow control has a
different focus-preserving busy behavior.

**Coverage gap.** `scripts/verify-peak-cards.mjs` (lines 223–244) already drives
keyboard Refresh and measures geometry, but never checks its active element.
The same verifier explicitly checks snow Refresh focus at lines 270–276.
Passing the existing matrix therefore does not establish this requirement.

**Smallest safe direction.** Keep the action focusable through its temporary
busy state using the existing accessible unavailable-control pattern. Preserve
the pending/cooldown guard for pointer, keyboard, and programmatic activation;
ARIA alone must not permit duplicate requests. Do not steal focus back if the
user deliberately moves elsewhere during the request. Audit the rate-limit
transition of the model selector as part of the same interaction boundary.

**Acceptance and commit boundary.** One focused weather-action commit with
behavior and browser assertions. Hold requests and verify Enter/Space,
repeat activation, success, service error, timeout, cooldown, and retry. Assert
the active element, request count, action dimensions, surrounding cards, and
scroll position at each transition. Exercise light/dark, desktop/narrow,
100/200% browser zoom in Chrome and Firefox. First run the new focus assertion
on the audited implementation and retain its expected failure.

## F3 — Async source metadata moves following content

**Reproduction.** Open Source details on the loaded GFS forecast. Hold its two
model-metadata responses, scroll the disclosure into view, record document
geometry, then release the normal timestamp responses. The initial deliberate
disclosure expansion is excluded from the comparison.

| Browser / viewport | Footer and following snow card movement | Source height, pending → ready |
| --- | --- | --- |
| Chrome 156 / 375 × 1100 | +31.875 CSS px | 447.234 → 479.109 px |
| Firefox 158.0.1 / 375 × 1100 | approximately +31.90 CSS px | 447.400 → 479.300 px |
| Both / 1440 × 1100 | No measured movement | Unchanged in this fixture |

Document scroll and the source disclosure's top remain unchanged. Its bottom,
the footer, and the following card move. Pending/ready screenshots were also
visually inspected. These measurements used light theme at 100% zoom; dark,
200% zoom, long locale strings, errors, and staggered individual responses
remain acceptance work, not completed proof.

**Root cause.** `src/weather/peak-weather.js` (lines 103–110) builds the table
with short `Loading…` cells, then replaces them with longer localized timestamps
and intervals independently (lines 115–129). At narrow container widths,
`src/weather/peak-weather.css` (lines 112–120 and 133–134) uses a fixed-layout
table with arbitrary word wrapping. It has no content-based reservation for
the pending and completed cell text. The result needs extra wrapped lines.

**Smallest safe direction.** Size metadata cells for their supported loading,
timestamp, delayed, and unavailable states using noninteractive,
accessibility-hidden reservations or a comparably stable readable layout.
Preserve prior usable clocks on refresh where possible. Do not use a clipped
fixed height, invisible buttons, oversized blank panels, or compensating scroll.

**Acceptance and commit boundary.** One metadata-presentation commit. Extend
the existing browser fixture to hold and release each metadata reply separately,
including failure and delayed timestamps. Compare source trigger, table,
footer, following native/extension content, and scroll before/during/after;
allow only a documented rounding tolerance of at most 1 CSS pixel. Cover both
browsers, themes, 375/1440 px widths and 200% browser zoom. Keep the initial
user-requested disclosure expansion distinct from asynchronous jitter.

## F4 — Pointer movement repaints an unchanged hourly reading

**Measured behavior.** With Temperature selected in an expanded hourly chart,
dispatch 120 pointermove events at the same chart coordinate after establishing
the initial selection. The production handler in hidden Chrome produces 360
child-list mutation records, 240 added nodes and 240 removed nodes, while the
displayed reading stays identical. The synchronous burst took 27.5 ms in one
run; this is a synthetic burst measurement, not a real-user frame-rate or
cross-machine benchmark. It establishes redundant work, not severe jank.

**Root cause and engineering concern.**
`src/weather/peak-weather-hourly.js` (lines 201–209) reads geometry and redraws
on every event without checking whether the selected sample changed.
`drawCursor` removes/recreates the cursor and rewrites the readout
(lines 84–93). `src/ui/stable-text.js` (line 21) also writes identical text.
These child-list mutations reach the whole-body card-layout observer in
`src/ui/peak-card-layout.js` (lines 298–322), which rescans card registration,
ordering and disclosure state for unrelated chart changes. MutationObserver
batches synchronous mutations; 360 records do not mean 360 observer callbacks.

**Smallest safe direction.** Skip unchanged pointer selections, preserve the
existing cursor nodes where appropriate, and coalesce rapid changed selections
to one paint per animation frame if profiling justifies it. Treat resize,
metric/unit changes, leave, pinned selection and keyboard/live-region behavior
as explicit invalidations. The snow chart's unchanged-index guard is a useful
local precedent. Narrowing the layout observer is a separate follow-up only
if the remaining cost warrants it; do not redesign both drag controllers.

**Acceptance and commit boundary.** One small chart efficiency commit with a
focused mutation-count regression. Repeated events on the same sample should
not rewrite the readout or cursor after the initial paint. Changed selections,
resize, missing readings and keyboard navigation must still update correctly;
queued work must be cancelled on disposal. Inspect one real-browser hover/tap
and keyboard sequence and rerun the relevant hourly-chart tests. Keep CPU/FPS
claims limited to measurements actually made.

## D1 — Existing dependency advisory and imminent review deadline

After explicit approval for the npm metadata request, a fresh raw audit
reported **three high findings**: `node-forge` and its `@devicefarmer/adbkit`
and `web-ext` parents. The strict `npm run audit:ci` failed with those three
names. Evaluating that same response with the repository's reviewed policy
passed as `accepted-development-advisory`, expiring **October 24, 2026 at
00:00 PDT** (`2026-10-24T07:00:00Z`; acceptance is through October 23 locally).

This is the known
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
chain already recorded in the
[October 19 ledger](codebase-audit-2026-10-19.md), not a new exception. The
specific `web-ext` tooling chain is outside the extension bundles. Do not
generalize that conclusion to every devDependency: several devDependencies
are bundled runtime libraries. The registry's suggested `web-ext` 5.1.0 major
downgrade was not applied or judged compatible.

Before the deadline, recheck an upstream-compatible repair and the packaging
impact, or obtain an explicit scoped policy decision. Do not silently extend
the expiry or weaken the default gate. The stale “expires October 17” comment
in `.github/workflows/test.yml` (line 58) should be corrected with that policy
work; the executing policy's October 24 timestamp is the authority.

**Remediation review, October 22.** Fresh `npm audit --json` still reports only
the same three high findings. Evaluating that exact response rejects the
strict gate and accepts the existing reviewed exception, unchanged through
`2026-10-24T07:00:00Z`. The public npm registry reports `node-forge` 1.4.0 as
latest, and the linked advisory still reports no patched version. Current
`web-ext` 10.8.0 still depends on `@devicefarmer/adbkit` 3.3.9, whose dependency
remains `node-forge` ^1.3.1. An ordinary compatible tool upgrade therefore does
not remove this chain; no downgrade, unreviewed crypto fork, dependency patch,
or expiry extension was applied. D1 remains open for an upstream repair or an
explicit owner policy decision. The stale workflow comment now points to the
executing policy instead of carrying a second expiry date.

## Original audit verification and evidence limits

| Check | Observed result |
| --- | --- |
| Initial `npm test` | 3,242 passed; 0 failed/skipped; about 41.9 seconds. |
| `npm run lint` | Passed; 50 bundles built, with 8 existing owned web-ext warnings. |
| Snapshot `npm run test:scale` | 14 passed; 0 failed/skipped; about 23.3 seconds. No broad scale regression established. |
| Existing peak-card verifier, Chrome | Passed the desktop/narrow, light/dark, pending/error/retry, order/column, drag and zoom matrix; hidden Chrome 156.0.8078.4. |
| Existing peak-card verifier, Firefox | Passed the corresponding matrix; hidden Firefox 158.0.1. |
| F1 additional built-worker assertion | Failed as expected: second summit request occurred immediately after headerless 429. |
| F2/F3 additional browser probes | Focus loss in both browsers; narrow metadata shift in both; 1440/375 × 1100, light, 100% zoom. |
| F4 additional browser probe | Confirmed unchanged-selection mutation churn in Chrome at 1440 × 1100. |
| Dependency audit | Strict gate failed on 3 known high findings; reviewed-policy evaluation of the captured response passed with the existing expiry. |
| Documentation checks | 3 documentation tests passed; `git diff --check` passed. |

Browser checks loaded real unpacked `dist/` against repository HTTPS Peakbagger
fixtures in isolated headless profiles. Providers were stubbed; no authenticated
user tabs, live provider requests, saves, releases or pushes were involved.
These were DOM/SVG/layout checks; no new WebGL renderer measurement or terrain
visual certification was performed. Browser/profile/server teardown completed;
the process inspection found no remaining audit browser/server processes and
all five reported disposable profile paths were absent. The failed probe also
ran the verifier's teardown; its process was absent in the same inspection.

One disposable chart probe initially failed because its selector matched all
16 day summaries. It was corrected to the first day and rerun. That setup
failure is not a product finding. All probes were confined to the disposable
snapshot; committed runtime and test files were not edited by this audit.

Still unproven: native screen-reader output, OS/browser focus and chrome,
physical touch, live Peakbagger/provider behavior, store/package acceptance,
hosted CI, the complete general browser smoke suite, and terrain GPU/LOD
behavior. Existing audit ledgers' proof gaps remain in force. Successful tests
did not close F1–F4 at audit completion, and the concurrent weather commit was
not covered by the starting-tree full-suite result. Current remediation
verification is recorded in the closure ledger below.

## Execution order and closure ledger

Implement F1 first, F2 and F3 as separate UX fixes, then F4 as a small
performance improvement. Handle D1 independently before its deadline. Each
completed independent unit needs its own focused Conventional Commit after
appropriate checks; port the disposable repro into a durable test before
changing its runtime owner. Do not bundle an architecture rewrite into these
fixes. Preserve this ledger when the plan is eventually archived.

### Remediation commits and final integration

| Unit | Commit |
| --- | --- |
| F1 capture cooldown | `a0f5f76e` |
| F2 weather focus | `d660b677` |
| F3 metadata layout | `4040e701` |
| F4 chart efficiency | `3eef74df` |
| Browser CI and script inventory | `7b14bf1c` |
| D1 upstream review and stale-comment correction | `e97621f1` |

Final full suite: **3,257 passed, zero failures/skips** (about 41.9 seconds).
Scale suite: **14 passed, zero failures/skips** (about 22.6 seconds). Full
ESLint/build/web-ext lint passed with the same eight reviewed warnings. The
first integration run found the missing new-verifier inventory entry; it was
registered, its CI failure propagation tested, and the full suite rerun cleanly.
The focused inventory/CI/runner suite passed all 48 checks. The new interaction
gate runs after snow/card coverage in each browser; hosted CI remains unrun.

General real-manifest smoke passed in hidden Chromium 156.0.8078.4 and Firefox
158.0.1 at 1000 × 760, plus header checks at 1600/800/390 widths and enlarged
text. Chrome exercised a persisted BFCache restore; Firefox reported a
non-persisted navigation, preserving the native Firefox BFCache proof gap.

Final `--cards` gates passed in both browsers (ten case groups each, including
the durable Refresh-focus regression). Final `--interactions` gates passed
eight width/theme/zoom cases plus two desktop chart-input cases per browser;
each 120-event unchanged-sample burst produced zero child-list mutations.
Earlier German-locale runs cover the metadata matrix independently. All runs
used real unpacked `dist/`, HTTPS Peakbagger fixtures, stubbed providers and
isolated headless profiles; no live account, Save or provider write was used.
Every successful verifier reported teardown passed. Final process inspection
found no remaining verifier browser/server processes; all twelve distinct
profile paths reported in retained summaries were absent. Disposable screenshots
and logs were removed after review. Documentation checks passed; no push,
release or hosted workflow was performed. D1 is the sole remaining audit item.

### Fixed and verified

- F4: unchanged pointer sample indices no longer repaint, and the shared stable
  text helper skips identical text. No animation queue was added. New regression
  checks failed on baseline with 360 chart mutations / 120 identical text
  mutations and pass at zero after the fix. All 81 focused weather/hourly/text
  tests passed, including changed readings, resize, missing data, keyboard live
  announcements and disposal. Hidden Chromium 156.0.8078.4 and Firefox 158.0.1
  passed real hover → changed sample → pointer selection → keyboard sampling
  at 1440 × 1100 in light/dark; both browsers recorded zero child-list mutations
  for the same 120-event burst. The complete eight-case focus/metadata matrix
  also passed in each browser. Focused lint and diff checks passed. This is a
  mutation-count result, not a CPU/FPS or physical-touch performance claim.
- F3: metadata cells use noninteractive, accessibility-hidden localized clock
  and cadence reservations, preserving readable wrapping without a fixed box.
  Last usable per-domain clocks survive refresh and failed rechecks (with a
  last-known title). The new browser assertion failed on baseline after the
  first delayed reply: source height 292.17 → 309.56 CSS px. It now passes the
  pending → individual delayed reply → sibling failure transitions, comparing
  source trigger/table/footer, following card/native heading and scroll within
  1 CSS px. Eight cases per browser and locale passed: Chromium 156.0.8078.4 /
  Firefox 158.0.1, `en-US` / `de-DE`, light/dark, 375/1440 × 1100 and 100/200%
  real tab zoom; all teardowns passed. Narrow pending/ready and German dark
  renders were inspected. Firefox's installed UI language pack did not change
  Intl via preferences alone; the fixture's isolated locale service now selects
  and asserts actual content formatting. This does not prove localized browser
  chrome. Weather tests: 72 passed; focused lint and verifier tests passed.
- F2: weather Refresh and the model selector retain focus with guarded
  `aria-disabled` states. No focus restoration runs on completion. The durable
  card assertion failed on baseline focus after failure and passes with the
  fix. All 71 weather tests passed, including pending duplicates, cooldown
  expiry, rejected selector changes and a simulated timeout/retry. The new
  `weather-interactions` verifier passed eight cases in each hidden browser:
  Chromium 156.0.8078.4 and Firefox 158.0.1; 375/1440 × 1100, light/dark,
  100/200% real tab zoom. Checked held Enter/Space/pointer activation, service
  error, retry, success, deliberate focus movement, selector cooldown, action
  dimensions, panel/following-card geometry and scroll (1 px rounding tolerance).
  Narrow dark pending renders were visually inspected. Focused ESLint and
  diff checks passed; both browser teardowns passed. Timeout classification was
  injected in the unit harness; real slow-network timeout was not browser-tested.
  Verifier repairs: immediate pointer input avoids Playwright waiting for ARIA
  availability; each case resets persisted model choices. Firefox twice timed
  out in BiDi `setViewport` when narrowing directly from 200% zoom; resetting
  real tab zoom before resizing made the full transition matrix pass.
- F1: the worker now retains a five-minute fallback for unusable Peakbagger
  reset times, keeps valid provider deadlines, serializes session persistence,
  and retains the longest in-memory deadline on write failure. The new tests
  failed on the baseline (second capture reached `ready` / another request ran)
  and pass after the fix. Covered missing, malformed, past, equal-to-now,
  over-24-hour, short/long valid times, ordinary/forced retries, second tab,
  restart, expiry, concurrent refusals and failed writes. Focused worker/request
  suite: 235 passed; full suite: 3,251 passed, zero failures/skips; the additional
  concurrent-boundary test and focused lint passed. Real-manifest Chrome smoke
  passed hidden on Chromium 156.0.8078.4 at 1000 × 760, with header checks at
  1600/800/390 widths, light/dark and enlarged text; teardown passed.

### Intentionally not changed

- Manifest, settings schema, privacy boundaries and native
  Save ownership are unchanged.
- Concurrent weather work and the earlier audits' implemented fixes and
  explicit live/native verification gaps.
- The exact dependency exception and its expiry. It remains an owner decision.
- The broad card-layout observer and drag controllers. Once unchanged chart
  paints are skipped, this audit supplies no measured reason to redesign them.
- No chart-data correctness bug or response-size failure was established by
  this review; those early hypotheses are not promoted to findings.

### Changed but not fully proven

- No partially verified runtime fixes at this checkpoint. Live provider refusal
  timing, native screen-reader output, OS/browser focus and chrome, physical
  touch, native Firefox BFCache, hosted CI and store/package acceptance remain
  unproven. General hidden Chrome/Firefox smoke passes do not establish them.
  No new WebGL renderer or terrain GPU/LOD measurement was made for these
  DOM/SVG changes. A failed session write cannot persist a cooldown across
  worker termination; the running worker still enforces it.
