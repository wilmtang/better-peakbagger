# Settings storage, export, and sync

Maintained report, updated **2026-10-25** for the implementation following the
storage audit (package version **4.0.2**, unreleased changes). This describes the
repository, not necessarily the extension installed in a particular browser.
The [remediation ledger](archive/settings-portability-remediation.md) records
commits, verification, intentional boundaries and remaining live checks.
The [custom-layer follow-up](archive/custom-layer-settings-audit-2026-10-25.md)
records the centralized manager and version 6 backup/restore audit.

## Current policy

- **67 portable preferences** live in `storage.sync.bpbSettings`, travel in
  settings JSON files, and can be backed up to GitHub's `settings.json`.
- **Nine device settings** live in `storage.local.bpbDeviceSettings`. Map size,
  terrain cache budget and GitHub transfer choices stay on this installation;
  settings files and GitHub restores cannot enable them on another device.
- **Weather, overlay and photo-tool preferences now travel with settings.**
  Their legacy local values migrate only when no synced choice exists.
- **Automatic GitHub transfers start off on new installations.** Existing local
  connections preserve their previous choices. Settings and favorites backups
  require review before replacing a first-seen or externally changed remote file.
- **Custom favorites and ignored climbers have independent JSON files.** They
  remain separate from settings; importing them needs no GitHub connection.
- **Credentials remain local.** Manual settings files include them only with
  the unchecked-by-default **Include saved credentials (ImgBB, GitHub and Garmin)**
  option. GitHub settings backups never include credentials.
- **Custom map sources are backed up with settings.** Their definitions,
  attribution, zoom ranges, appearance and opacity stay in a separate local
  registry and travel in settings files and GitHub settings backups. They do
  not use browser sync: the registry can exceed its per-item quota. Saved public
  URLs and any public keys in them are included; private tokens do not belong
  in custom source URLs. Saving/restoring never enables layers on a map.

## Transfer matrix

“Local” means one browser profile or site origin, not every browser on the same
computer. “Settings file” means **Export settings**, not a complete profile backup.

| Data | Storage | Browser sync | Settings file | GitHub / separate file |
| --- | --- | --- | --- | --- |
| 67 portable preferences | `storage.sync.bpbSettings` | Eligible | Yes | `settings.json`: push and explicit restore |
| Nine device settings | `storage.local.bpbDeviceSettings` | No | No | No |
| Custom map sources and opacity | `storage.local.bpbCustomMapOverlaysV1`, `bpbCustomMapOverlayPreferencesV1` | No | Yes, `customLayers` | `settings.json`: push and explicit restore |
| ImgBB API key | `storage.local.bpbImgbbAuth` | No | Credential opt-in only | Never in GitHub settings backup |
| GitHub token and repository | `storage.local.bpbGithubAuth` | No | Credential opt-in and complete connection only | Never in GitHub settings backup |
| Garmin Personal API key | IndexedDB `bpb-garmin-v1` | No | Credential opt-in only | Never in GitHub settings backup |
| Garmin account binding, import consent, inbox/history | Same Garmin database | No | No | No |
| Custom favorite climbers | `storage.local.bpbFavoriteClimbers` | No | No | Standalone JSON; `favorite-climbers.json` push/restore |
| Ignored climbers | `storage.local.bpbIgnoredClimbers` | No | No | Standalone JSON; `ignored-climbers.json` backup/restore and optional two-way sync |
| Photo catalog and annotation projects | IndexedDB `betterPeakbaggerPhotos` | No | No | Per-photo project files; `photo-library.json` metadata/project recovery |
| Original/thumbnail image bytes and ImgBB deletion URLs | Same photo database | No | No | Excluded from GitHub photo recovery; rendered image downloads are separate |
| Report drafts | Extension-local draft store | No | No | Separate draft download; saved ascent/report backup is another workflow |
| Page layout/filter state, caches, job state, bookkeeping | Local, session, IndexedDB or memory | No | No | Excluded from settings and list files |

Browser sync is the browser's extension-storage service. Chrome requires Chrome
sync; desktop Firefox requires its Mozilla account's **Add-ons** sync. They are
separate services, so Chrome-to-Firefox transfer uses files or GitHub restore.
See the [Chrome storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage#sync)
and [Mozilla storage.sync documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync).

The extension still writes portable preferences as one storage item. Its worker
serializes local patches, but does not implement a cross-device, per-field
merge. Simultaneous edits on different devices remain subject to browser sync
conflict semantics; see [Mozilla's synchronization process](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync#synchronization_process).
This limitation is distinct from the guarded GitHub file replacement below.

## Complete portable-settings inventory

Every key below is browser-sync eligible, settings-file exportable, and
GitHub-settings-backup eligible. The inventory is the 67-key `PORTABLE_KEYS`
allowlist in the [single settings schema](../src/settings/settings-schema.js).

| Group | Exact keys |
| --- | --- |
| Theme and units (7) | `theme`, `units`, `distanceUnits`, `elevationUnits`, `temperatureUnits`, `precipitationUnits`, `windUnits` |
| Peak cards (8) | `showSunMoon`, `showWeather`, `showSnotel`, `peakCardOrder`, `peakCardColumns`, `peakSunCollapsed`, `peakWeatherCollapsed`, `peakSnowCollapsed` |
| Capture and draft filling (6) | `retainWaypoints`, `removeGpxTimestamps`, `fillAscentDetails`, `fillTripInfo`, `fillWildernessNights`, `fillExternalUrl` |
| Garmin inbox preferences (5) | `enableGarminInbox`, `garminCheckHours`, `garminRecentDays`, `garminHistoryStart`, `garminActivityTypes` |
| GPX chart (1) | `chartDefaultSeries` |
| Report editor (4) | `enableReportEditor`, `addReportCredit`, `reportEditorMode`, `reportImageWidth` |
| Route appearance (4) | `mapRouteColor`, `mapRouteWidth`, `mapRouteCasingColor`, `mapRouteCasingWidth` |
| Terrain (1) | `enable3dMap` |
| Remembered base layer (2) | `rememberMapLayer`, `mapLastLayer` |
| Map providers and peak links (3) | `mapProviderOrder`, `mapProvidersEnabled`, `peakLinkOrder` |
| Ascent-list ordering (3) | `betaPeakFilterOrder`, `betaPersonalFilterOrder`, `betaSortDateDesc` |
| Favorites behavior (2) | `favoritesSource`, `removeFavoriteWhenBuddyRemoved` |
| Definition of “Has beta” (4) | `betaTr`, `betaTrMinWords`, `betaGps`, `betaLink` |
| Weather model, metric and placement (6) | `bpbPeakWeatherModelPast`, `bpbPeakWeatherModelForecast`, `bpbPeakWeatherHourlyMetric`, `bpbAscentWeatherModel`, `bpbAscentWeatherColumn`, `bpbAscentWeatherSlot` |
| Overlay opacity and public-land categories (1) | `bpbMapOverlayOpacityV1` |
| Photo-tool appearance defaults (10) | `bpbPhotoSharedStyle`, `bpbPhotoTool:route`, `bpbPhotoTool:drawing`, `bpbPhotoTool:bolt`, `bpbPhotoTool:anchor`, `bpbPhotoTool:piton`, `bpbPhotoTool:rappel`, `bpbPhotoTool:belay`, `bpbPhotoTool:pitch`, `bpbPhotoTool:text` |

These preferences contain bounded identifiers, style values and choices, not
weather coordinates/results, activity data, annotations or credentials.
Garmin's synced feature gate does not replace its local key, Peakbagger account
binding or processing consent. Active overlays and selected weather map points
remain page state. Photo styles already applied to a project also travel with
that project's separate transfer.

## Device settings and other local preferences

The versioned device record contains these nine schema-owned values:

| Group | Exact keys | Policy |
| --- | --- | --- |
| Ascent map dimensions (2) | `mapViewportWidth`, `mapViewportHeight` | Retain per-device sizing |
| Terrain cache budget (1) | `terrainCacheLimitMb` | Retain per-device capacity; actual tiles stay local |
| Ascent/report GitHub backup (3) | `enableGithubBackup`, `autoGithubBackup`, `removeGithubBackupOnDelete` | Default off; `autoGithubBackup` follows `enableGithubBackup`; disabling backup clears deletion mirroring |
| Companion automatic backups (3) | `autoSettingsBackup`, `autoFavoritesBackup`, `autoPhotoLibraryBackup` | Independent, default off on new devices |

Other local state has separate owners and does not belong in a settings file:

| State | Exact key / owner | Reason |
| --- | --- | --- |
| Ignored-list sync consent and baseline | `bpbIgnoredSyncState` in `storage.local`; [sync controller](../src/background/climber-list-sync.js) | Device connection, reviewed merge baseline and interrupted-transfer state; new consent defaults off |
| Photo canvas dimensions | `bpbPhotoViewport` in `storage.local`; [photo editor](../photos/photos.js) | Device layout |
| Peak report favorites-only filter | `bpbPeakReportFilter.favoritesOnly` in `storage.local`; [ignored store](../src/background/ignored-store.js) | Current viewing preference, separate from list membership |
| Active ascent chips and Trip report chip threshold | `pbAscentBetaFilter.v1` in Peakbagger `localStorage`; [ascent filter](../src/ascent/ascent-filter.js) | Current page-view state; chip order and “Has beta” definition are portable |
| Ascent and peak table splits | `pbAscentTableSplit.v1`, `pbPeakTableSplit.v1`; [column persistence](../src/ui/column-resize.js) | Device layout |
| Peak-page map dimensions | `pbPeakMapViewport.v1`; [peak map](../src/maps/peak-map.js) | Device layout |
| Theme startup mirrors | `bpbThemePref` in page/panel `localStorage`; [theme](../src/theme/theme.js), [panel theme](../src/theme/panel-theme.js) | Mirror of portable `theme`, not a separate theme choice |
| Garmin consent and account | `connection.enabled`, `connection.cid` in [Garmin store](../src/garmin/garmin-store.js) | Per-device authorization; key transfer does not copy it |

## Migration and settings files

[Settings storage](../src/settings/settings.js) reads the portable and device
records through the same schema. Worker-owned writes serialize the two stores,
retain device choices on replacement, and report persistence failures. Failed
authoritative reads cannot become default-filled export or preservation data.

On upgrade, existing local weather, overlay and tool defaults migrate into
portable settings only when their synced key is absent. Existing synced choices
win. Unset legacy chip orders still migrate on a list visit; a settings export
uses explicit default orders when no order has been chosen. Old local preference
keys may remain as migration inputs, but current edits use the portable store.
Fresh installation does not publish a default-filled `bpbSettings` item.

Legacy GitHub toggles are preserved only for an existing local token/repository
when creating the device record. Fresh devices cannot inherit transfer consent
from browser sync. An existing ignored-sync record retains its choice. Legacy
map dimensions/cache budget seed the device record; later sync changes cannot
replace it. [Settings migration](../src/settings/settings.js) and
[connection selection](../src/background/github-routes.js) enforce this boundary.

[Settings transfer schema v6](../src/settings/settings-transfer.js) exports
portable keys plus a separate `customLayers` envelope. It still reads supported
v1–v5 files, but strips their old device
and transfer values too. Import replaces the portable snapshot after
confirmation: missing portable keys receive cleaned defaults, unknown keys are
excluded, and destination device settings stay unchanged. Applied portable
settings can subsequently propagate through browser sync.

### Custom map layer management and transfer

**Map & GPX chart → Custom layers** is the central library in Options, with its
own sidebar link. Add/edit opens the packaged editor in a modal; the list shows
format, provider host and opacity, and confirms removal. The same sources are
available on every map. **Check source** can read TileJSON in Options; testing
tile coverage at the map center remains an explicit action on that map.

Version 6 writes `customLayers: {schemaVersion: 1, sources, preferences}` beside
`settings`, using the [shared source schema](../src/maps/custom-overlay-schema.js).
It includes configured URLs/public keys, bounds, native zoom/provenance,
coordinate scheme, raster size, attribution, simple style rules and saved
opacity. It excludes selections, previews, tile/feature bytes and probe locations.
Local source revisions are normalized for transfer and rebased on restore.

File import and GitHub restore preview the replacement layer count before
confirmation. An included empty library deliberately clears saved layers;
v1–v5 files and other files without `customLayers` leave the destination library
alone. Malformed sources reject the entire file before writes. Registry
replacement and opacity commit together through the worker's serialized store;
concurrent edits block replacement, and a later credential failure attempts a
conditional rollback that preserves newer edits. Restore increments the library
generation so open maps clear their selections and cannot silently request a
restored provider. It does not fetch providers or enable layers.

GitHub signatures and overwrite reviews include definitions and opacity;
source-only changes schedule automatic settings backup when that device's
existing opt-in is enabled. Runtime cache/probe activity never schedules backup.
No new automatic transfer consent is enabled by adding or restoring layers.
An unreadable/corrupt registry blocks export/backup rather than exporting an
apparently empty library. Public repository contents and Git history can expose
source URLs and their public URL keys, independently of the credential checkbox.

The default settings file has no `apiKeys` or `githubConnection`. Credential
opt-in adds `apiKeys.imgbb` and `apiKeys.garmin` (including explicit null for a
missing key), and a complete GitHub connection's token and repository owner,
name and available numeric ID. These are unencrypted secrets. Account caches,
authorization epochs, access tokens, browser permission grants and Garmin
processing consent do not transfer.

On import, omitted credentials preserve the destination; an explicit null API
key removes that key. Included GitHub and non-null Garmin credentials require
host access and validation. A fresh Garmin key import leaves import consent off;
existing destination consent remains its own choice. GitHub connection imports
retain destination transfer settings. See the [manual file routes](../src/background/settings-file-routes.js)
and [Garmin import handling](../src/garmin/garmin-imports.js).

## Climber-list files

**Climber lists → Favorites → Custom list** and **Climber lists → Ignored** each
provide **Export JSON** and **Import JSON…**. Each file contains one complete
list, capped at 1,500 entries and 2 MiB. No GitHub connection is needed.

Import validates the kind, schema, every entry and duplicates, then previews the
replacement counts. **Replace list** uses the worker's expected signature (and
ignored-list revision). A concurrent edit requires renewed review. Favorite /
ignored / Buddy membership rules still apply. Empty files are valid intentional
replacements; a wrong-list file, even empty, is rejected. Existing GitHub favorite
files without a `kind` field remain compatible.

List files exclude Buddy cache/owner metadata, native Buddy membership, settings,
credentials, sync baselines and filter state. Import never edits Peakbagger's
Buddy List. Existing automatic backups or ignored sync, if already enabled on
this device, can transfer the resulting list change. See [file formats](../src/favorites/climber-files.js),
[file controls](../options/climber-files.js), and [list policy](../src/background/climber-list-policy.js).

## GitHub behavior and overwrite protection

| File / feature | Automatic behavior after device opt-in | Restore / reconciliation |
| --- | --- | --- |
| `settings.json` | Push portable settings plus custom sources/opacity | Explicit replacement of portable settings and included custom library; no automatic pull or per-key merge |
| `favorite-climbers.json` | Push custom list | Explicit guarded replacement; no automatic pull or two-way list merge |
| `ignored-climbers.json` | Two-way sync after setup | Review initial merge and conflicting changes; later three-way comparison propagates additions/removals |
| `photo-library.json` | Push/merge catalog metadata and projects | Explicit restore preview; excludes original pixels, thumbnails and deletion URLs |
| Saved ascent/report folders | Backup after saves when locally enabled | Separate archive workflow; never clicks Peakbagger Save |

Settings/favorites retain trailing alarms and watchdogs, but remote replacement
now compares the remote file with the current local signature and this device's
last acknowledged baseline. A first-seen different file or a changed remote file
pauses for explicit replacement review. Automatic work records a review-needed
state. Malformed/newer remote files cannot be overwritten as if they were empty.

Review is bound to the exact local/remote signatures and connection. The queue
rereads the relevant remote file on Git ref conflict retries and rechecks
connection/consent before advancing the branch. A stale approval cannot replace
a newer remote version. Settings/favorites still use push plus explicit restore;
these safeguards do not turn them into two-way sync.

For migration, connect the destination with automatic transfers off, restore the
desired settings/lists, then choose which automatic transfers to enable locally.
Changing those choices no longer changes other browser profiles. See
[root-backup guard](../src/github/root-backup-guard.js),
[GitHub routes](../src/background/github-routes.js), and
[GitHub client](../src/github/github-client.js).

## Verification and remaining limits

The [closure ledger](archive/settings-portability-remediation.md) records unit,
full-suite and browser evidence. The overwrite regression was reproduced against
the prior worker. Deterministic tests cover remote conflicts, snapshot-bound
review, migration, old-file exclusions and guarded list imports. Hidden Chrome
and Firefox checks cover the changed Settings and list-file controls, both themes,
narrow/desktop layouts, enlarged text, keyboard focus and asynchronous geometry.

Real browser-account synchronization across physical devices, simultaneous live
GitHub writers, native file chooser appearance, and native window/focus behavior
remain unproven. No real account settings or GitHub repository were changed for
verification. The browser's whole-item sync conflict behavior remains an explicit
product limitation; local queues and tests cannot prove cross-device merging.
