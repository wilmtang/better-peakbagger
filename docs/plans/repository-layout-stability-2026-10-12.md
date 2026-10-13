# Repository layout-stability audit — 2026-10-12

Requested outcome: audit every extension-owned interactive surface for unexpected
movement through idle, pending, completion, error and retry states, then fix each
confirmed occurrence in a focused commit. Deliberate navigation, disclosures,
result insertion and user-controlled resizing remain distinct from jitter.

## Baseline and method

The tree contains unrelated in-progress avalanche and climber-card work. Preserve
those edits. Audit existing surfaces, inspect changed surfaces too, and record
which snapshot each check covers. Do not treat static layout or green behavior
checks as transition evidence.

Hidden browser preflight loaded the real unpacked extension in Chrome for Testing
153.0.8010.12 and rendered shipped popup assets in Chrome and Firefox. Existing
capture-layout output shows the ready result area ending at 536.1 px and opening
at 564 px: feedback inserted before the action changes its position. Existing
checks cover static states but never compare the action between those states.

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

No dispositions yet. Record evidence for every deliberate layout transition.

### Changed but not fully proven

No runtime changes yet. Live authenticated provider/native-browser behavior and
any blocked fixture paths must remain explicit rather than being called closed.
