# Climber membership delivery ledger — 2026-10-04

The old implementation treated favorites and ignored climbers as independent
lists. A UI-only disable would still allow contradictory imports, restores,
sync reconciliation, Undo, and simultaneous edits. The implementation now
enforces mutual exclusion at the extension worker boundary and explains the
required removal beside profile controls.

## Fixed and verified

- Favorites and ignored mutations share a serialized local storage lane. A
  conflicting add, Buddy import, replacement, or Undo is rejected without a
  partial write. Invalid opposite-list storage prevents new additions.
- Ignored GitHub setup, restore, upload, and reconciliation check protected
  membership. Pending results reserve ignored IDs while network work runs
  outside the lane. Conflicts require review instead of being labelled offline.
- Profile Ignore checks custom favorites, saved buddies, and native Remove
  Buddy controls. The star and native Add Buddy actions check current and
  pending ignored membership. Removals remain available for old overlaps.
- Native Add Buddy pointer, keyboard activation, and form submission are
  intercepted before the fixture receives a request. Unignore restores those
  actions. Saves and unconfirmed native additions also guard conflicting
  actions on the same profile.
- The manager checks a fetched profile's Buddy status before ignoring. Conflict
  errors identify the climber and recovery step; favorites restore and Undo
  preserve those errors instead of replacing them with generic failures.
- Membership observations subscribe before their initial read, discard stale
  reads, preserve a valid snapshot on failure, and recover coherently.

Verification actually run:

- `npm test`: all **2,249 tests passed**, including a rebuilt `dist/`.
- Changed JavaScript and tests passed ESLint; `git diff --check` passed.
- `node scripts/verify-extension.mjs`: full packaged extension passed in hidden
  Chrome for Testing **153.0.8010.12**, new headless.
- `node scripts/verify-firefox-extension.mjs`: full derived extension passed in
  hidden Firefox **157.0**.
- Shared browser coverage exercises favorite, ignored, and Buddy membership,
  suppression of native requests, removal recovery, and guidance geometry.
  Screenshots were captured in light/dark at requested **1000×760** and
  **480×760** sizes. Profile guidance was visually inspected across both
  browsers, themes, and sizes. Firefox uses WebDriver window dimensions, so its
  content viewport can differ slightly from the requested window size.
- Verifier-owned browser processes and disposable profiles were checked after
  teardown; the user's browser sessions were not used or closed.

## Intentionally not changed

- Existing overlaps are preserved for explicit user cleanup. Ignore retains
  precedence for report visibility.
- Favorite source selection, automatic Buddy-to-custom-favorites additions,
  and the existing optional Buddy-removal preference retain their behavior.
- Peakbagger remains the Buddy List authority. The extension does not silently
  delete server buddies, remove favorites, or unignore someone to satisfy an add.
- A last-known Buddy cache conservatively protects ignored additions. The user
  can refresh it after server changes.

## Changed but not fully proven

- Browser verification uses masked HTTPS Peakbagger fixtures. Live authenticated
  Peakbagger postbacks and every possible native Buddy markup variant were not
  exercised against the service.
- Local worker transactions cannot lock a Peakbagger server mutation. Changes
  through another surface/device, or concurrent native actions in another tab,
  can introduce overlaps before a Buddy refresh. Guards cover the instrumented
  public profile and known cached membership; they are not a server invariant.
- Hidden checks establish rendered guidance, DOM behavior, request suppression,
  and keyboard activation. They do not establish screen-reader speech, native
  browser chrome, focus of the user's working window, or window placement.
