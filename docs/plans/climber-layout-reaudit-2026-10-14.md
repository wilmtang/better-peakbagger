# Climber interaction and layout re-audit — 2026-10-14

Status: **remediation in progress**. C01–C07 have focused corrections;
final C08 baseline/integration proof and O01/O02 remain open. This is the re-audit of the Buddy/Favorite/Ignore
page-jump report; the focused remediation order is recorded separately below.

Audited runtime: `c27e3dad`, including the earlier `95bcaa15` climber
layout-stability changes. The pending peak-name request was completed separately
in `c27e3dad`; it is not part of climber remediation.

## Outcome and scope

The reported page movement is real. The old checks prove that selected buttons
remain anchored, not that the heading row, native Buddy controls, following
tables, visible feedback or recovery affordances remain usable. The archived
[layout-stability audit](../archive/repository-layout-stability-2026-10-12.md)
cannot be treated as complete UX closure while these findings remain open.

Scope: public other-climber profile Favorite/Ignore controls, supported native
AddBuddy/RemoveBuddy actions, shared membership/pending-intent presentation,
hover-card errors/recovery and the gates claiming to verify these interactions.
This is not a fresh audit of every extension surface. Earlier GPX/report
regressions remain explicitly carried below.

## Evidence and limitations

- `node --test test/favorites/climber-favorite.test.mjs
  test/favorites/climber-ignore.test.mjs
  test/favorites/climber-hover-card.test.mjs
  test/favorites/climber-membership.test.mjs
  test/favorites/climber-card-state.test.mjs`: **42 passed**.
- The unchanged `node scripts/verify-layout-stability.mjs --surface=climbers`
  passed all eight Chrome/Firefox × light/dark × 390/1280 cases. Those green
  results coexist with the reproduced failures below.
- A separate read-only audit probe executed the shipped `dist/` IIFEs against
  disposable HTTPS `www.peakbagger.com` fixtures with controlled extension APIs
  and Buddy POST responses. It captured **480 profile and 96 card states** in
  hidden Chrome 153.0.8010.12 and Playwright Firefox 155.0: light/dark,
  390/768/1280×900, normal/enlarged text. Held operations expose pending states
  deterministically; checks wait for visible state and animation settlement.
- Profile markup combines the masked supported Buddy form with the packaged
  archived native `pb.css`, a centered heading cell and representative following
  content. It is not a new live Damon Up DOM capture. The enlarged matrix doubles
  profile action/feedback text and enlarges the heading; it is not native zoom.
- Inspected desktop profile idle/pending and wide/narrow card-error screenshots.
  No live lists were changed, no account POST was sent, and no user browser was
  raised. API fixtures do not prove current server behavior, real cross-tab
  worker execution or native accessibility. The real worker policy was separately
  invoked with an unresolved Buddy intent and correctly returned `list-conflict`.
- Reproduction script, JSON and PNG evidence are retained in the task's
  `climber-re-audit` visualization directory: `audit-climber-layout.mjs`,
  `profile-evidence.json`, `card-evidence.json`. They are task artifacts, not
  production/test-suite changes. No climber runtime file was modified.
- Final process/profile inspection found no task-owned verification browser or
  disposable fixture/profile directory remaining; retained evidence is separate.
- Full repository tests were not rerun for this documentation-only audit. The
  two unchanged README assertions recorded in the earlier ledger remain known.

### Measured normal-text profile movement

Controlled dark fixture; changes are relative to that action's idle state.
Positive values move following content downward. Light mode also reproduces.

| Transition | Chrome 1280 | Firefox 1280 | Chrome 390 | Firefox 390 |
| --- | ---: | ---: | ---: | ---: |
| Favorite add/remove pending: following table Y | +11.44 px | +12.00 px | +24.80 px | +24.80 px |
| Buddy add/remove pending: following table Y | +45.03 px | +45.60 px | +74.39 px | +75.40 px |
| Ignore completion: following table Y | +45.03 px | +45.60 px | +58.39 px | +58.40 px |
| Long Ignore error: following table Y | +196.20 px | +196.80 px | +209.56 px | +209.60 px |
| Long Ignore error: heading/button X | −30.53 px | −30.53 px | 0 px | 0 px |
| Buddy Add → Remove control width | +41.47 px | +41.02 px | +41.47 px | +41.02 px |

The normal pending Favorite/Buddy and Ignore→Unignore feedback reversals move
the following table back up. Ignore retry removes the entire error block and
then adds completion feedback again. Enlarged-text desktop Buddy pending moves
following content **141.25 px in Chrome / 139.83 px in Firefox**. These are
fixture measurements, not estimates of the exact pixels in the user screenshot.

## Findings

### C01 — P1: shared profile guidance changes the entire heading-row height

Evidence: `src/favorites/climber-ignore.js` (lines 19–29, 54–73, 80–88).
The feedback lives inside the same inline-flex title host as the name, star and
Ignore button. `contain:inline-size` excludes its text from intrinsic width,
so multi-line notes wrap into the small action-group width. Hiding/revealing
the note changes the row height and moves every following native control/table.
The star and Ignore button can stay perfectly still while the page jumps.

This is mixed provenance: changing inline-flex feedback into a narrow grid with
inline-size containment and baseline alignment came from `95bcaa15`; conditional
pending/ignored text existed earlier. The audit did not eliminate reflow and
made long feedback much taller. It should not be reported as a wholly new
membership logic bug.

Proposed correction: separate action-row sizing from a single, compact profile
feedback region. Reserve room for normal short progress/completion copy before
starting work, and do not put transaction status in a narrow column under Ignore.
Long errors must remain readable, with a concise visible summary and an explicit
detail disclosure if needed, rather than a huge permanent spacer or clipped text.

Acceptance: add/remove Favorite, add/remove Buddy, Ignore/Unignore, slow results,
failure and retry keep the action row and following reading position stable
within 1 px for normal feedback. Any necessary expanded error detail has one
documented, user-requested expansion; no auto-scroll or hidden-error workaround.

### C02 — P2: the reserved Retry cell creates a third column instead of staying fixed

Evidence: `src/favorites/climber-ignore.js` (lines 21–23, 47–48, 73).
The invisible `::after` occupies grid area `1 / 2`, but the actual Retry button
has only `grid-row:1`, leaving its column automatic. When Retry appears, it goes
into an implicit third column. Both browsers report `83px 53.06px` at idle and
`83px 53.06px 53.06px` on error. The centered title host gets wider, moving the
name, star and Ignore approximately 30.53 px left. Retry then disappears during
retry, moving them back. This reservation regression is attributable to `95bcaa15`.

Proposed correction: put the real Retry control in the same intended slot as its
reservation, size that slot from the actual control typography, and confirm the
idle appearance remains compact. Preserve real hidden semantics.

Acceptance: computed grid never acquires an implicit recovery column; heading,
Favorite, Ignore and visible Retry geometry remain stable through error/retry
at narrow widths and enlarged text. A placeholder alone is not acceptance proof.

### C03 — P2: native Buddy labels and appended feedback have no stable layout contract

Evidence: `src/favorites/climber-favorite.js` (lines 161–199),
`src/favorites/buddy-client.js` (lines 95–102).
On first activation, the code appends a new status span and hidden check button
after the native input. Loading, success, warning and error copy have arbitrary
length. Add/Remove labels also change the native control's width by about 41 px;
the BuddyLabel changes length separately. At 390px, retained success copy forces
an extra 16/17px row even after heading feedback disappears.

This behavior predates the layout audit (`4a6d56aa`) and was missed, not introduced
by `95bcaa15`. The supported AddBuddy/RemoveBuddy form differs from the legacy
BuddyButton used in the old geometry gate.

Proposed correction: keep the native action and relationship label readable but
give the action/check/status group stable sizing before activation. Use one
truthful feedback owner; do not display "Saving…" beside a large unrelated
"Refresh this page before ignoring" warning for an ordinary in-flight save.
Retain status-only recovery after uncertain POSTs; never automatically resend.

Acceptance: supported submit and legacy controls, add/remove/check-only paths,
first activation and subsequent attempts preserve dimensions, position and
neighboring content through pending/success/error. Warning and long-error
native paths need browser proof; this audit captured supported success/pending
but did not inject every native POST failure.

### C04 — P2: profile Ignore ignores durable unresolved Buddy intents

Evidence: `src/favorites/climber-ignore.js` (lines 54–79),
`src/favorites/climber-membership.js` (lines 27–32),
`src/favorites/climber-card-state.js` (lines 27–42),
`src/background/climber-list-policy.js` (lines 48–53).
The membership observer already supplies `buddyIntents`, and the card uses them.
The profile checks only a DOM pending marker and cached/native membership. Once
the local pending marker is cleared—or another tab produced the unresolved
intent—the profile enables Ignore with no guidance. All 24 matrix variants
reproduced this after publishing a valid dispatched intent with an expired lease.
The production worker correctly refuses Ignore with "Check the pending buddy
change before ignoring." This is inconsistent affordance/recovery, not a bypass
of the worker's safety policy. Lease expiry intentionally does not remove that
protection. This is an older missed defect, not a CSS audit regression.

Proposed correction: derive profile and card eligibility from the same validated
membership/pending state, distinguish local work in progress from unconfirmed
remote outcome, and expose an appropriate status-only check without requiring a
blind refresh. Do not clear reservations or weaken the worker gate to hide errors.

Acceptance: another-tab intents, reload after uncertain POST, failed confirmation
and confirmed-with-warning cases show truthful disabled/add/recovery affordances.
Ignore removal stays available when safe; no duplicated Buddy POST or lost intent.

### C05 — P2: profile Favorite failures are reported only in a tooltip

Evidence: `src/favorites/climber-favorite.js` (lines 318–330, 339–357).
A failed add/remove clears busy state, keeps the old star and sets `button.title`
to the error. There is no visible error or live announcement on this surface.
The matrix reproduced the long error only in the title attribute; the page looks
idle again. Keyboard and touch users cannot rely on a mouse-hover tooltip.
This predates the layout audit and belongs with the shared profile feedback fix.

Proposed correction: show concise failure/recovery feedback in C01's stable
region and announce it accessibly. Do not add another independently expanding
banner or make a failed operation look successful.

Acceptance: failed add and removal preserve the actual state, expose readable
visible feedback without hover, announce once, and let the user retry explicitly.

### C06 — P1: card geometry is stable by making the error entirely invisible

Evidence: `src/favorites/climber-hover-card.js` (lines 108–115, 183–193),
`src/favorites/climber-hover-card.css` (lines 13–17, 42–48).
An above-anchor card caps maximum height to its *initial* content height. Paint
does not reposition or allocate feedback room when new status arrives. In the
normal-text probe the card occupies Y=432.5–714; after failure the error begins
at Y=742. Its scroll height grows from 280 to 433px while scrollTop stays zero.
The entire error is outside the visible viewport, though the action bounds are
unchanged. Screenshots show only an unexplained Retry. Both browsers reproduce.

This is one of the previously open findings and is attributable to `95bcaa15`'s
placement-freezing strategy. It is reverified here, not counted as already fixed.

Proposed correction: design readable feedback room before starting a mutation,
using a compact summary/recovery area or a separate scrolling detail region.
Keep the primary controls and card side anchored without freezing away new
content. No forced scroll/focus move merely to compensate for missing layout.

Acceptance: errors, warnings and completion are visibly understandable without
scrolling/searching. Above/below/middle anchors, small viewports, both themes,
enlarged text and native zoom retain usable action and recovery geometry.

### C07 — P2: card Retry is enabled while its handler refuses to act

Evidence: `src/favorites/climber-hover-card.js` (lines 111–115, 373–376).
The layout change retains Retry during an operation to reserve its position,
but never disables it. The handler immediately returns when `operation` exists.
After an error, starting another Favorite save leaves `aria-busy=true` with
visible `Retry.disabled=false`. A real click focuses Retry and sends nothing:
the fixture message count stays two. Both browsers reproduce. This is the
second previously open card finding, introduced by `95bcaa15`.

Proposed correction: retain geometry while making unavailable recovery actually
disabled with truthful busy semantics. Clarify whether retry means status/list
reconciliation or repeating a local change; Buddy uncertainty must remain a
status check, never an automatic POST retry.

Acceptance: pointer and Enter/Space receive consistent enabled/disabled behavior;
pending recovery has no fake click affordance; the completed state restores the
correct actionable control without shifting it.

### C08 — P1: the verification gate and closure wording certify the wrong invariant

Evidence: `scripts/verify-layout-stability.mjs` (lines 842–879),
`scripts/verify-climber-membership.mjs` (lines 10–39), and the historical
J11 closure in the linked layout ledger.
The gate checks the card Favorite/Buddy bounds. The profile test injects a storage
change and checks only Ignore/star bounds; its fixture has legacy BuddyButton,
not the supported submit-form flow. It never checks the title-row height, table
position, native action labels, error visibility or Retry availability. The
manifest membership checks inspect final clipping/protection, not transitions.
This explains the repeated green result alongside bad UX; it is not a browser
rendering limitation or a reason to weaken layout assertions.

Proposed correction: add real activation with controlled response timing and
rendered-frame measurements for the full action region and following content,
plus independent assertions that feedback/recovery are visible and meaningful.
Run the new tests against the old tree to require genuine baseline failures.
Replace unqualified closure wording and keep findings open until every relevant
state has evidence. Do not tune fixtures or tolerances to current broken geometry.

Acceptance: at least C01/C02/C03/C06/C07 fail the old gate with new assertions;
cover local storage notifications, supported native forms, slow/error/retry and
keyboard paths in both engines. Ordinary geometry permits only 1px rounding;
explicit disclosures/navigation have documented separate expectations.

## Focused implementation order (not executed)

1. **C08 regression gate + C01/C02/C05 profile feedback**, one focused commit
   with the tests that demonstrate these defects. Preserve the heading and
   native reading position; avoid premature broad CSS changes.
2. **C03 native Buddy presentation**, separate commit; retain transport identity,
   reservations, confirmed completion and no-repeat POST behavior.
3. **C04 coherent pending-state affordances**, separate commit with worker/profile/
   card agreement tests; keep read-only recovery distinct from new mutation.
4. **C06/C07 hover-card feedback/recovery**, separate commit with visible-content
   checks as well as stable action bounds. Verify short and long errors, both
   placement sides and viewport edges before committing.
5. Run real-manifest checks after content-script changes; run the focused/full
   unit checks, documentation checks and final process/profile cleanup. Archive
   only when the closure ledger below is updated with actual proof.

## Carry-forward findings outside the climber scope

- **O01 OPEN — GPX source-view hidden-state regression:**
  `src/gpx/gpx-panel-css.js` (lines 190–196) still sets explicit display for the
  source-view button without honoring its own hidden state. Warning-only tracks
  with no excluded segments were confirmed in the earlier ledger. Revalidate
  the rendered warning-only path before a focused fix; no new GPX browser run
  is claimed by this climber audit.
- **O02 OPEN — stretched report-caption controls:**
  `src/reports/report-editor.css` (lines 265–271) still gives caption actions two
  equal fractional columns. The earlier review confirmed half-toolbar-width
  buttons. Preserve compact actions and prove hidden/label transitions in a
  separate report fix; no new report-browser run is claimed here.

Earlier stretched backup actions, Settings reorder layout, inert completed
backup status, commit-link wrapping, weather refresh/model memory and independent
weather-day disclosure corrections remain separate completed commits. They are
not silently re-opened or used as proof that climber UX is now fixed.

## Closure ledger

### Fixed and verified

- C06/C07: the card now scrolls its action body independently of its reserved
  feedback footer. A short visible summary and explicit full-details pane
  replace invisible errors. Favorite/source and Ignore-detail readings reserve
  real alternatives, including a fail-closed settings error. Small viewports
  allocate at least one readable primary control; explicit details scroll inside
  their pane without moving the page. Body/detail scrolling does not reposition
  the anchor. Error announcements retain the complete message.
- Recovery is disabled through mutations and slow read-only checks. "Check
  lists" describes actual reconciliation rather than implying a repeated write;
  Buddy recovery remains "Check status". Both captions reserve their dimensions.
  The visibility and unavailable-recovery tests independently failed the old
  card. All 25 focused card/state/feedback/membership tests passed; build and
  focused ESLint passed. The initial 24×3 placement matrix and replacement
  eight-case gate passed; the expanded check covers 144 positions across both
  engines, themes, 390/768/1280 widths, normal/enlarged text and 900/540 heights.
  Pointer, slow reads, settings failure, repeated mutation failure, full details
  and recovery target geometry are exercised. Wide/narrow error and details
  renders were inspected. Real unpacked Chrome startup/BFCache/teardown passed.
- The final 144-position card run passed with Enter/Space, repeated-key write
  suppression, preserved focus and visible initial keyboard targets. Firefox
  focus loss from physically disabling the active action was reproduced and
  corrected with guarded `aria-disabled` ownership; unrelated unavailable
  controls remain physically disabled. A real Firefox boundary-wheel probe
  moved the document 508px despite CSS containment; the card now consumes only
  actual scroller-boundary gestures. Normal scrolling is unchanged. Wheel
  testing is isolated from save geometry so compositor gestures cannot corrupt
  those comparisons. Profile/native busy-focus coverage remains for final C08.
- C04: Ignore now uses the shared validated card eligibility and durable intent
  protection. Profile/card/native Buddy actions agree on live leases and other
  accounts; expired intents remain protected but permit explicit status checks.
  The membership observer republishes at lease deadlines and cancels its timer
  on stop. It never clears or writes an intent. Safe removals and independent
  Favorite actions remain available. Recovery eligibility is rechecked when
  concurrent list changes invalidate a previous action.
- Two new profile tests failed the old bundle on unresolved-intent eligibility.
  All 63 focused profile/card/membership/worker-policy tests passed, including
  deterministic timer cancellation, confirmed-status live leases, other-tab
  publication and safe Unignore. The 24-case hidden pending-state matrix passed
  in both engines: active/expired/failed/reconciled/other-account states, both
  profile and card recovery, with zero POSTs for reconciliation. The combined
  profile/native matrix also passed, including invalidated recovery. Build,
  focused ESLint and real unpacked hidden Chrome startup/BFCache/teardown passed.
- C03: native Buddy inputs retain their exact identity, accessible value and form
  association while visible captions reserve the largest real alternative and
  can wrap. The relationship label reserves its alternatives too. Save, warning,
  uncertainty and legacy request-limit feedback use the existing profile region,
  not newly appended native rows. Recovery is explicitly status-only.
- The native Buddy check failed the preceding bundle on a 16px first-activation
  row shift. The combined profile/supported/legacy matrix passed 24 hidden
  browser/theme/width/text-scale variants. Supported checks cover add/remove,
  failed begin, uncertain POST, read-only recovery and confirmed-with-warning;
  recovery sends no additional POST. Existing Buddy adapter/store safety tests
  and the new exact native-form preservation test passed (40 focused tests).
  Build, focused ESLint/diff checks, the integrated eight-case gate and real
  unpacked hidden Chrome startup/BFCache/teardown passed. Wide dark and narrow
  light warning renders were inspected; a dark caption repaint conflict was
  corrected and now has a computed-color regression assertion.
- C01/C02/C05: profile feedback now has one compact, two-line region outside
  the centered heading/action host. Short failure summaries and explicit full
  Details replace tooltip-only failures and automatic error expansion. Ignore
  labels reserve their actual text geometry; Retry has no title-grid column and
  is disabled during its operation. No huge fixed-height error spacer or scroll
  compensation. The new test failed the old bundle on a 24.8px title-row shift;
  the Favorite failure behavior test also failed the old bundle.
- Shipped profile transitions passed all 24 hidden Chrome 153.0.8010.12 /
  Playwright Firefox 155.0 combinations, light/dark, 390/768/1280×900,
  normal/enlarged text. Three rendered frames per state measure the heading,
  both controls, Buddy region and following native content within 1px. Enter,
  Space and pointer recovery cover long errors, repeated failures and deliberate
  detail expansion/collapse. Focused unit tests passed 31; build and focused
  ESLint passed. Real unpacked Chrome startup/BFCache/teardown passed hidden at
  1000×760. Full climber closure is not claimed by this first correction.
- Audit evidence and priority/acceptance plan are produced; the active index and
  former closure claim are corrected. Other finding groups remain open.
- The independent unfinished peak-name request is completed in `c27e3dad`, with
  its checks and live-proof limits recorded in the archived ledger.

### Intentionally not changed

- Real lists, Buddy mutation transport, membership safeguards,
  opt-in Favorite removal, manual Peakbagger Save and current user browser state.
- No global CSS rollback, large fixed-height spacer, auto-scroll workaround,
  wider permissions or destructive list reconciliation is authorized by an audit.

### Changed but not fully proven

- Final C08 integration/baseline proof and carried GPX/report remediation
  remain open. Hidden controlled probes do not prove live server compatibility.
- Native browser zoom, live Brave/authenticated DOM, screen-reader speech,
  touch, every native POST failure/check-only recovery and actual multi-window
  worker timing remain unverified. Dependency/security/release readiness was not
  re-audited. Known full-suite README failures remain separate.
