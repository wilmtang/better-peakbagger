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
- **D8 — GitHub also retains obsolete disconnect feedback.** The second review
  restored a connection through another window and observed a connected account
  beside the old "Disconnected" status. Replacing the focused Connect action
  also lost keyboard focus, including when host permission remained missing.
- **D9 — External GitHub credential removal leaves setup live.** A pending
  permission flow deferred all credential notifications, so removing its saved
  credential from another window still allowed it to start sign-in afterward.

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

- Final remediation review: checked draft-count invalidation, delayed setup
  continuations, owned versus external credential notifications, focus handoff,
  and the lifetime of success/error feedback. The review found D8/D9, which were
  fixed and reviewed again; no further findings were confirmed in these changed
  paths. An additional adversarial check confirmed that a rejected replacement
  key keeps its error while the saved connection is unchanged, then yields to
  an external credential removal.
- Combined verification: all 204 focused worker/options/project tests passed.
  Packaged Settings passed 108 hidden Chromium 156.0.8078.4 / Firefox 157.0
  connection cases at 1180×1000 and 390×1000, both themes and 200% CSS zoom.
  Existing Garmin settings/inbox/popup verification passed all 16 cases.
  ESLint passed, and the development build completed. The full current-workspace
  suite reported 3,827 passes and the two unchanged fixture-registry failures
  listed below. Unrelated vector-map work was preserved throughout.

- D8/D9 (second review): authoritative GitHub reconnection resets removal
  feedback. Connected, disconnected and permission-recovery renderers restore
  focus when they replace the active control. External removal of a saved
  credential invalidates pending setup and refreshes its UI immediately, while
  owned cleanup and its delayed notifications preserve the local continuation
  and focus. Both new state regressions failed before these fixes. All 69
  focused GitHub/regression tests passed. The hidden Chrome/Firefox matrix passed
  108 cases and representative new narrow dark states were visually inspected. It
  covers external removal while permission is pending, external reconnection
  with/without host access, and stable headings, action slots and focus.

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

- D5–D9 are fixed and verified in the scenarios above. Final repository-wide
  `npm run lint` reached web-ext lint but failed on a new unowned
  `UNSAFE_VAR_ASSIGNMENT` warning in `content/vector-map.js`, generated by
  unrelated in-progress map work. Focused and repository-wide ESLint passed;
  the warning and its source were not changed by this remediation.

- Initial implementation `npm test`: 3,812 passed, two fixture-privacy checks failed because the
  unchanged registry does not recognize `test/fixtures/maps/snow-depth-legend.json`.
  Neither that fixture, its privacy manifest nor its tests were changed here.
  The final current-workspace run also failed those same two checks (3,827
  passed). The full suite is not green. Initial implementation lint passed with
  eight already-owned web-ext warnings; the final additional warning is above.
- Live service sessions, native permission prompts, real screen reader output,
  native browser zoom, and visible focus/window placement were not exercised.
  Browser service/storage replies are synthetic; no real user key was removed
  and no remote account, upload or backup was modified. Headless DOM focus and
  CSS zoom establish only their explicitly tested browser behavior.
