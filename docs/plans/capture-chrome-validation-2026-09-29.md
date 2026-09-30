# Chrome capture validation — 2026-09-29

Status: in progress. Baseline: `23f3666` on local main. The user requested full
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
- `npm test`: 2,095 passed. `npm run lint`: passed with 8 owned warnings.
  `npm run verify:chrome`: passed. Provider-contract checks passed in Chrome
  153 and Firefox 155; those are sanitized fixtures, not live providers.
- Browser: Chrome for Testing 153.0.8010.12, hidden, 1000x760 page viewport,
  native action-popup sizing, no WebGL. Result, outage, and draft screenshots
  were inspected locally under ignored `tmp/capture-flow/`.

### Intentionally not changed

- Ownership and Peakbagger session checks remain fail closed. Provider host
  permissions remain temporary and raw GPX stays in the provider page.
- No live Peakbagger Save will be clicked. A browser reload of a POST result can
  repeat the browser's POST; the exactly-once assertion instead revisits by GET
  to distinguish browser resubmission from extension reapplication.

### Changed but not fully proven

- The error mapping and new verifier have local evidence; remote CI is pending.
- Live Garmin activity 24524298734, provider authentication, Peakbagger session,
  live summit responses, and draft field compatibility still require validation.
- Cancellation and popup close/reopen need the remaining browser checks.
  The existing multi-summit verifier hit a Chrome renderer crash on its second
  draft navigation; investigate before claiming that flow verified. Hidden runs do not establish visible focus or screen-reader behavior.
