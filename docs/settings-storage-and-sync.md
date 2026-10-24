# Settings storage, export, and sync audit

Audited **2026-10-23** against source commit
`34cd0588a3a446376b8a22ac2106016d1325e3f7` (package version **4.0.2**).
This describes the checked-out implementation, not the version installed in a
particular browser. No runtime behavior was changed for this audit.

## Findings

1. **All 59 recognized core settings have the same portability:** they live in
   `storage.sync.bpbSettings`, are included in manual settings JSON files, and
   can be backed up to GitHub's `settings.json`. There is no separate export or
   GitHub allowlist that omits some of these 59 keys.
2. **Several real preferences are outside that core object.** Weather models,
   map overlay opacity and land-type choices, Photo Topos tool defaults, some
   layout dimensions, active list filters, and the ignored-climber sync switch
   are local. Settings export and GitHub settings backup do not preserve them.
3. **GitHub settings backup is an automatic push plus an explicit restore, not
   two-way settings sync.** A second connected profile can replace the shared
   backup with its own settings. Custom favorites use the same push/restore
   model. Ignored climbers have a separate, genuine two-way sync implementation.
4. **Credentials are local but optionally portable.** The manual export's
   unchecked-by-default **Include saved credentials (ImgBB, GitHub and Garmin)**
   option includes saved API keys and a complete GitHub connection in plain
   text. GitHub settings backups never include those credential fields.
5. **Existing documentation has drifted.** The GitHub guide still describes
   schema version 3, unconditional ImgBB-key file export, and a GitHub-only
   checkbox. Runtime uses schema version 4 and one opt-in for all three services.
   Details and follow-up checks appear below.

## What each transfer mechanism means

**Browser sync** means the browser's extension-storage service. Chrome syncs
this area across signed-in Chrome instances when sync is enabled; when disabled,
it behaves locally. [Chrome storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage#sync)
describes that prerequisite. Desktop Firefox uses the Mozilla account and
requires **Add-ons** sync; see [Mozilla's storage.sync documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync).
These are separate browser services: this extension does not bridge Chrome
settings into Firefox through `storage.sync`. File transfer or an explicit
GitHub restore supplies that route.

**Local** means a browser profile or site origin, not every browser on the same
computer. Extension `storage.local`, extension IndexedDB, Peakbagger
`localStorage`, and transient session state are different stores. A shared
schema validator does not make a value synced: the storage writer determines
that, which matters for map overlay preferences.

**Export settings** is a user-triggered JSON download. It is not a complete
extension/profile backup. **Back up settings** writes a separate,
credential-free JSON payload to the selected GitHub repository. **Restore from
GitHub** reads that payload and requires confirmation before applying settings.

| Category | Stored in | Browser sync | Manual settings export | GitHub transfer |
| --- | --- | --- | --- | --- |
| All 59 core preferences | `storage.sync.bpbSettings` | Yes, subject to browser sync prerequisites | Yes | `settings.json`; manual/automatic push, manual restore |
| Local UI preferences listed below | `storage.local` or site `localStorage` | No | No | No |
| ImgBB API key | `storage.local.bpbImgbbAuth` | No | Only with credential opt-in | Never in settings backup |
| GitHub token and selected repository | `storage.local.bpbGithubAuth` | No | Only with credential opt-in and a complete connection | Never in settings backup |
| Garmin Personal API key | Extension IndexedDB `bpb-garmin-v1` | No | Only with credential opt-in | Never in settings backup |
| Garmin account binding and import consent | Same Garmin database | No | No; importing a key does not copy source-device consent | No |
| Custom favorite climbers | `storage.local.bpbFavoriteClimbers` | No | No | Separate `favorite-climbers.json`; manual/automatic push, manual restore |
| Ignored climbers | `storage.local.bpbIgnoredClimbers` | No | No | Separate `ignored-climbers.json`; backup/restore and two-way sync |
| Photo library and annotation projects | Extension IndexedDB `betterPeakbaggerPhotos` | No | No; separate per-photo project downloads exist | Separate `photo-library.json`; metadata/projects, not image bytes |
| Drafts, caches, job state, and transfer bookkeeping | Local, session, IndexedDB, or memory | No | No | Excluded from settings backup; saved ascent/report backup is a separate feature |

Source boundaries: [settings store](../src/settings/settings.js) (lines 19–20,
36–48, 63–71), [settings serializer](../src/settings/settings-transfer.js)
(lines 11–34, 81–105), [manual file routes](../src/background/settings-file-routes.js)
(lines 80–108), and [GitHub settings writer](../src/background/github-routes.js)
(lines 1218–1289). Local exceptions are traced individually below.

## Complete core-settings inventory

**Every key in this table is browser-sync eligible, file-exportable, and
GitHub-backup eligible.** The table contains all 59 keys in
[the schema's defaults](../src/settings/settings-schema.js) (lines 73–154).
File and GitHub serialization both iterate those defaults, after validation.

| Setting group | Exact stored keys | Meaning / important distinction |
| --- | --- | --- |
| Theme and units (7) | `theme`, `units`, `distanceUnits`, `elevationUnits`, `temperatureUnits`, `precipitationUnits`, `windUnits` | Theme, overall unit preference, and measurement overrides |
| Peak cards (8) | `showSunMoon`, `showWeather`, `showSnotel`, `peakCardOrder`, `peakCardColumns`, `peakSunCollapsed`, `peakWeatherCollapsed`, `peakSnowCollapsed` | Visibility, card order/column, and collapsed state; weather model choices are separate local preferences |
| Activity capture (6) | `retainWaypoints`, `removeGpxTimestamps`, `fillAscentDetails`, `fillTripInfo`, `fillWildernessNights`, `fillExternalUrl` | Capture/privacy and draft-filling preferences; does not transfer any activity or GPX |
| Garmin inbox preferences (5) | `enableGarminInbox`, `garminCheckHours`, `garminRecentDays`, `garminHistoryStart`, `garminActivityTypes` | Feature gate, schedule, history range, and activity selection; key, account binding, consent, and inbox contents stay separate |
| GPX chart (1) | `chartDefaultSeries` | Initial distance/time series selection |
| Report editor (4) | `enableReportEditor`, `addReportCredit`, `reportEditorMode`, `reportImageWidth` | Editor enablement, credit, last mode, and inserted photo width; not report contents or Photo Topos viewport size |
| GitHub ascent/report backup (3) | `enableGithubBackup`, `autoGithubBackup`, `removeGithubBackupOnDelete` | Ascent backup and optional deletion mirroring; `autoGithubBackup` is a derived compatibility field, not an independent choice |
| Automatic companion backups (3) | `autoSettingsBackup`, `autoFavoritesBackup`, `autoPhotoLibraryBackup` | All default to true; each requires a local GitHub connection. Ignored-climber sync has its own local switch |
| Route appearance (4) | `mapRouteColor`, `mapRouteWidth`, `mapRouteCasingColor`, `mapRouteCasingWidth` | Route line and outline appearance |
| Ascent map size (2) | `mapViewportWidth`, `mapViewportHeight` | GPX/ascent map dimensions; the peak-page map uses a different, local size |
| Terrain (2) | `enable3dMap`, `terrainCacheLimitMb` | 3D gate and cache budget; cached tiles themselves do not transfer |
| Remembered base layer (2) | `rememberMapLayer`, `mapLastLayer` | Remember-layer toggle and saved supported layer; overlay opacity and enabled overlays are different state |
| Map providers and peak links (3) | `mapProviderOrder`, `mapProvidersEnabled`, `peakLinkOrder` | Provider order/visibility and peak-link order |
| Ascent-list ordering (3) | `betaPeakFilterOrder`, `betaPersonalFilterOrder`, `betaSortDateDesc` | Filter-chip order and default newest-first behavior; not the currently active filter chips |
| Favorite-list behavior (2) | `favoritesSource`, `removeFavoriteWhenBuddyRemoved` | Buddy/custom source choice and removal coupling; not list membership |
| Definition of “Has beta” (4) | `betaTr`, `betaTrMinWords`, `betaGps`, `betaLink` | Signals counted as beta; separate from the active Trip report chip's local word threshold |

Important normalization rules:

- `autoGithubBackup` follows `enableGithubBackup`; disabling ascent backup also
  clears `removeGithubBackupOnDelete`. See [schema cleaning](../src/settings/settings-schema.js)
  (lines 266–271).
- Older site-local chip orders migrate into the two core order settings on a
  list visit when those settings are unset. Export substitutes explicit default
  orders for still-unset values; it does not read an unmigrated site's local
  storage. See [list migration](../src/ascent/ascent-filter.js) (lines 930–937)
  and [transfer selection](../src/settings/settings-transfer.js) (lines 26–34).
- Imports contain a full cleaned settings snapshot, not a sparse preference
  patch. Missing known keys receive schema defaults/migrations. Unknown keys
  are excluded from transfer, although the runtime settings cleaner preserves
  unknown fields already present in storage. See [transfer parsing](../src/settings/settings-transfer.js)
  (lines 130–150) and [store mutation](../src/settings/settings.js) (lines 63–71).
- Import/restore writes the same sync store. Applied settings can therefore
  propagate to other signed-in profiles; they are not a device-only override.
  See [file import](../src/background/settings-file-routes.js) (lines 196–215)
  and [GitHub restore confirmation](../options/settings-backup.js) (lines
  193–220, 311–327).

## Preferences that remain local and are not exportable

Here, “not exportable” means no supported settings-file or GitHub-settings
transfer path. It does not mean the storage is technically inaccessible to
developer tools. These exclusions are established by tracing the writers and
the schema-based export allowlist, not just by searching preference labels.

| Preference | Exact key / store | Evidence |
| --- | --- | --- |
| Summit recent-weather and forecast model choices | `bpbPeakWeatherModelPast`, `bpbPeakWeatherModelForecast` in `storage.local` | [Peak weather](../src/weather/peak-weather.js), lines 22–23, 391, 461 |
| Summit hourly weather metric tab | `bpbPeakWeatherHourlyMetric` in `storage.local` | [Peak weather](../src/weather/peak-weather.js), lines 23, 238, 461 |
| Historical ascent weather model and card placement | `bpbAscentWeatherModel`, `bpbAscentWeatherColumn`, `bpbAscentWeatherSlot` in `storage.local` | [Ascent weather](../src/ascent/ascent-weather.js), lines 26–28, 562, 676, 690 |
| Raster overlay opacity and selected public-land types | `bpbMapOverlayOpacityV1` in `storage.local` | [Overlay bridge](../src/maps/map-layer-bridge.js), lines 15–17, 52–55, 124; validation in [schema helpers](../src/settings/settings-schema.js), lines 45–58, outside `DEFAULTS` |
| Photo Topos viewport dimensions | `bpbPhotoViewport` in `storage.local` | [Photo editor](../photos/photos.js), lines 213, 293–299, 371–378 |
| Photo Topos drawing/marker/text defaults and shared color/opacity | `bpbPhotoTool:<type>`, `bpbPhotoSharedStyle` in `storage.local` | [Photo editor](../photos/photos.js), lines 346–386; the nine types are route, drawing, bolt, anchor, piton, rappel, belay, pitch, and text |
| Peak-page report “favorites only” filter | `bpbPeakReportFilter.favoritesOnly` in `storage.local` | [Preference schema](../src/favorites/ignored-climbers.js), lines 6–8, 54–57; [writer](../src/background/ignored-store.js), lines 64–68 |
| Ignored-climber two-way sync enabled/disabled | `bpbIgnoredSyncState.enabled` in `storage.local` | [GitHub wiring](../src/background/github-routes.js), lines 841–843; [sync controller](../src/background/climber-list-sync.js), lines 13–15, 345–361 |
| Active ascent filter chips and Trip report chip's minimum words | `pbAscentBetaFilter.v1` in Peakbagger `localStorage` | [Ascent filter](../src/ascent/ascent-filter.js), lines 52–97, 918–937; old order fields remain as migration inputs, but current order is core settings |
| Ascent table column split | `pbAscentTableSplit.v1` in Peakbagger `localStorage` | [Ascent split](../src/ascent/ascent-table-split.js), lines 17, 117; [shared persistence](../src/ui/column-resize.js), lines 12–37 |
| Peak-page column split | `pbPeakTableSplit.v1` in Peakbagger `localStorage` | [Peak split](../src/ui/peak-table-split.js), line 25; same shared persistence |
| Peak-page map viewport dimensions | `pbPeakMapViewport.v1` in Peakbagger `localStorage` | [Peak map](../src/maps/peak-map.js), lines 94–144 |
| Garmin import consent and selected Peakbagger account | `connection.enabled`, `connection.cid` and connection metadata in extension IndexedDB `bpb-garmin-v1` | [Garmin store](../src/garmin/garmin-store.js), lines 4–19; [enable/import paths](../src/garmin/garmin-imports.js), lines 276–283, 321–338 |

Photo annotation styles already applied to a project can travel with that
project through the photo backup or project download. That does not transfer
the editor's remembered defaults for the next drawing or photo.

The `bpbThemePref` site/extension-page `localStorage` entries are startup mirrors
of the **synced** `theme` setting, not separate local theme choices. See
[page theme](../src/theme/theme.js) (lines 73–76) and
[extension-panel theme](../src/theme/panel-theme.js) (lines 10–21).

## Credentials and device migration

The default file download has no `apiKeys` or `githubConnection` field. Opting
in adds `apiKeys.imgbb` and `apiKeys.garmin`, including explicit `null` for an
absent saved key. A complete GitHub connection adds `githubConnection.token`
and `repository.owner`, `repository.name`, and an available numeric repository
ID. It does not copy the auth epoch, cached account metadata, or selected branch;
the GitHub import validates the connection and resolves repository state again.

Source: [file export](../src/background/settings-file-routes.js) (lines 36–49,
80–108), [credential payload validation](../src/settings/settings-transfer.js)
(lines 37–78), [GitHub local storage](../src/github/github-auth.js) (lines
320–339), and [ImgBB local storage](../src/photos/imgbb-auth.js) (lines 9–23).

On import:

- Absent credential fields preserve the destination credentials. An explicit
  null API key removes that service's saved key. Null Garmin credentials
  disable that connection while retaining inbox data.
- Included GitHub and non-null Garmin credentials require host access and
  validation. Browser permission grants are not serialized in the file.
- A Garmin key imported onto a fresh profile does **not** enable imports or
  copy the source Peakbagger account binding. Existing destination consent is
  preserved only when already present. Garmin access tokens remain in memory
  and are not exported.
- These are unencrypted files. GitHub backup uses a newly built settings-only
  payload, rather than uploading the credential-bearing file.

Evidence: [import preflight and writes](../src/background/settings-file-routes.js)
(lines 123–238), [permission request](../options/settings-backup.js) (lines
193–220), [Garmin imported-key handling](../src/garmin/garmin-imports.js)
(lines 321–338), and [Garmin privacy contract](../PRIVACY.md) (lines 86–92).

## GitHub behavior and cross-device limitations

| File / feature | Automatic behavior | Restore / reconciliation | Control location |
| --- | --- | --- | --- |
| `settings.json` | Push current cleaned core settings; default on when connected | Explicit restore replaces known settings after confirmation; no automatic pull or per-setting merge | Synced `autoSettingsBackup` |
| `favorite-climbers.json` | Push current custom favorites; default on when connected | Explicit list replacement with guarded Undo; no automatic pull or cross-device list merge | Synced `autoFavoritesBackup` |
| `ignored-climbers.json` | Two-way sync; default on when connected | Initial combination preserves both lists when compatible; subsequent three-way comparison propagates additions/removals and pauses for unresolved conflicts | Local `bpbIgnoredSyncState.enabled` |
| `photo-library.json` | Push/merge catalog metadata and projects; default on when connected | Explicit restore preview and conflict handling; does not restore local image bytes from GitHub | Synced `autoPhotoLibraryBackup` |
| Saved ascent/report folders | Backup after saves when ascent backup is enabled; manual backup also available | Separate ascent archive workflow, not settings sync or automatic Peakbagger form saving | Synced `enableGithubBackup`; deletion mirroring separately opt-in |

Settings and favorites have a one-minute trailing alarm and a 30-minute
watchdog. Writes skip an unchanged local content signature within the same
repository/branch/auth epoch. Connection changes schedule enabled backups.
This signature is a local acknowledgement, not evidence that no other device
has subsequently changed the remote file. See [automatic backup controller](../src/background/github-routes.js)
(lines 1134–1263, 1937–1952).

**Practical consequence:** connecting a fresh profile with default
`autoSettingsBackup: true` can upload its default/different preferences over an
existing repository's `settings.json` before the user restores it. The same
reasoning applies to custom favorites. This is a source-derived consequence of
the documented push-only design; this audit did not reproduce an overwrite
against a live repository. The root writer preserves unrelated files and
retries Git ref conflicts, but does not merge the settings JSON content. See
[root-file writer](../src/github/github-client.js) (lines 600–613) and the
[original transfer boundaries](archive/settings-export-import-github-backup.md)
(lines 29–51).

For a deliberate migration through an existing GitHub backup, disable automatic
settings/favorites backup on the destination before connecting, then restore
the desired data before enabling automatic backup. Because those toggles are
themselves synced, changing them can affect other profiles in the same browser
account. A manual settings file avoids needing to connect GitHub just to
transfer the core preferences.

Browser sync itself is also not a field-level merge implemented by Better
Peakbagger. The worker serializes local patches, but writes the entire
`bpbSettings` object as one storage item. Concurrent edits on different devices
are resolved by the browser's sync semantics; local queuing does not guarantee
both changes survive. [Mozilla documents key-level conflict resolution](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync#synchronization_process).
No multi-device collision was tested here.

## Related data that a settings export does not cover

- **Custom favorites and ignored lists:** separate GitHub JSON files. The
  inspected list controls offer GitHub transfer, not a standalone local JSON
  download/import. Neither list is inside the settings download. Buddy List
  membership belongs to Peakbagger; the local Buddy cache/intents are not
  exported. A Buddy-derived entry already copied into custom favorites can be
  in the favorites backup. See [favorites UI](../options/favorites-backup.js),
  [ignored UI](../options/ignored-backup.js), and
  [climber-list design](climber-lists.md).
- **Photo originals and projects:** **Download project** creates a separate
  `.bpb-photo` bundle containing the original and project; a matching import
  path exists. This is not an export of global photo-tool preferences or the
  entire extension. GitHub photo backup contains allowlisted metadata,
  annotation projects, public URLs, and deletion tombstones, not original or
  thumbnail blobs, API keys, delete URLs, or upload journals. See
  [project transfer](../photos/photos.js) (lines 2824–2950) and
  [photo backup serializer](../src/photos/photo-backup.js) (lines 36–78, 118–141).
- **Unsaved report drafts:** local records with **Copy Markdown**, not settings
  transfer or automatic GitHub draft recovery. Saved ascent/report backup is a
  different path. See [draft manager](../options/drafts.js) (lines 272–279) and
  [draft storage routes](../src/background/report-draft-routes.js).
- **Garmin inbox/history:** retained activity analyses, drafts, verified-save
  receipts, dismissals, scan cursors, and retry state stay in local IndexedDB.
  Exporting the Garmin key does not transfer them. See
  [Garmin state](../src/garmin/garmin-store.js) (lines 4–19).
- **Caches and transient state:** DEM tiles/index, public SNOTEL catalog,
  browser/session capture jobs, handshakes, backup signatures/retry records,
  and theme mirrors are not settings backups. Active overlay selections,
  temporary weather locations/stations, chart interactions, and current editor
  camera/selection state are not portable preferences. See
  [privacy storage inventory](../PRIVACY.md) (lines 74–83),
  [terrain cache](../src/terrain/terrain-cache.js), and
  [SNOTEL client](../src/snow/snotel-client.js).

## Audit follow-ups and status

| ID | Finding / decision | Status and acceptance check |
| --- | --- | --- |
| S1 | Core settings backup is push-only; a newly connected profile can replace the shared backup | Documented design boundary, unchanged. If automatic cross-device settings reconciliation is desired, specify conflict and first-connection behavior separately; verify with two isolated profiles and distinct values before claiming two-way sync |
| S2 | A settings migration omits the local preferences listed above, including the ignored-sync opt-out | Confirmed coverage boundary, unchanged. Decide which choices should be portable before implementation; geometry and local service consent should not silently become globally synced |
| S3 | Transfer documentation is stale | Open documentation defect: [GitHub guide](github-ascent-backup.md) lines 669–701 describes v3, always-exported ImgBB, and “Include GitHub connection”; [serializer comment](../src/settings/settings-transfer.js) lines 81–84 repeats the old unconditional API-key story. Update both against the actual file routes and test credential-free/default, opted-in, and legacy import cases |
| S4 | Manual-file privacy summary omits Garmin from its credential list | Open documentation omission: [manual settings files](../PRIVACY.md#manual-settings-files) names ImgBB/GitHub, while the separate Garmin section and current UI correctly describe opt-in Garmin export. Align the summary without widening the existing runtime boundary |

These are report findings, not authorization to change runtime storage policy.
The local weather/overlay exclusions and push-only settings/favorites behavior
are already documented design choices; they are not presented as newly
discovered implementation bugs.

Closure ledger:

- **Fixed and verified:** no runtime fixes in this audit. This report and its
  documentation-index entry were added; local verification is recorded below.
- **Intentionally not changed:** all storage scopes, credential boundaries,
  backup directions, defaults, and local-only preferences.
- **Changed but not fully proven:** none in runtime. Live browser-account sync,
  live GitHub transfers/collisions, and device migration remain untested.
  S3/S4 remain open documentation findings outside this report.

## Verification performed

- Searched persistence call sites across `src/`, `options/`, `photos/`, and
  `popup/`, then traced the core serializer, manual file routes, GitHub writers,
  list sync controller, and Garmin credential import path.
- A direct Node probe enumerated **59** defaults and asserted exact key equality
  with the exported settings, unknown-key exclusion, and absence of credential
  fields in the default payload. Current transfer schema is **4**.
- A second probe checked this report's inventory against the schema: all 59
  keys appear exactly once. Documentation checks passed **3/3** after correcting
  an invalid privacy-section link; `git diff --check` passed.
- `npm run build` passed, producing 52 bundles. The following focused command
  completed successfully, including bundled-worker tests with scripted network
  responses and local storage/IndexedDB substitutes:

  ```sh
  node --test --test-reporter=dot \
    test/settings/settings-schema.test.mjs \
    test/settings/settings-store.test.mjs \
    test/settings/settings-transfer.test.mjs \
    test/background/background-settings-file.test.mjs \
    test/background/climber-list-sync.test.mjs \
    test/github/github-backup-integration.test.mjs \
    test/garmin/garmin-imports.test.mjs \
    test/photos/photo-backup.test.mjs \
    test/options/options-settings.test.mjs \
    test/options/options-ignored-backup.test.mjs
  ```

- Browser-account behavior was checked against the linked official Chrome and
  Mozilla documentation. No live credentials or user storage were read.
- No browser window was launched. No real Chrome/Firefox account sync, live
  GitHub write, credential import, visual rendering, or multi-device collision
  was exercised. These automated results establish local code behavior only.
