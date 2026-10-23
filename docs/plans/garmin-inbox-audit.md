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

Validation so far: 16 coordinator tests, the bundled-worker handoff test and
focused ESLint pass. Final browser and complete-suite results are recorded below
when finished.

## Intentionally not changed

- Peakbagger Save remains a user action. An expired or uncertain form handoff
  requires reviewing existing saved ascents; it does not automatically replay.
- Activity-date pagination plus overlapping checks and periodic full-history
  reconciliation remain necessary; upload-date sorting was not honored in the
  investigation.
- Business enrollment and publishing remain outside this local implementation.

## Changed but not fully proven

- UX audit: stale review results, recovery controls and status copy are being
  corrected and still require rendered transition checks.
- Native permission prompts, a truly expired Garmin key, and live browser
  provider/Peakbagger sessions have not been verified. The authorized live Node
  API test verified identity, 12 activity summaries and one FIT recording.
- Garmin distribution agreement review remains open.
