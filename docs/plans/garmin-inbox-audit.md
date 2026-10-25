# Garmin inbox implementation audit — October 23, 2026

## Fixed and verified

- **Connection now implies draft enablement (October 25).** Connecting or
  importing a validated key starts the chosen import schedule, including for
  already-saved keys with the old enable flag unset. Cached summaries follow
  the same rule. Discovery can queue activities before Peakbagger is open;
  the first verified account is recorded for the queue before route download,
  and later checks retain that account. The redundant Enable button is gone;
  Allow Garmin access appears only to restore revoked browser permission.
  The new importer assertions failed before the change, and the browser
  assertion failed against a disposable original UI with one visible extra
  activation button. Verified: 3,534 full-suite tests, then all 81 Garmin tests
  and four focused settings tests after the final regression additions;
  focused ESLint and three documentation checks pass. All 16 Garmin fixture
  cases pass in hidden Chrome 156 and Firefox 157, including connection
  pending/rejection/retry, permission recovery, and waiting for Peakbagger →
  account-bound status. Both themes at 1180×1000 and 390×1000, plus 200% CSS
  zoom on desktop, preserve action/panel/following-content and scroll geometry
  within 1px during applicable transitions. Initial connection deliberately
  reveals preferences below the anchored connection action. Desktop, narrow
  and enlarged screenshots were inspected. The import-confirmation copy was
  also rendered in both browsers/themes/sizes with its controller stubbed.
  The rebuilt real extension passes hidden Chrome 156 at 1000×760. These are
  DOM/CSS checks with synthetic provider/session responses; native permission
  dialogs, OS focus and live Garmin/Peakbagger integration remain unproven.

- **General master switch.** Garmin activity inbox defaults on; disabling it
  cancels in-flight work, removes its alarm and blocks manual/visit-triggered
  processing. Popup, connection section and sidebar entry hide. Existing keys,
  queue and duplicate receipts are retained. Bookmarked inboxes explain the
  disabled state; old settings links return to General, including same-document
  fragment navigation. The alarm regression failed before implementation and
  passes afterward. Verified: full suite 3,386 passing tests, then 143 focused
  tests after the fragment fix; full ESLint and packaging lint (eight existing
  warnings); all 12 Garmin UI fixture cases in hidden Chrome 156/Firefox 157;
  real unpacked-extension checks in hidden Chrome 156/Firefox 158. Off/on,
  saved-state restoration and disabled deep links pass in both themes. Switch
  and scroll geometry stay within 1px. Chrome settings viewports: 1982×1000,
  1000×760, 1000×420 and 480×760; Firefox content viewports: 1982×915, 1000×675,
  1000×347 and 500×675. Desktop/narrow settings and disabled popup screenshots
  were inspected. Static DOM/CSS checks do not establish native focus or
  permission prompts. Process and profile inspection confirmed teardown.

- **Blocked summit lookups now retain a durable queue.** Discovery continues;
  peak preparation pauses after a challenge, missing session or rate limit.
  Loading or selecting a completed active Peakbagger page resumes bounded
  preparation batches without rescanning Garmin history or opening a helper
  tab. The inbox and popup expose the waiting count. Manual-only discovery
  remains manual; visiting Peakbagger can finish previously queued activities.
  Verified: 335 Garmin, worker and popup tests; focused ESLint; the real
  unpacked extension in hidden Chrome 156 at 1000×760; all 12 hidden Garmin
  UI cases in Chrome 156 and Firefox 157. Both themes at 1180×1000 and
  390×1000 preserve the button, heading, list, footer and scroll geometry
  through challenge → rate-limit feedback. The narrow rendered queue was
  inspected. Provider replies are stubbed; these are DOM/CSS checks.

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

- Queue recovery uses synthetic challenge and cooldown responses in tests;
  completion of a real interactive Cloudflare challenge remains unverified.

- The added sport filters use recorded Garmin type keys; their live recordings
  have not been downloaded in this follow-up. Garmin uses the combined
  `backcountry_skiing_snowboarding` key, also present in the
  [tapiriik Garmin adapter](https://github.com/cpfair/tapiriik/blob/master/tapiriik/services/GarminConnect/garminconnect.py).
- Native permission prompts, a truly expired Garmin key, and live browser
  provider/Peakbagger sessions have not been verified. The authorized live Node
  API test verified identity, 12 activity summaries and one FIT recording.
- Garmin distribution agreement review remains open.
