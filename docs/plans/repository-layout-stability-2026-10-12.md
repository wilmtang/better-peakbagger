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

None yet.

### Intentionally not changed

No dispositions yet. Record evidence for every deliberate layout transition.

### Changed but not fully proven

No runtime changes yet. Live authenticated provider/native-browser behavior and
any blocked fixture paths must remain explicit rather than being called closed.
