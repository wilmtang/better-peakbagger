# Garmin inbox implementation audit — October 23, 2026

## Fixed and verified

- **P1: background completion could undo dismissal.** The retained item now has
  a revision; both successful and failed preparation check it and the dismissal
  and handoff state before writing. The regression failed with one visible item
  after dismissal before the fix, and passes with zero afterward.
- **P1: full-history requests could disappear behind recent checks.** Concurrent
  full requests coalesce into a subsequent full check. A partial recent cursor
  no longer determines the explicit full range. The regression failed before
  the fix and passes afterward.
- **P1: stale or invalid draft selection could lock an activity.** Validate the
  selection before recording a handoff and recheck the live item during the
  transaction. The bundled-worker test verifies that invalid selections leave
  the activity unlocked, valid opening succeeds, and repetition reuses forms.
- **P2: refreshed results and recovery controls stayed stale.** Review now offers
  updated matches explicitly, preserves selection until accepted, shows the
  saved-ascent link after opening drafts and disables incompatible actions.
  Explicit navigation transfers focus; background polling does not. The new
  stale-review regression failed before the fix and passes afterward.
- **P2: recovery copy could mislead.** Disconnected users see connection guidance;
  removed permission offers Allow Garmin access instead of Update key.
  Transport errors survive background status polls.
- **P2: new ZIP bundle included legacy dynamic evaluation.** The build applies
  a version-checked patch that accepts function callbacks only. DEFLATE/FIT
  decoding passes with VM dynamic code generation disabled; string callbacks
  are rejected. Packaging lint passes without increasing warning allowances.

Validation: all **3,370 tests** passed; `npm run lint` passed with the existing
eight owned warnings and no new allowances. Hidden Chrome 156 and Firefox 158 real-extension
checks passed. Twelve Garmin fixture cases passed in Chrome 156 and Firefox 157,
including both themes at 390×1000 and 1180×1000, popup at 390×700, 200% CSS zoom,
updated-match acceptance and pending → handoff recovery. Button, heading,
following-content and scroll geometry use a 1px tolerance; keyboard focus and
duplicate activation are checked. Review screenshots were visually inspected.
Documentation/inventory checks passed 46 cases. Browser checks used static
DOM/CSS surfaces (no WebGL renderer claim), and fixture transport/session replies
were stubbed. They do not prove native browser permission dialogs or OS focus.
The two stalled UI-verifier process trees and their exact disposable profiles
and certificates were removed; subsequent completed checks reported teardown.
Final process inspection found no remaining Garmin UI verifier processes.

## Intentionally not changed

- Peakbagger Save remains a user action. An expired or uncertain form handoff
  requires reviewing existing saved ascents; it does not automatically replay.
- Activity-date pagination plus overlapping checks and periodic full-history
  reconciliation remain necessary; upload-date sorting was not honored in the
  investigation.
- Business enrollment and publishing remain outside this local implementation.

## Changed but not fully proven

- Native permission prompts, a truly expired Garmin key, and live browser
  provider/Peakbagger sessions have not been verified. The authorized live Node
  API test verified identity, 12 activity summaries and one FIT recording.
- Garmin distribution agreement review remains open.
