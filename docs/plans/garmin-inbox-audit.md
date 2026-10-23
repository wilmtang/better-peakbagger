# Garmin inbox implementation audit — October 23, 2026

## Fixed and verified

- **Expanded default activity group.** Mountain activities now includes rock
  climbing and backcountry skiing alongside hikes, walks, trail runs and
  mountaineering. The existing stored preference is preserved; inbox titles
  identify the added sports. The importer regression failed before the change
  because both new types were missing, then passed with duplicate protection
  and the All activities alternative checked. All 77 Garmin/schema tests and
  focused ESLint pass. All 12 hidden Garmin fixture cases passed in Chrome 156
  and Firefox 157, including stable group switching and saving in both themes
  at 1180×1000 and 390×1000, plus group switching at 200% CSS zoom on desktop.
  Desktop, narrow and enlarged settings screenshots were inspected.
  The rebuilt unpacked extension passed its hidden Chrome 156 check. These
  static DOM/CSS checks stub provider replies and do not prove native menus.
- **P2: oversized, inconsistent action buttons.** Garmin now uses the shared
  compact panel button component; Reconnect is secondary when connected.
  The [panel button audit](panel-button-audit.md) records the migration,
  transition checks, popup fit correction and retained verification limits.
- **P2: the broad activity filter claimed to exclude indoor activities.** Renamed
  it to **All activities** and documented the two filters' actual scope. Filtering
  behavior is unchanged. Three Garmin UI unit tests and all 12 hidden Chrome
  156/Firefox 157 fixture cases pass; selected-option screenshots were inspected
  at desktop and narrow widths. This verifies the label, not live recording
  support for every Garmin sport.
- **P2: Garmin connection was missing from settings navigation.** Added its
  sidebar entry and accessible heading association. The earlier isolated Garmin
  fixture disabled the main options controller, and the options fixture omitted
  the Garmin bundle. Options tests now load both and require one sidebar link
  per subsection; both new regressions failed against the missing-link version.
  All 211 options/Garmin UI tests pass. Hidden Chrome 156 and Firefox 158 checks
  load the real extension and verify Garmin clicks, deep links, active states,
  Back/Forward and stable navigation/content frames in both themes at
  1982×1000, 1000×760, 1000×420 and 480×760. Desktop and narrow screenshots were
  inspected. The established narrow layout shows parent chips only; Garmin
  deep links still work there. These checks do not prove native browser focus.
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

- The added sport filters use recorded Garmin type keys; their live recordings
  have not been downloaded in this follow-up. Garmin uses the combined
  `backcountry_skiing_snowboarding` key, also present in the
  [tapiriik Garmin adapter](https://github.com/cpfair/tapiriik/blob/master/tapiriik/services/GarminConnect/garminconnect.py).
- Native permission prompts, a truly expired Garmin key, and live browser
  provider/Peakbagger sessions have not been verified. The authorized live Node
  API test verified identity, 12 activity summaries and one FIT recording.
- Garmin distribution agreement review remains open.
