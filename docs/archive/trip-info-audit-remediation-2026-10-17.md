# Trip Info audit remediation

Date: 2026-10-17. Scope: the two findings from the requested audit of
**Trip info for multiple peaks**. Both fixes are complete locally; live
Peakbagger persistence remains outside the evidence below.

## Fixed and verified

### F1 — Incomplete Trip Info could silently reach GPS Preview

Previously, the draft filler ignored a failed **Add New Trip** selection and
treated requested trip fields as optional. An incomplete form could therefore
continue into GPS Preview without the promised trip or sequence.

Commit `9c87e39d` makes requested Trip Info a prerequisite in
[the draft filler](../../src/ascent/ascent-draft.js). The selector must belong to
the ascent form and have one enabled, unambiguous target option. Sequence must
be editable; a new trip additionally requires editable name and nights fields.
Validation runs before filling and again after native change handlers. Failure
uses the existing rollback, blocked Save controls, and **Reload ascent form**
recovery.

The missing-option and missing-sequence regression assertions were first run
against the original implementation. Both failed because GPS Preview actually
ran, rather than because of a fixture setup error or timeout. The fixed build
passes [all 45 ascent draft tests](../../test/ascent/ascent-draft.test.mjs),
including malformed controls, native handlers changing the form, shared-trip
fields, and preservation of existing manual Trip Info.

### F2 — Settings promised an activity-title trip name

Commit `2929d0d8` corrects [the Settings description](../../options/options.html)
to describe the existing activity start-date name, selected-summit fallback
when no date is available, and track-order sequencing. The naming algorithm
was already intentional and is unchanged.

## Intentionally not changed

- Trip Info is supplied only when the setting is enabled and at least two
  peaks are selected. Drafts without requested Trip Info still tolerate absent
  trip controls.
- Shared trips need only the trip selector and sequence, not new-trip name or
  nights inputs. Reusing a form preserves existing manual Trip Info.
- Names use the activity-local start date in `YYYY-MM-DD` form, falling back to
  selected summit names in track order, bounded to 200 characters.
- The user reviews and saves every ascent. After the first manual save creates
  the trip, later drafts use its shared ID and track-order sequence. No extension
  path clicks a Peakbagger Save control.
- [Saved-ascent verification](../../src/ascent/capture-save-verification.js)
  checks the shared trip ID and complete GPX. It does not assert that the saved
  name or sequence still matches the prepared values; manual edits remain
  possible. Local fixture assertions of those values are not live-server proof.

## Changed but not fully proven

- F1 is verified against packaged code and native-form fixtures. No live
  Peakbagger save was attempted, so current server persistence, WebForms
  postbacks, and live provider exports remain unverified.
- The malformed-form browser fixture stubs worker replies and native Preview
  submission. The separate three-summit verifier loads the real unpacked
  extension, but its Peakbagger server and manual saves are local fixtures.
- Hidden browser checks establish DOM focus, rendered wrapping, and geometry.
  They do not establish native window placement, browser chrome, or
  screen-reader speech.

## Verification record

- `npm run build`: passed before tests and browser checks.
- Focused ESLint for the draft implementation and its tests: passed.
- Capture integration: 372 tests passed across capture core, worker capture,
  local GPX processing, ascent draft/upload, and saved-ascent verification.
  The 45 draft tests above are included in this count.
- Options UI/settings: 68 tests passed.
- `node scripts/verify-extension.mjs`: passed with the real unpacked extension
  in hidden Chrome 153.0.8010.12 at 1000 × 760; teardown passed.
- `node scripts/verify-multi-summit.mjs`: passed for Strava and local-upload
  fixtures, each manually saving three ascents into one date-named trip with
  sequences 1–3, suffixes a/b/c, and the complete GPX. Hidden Chrome
  153.0.8010.12 at 1000 × 760.
- A temporary malformed-form browser probe passed 16 cases each in hidden
  Chrome 153.0.8010.12 and Firefox 155.0: widths 1000 and 390, height 760,
  light/dark, and CSS zoom 100%/200%. Missing trip option/sequence and repeated
  failure notifications preserved Save controls, heading, following native
  content, scroll, and recovery-action focus; Preview acknowledgements and
  submissions remained zero. Desktop/narrow screenshots were inspected.
- A temporary real-extension Settings probe passed eight hidden Chrome cases:
  widths 1440 and 390, height 900, light/dark, and CSS zoom 100%/200%. Keyboard
  toggles persisted and preserved control/row/following-content geometry,
  scroll, and focus. Desktop, narrow, and enlarged-text screenshots were
  inspected after the Saved notice faded. An initial probe measured an
  unsettled navigation scroll; the final probe waits for scroll stability.
- These focused UI probes use static DOM rendering, with no WebGL surface.
  Disposable browsers and profile directories were checked after teardown.

The temporary probes supplement the committed behavior regressions; they are
not maintained browser regression commands. Documentation links and
`git diff --check` are checked before committing this ledger.
