# Connected-service disconnect audit — October 31

Scope: persistent user credentials in the extension, their Settings controls,
and asynchronous work that could restore credentials after disconnection.

## Findings and interaction contract

- **D1 — Garmin cleanup is gated by the feature it cleans up.**
  `options/garmin.js` hides the entire section when imports are off and puts
  Disconnect inside a closed disclosure. `src/garmin/garmin-imports.js` rejects
  disconnect while the feature is off. Keep connection management reachable;
  connecting and importing still require the feature. Expose only saved-key
  presence through the feature-independent status route, never activity data.
- **D2 — An older Garmin connect can undo Disconnect.** The permission await
  precedes the stored epoch snapshot. Disconnect must invalidate the attempt
  before any await and abort identity verification; retain the durable epoch
  transaction guard. Two new assertions failed on the original implementation:
  the older connect completed, and feature-independent status was unavailable.
- **D3 — ImgBB cleanup disappears with the report editor.**
  `options/options.html` hides the key settings with the feature; status failures
  in `options/imgbb.js` also hide Remove. Keep the credential row reachable,
  label the action Disconnect, and preserve a usable retry after failure.
- **D4 — GitHub cleanup disappears in permission/setup error states.**
  `options/github.js` shows Disconnect only in the fully connected renderer.
  Keep local cleanup available without reauthorizing GitHub or choosing a repo.
  The worker already clears pending authorization and advances its credential
  epoch (`src/background/github-routes.js`, `src/github/github-auth.js`).

UX: place Disconnect beside connection status, outside advanced disclosures.
Use the existing secondary button style, entry-only password fields, visible
busy/error feedback, guarded repeat activation and stable action geometry.
Explain the local effect before the action: remove the saved credential and
stop future service work; keep drafts, photos and remote backups. No destructive
confirmation is needed for local disconnection. Local-data deletion remains a
separate confirmed Garmin action. Restore focus deliberately when a successful
disconnect removes its control.

## Closure ledger

### Fixed and verified

- D2: pending Garmin connect is invalidated before asynchronous validation;
  disconnect also aborts its identity request. Worker regressions cover the
  permission race, identity cancellation and failed optional-permission cleanup.
- D1 worker boundary: trusted Settings/inbox pages can inspect saved-key presence
  and disconnect with imports off or unreadable settings. The disabled activity
  status remains redacted. Disconnect preserves drafts and import receipts.
  `node --test test/garmin/garmin-imports.test.mjs`: 36 passed.
  Focused ESLint passed. `npm run verify -- chrome` loaded the real unpacked
  extension in hidden Chromium 156.0.8078.4 (1000×760 lifecycle fixture plus
  light/dark layout checks at 1600, 800 and 390 pixels; narrow doubled text).
  The verifier reported successful teardown.

### Intentionally not changed

- Disconnect removes this device's credentials; it does not revoke the key or
  GitHub installation at the provider. Other devices are unaffected.
- ImgBB uploads already submitted may finish; removing the saved key stops new
  leases/uploads. Existing public photos, photo projects and deletion links stay.
  The editor's separate tab-only key already has a Forget action and is never
  stored in Settings (`photos/photos.js`).
- Garmin retains account identity with its drafts to prevent cross-account
  mixing. Delete local Garmin data remains the explicit reset for that boundary.
- Custom map-layer public/private URL parameters belong to removable layer
  definitions, not account connections. Strava/website Garmin capture uses
  short-lived activeTab access and has no saved provider key to disconnect.
- Repository CI credentials are outside the extension's connected-service UI.

### Changed but not fully proven

- D1/D3/D4 UI implementation and interaction/browser verification pending.
- Baseline: 100 focused Garmin/options tests passed. Packaged Settings loaded in
  hidden Chromium 156.0.8078.4 and Firefox 157.0 at 1180×1000 and 390×1000,
  both themes. Live service sessions, native permission prompts, real screen
  reader output and visible focus/window placement are not exercised by stubs.
