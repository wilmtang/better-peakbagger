# Repository layout-stability audit — 2026-10-12

Requested outcome: audit every extension-owned interactive surface for unexpected
movement through idle, pending, completion, error and retry states, then fix each
confirmed occurrence in a focused commit. Deliberate navigation, disclosures,
result insertion and user-controlled resizing remain distinct from jitter.

Status: closed locally. All thirteen confirmed finding groups are implemented
in focused commits. The final runtime snapshot and CI integration are recorded
by `40b0b20d`; no confirmed occurrence remains open in this inventory. This is
evidence for the exercised transitions, not proof of every possible live state.

2026-10-13 follow-up: user screenshots exposed presentation and interaction
regressions missed by the geometry matrix. Its original closure does not prove
compact action sizing, reorder-list alignment or correct completion semantics.
Corrections and their evidence are recorded below.

2026-10-14 follow-up: model switching still moved the summit-weather results.
The original model-refresh geometry proof covered the ascent archive, not the
summit card. This gap and the new regression matrix are recorded below; the
four additional presentation/affordance findings from the follow-up review
remain open and are not included in this weather fix.

## Baseline and method

The starting tree contained unrelated in-progress avalanche and climber-card
work. Those edits were preserved; completed shared-tree changes were inspected
as part of the current surface inventory. Static layout and green behavior
checks were not treated as transition evidence.

Hidden browser preflight loaded the real unpacked extension in Chrome for Testing
153.0.8010.12 and rendered shipped popup assets in Chrome and Firefox. Existing
capture-layout output shows the ready result area ending at 536.1 px and opening
at 564 px: feedback inserted before the action changes its position. Existing
checks cover static states but never compare the action between those states.

That coverage gap explains why the popup shift survived: independently valid
idle and pending screenshots did not assert that the user's action stayed in
place. Other omissions included replacing focused nodes on progress ticks,
intrinsic-width labels, vertically centered legacy table cells, and different
anchors in the 2D and 3D adapters. Existing Sun & Moon and weather checks already
covered some geometry; the gap was uneven coverage, not a complete absence of
UI verification. The new CI gate compares state-dependent geometry and repeated
updates across the inventory.

Use HTTPS fixtures on a real Peakbagger hostname, explicit visible postconditions,
controlled pending responses, geometry samples during transitions, narrow and
wide viewports, light/dark themes, long content and enlarged text. Keep browsers
hidden, tear down only task-owned processes/profiles, and inspect screenshots.

## Findings before runtime changes

| ID | Surface | Broken invariant / source evidence | Initial disposition |
| --- | --- | --- | --- |
| J01 | Capture popup | Selection-lock and grouping messages precede the draft button; ready/opening static geometry differs by about 28 px. | Confirmed shift; fix and add transition coverage. |
| J02 | Map-provider access pages | Centered card height changes with permission status and the second button; its primary action moves while waiting or on failure. | Reproduce all four providers. |
| J03 | Saved-GPX handoffs | Preparing/completion labels replace intrinsic-width labels in a wrapping flex row; hover also translates controls. | Reproduce pending/success/error and wrapping boundaries. |
| J04 | Report photo upload | A hidden status banner is prepended above the editor; save progress reveals it and changes labels. | Reproduce Save position during preparation/upload/failure. |
| J05 | Single-ascent backup | Idle button is replaced by short progress text, then error text plus Retry in a wrapping inline region. | Reproduce; retain stable actionable recovery. |
| J06 | Profile backup | Every progress tick replaces all body nodes, including focused Pause/Cancel controls; variable text precedes the actions. | Reproduce long names, ticks, pause/cancel and errors. |
| J07 | Settings and climber/draft workspaces | Dynamic status text shares centered rows with actions; copy/connection labels have intrinsic widths; selected filter weight changes. | Enumerate and reproduce affected paths. |
| J08 | Photo Topos | Changing estimates/status precede upload actions; card copy states and toast labels have intrinsic widths; sidebar context changes may resize the image area. | Reproduce, distinguish deliberate tool selection from jumps while drawing. |
| J09 | Peak/ascent weather | Retry/Refresh labels, conditional status content, chart-empty states and variable hover readings can change geometry. | Reproduce refresh/retry, model/day/metric switches and hover. |
| J10 | GPX Analyzer, Sun & Moon, maps | Dynamic metrics, coordinate feedback, source/interpreted buttons, Moon/readout text and map status overlays need state geometry coverage. | Inspect and exercise existing contracts. |
| J11 | Climber actions and report filters | Pending labels, membership details and feedback affect card height and placement; pressed filter font weight may reflow controls. | Inspect current shared-tree implementation and reproduce. |
| J12 | Ascent GPX processing and summit picker | Final inventory pass found pressed scaling, intrinsic-width Process progress labels, centered inline status and selection-dependent picker labels. | Confirm and fix after the climber unit. |
| J13 | Report editor contextual controls | Final report pass found caption/link label resizing and validation growth in bottom-anchored popovers; narrow footer feedback precedes Manage drafts. | Fix targeted control geometry; preserve existing overlays. |

## Surface inventory and coverage

- Popup: capture/recovery, selected peaks, opening/group warning, clear capture.
- Settings: preferences/units, route order/appearance, cache usage, ImgBB key,
  GitHub connection/verification/copy, settings/favorites/ignored/photo backups,
  confirmation/undo; standalone favorites/ignored and draft manager.
- Photo Topos: credential, import, drawing/selection, route points, viewport,
  upload estimate/save/upload, library cards/copy/delete/restore/pagination/backup,
  toast; guide navigation.
- Ascent editor: attach/process GPX, capture/prepared-draft feedback, report modes,
  contextual tools, draft/save recovery, pasted photos and Save.
- Saved ascent/profile: GPX handoffs, backup/check/retry, profile preparation and
  progress/pause/cancel/challenge/retry; owner and privacy gates stay intact.
- Peak/ascent pages: weather overview/model/refresh/retry/day/hourly/source,
  Sun & Moon date/time/disclosure, GPX analysis/selection/copy/layers/diagnostics,
  map resize/2D/3D/terrain consent/status/Sentinel imagery.
- Climber surfaces: favorite/buddy/ignore actions, hover-card placement, report
  filter controls, ignored-report visibility and ascent filters.
- Gaia/onX/AllTrails/CalTopo permission pages and provider import feedback.

## Closure ledger

### Fixed and verified

- **J13 report controls:** reserve caption/link labels and unavailable Remove
  slots. Bottom-anchored validation expands above fields/actions; recovery and
  manager feedback follow their triggers. Existing contextual overlays still
  leave the writing surface in place. Build, 117 report-editor tests and ESLint
  passed. Hidden Chrome/Firefox passed validation, link/caption states and
  recovery/manager geometry at both widths/themes. The real-extension photo
  verifier passed contextual editing, Save geometry and upload failure recovery.
- **J12 ascent processing:** reserve Process progress and picker selection
  labels; remove pressed scaling. Top-align the Preview cell and preserve the
  native Preview/Remove action row above feedback. The wide baseline exposed
  a 24.6 px Preview shift when its cell centered against a tall neighboring
  map. Forty-one tests, build and ESLint passed. Hidden Chrome/Firefox passed
  trusted file selection, held lookup, long-error fallback and picker/Cancel
  geometry at both widths/themes. The narrow screenshot was inspected.
- **J11 climber UI:** reserve action labels, keep card placement fixed during
  operations, and scroll overflowing feedback within its available viewport
  side. Retry precedes variable feedback and remains during pending recovery.
  Profile membership text follows stable buttons; remove favorite hover motion
  and reserve report-filter labels/counts. All 104 favorites tests passed, plus
  build/ESLint. Hidden Chrome/Firefox passed actual card pending/error/retry/
  success with normal/doubled text and profile feedback/hover at both widths
  and themes. Screenshots were inspected. Full Firefox passed; Chrome's
  trusted-click probe was corrected to accept a button's descendant as its event
  target. Both final real-extension checks passed.
- **J10 GPX/maps:** place stable GPX actions before variable metrics/diagnostics;
  reserve the source-view label and put coordinate feedback after the chart.
  Retry remains visible while pending. Sentinel feedback grows above its
  bottom-anchored picker and reserved retry slot. Terrain consent anchors near
  the top, keeps the enable label's size and puts errors after actions. All 104
  GPX/Sentinel/terrain tests passed with build and ESLint; hidden Chrome/Firefox
  passed controlled Sentinel requests and GPX/consent component geometry in
  both themes at 390×900 and 1280×900. Narrow screenshots were inspected.
  The full Chrome run exercised native GPX source selection and Sun & Moon;
  its two obsolete placement assertions were updated. Both final real-extension
  checks passed.
- **J10 map-anchor follow-up:** the 3D frame anchors its stack at the top, so
  its picker/retry precede feedback while the 2D stack uses the opposite order.
  Bound the 3D stack to the frame with scrolling, preserving full error text.
  Build, 44 Sentinel/terrain tests and ESLint passed. Hidden Chrome/Firefox
  passed error/retry/completion geometry in both themes/widths, including a
  180-pixel-high frame with long errors and scroll access. Narrow renders were
  inspected; this component fixture does not render WebGL.
- **J09 weather:** reserve hourly-readout wrapping from every actual possible
  reading, with hidden CSS sizing text excluded from the live region. Empty
  graphs retain plot height; Refresh/Retry retains width and ascent retry
  stays above feedback while pending. Build, 155 weather/helper tests, ESLint
  and diff checks passed. Hidden Chrome/Firefox geometry checks covered all
  numeric metrics, unavailable data, interval boundaries, hover and keyboard
  selection with normal/doubled reading text. Actual unpacked ascent weather
  passed in Chrome and Firefox; peak weather passed in Chrome, including model
  refresh, date navigation, partial/error/rate-limit states and cursor behavior.
  The narrow doubled-text empty chart was inspected.
- **J08 Photo Topos:** estimates and save feedback follow upload actions;
  toast recovery keeps a fixed width and places its reserved action at the bottom.
  Remove pressed scaling. Existing fixed canvas/status-row and chip sizing
  remain intact. All 138 photo behavior/page tests passed; final page checks,
  build and ESLint passed. Hidden Chrome/Firefox component checks covered long
  estimates, save errors, hover and copy recovery at both widths/themes, with
  footer/toast screenshots inspected. The real-extension report-photo verifier
  passed edit/selection, narrow layout, upload and exactly-once insertion.
- **J07 Settings/workspaces:** place backup/cache feedback after controls in
  wide and stacked rows; align ImgBB and buddy feedback with the top of actions.
  Reserve unit-preview, copy-code, draft-copy and My Ascents label geometry;
  keep navigation/filter font weight constant. Manual draft-copy recovery follows
  the list instead of pushing its buttons down. Build, 203 options/draft tests,
  ESLint and diff checks passed. Hidden Chrome/Firefox passed actual Settings
  unit changes and long feedback plus component copy/selection states, both
  themes at 390×900 and 1280×900 with 100% and 200% UI scaling. Unit and copy
  screenshots were inspected; component fixtures do not establish native
  clipboard permission prompts or live GitHub authorization.
- **J06 profile backup:** progress ticks update the existing readout and progress
  bar while retaining focused Pause/Cancel nodes. Actions occupy stable slots
  above feedback; preparation and cancellation retain Cancel's slot, and sizing
  labels reserve wrapping height. Twenty-one pipeline/interaction tests passed
  with build and ESLint. The shipped view callback (exposed only by the fixture)
  passed 20 alternating long/short ticks with exact focused-node retention and
  pause/request/cancellation geometry in hidden Chrome/Firefox, both themes at
  390×900 and 1280×900. The narrow pending screenshot was inspected. This view
  fixture does not make live GitHub writes; the behavior tests cover the pipeline.
- **J06 final repeated-state check:** pending pause/cancel ticks also retain
  their controls. Reserve all batch-note/pending messages; show the activity
  name on one line with its complete title and live text retained. The entire
  panel now keeps its bounds across 20 long/short reading ticks and repeated
  pending updates, preventing the ascent table below from bouncing. All 21
  profile tests and the Chrome/Firefox width/theme geometry matrix passed.
- **J05 saved-ascent backup:** preserve one button across checking, writing,
  completion and retry, reserve its widest label and put long feedback below
  without contributing to its width. Completed/current backups disable the
  action; ownership and reconciliation gates remain intact. Twenty-four tests
  passed, including node/focus preservation and trusted writes, plus build and
  ESLint. Hidden Chrome/Firefox passed pending/error/retry/success geometry in
  both themes at 390×900 and 1280×900; the narrow completion was inspected.
- **J04 report photo upload:** the pending banner moved Save 2 down 43.5 px.
  Manual-popover feedback now leaves the form in place, appears on the opposite
  viewport edge from the clicked Save, and permits dismissal after failure.
  Both Save controls retain their geometry during upload, failure and dismissal.
  The real unpacked extension passed hidden Chrome upload success and rate-limit
  fixtures at 1280×900 and 720×900, including exactly one native submission on
  success and none on failure. Twelve photo behavior tests, build and ESLint
  passed; the narrow dark error screenshot was inspected.
- **J03 saved-GPX handoffs:** Gaia preparation shrank its button by 5.5 px in
  the baseline. Reserve each provider's longest label with a hidden sizing
  label; keep feedback below the action row without affecting its intrinsic
  width, and remove the hover translation. Cover the native inline placement
  and the weather-details placement. All four providers passed pending,
  error/retry and completion plus neighboring-action geometry in hidden Chrome
  and Firefox, light/dark at 390×900 and 1280×900. The narrow dark screenshot,
  13 handoff tests, build, focused ESLint and diff checks passed.
- **J02 map-access pages:** the Gaia error path moved its action upward by
  17.3 px at 390 px before the fix. Anchor the shared card near the top of the
  viewport and use full-width actions with the completion action below it.
  All four providers now pass pending/error/denial/retry/success geometry checks
  in hidden Chrome and Firefox, both themes at 390×900 and 1280×900. The narrow
  AllTrails completion screenshot was inspected; four access behavior tests,
  build, focused ESLint and diff checks passed.
- **J01 capture popup:** feedback follows the persistent actions; opening and
  deletion failures retain the result list and original controls. The new
  `scripts/verify-layout-stability.mjs` reproduced disappearing actions before
  the fix and now compares button geometry through controlled pending, failure,
  retry, grouping completion and deletion failure. Hidden Chrome 153.0.8010.12
  and Playwright Firefox 155.0 passed in light/dark at 390×900 and 1280×900;
  the narrow dark screenshot was inspected. All 48 popup tests, focused ESLint
  and the build passed. Native popup sizing was established by the preflight;
  fixture geometry does not establish native window focus or placement.

### Intentionally not changed

- **User-requested disclosures and views:** Sun & Moon, weather day/source
  details, GPX diagnostics, Settings navigation, editor tool selection and
  manager pagination deliberately replace or expand the selected content.
  Their trigger remains an explicit control; changing those flows to fixed
  clipped panels would hide useful content. Existing browser checks cover
  the Sun/weather placements; the new matrix targets variable feedback around
  actions, not suppression of requested content.
- **Result and collection changes:** capture results, favorite/ignored lists,
  report filters, Photo Topos library deletion/restoration and draft-manager
  deletion update the visible collection. Removing a row or inserting a result
  is an intended outcome. Label/status/progress changes within those flows now
  retain action geometry; normal collection mutation remains visible.
- **Spatial interaction and completion:** dragging/resizing maps, panning,
  zooming, drawing and selecting geometry intentionally move the viewport or
  marks. Successful navigation, opening a draft, closing a dialog and native
  Preview fallback deliberately change the workflow. The fixes retain existing
  ownership, privacy, manual Save and recovery boundaries.
- **Legacy Peakbagger minimum widths:** narrow fixtures retain native tables
  and page overflow. This audit corrects state-dependent movement; it does not
  redesign the host site's layout or claim that its entire page fits 390 pixels.

### Changed but not fully proven

- Controlled APIs and component fixtures do not establish authenticated live
  provider DOM, GitHub writes, native clipboard/permission dialogs, screen-reader
  speech or visible window/focus placement. The hidden checks used modern
  browsers; browser-floor rendering and hosted CI have not been run for this
  change. The ordinary CI gate is wired and locally tested, but nothing was
  pushed or published.
- The map-control component fixture exercises shipped CSS and Sentinel behavior
  without WebGL. It proves control geometry and readable overflow, not terrain
  rendering, live imagery availability or GPU behavior.
- The matrix uses doubled reading text and 100%/200% UI scaling on selected
  surfaces. That is not native browser zoom or an accessibility review of every
  host-page layout. Focus-node retention and keyboard checks are bounded to
  the exercised paths.

## Final verification and evidence

- `npm test`: **2,720 passed, zero failures**, after all runtime fixes.
- `npm run lint`: passed, including the shipped `dist/` manifest and the six
  existing owned web-ext warnings. The added CI guard then passed with all
  thirteen focused project integration checks and focused ESLint.
- `scripts/verify-layout-stability.mjs`: **96 passed matrix cases** — twelve
  surface groups, two browsers, light/dark, 390×900 and 1280×900. Each case
  exercises multiple transitions, with one CSS pixel rounding tolerance;
  repeated progress also compares panel bounds and focused node identity.
  Chrome for Testing 153.0.8010.12 and Playwright Firefox 155.0 ran hidden.
- The final real-manifest verifiers passed in hidden Chrome 153.0.8010.12 and
  Firefox 157.0.1 at 1000×760. Both observed BFCache restoration and reported
  teardown passed. Earlier photo, weather and upload fixtures provide the
  additional widths/states recorded above. The earlier presentation audit's
  Chrome helper-adoption failure did not recur in this final run; that does
  not retrospectively establish the cause of the earlier failure.
- Relevant narrow rendered screenshots were inspected. Selected screenshots
  and exact final logs are retained in this task's local
  `repository-jitter-audit` evidence directory.
- Owned browser contexts, servers, certificates and profiles use teardown.
  A final process/path inspection found no remaining audit-owned browser or
  fixture processes or disposable directories; the user's browsers were not
  used or closed.

Reproduce with `npm run verify:layout-stability`; use `-- --surface=maps` to
isolate one group and `BPB_JITTER_ARTIFACTS` to retain renders. The ordinary
Chrome CI job now runs the complete Chrome/Firefox matrix and retains failure
evidence alongside the real-manifest and capture gates.

## 2026-10-13 correction ledger

### Fixed and verified

- **J06 compact actions:** replace full-page fractional button columns with
  content-sized slots. Reserve both primary labels and the secondary cancellation
  label, including the empty first slot during cancellation. The new compactness
  assertion failed on the original implementation. All 41 profile tests, build,
  focused ESLint and diff checks passed. Hidden Chrome 153.0.8010.12 and Firefox
  155.0 passed both themes at 390×900 and 1280×900, with additional idle checks
  at 2048×900 and 4052×900. Refresh confirmation, preparation, running, twenty
  progress ticks and pause/cancel transitions retain action geometry. Dark site
  rules are included; wide and narrow screenshots were inspected.
- **J07 reorder alignment:** the generic status-row selector matched the
  visually hidden reorder announcement and replaced all three editors' stacked
  layout with a grid. Exclude that announcement from feedback layout rules.
  The new desktop assertion reproduced the original failure. All 26 options
  settings tests, build, focused ESLint and diff checks passed. Hidden Chrome
  153.0.8010.12 and Firefox 155.0 passed both themes at 390×900 and 1280×900,
  with normal and doubled reorder text, held saves, failure/rollback and retry.
  Assertions require lists below their descriptions, matching left alignment,
  contained widths and stable setting-row bounds. Desktop and narrow enlarged
  renders were inspected; the existing settings feedback matrix also passed.
- **J05 completion semantics:** keep a sized action slot while displaying
  current/successful backups as a plain `role="status"` span. Hide the retained
  button on completion and restrict pointer/hover affordances to enabled actions.
  Regression assertions failed on the original current/success states. All 24
  ascent-backup and 11 theme tests, build, focused ESLint and diff checks passed.
  Hidden Chrome 153.0.8010.12 and Firefox 155.0 passed both themes at 390×900
  and 1280×900 with normal/doubled backup text. Controlled checking, slow writes,
  error, keyboard retry, completion and existing-backup states retain slot and
  neighboring-link geometry. Status hover has no button chrome or pointer cursor,
  the accessible button is absent, and clicking status sends no write. Completion
  renders were inspected. The real unpacked extension passed hidden Chrome at
  1000×760, including BFCache restoration and verifier teardown.

### Intentionally not changed

- Existing ownership, trusted activation, manual Save and backup transaction
  boundaries remain unchanged. Legacy host-page overflow remains out of scope.

### Changed but not fully proven

- The profile correction uses controlled APIs, so it does not prove live GitHub
  writes, native browser focus/window placement or screen-reader speech.
- The full Firefox manifest verifier was not rerun for this follow-up; Firefox
  evidence here is the shipped-asset fixture matrix. Hidden checks do not prove
  onscreen focus/window placement, native browser zoom or screen-reader speech.

## 2026-10-14 summit-weather model-switch correction

### Fixed and verified

- A held model response revealed an extra retained-model paragraph inside the
  overview. It increased the summit card and shifted its day list by 21.39 px
  at both 390×900 and 1280×900 in hidden Chrome before the fix.
- Use the existing feedback row for “Updating… Showing GFS” and failed-request
  model identity. Reserve the actual loading labels before interaction, keep
  the displayed weather mounted while pending, and associate feedback with
  the model picker. Remove the redundant paragraph above the results.
- Add a shipped-asset `weather-models` case to the ordinary CI geometry gate,
  independent of the hourly-reading case. Hidden Chrome 153.0.8010.12 and
  Firefox 155.0 passed forecast/history, light/dark, 390×900 and 1280×900,
  normal/doubled feedback text, held and repeated/superseded selections,
  completion, failure and keyboard Refresh retry. Check card/picker/Refresh,
  day-list and footer bounds during loading (1 px rounding tolerance), scroll,
  focus and retained day nodes. The real unpacked extension also passed the
  hidden Chrome summit-weather verifier at 375, 768 and 1440×1100 in both
  themes, with controlled provider responses and teardown. Desktop pending,
  narrow enlarged feedback, error and real-extension renders were inspected.
- Build and 64 focused weather/sizing/CI tests passed, as did focused ESLint
  and diff checks. The full `node --test --test-reporter=dot
  "test/**/*.test.mjs"` run failed two unchanged README assertions in
  `test/photos/photo-page.test.mjs`: documented photo budgets and exact
  saved-key storage disclosure. The README and those tests match HEAD and
  are outside this correction; the full suite is not green.

### Intentionally not changed

- A necessary error can expand below the anchored picker and Refresh button;
  it must remain readable, not clipped to preserve the card height. A new
  model's shorter forecast horizon is a deliberate completed-result change,
  not a loading placeholder. Provider/cache/cancellation/privacy semantics
  are unchanged.

### Changed but not fully proven

- Provider data is controlled in these checks, not live forecast evidence.
  Firefox evidence is the shipped-asset geometry fixture rather than a full
  Firefox manifest run. Doubled feedback text is not native browser zoom.
  Hidden checks do not establish onscreen focus/window placement, native
  select-menu behavior or screen-reader speech. The ascent-archive model
  switch is a separate surface and its prior proof is not expanded by this fix.

### Outstanding findings outside this weather correction

- Climber-card failure feedback can be below its internal scroll viewport.
- Climber Retry remains enabled but inert during an operation.
- GPX source-view button styling overrides its hidden state on warning-only
  tracks with no excluded segments.
- Report caption actions stretch to half the toolbar width.

These are confirmed findings from the 2026-10-13 review, still unfixed; they
must not be mistaken for optional cleanup or a complete audit closure.

## 2026-10-14 ascent-backup commit-row correction

### Fixed and verified

- The completion-semantics correction did not repair the audit's one-column
  backup grid: its commit link still occupied a separate feedback row. The
  new browser assertion failed before the fix, with the link center 22.92 px
  below the status center at 390×900.
- Keep plain completion status and View commit in two content-sized columns.
  Reserve the compact link footprint before completion so it does not enlarge
  the control or displace neighboring links when it appears. Progress/errors
  remain below the action; constrain the control to its available width.
- Build, all 25 ascent-backup tests, 11 contrast tests and six theme-injection
  tests passed (42 total), as did focused ESLint and diff checks. Hidden
  Chrome 153.0.8010.12 and Firefox 155.0 passed at 390×900 and 1280×900 in
  light/dark with normal/doubled backup text. New-backup, updated-backup and
  existing-backup completion remain non-button status. Assert status/link
  alignment, no overlap or clipping, stable completion/control bounds and
  native-link positions, including a representative following Add Photos link.
  Existing checking, pending, slow, error and keyboard-retry checks remain.
  Desktop and narrow enlarged completion renders were visually inspected.
- The real unpacked extension passed hidden Chrome 153.0.8010.12 at 1000×760,
  including BFCache restoration and verifier teardown.

### Intentionally not changed

- Necessary long error text may expand below the anchored backup action. If
  the native page has already wrapped its following photo link onto another
  line, that line may move by exactly that error expansion. The regression
  explicitly distinguishes this predictable disclosure from completion,
  which must restore the original row bounds and native-link positions.
- Backup ownership, trusted activation, persistence, commit URLs and manual
  Peakbagger Save boundaries are unchanged. The four earlier review findings
  remain open; this corrects the newly reported commit-row defect only.

### Changed but not fully proven

- Controlled backup responses prove presentation, not live GitHub writes.
  The fixture's following photo link is representative, not a captured live
  owner-page DOM. Firefox evidence is shipped-asset fixtures, not a new full
  manifest run. Enlarged text is not native browser zoom; hidden checks do not
  prove native window focus, placement or screen-reader speech.
- The full unit suite was not rerun for this CSS-only runtime correction. Its
  two unchanged README documentation failures recorded above remain known.

## 2026-10-14 archive-weather model preference

### Fixed and verified

- The ascent archive had no persisted model preference: every new document
  initialized Best Match. Add a separate device-local `bpbAscentWeatherModel`
  ID, validate it against the packaged registry, and restore an eligible model
  before the first summit/provider request. The persistence and delayed-read
  regressions failed on the original shipped bundle.
- Persist only explicit selections; serialize rapid writes. Initial date or
  regional fallback uses Best Match for that visit without overwriting the
  stored model. Provider failures do not silently switch models. A bounded
  local read keeps storage failure from leaving indefinite loading; generation
  checks prevent requests after opt-out or disposal. Failed writes leave the
  active data usable and show “Not remembered locally” in the existing
  description slot, with full detail in its tooltip.
- Build, all 52 ascent-weather and 59 peak-weather tests passed (111 total),
  as did focused ESLint and diff checks. Coverage includes reload/next ascent,
  ineligible dates/regions, return to eligible coverage, malformed storage,
  delayed reads, timeout/late response, opt-out, serialized writes and stale
  write failures. Only the allowlisted model ID is persisted; no ascent ID,
  date, coordinates, weather payload or peak-weather preference is written.
- The real unpacked extension passed hidden Chrome 153.0.8010.12 and Firefox
  157.0.1 at 375, 681, 768 and 1440×1100 in both themes, including teardown.
  Dedicated reload checks at 375/1440 require the very first provider request
  to use the saved model, verify explicit Best Match persistence, and verify
  that a regional fallback leaves the stored model untouched. Existing held
  model-refresh geometry, error/retry, day navigation and GPX-cursor checks
  remain. Narrow/desktop remembered-model renders were inspected. Independent
  fixtures explicitly reset the model; persistence fixtures bypass that reset.
- The generic real-manifest Chrome 153.0.8010.12 verifier also passed hidden
  at 1000×760, including worker/content startup, BFCache restore and teardown.
- Privacy and architecture documentation now distinguish archive-model
  memory from the separate peak forecast/history preferences.

### Intentionally not changed

- The preference is global to this device, not per ascent and not browser
  synced. It is excluded from settings exports and GitHub backups. No new
  setting, banner or weather request is added merely to save a choice.
- Regional and date coverage, model endpoints, weather opt-out and manual
  Peakbagger Save boundaries remain unchanged. Earlier audit findings remain
  open; this is the newly requested archive-preference behavior only.

### Changed but not fully proven

- Browser provider responses are controlled, not live forecast evidence.
  Storage rejection/timeout paths are driven in unit tests; the local-write
  failure notification was not fault-injected in a real browser. Hidden
  verification does not prove native select menus, onscreen focus/window
  placement, browser zoom or screen-reader speech.
- The full repository unit suite was not rerun; the two previously recorded
  unchanged README assertions remain known and outside this change.
