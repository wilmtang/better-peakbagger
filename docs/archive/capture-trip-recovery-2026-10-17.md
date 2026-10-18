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
- F2: worker recovery errors and missing replies now block both native Save
  controls and pointer/implicit submissions on fresh forms. Repeated errors
  keep the guard; explicit capture discard restores the original native state.
  The two new page regressions failed against the original build because Save
  was enabled. All 447 focused capture, upload, draft, save-verification, manifest,
  and verification-tool tests pass. All 75 tests in the final draft/tool
  follow-up also pass.
- The extended browser assertion failed on the original build because Save was
  enabled after a worker error. The fixed shipped bundle passes all eight
  combinations per browser in hidden Chrome 156.0.8078.4 and Firefox 157.0:
  widths 1000/390, height 760, light/dark feedback, and CSS zoom 100%/200%.
  Both the existing apply-failure/reload cycle and fresh-form worker errors are
  exercised, including repeated updates, keyboard activation, guarded native
  submissions, and explicit discard. Save controls, heading, following content,
  scroll, and active-field focus stay stable within 0.75 pixels. Desktop and
  narrow enlarged screenshots were inspected. Rendering is static DOM with no
  WebGL; worker replies and native Preview postbacks are stubbed.
- The initial extended rendering run counted submission events before the
  extension's capture guard could stop them. The final fixture observes only
  events that pass the guard; that fixture error is not a product failure.
- The final build, focused ESLint, documentation links, and diff checks pass.
  The real-extension Chrome verifier and both three-summit fixture paths also
  pass with the final build. Process command lines and disposable paths were
  checked after teardown; temporary screenshots and test logs were removed.

## Intentionally not changed

- Suffixes apply only to selected peaks sharing an ascent date; singleton dates
  stay blank. Trip sequences follow track order across the whole selection.
- The first manual Save creates the trip; later drafts reuse its verified ID.
  No extension path clicks Save. Manual form edits remain possible.
- An uncertain save requires reviewing that ascent before starting a new
  capture; it is never replayed automatically.

## Changed but not fully proven

- Live Garmin/Strava exports and live Peakbagger persistence remain unverified;
  browser saves use local fixtures. The real-extension three-summit save and
  navigation path has been exercised in Chrome; Firefox rendering covers the
  shipped page bundle with worker replies stubbed.
- Hidden checks do not establish native window placement, OS focus, browser
  chrome, permission prompts, or screen-reader speech.

Both reported findings are fixed locally. The external verification limits above
remain open and are not replaced by passing fixture checks.
