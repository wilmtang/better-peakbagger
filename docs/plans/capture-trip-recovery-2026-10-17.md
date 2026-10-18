# Capture trip recovery audit remediation

Scope: the two findings from the audit of capture suffixes and Trip Info.
Normal same-date suffix assignment and shared-trip creation passed the audit;
recovery could replay a saved summit or expose Save on an unprepared form.

## Fixed and verified

- F1: save confirmation now records verified peak IDs on the capture job,
  independently of tab records. Reviewing drafts excludes those peaks while
  keeping the full original selection for suffix and trip-sequence calculation.
  Closing all tabs after a partial save keeps selection locked. A departed
  previewing/previewed tab with an unverified save stops review instead of
  creating another ascent or trip.
- Six worker regressions failed against the original build for the reproduced
  behaviors, including worker restart and partial-save closure. All 282 capture
  worker, local-GPX worker, and capture-core tests pass after the fix.
- The real-extension multi-summit regression failed against the original build
  because Review drafts actually created another form for the saved summit.
  The fixed build passes for captured and local-file jobs in hidden Chrome
  156.0.8078.4 at 1000 by 760, including all three manual fixture saves and
  unchanged a/b/c suffixes, sequences 1–3, shared trip ID, and complete GPX.
- Focused ESLint, the three documentation checks, and diff whitespace checks
  pass. The real unpacked-extension verifier passes in hidden Chrome
  156.0.8078.4 at 1000 by 760, with teardown confirmed by the verifier.

## Intentionally not changed

- Suffixes apply only to selected peaks sharing an ascent date; singleton dates
  stay blank. Trip sequences follow track order across the whole selection.
- The first manual Save creates the trip; later drafts reuse its verified ID.
  No extension path clicks Save. Manual form edits remain possible.
- An uncertain save requires reviewing that ascent before starting a new
  capture; it is never replayed automatically.

## Changed but not fully proven

- Live Garmin/Strava exports and live Peakbagger persistence remain unverified;
  browser saves use local fixtures. Multi-summit recovery has been exercised in
  Chrome; cross-browser recovery verification remains pending.
- Hidden checks do not establish native window placement, OS focus, browser
  chrome, permission prompts, or screen-reader speech.

## Remaining work

- F2: a fresh form receiving a draft recovery error must keep both native Save
  controls and implicit submission blocked. Add regressions for recovery,
  repeated errors, and restoring ordinary Save after explicit discard.
