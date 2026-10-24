# Settings and favorites transfer: completed implementation record

This completed plan introduced settings file export/import, fixed-root GitHub
settings backup, and optional automatic settings/favorites backup. Detailed
implementation instructions are superseded by the maintained
[GitHub backup guide](../github-ascent-backup.md#settingsjson-schema-version-5)
and [privacy contract](../../PRIVACY.md). The decisions below describe the
original scope; later credential-file support is documented in those guides.

## Names used throughout (do not improvise different ones)

| Thing | Name |
| --- | --- |
| Settings schema key (new) | `autoSettingsBackup` (boolean, default `false`) |
| Settings schema key (new) | `autoFavoritesBackup` (boolean, default `false`) |
| Settings backup file (repo root) | `settings.json` |
| Favorites backup file (repo root) | `favorite-climbers.json` (exists: `FAVORITE_CLIMBERS_BACKUP_PATH`, `background.js:33`) |
| Settings debounce alarm | `bpb-settings-backup` |
| Favorites debounce alarm | `bpb-favorites-backup` |
| Settings backup state (`storage.local`) | `bpbSettingsBackupState` = `{ signature, syncedAt, attempts? }` |
| Favorites backup state (`storage.local`) | `bpbFavoritesBackupState` = `{ signature, syncedAt, attempts? }` |
| New message types | `GITHUB_SETTINGS_BACKUP`, `GITHUB_SETTINGS_RESTORE` (no payload either way) |
| Changed message type | `GITHUB_FAVORITES_BACKUP` no longer takes `content` |
| New options element ids | `favorites-auto-backup` (checkbox); settings-backup ids are yours to choose, prefixed `settings-backup-` |
| Debounce / retry timing | 1 minute debounce; on push failure re-arm at 10 minutes, at most 2 retries per change |

## Decisions (already made — do not reopen)

- **Settings file scope: settings only** — the `bpbSettings` schema values.
  Favorites keep their own separate file; the GitHub token/repo
  (`bpbGithubAuth`) must never leave `storage.local`; drafts and terrain
  caches stay device-local.
- **Manual button + separate opt-in auto toggle, per feature.** Restore is
  always a manual button for both features. Restore semantics: replace
  wholesale after an explicit inline confirmation (favorites already has this
  flow; settings copies it). No merging.
- **Favorites auto trigger: every stored change to `bpbFavoriteClimbers`,
  regardless of surface.** The options page, the climber-page star
  (`src/favorites/climber-favorite.js`), and ascent-filter buddy sync all
  write through `storage.local`, so the worker watches that one key instead
  of tagging user intent across three writers.
- **The worker builds and serializes the favorites payload itself** for both
  manual and automatic backups (the auto path needs it anyway; sharing it
  keeps one serialization and one signature-state record).
- **Neither auto toggle is coupled to `enableGithubBackup`** — that gate
  belongs to ascent backup (favorites manual backup already ignores it; there
  is an existing test pinning that independence). Both new booleans sync
  harmlessly: without a device-local token/repo they are inert.
- **PRIVACY.md is part of this change** — it currently promises the favorites
  file reaches GitHub only on an explicit click.
- **Non-goals:** no auto-restore, no conflict resolution between devices
  (last write wins on the fixed root path), no surfacing of auto-push
  failures in the UI (the manual buttons remain the loud path), no backup of
  the buddy cache (`bpbBuddyCache` is owner-scoped and refreshable).

## Verification record

The original plan required `npm test`, the then-named `verify:extension`,
fixture-based worker/Settings coverage, and normal/narrow light/dark inspection.
It also required a fresh-profile settings import and minimal live GitHub
backup/restore, debounce, and restore-without-rebackup checks.

No executed check counts, terminal browser results, or commit hashes were
recorded in this document. Those requirements are not evidence that every
manual or live check passed. Current verification commands and their limits
are maintained in [development.md](../development.md#what-each-check-can-and-cannot-see).
