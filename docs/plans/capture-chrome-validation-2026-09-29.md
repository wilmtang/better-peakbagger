# Chrome capture validation — 2026-09-29

Status: in progress; live Garmin capture and Preview passed. Baseline: `23f3666` on local main. The user requested full
Chrome capture testing, bug fixes, and a pause for manual validation if a live
bot-detection page blocks the test.

## Coverage and findings

The existing readiness verifier replaces the provider adapter and ends before
summit lookup. Existing draft checks seed completed jobs. The new
`verify:capture-flow` runs the unmodified `dist/` through Chrome's toolbar action,
including its real activeTab grant, provider adapter, page helper, background
worker, popup, and ascent draft. HTTPS fixtures keep all traffic local.

A real worker failure with Peakbagger HTTP 503 exposed transport code `server`.
The popup did not recognize that code, so it offered a Garmin reload for a
Peakbagger outage. The same contract mismatch affected several other transport
failures. Map them into the existing capture error policy at the worker boundary.

## Closure ledger

### Fixed and verified

- Peakbagger failures map to the appropriate capture recovery code. Focused
  bundled-worker tests cover both account and summit requests. The hidden Chrome
  flow verifies the outage message and a successful user-triggered retry.
- The new full-flow verifier covers Garmin and Strava success, one Preview,
  no Save, date/suffix filling, raw GPX metadata exclusion, account and ownership
  gates, no GPS, malformed GPX, provider rate limits, and summit outages.
  Cancellation aborts a held provider request, removes the job, and allows a
  fresh capture. Reopening during export or after completion reuses the same
  job without another export; deleting captured data removes its job/payload.
  The extended hidden Chrome flow and focused script lint passed.
- `npm test`: 2,095 passed. `npm run lint`: passed with 8 owned warnings.
  `npm run verify:chrome`: passed. Provider-contract checks passed in Chrome
  153 and Firefox 155; those are sanitized fixtures, not live providers.
- Browser: Chrome for Testing 153.0.8010.12, hidden, 1000x760 page viewport,
  native action-popup sizing, no WebGL. Result, outage, and draft screenshots
  were inspected locally under ignored `tmp/capture-flow/`.

- Multi-summit fixture selection now activates the exact returned tab ID rather
  than guessing an arbitrary blank tab and forcing navigation. Both activity
  and local-upload flows pass in hidden Chrome 153 at 1000x760, including
  simulated manual Save, intact GPX for both ascents, shared trip/sequence, and
  payload cleanup. The low-level renderer crash itself was not diagnosed.
- At the user's explicit request, live validation used their existing signed-in
  Chrome profile. Reloaded this workspace's unpacked extension and refreshed the
  supplied Garmin activity. The real export returned HTTP 200; 8,708 points were
  reduced to 3,000, Hoodoo Peak matched at 100% confidence, and the live draft
  retained date 2026-09-27 with a blank suffix. Peakbagger confirmed GPX Preview
  success. The draft is unsaved, at a 2048x950 page viewport.

### Intentionally not changed

- Ownership and Peakbagger session checks remain fail closed. Provider host
  permissions remain temporary and raw GPX stays in the provider page.
- Ascent-detail autofill was disabled in the user's settings; the live draft's
  empty metrics are expected. No user setting was changed.
- No live Peakbagger Save will be clicked. A browser reload of a POST result can
  repeat the browser's POST; the exactly-once assertion instead revisits by GET
  to distinguish browser resubmission from extension reapplication.

### Changed but not fully proven

- The error mapping and new verifier have local evidence; remote CI is pending.
- The fresh isolated live profile hit Cloudflare and was stopped; the existing
  user profile passed after explicit authorization to use it. Live Strava was
  not tested; its provider and end-to-end checks use fixtures.
- Hidden runs do not establish visible focus or screen-reader behavior.
