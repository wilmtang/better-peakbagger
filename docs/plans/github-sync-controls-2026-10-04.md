# GitHub sync controls audit — 2026-10-04

Scope: Settings controls for ascent/TR backup, automatic ascent backup,
deletion mirroring, settings backup, favorite climbers, ignored climbers,
and photo-library backup. Preserve saved preferences, optional host access,
local-only credentials, worker transfer gates, and reviewed restores.

User decision: favorite and ignored sync remain checked by default and disabled
before GitHub setup. Connected users can turn either off and back on. Explicit
opt-outs survive reloads and reconnects. Other automatic backups remain opt-in.

## Fixed and verified

Ignored sync used `!connected && !enabled`, which allowed an
unchecked-to-disabled one-way transition before setup. Its idle gate now uses
`!connected`, preserving the cancellation control during an active upload.
The new preference matrix covers disconnected/permission-denied controls and
both-direction connected changes. Packaged Chrome/Firefox verifiers now assert
the default-on disabled state before setup.

Verification: 49 focused options tests passed; changed JavaScript passed ESLint.
The old behavior was reproduced in hidden Firefox 157.0. The fixed packaged
page was rendered and visually inspected in hidden Firefox at a 1200×815 content
viewport. Both climber checkboxes remained checked and disabled. The new full
browser-verifier assertions still await the final audit run.

Settings and photo refreshes now reject superseded responses. The photo
checkbox reads its preference only from the settings subscriber, so an older
photo-status snapshot cannot replace a newer choice. Both regressions failed
against the previous bundles and passed after the fix. Verification: build and
ESLint passed; 38 options/settings/photo-backup tests passed.

All five GitHub sections now observe auth storage and optional host-access
changes. The connection panel rejects superseded refreshes and waits for its
own auth operations before repainting. Passive notifications preserve an
active device flow and a repository safety confirmation; revoked host access
closes the device flow. Preferences remain unchanged through revocation,
regrant, disconnect, and reconnect. Verification: the two access-lifecycle
regressions failed before the fix; all 98 focused options/photo tests and
changed JavaScript ESLint passed afterward.

The ascent/TR feature switch no longer creates a second rejected promise from
its event handler when saving fails. The shared Settings save path restores
confirmed values and displays the error. A failed-write matrix covers the
parent switch and every automatic/deletion setting. The parent-switch case
failed with an unhandled rejection before the fix. Verification: build and
ESLint passed; all 81 focused options tests passed after the fix.

## Intentionally not changed

- Favorite sync already uses the intended disconnected gate and stored value.
- Settings and photo GitHub actions are hidden while disconnected. Local file
  settings export/import and credential export remain available independently.
- Ascent/TR automatic backup and deletion mirroring depend on their parent
  feature gate. The schema clears subordinate opt-ins when it is turned off.
- Worker GitHub access, cancellation, mutation queues, and restore reviews
  remain the authority for network transfers and destructive operations.

## Changed but not fully proven

Open findings to remediate:

- The GitHub design note incorrectly calls favorite sync default-off.

Live GitHub OAuth, repository selection, native permission prompts, and native
focus/window placement require separate manual evidence; synthetic tests and
hidden browser checks must not be represented as that evidence.
