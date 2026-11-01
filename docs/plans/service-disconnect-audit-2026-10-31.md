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
- **D5 — Unknown draft counts authorize Garmin deletion.** Re-enabling imports
  after a credential-only status read exposes Delete with no full draft count.
  When the full read fails, the zero fallback confirms "Delete 0" but removes
  every draft. Self-review reproduced deletion of 25 test drafts.
- **D6 — Older GitHub setup can resume after Disconnect.** Permission and setup
  continuations do not share the status renderer's invalidation guard. A held
  permission request can start a new device flow after local removal succeeds.
- **D7 — Garmin's successful disconnect masks a later connection.** Reusing
  `keyError` to retain the success message prevents polling from reporting a
  new saved key, although the Disconnect button becomes available again.

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

- D7: successful disconnect feedback has its own lifetime instead of becoming
  a permanent key-validation error. It survives unreadable status while no key
  is saved, yields to authoritative reconnection (imports on or off), and clears
  after explicit local-data deletion. Both reconnection regressions failed
  before the fix. All 23 focused Garmin/regression tests passed; hidden Chrome
  and Firefox passed 96 connection cases with reconnection focus and geometry
  checks. The later local-data action cannot retain "drafts are kept" feedback.

- D6: local Disconnect, Cancel and Reconnect invalidate the setup generation.
  Every permission, begin/poll, authorization, discovery and repository-selection
  continuation checks ownership before sending more setup work or rendering.
  Three regressions failed before the fix: late permission, late begin response
  and late selection success. Tests also cover an in-flight authorized poll and
  a subsequent explicit Connect. All 61 focused GitHub/regression tests and
  focused ESLint passed. The hidden Chrome/Firefox matrix now covers pending
  permission → Disconnect → late grant → fresh explicit Connect.

- D5: Delete requires a known nonnegative full-status draft count. Feature
  transitions and failed status reads invalidate it; credential-only status
  still permits Disconnect. ARIA unavailability retains keyboard focus and the
  click handler blocks both confirmation and deletion. The new real-store/UI
  regression failed before the fix with "Delete 0" for 25 drafts. All 41 focused
  Garmin/settings tests and focused ESLint passed. Hidden Chrome/Firefox passed
  84 connection cases, including failure/recovery after re-enabling imports,
  Enter/Space guards, correct native confirmation dismissal, focus and geometry.

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
- D1/D3/D4 Settings: Garmin Disconnect is beside the key controls, outside the
  disclosure. Garmin connection management and the ImgBB key row/sidebar remain
  reachable with their features off. Only the photo-library row and report
  drafts retain the editor feature gate. Failed status reads still offer local
  cleanup. GitHub disconnect is independent of host access, repository discovery
  and the dynamic setup/error panel.
- Busy/error/retry feedback preserves the action and focus; repeated pointer and
  keyboard activation sends one removal. Success removes the hidden action from
  painting/focus and deliberately focuses the surviving key/Connect control (or
  the Garmin heading when connecting is unavailable). Delayed status replies and
  GitHub credential notifications cannot restore stale UI or steal that focus.
- Final focused ESLint and 194 worker/options/project tests passed. The GitHub
  notification focus assertion failed before its rendering guard was added.
  `node scripts/verify-connections.mjs` passed 72 cases in hidden Chromium
  156.0.8078.4 and Firefox 157.0: both themes, 1180×1000 and 390×1000,
  200% CSS zoom, feature on/off, missing permission, long account/repo names,
  held pending/error/retry/success replies, repeat activation and focus.
  Buttons, action slots, connection headings and following section positions stayed
  within 1px with unchanged scroll. Ending GitHub deliberately replaces its
  following backup options with setup guidance, allowing that panel's height
  to shrink once; the backup heading stays anchored. The connection panel keeps
  its previous height until the next explicit Connect action.
- Visually inspected representative idle/pending/error/success screenshots,
  including narrow dark Firefox/Chromium and enlarged light Chromium. Existing
  `node scripts/verify-garmin-ui.mjs` also passed all 16 settings/inbox/popup
  cases. An old-code packaged fixture failed the new browser assertion because
  `#garmin-disconnect` existed but was hidden in the closed disclosure.

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

- D5–D7 are fixed; the final fresh review and combined verification are pending.

- Full `npm test`: 3,812 passed, two fixture-privacy checks failed because the
  unchanged registry does not recognize `test/fixtures/maps/snow-depth-legend.json`.
  Neither that fixture, its privacy manifest nor its tests were changed here.
  The full suite is not green. `npm run lint` passed with eight already-owned
  web-ext warnings.
- Live service sessions, native permission prompts, real screen reader output,
  native browser zoom, and visible focus/window placement were not exercised.
  Browser service/storage replies are synthetic; no real user key was removed
  and no remote account, upload or backup was modified. Headless DOM focus and
  CSS zoom establish only their explicitly tested browser behavior.
