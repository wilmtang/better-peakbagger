# Privacy and data handling

Better Peakbagger has no account, analytics, telemetry, advertising, or
developer data server. It uses data only for the user-facing features described
here, does not sell it, and does not use or transfer it for unrelated purposes
or credit decisions.

Captured activity data leaves the browser only for the Peakbagger summit lookup
and GPS Preview actions described below. Optional 3D map providers receive tile
requests for the viewed area only after the user enables that feature. Settings,
a custom favorite-climber list, and photo-library metadata or annotation
projects reach GitHub only through the user's connected repository, either on
an explicit backup click or after the user separately enables automatic backup
for that data.

## Browser permissions

- **`storage`** saves theme, units, chart, map, capture, editor, beta-filter,
  favorite-source, and backup-toggle preferences in `storage.sync`. It keeps
  the bounded DEM cache index, custom favorite-climber list, owner-scoped Buddy
  List cache, GitHub backup token/repository, the user's ImgBB API key, and
  automatic-backup signatures and retry state in `storage.local`; short-lived
  capture jobs,
  prepared drafts, save-time backup snapshots, short-lived ascent-deletion
  intents/tombstones, and an in-progress GitHub device authorization live in
  `storage.session`. Capture, draft, snapshot, and deletion records expire after
  30 minutes; pending authorization is removed when its GitHub
  device code completes, fails, or expires. DEM response
  bytes live in browser-managed CacheStorage and may be evicted under storage
  pressure. The photo library uses device-local IndexedDB for catalog metadata,
  annotation projects, original/thumbnail image blobs, an upload operation
  journal, ImgBB delete URLs, and deletion tombstones. Those records are never
  browser-synced.
- **`activeTab`** grants temporary access to the one Garmin Connect or Strava
  activity page where the user clicked the toolbar button. It replaces
  permanent provider host permissions.
- **`scripting`** injects the packaged provider adapter into that clicked tab's
  page world so it can verify ownership and make the provider's authenticated,
  same-origin GPX export request. It does not download or execute remote code.
- **`tabGroups`** groups newly opened ascent drafts under **Peak Drafts**. It
  does not inspect or reorganize unrelated groups.
- **`alarms`** runs cleanup every five minutes so expired capture jobs and
  draft payloads are removed from session storage. It also provides the
  one-minute debounce and bounded delayed retries for user-enabled automatic
  settings, favorite-climber, and photo-library metadata backups.
- **Peakbagger host access** enables GPX analysis, ascent filtering, theme,
  login and summit checks, validated draft filling, and user-initiated favorite
  management on Peakbagger. There is no persistent Garmin Connect or Strava
  host access.
- **Optional GitHub host access** (`github.com`, `api.github.com`) is requested
  only when the user connects GitHub backup. It authorizes the extension to
  sign in via GitHub's device flow and to write the selected ascent, settings,
  favorite-climber, and photo-library metadata backups to the one repository
  the user grants. The
  GitHub user token lives in
  `storage.local` (never `storage.sync`), is held only by the background worker,
  and is never exposed to any web page.
- **Optional ImgBB host access** (`api.imgbb.com`) is requested only from an
  extension-owned page the user is acting on: the photo editor when the user
  chooses to upload, or Settings when the user saves an ImgBB API key. It
  permits a direct upload of the newly flattened image using the user's own API
  key. The extension has no ImgBB relay or developer account and does not use
  that access to inspect unrelated browsing.
- **Firefox `locationInfo` disclosure** reports that activity coordinates are
  sent to Peakbagger for summit lookup and GPS Preview; when the user loads the
  3D view, that tile coordinates for the viewed area go to Mapterhorn,
  OpenFreeMap when OSM Vector is selected, and a compatible selected map
  provider; and, when the user backs an ascent up to GitHub, that Peakbagger's
  stored GPS track (which contains coordinates) is written to the user's chosen
  repository. It is a data-handling disclosure, not permission to read device
  location.

## Activity capture

- **Ownership gate:** capture stops before reading GPS coordinates unless the
  provider page gives unambiguous evidence that the signed-in user owns the
  activity.
- **Settings gate:** capture and local-file processing stop before parsing or
  retaining data if the extension cannot read the current capture settings.
  Schema defaults keep passive UI renderable; they never authorize capture or
  become an exported/remote settings backup.
- **On-page analysis:** raw Garmin or Strava GPX is parsed in the activity page.
  It is never persisted, sent to the extension developer, or forwarded as
  source XML.
- **Summit discovery:** Peakbagger receives small bounding boxes derived from
  the track corridor. Every required lookup must succeed before results are
  shown.
- **Prepared drafts:** derived ascent fields and a reduced track live only in
  `storage.session`, are bound to the expected source and draft tabs, and expire
  after 30 minutes.
- **GPS Preview:** only after the user chooses **Open drafts**, Peakbagger
  receives a newly serialized GPX containing trackpoint latitude, longitude,
  optional elevation and timestamp, and segment boundaries, plus waypoint
  coordinates and names by default. Trackpoints and waypoints share a limit of
  3,000 total points.
- **Manual publication:** Better Peakbagger can prepare GPS Preview, but no
  extension path clicks either Peakbagger Save control. Review and publication
  remain with the user.

The serializer excludes heart rate, cadence, power, temperature, device fields,
descriptions, routes, waypoint elevation/time/symbols, and extension elements.
The activity or track name is retained only for enabled multi-peak Trip Info.
Derived form values such as date, ascent times, distance, gain, per-day
statistics, and nights out remain in the prepared draft until it expires or is
discarded.

## Processing a GPX file you upload

Choosing a `.gpx` file in the GPS Track field of Peakbagger's own Add Ascent
form offers an optional **Process** action that runs the same pipeline as
activity capture, under the same rules:

- The file is read and parsed on that Peakbagger page. The raw XML never
  leaves the page, and the original file on disk is not modified.
- Only the analysis fields described above reach the background worker:
  trackpoint latitude/longitude/elevation/timestamp, plus waypoint
  coordinates/names and the track name exactly as the capture settings allow.
- The climb's timezone is resolved offline from the track's starting
  coordinate using the packaged `tz-lookup` data; no coordinate is sent to any
  timezone service.
- Peakbagger receives the same summit-corridor lookups, after the login check.
- If you apply the result, the upload field is repopulated with the newly
  serialized, privacy-reduced GPX described above — Peakbagger never receives
  your source file through the extension — and the prepared values follow the
  same 30-minute `storage.session` expiry, exactly-once GPS Preview, and
  manual-Save rules as capture.

The extension also fills an empty Ascent Date on a fresh form with today's
date, entirely locally.

## Peakbagger page features

The GPX Analyzer fetches only the GPX already linked from the current
Peakbagger ascent page and processes it locally. Cross-page preferences live in
`storage.sync` and may leave the device only through the user's browser-sync
account. Page-specific filter state and the early theme mirror stay in
Peakbagger's `localStorage`.

The Favorites ascent filter uses one of two device-local data sources. In Buddy
List mode, the extension fetches the signed-in user's own Buddy List only when
the filter needs an absent or stale copy, when the user requests a refresh or
Buddy import in Settings, or after the user uses Peakbagger's native Add/Remove
Buddy control. Visiting the Buddy List itself updates the cache from the
rendered page without another request. The cache contains third-party climber
ids and displayed names plus the signed-in owner's id and fetch time. Seven
days is its ordinary automatic refresh interval; a stale copy may remain
locally and usable when refresh fails, until a later refresh replaces it or
extension data is cleared.

To verify a native Add/Remove Buddy action after Peakbagger navigates, the
current Peakbagger tab briefly stores the target climber id, intended action,
and timestamp in that site's tab-scoped `sessionStorage`. The marker is consumed
and removed on the next supported climber-page load; values older than five
minutes are ignored. It is never copied to extension storage, browser sync, or
GitHub. The click alone is not treated as success: the extension fetches the
signed-in user's Buddy List, verifies the response owner, and checks the target's
actual membership before changing custom favorites. A valid report may refresh
the Buddy cache even when it does not confirm the intended action.

In custom mode, the extension stores up to 1,500 climber ids, displayed names,
added-at timestamps, and manual/Buddy provenance in `storage.local`. Adding by
id or link fetches that public Peakbagger climber page to verify its identity and
name. The list remains on the device until the user edits it, restores a backup,
clears extension data, or uninstalls the extension. It is not sent through
browser sync. After a confirmed native Buddy addition, custom mode also adds the
climber locally when space remains. Native Buddy removal leaves the custom
favorite alone unless the user enables **Keep Buddy removals in sync**; only
that boolean preference, not the favorite list, uses browser sync.

Rich- and Markdown-mode trip-report drafts are stored locally by the extension.
They are keyed to the climber and ascent or peak, become eligible for lazy
cleanup after 14 days, and are pruned toward 30 drafts when the editor performs
maintenance. Plain mode does not write these drafts. The editor offers a
differing draft for explicit restoration; it does not silently replace the
server's text. The complete lifecycle and current Save-boundary limitations are
documented in [the trip-report editor design](docs/trip-report-editor.md#device-local-trip-report-draft-lifecycle).

When a Rich editor or Markdown preview displays a user-provided remote image,
direct video, or YouTube embed, the browser may request that media from its
host. Better Peakbagger applies a no-referrer policy to local image/direct-video
requests and published direct videos. YouTube requires embedded players to
identify the embedding client, so its player receives only Peakbagger's origin
(`https://www.peakbagger.com/`), not the ascent path or query string. Published
remote images follow Peakbagger's page policy. Either way, the host still
receives the requesting browser's IP address and ordinary request metadata.
Saving remote media into a report also causes readers' browsers to request it
when Peakbagger displays the published report.

## Photo topo editor and ImgBB upload (optional)

The photo topo editor is an extension-owned page. Choosing an image stores its
original bytes, a local thumbnail, source dimensions/file name/hash, the
versioned annotation project, title, and alt text in the browser
profile's IndexedDB. The original may contain camera metadata; it stays in that
local blob and is not uploaded by Better Peakbagger.

Before upload, the editor flattens the photo and annotations into a newly
encoded JPEG or PNG. That export contains pixels only and excludes the source
file's EXIF and other metadata, source file name, project JSON, local record
identity, report identity, API key, and delete URL. The extension accepts only
browser-decodable images and exports through ImgBB's documented maximum of
32 MiB; there is no larger-file or chunked path.

- **What leaves the browser:** only after the user chooses **Upload and
  insert**, ImgBB receives the flattened image bytes, the chosen upload name,
  the user's API key, and ordinary network request data such as IP address.
  ImgBB returns public image/viewer URLs and a private delete URL. The public
  image URL can then be inserted into the user's report; Peakbagger and later
  report readers request it as ordinary remote media.
- **Credential handling:** the user supplies the ImgBB API key, from either the
  photo editor or Settings → Activity creation → Trip report photos. It is
  stored only in the dedicated `bpbImgbbAuth` record in device-local
  `storage.local`, never `storage.sync`, GitHub, a report, or the original
  Peakbagger content script. Neither page can read a saved key back: the
  background worker reports only whether one exists, and leases the value
  itself to the exact packaged photo page for an upload request. Removing the
  key does not alter prior uploads.
- **Local upload history:** Better Peakbagger keeps its own searchable catalog
  because ImgBB's documented v1 API does not provide an account-gallery listing
  operation. The catalog stores public URLs, source/export metadata and hashes,
  upload and reachability state, lineage, report references, and local asset
  availability.
- **Deletion capability:** the ImgBB delete URL is a sensitive capability and
  remains only in a separate device-local IndexedDB secret record. It is never
  put in a report or GitHub backup. Better Peakbagger does not automatically
  delete remote ImgBB images. Removing a library entry or report reference is a
  local action and does not remove a published image.
- **Local deletion:** a removed item enters **Recently Deleted** and writes a
  tombstone. It can be restored locally; after 30 days its original, project,
  and thumbnail are eligible for pruning. The tombstone remains so recovery
  does not resurrect an older record. Clearing extension data or uninstalling
  can remove the entire local library without deleting already uploaded images.

The ImgBB API governs remote retention and the public image URL. An interrupted
request can have an unknown provider outcome, so Better Peakbagger does not
automatically retry and risk a duplicate upload.

## Optional 3D terrain

The 3D feature is off by default, but its control remains visible. The first
click shows a provider and privacy confirmation. Declining keeps the feature
off; it can still be enabled later in Settings.

After confirmation, Mapterhorn receives DEM tile requests covering the route or
summit area and subsequent map movements. With 3D enabled, hovering or focusing
the 3D button may also pre-request the elevation tiles for that view from
Mapterhorn, so opening 3D paints from cache; this happens only on that explicit
interaction, never merely because a map page loaded. Selecting OSM Vector sends
tile requests to OpenFreeMap. Selecting a compatible Peakbagger Leaflet layer
may request raster tiles from that layer's existing provider for the 3D camera's
view. These requests necessarily disclose the viewed location and the user's IP
address to the provider.

The renderer receives coordinate segments or a summit focus plus a bounded,
transient map-layer descriptor. It does not receive source GPX, timestamps,
elevation samples, activity metadata, or Peakbagger identity. Successful DEM
responses may be reused from the bounded, best-effort local cache. Returning to
2D stops that session's tile activity — the renderer is parked idle for a few
minutes to make re-entry instant, then released — but does not clear the cache.

## GitHub connection and backup (optional)

GitHub is disconnected by default. The user must explicitly grant GitHub host
access, authorize the extension, and select a repository. Ascent backup is a
separate setting and remains off until enabled; settings and favorite backup or
restore and photo-library metadata recovery can use the connection without
enabling ascent backup. Their automatic backup toggles are also separate and
off by default. None of these features block or alter the Peakbagger save, and
the extension never clicks a Peakbagger Save control.

- **What leaves the browser:** for an ascent the user chooses to back up, the
  extension sends that ascent's structured fields (the values the user entered),
  the trip report as Markdown, and Peakbagger's *stored* GPS track — the same
  reduced, user-approved track Peakbagger already publishes on the ascent page,
  not the raw provider GPX, which still never leaves the activity page. It goes
  only to the single GitHub repository the user granted, over the GitHub API.
  A favorite-climber backup separately sends `favorite-climbers.json`
  containing the custom list's climber ids, displayed names, added-at timestamps,
  provenance, and export time. A settings backup sends `settings.json`, containing
  only the extension's validated settings schema values, export time, schema
  version, and extension version. It never contains the GitHub token or selected
  repository, favorites, drafts, caches, ascent, activity, or GPS data. These two
  transfers write only those fixed root files in the same selected repository.
  A photo-library backup separately writes `photo-library.json`, containing
  catalog metadata, public ImgBB URLs, the sanitized source file name,
  source/export hashes and dimensions, title and alt state, lineage, report
  references, annotation projects, deletion tombstones, schema/export time, and
  extension version. It never includes the ImgBB API key, ImgBB delete URLs,
  original or thumbnail image bytes, upload journal, transient editor state, or
  GitHub credentials.
- **When it leaves:** only on the user's explicit **Back up to GitHub** click,
  an explicit **Back up all ascents** or confirmed **Refresh all** run from the
  user's own ascent list, or — if the user separately turns on automatic
  backup — after each save. During a profile run, the extension reads each
  owned ascent's edit form and stored GPX from Peakbagger in the signed-in tab,
  sends one ascent at a time to GitHub, and retains no separate progress record.
  Existing repository folders are the resume checkpoint. Backups use named
  mountain folders at the repository root plus a small repository marker; a
  populated repository is inspected and requires explicit confirmation before
  selection, and unrelated files are preserved. No ascent is transmitted
  without one of those opt-ins. Settings and favorites leave on an explicit
  backup click, or automatically after their stored value changes while that
  data type's user-enabled automatic-backup toggle is on. Restore is always an
  explicit Settings action with a confirmation and never runs automatically.
  Photo metadata leaves on an explicit backup click or after a catalog change
  while its separate automatic toggle is enabled. Photo restore is explicit,
  shows a change/conflict preview, and requires confirmation. It reconstructs
  metadata and annotations only; it cannot restore original pixels, thumbnails,
  or ImgBB deletion capability. Automatic ascent backup never includes or
  updates `settings.json`, `favorite-climbers.json`, or `photo-library.json`.
- **Optional deletion mirroring:** if the user separately enables **Remove
  backup files after I delete an ascent**, the extension records intent before
  the native Peakbagger Delete POST, then checks the authenticated complete My
  Ascents list. Only after that list proves the ascent absent does it remove
  Better Peakbagger's `report.md`, `ascent.json`, and `track.gpx` from the
  repository's current branch. User-added files and Git history remain; a
  failed or unconfirmed Peakbagger deletion does not change GitHub.
- **Ownership:** the backup affordance appears only on ascents the signed-in
  climber owns. Full-profile controls additionally require the signed-in
  climber's own **My Ascents** identity and an edit affordance for every parsed
  row; they fail closed otherwise.
- **Authorization:** sign-in uses GitHub's device flow with only the app's
  public client id (no client secret exists). Repository scope is chosen on
  GitHub's own installation page ("Only select repositories"). The resulting
  token can reach only that repository's contents and is revocable at any time
  by disconnecting in Settings or uninstalling the app on GitHub. The token is
  stored in `storage.local` and never synced.

Settings can also be exported as a JSON file downloaded by the browser and
imported into another profile without GitHub. Export happens only when the user
clicks **Export settings**. Import validates the file through the current
settings schema and requires an inline confirmation before replacing the current
settings; it does not upload the file anywhere.

## Third-party services

- **Peakbagger** receives summit-corridor lookups and user-approved GPS Preview
  uploads.
- **Mapterhorn** receives DEM tile requests only for an activated 3D view, or a
  bounded pre-request for the view when the enabled 3D button is hovered.
- **OpenFreeMap** receives style and tile requests only when OSM Vector is
  selected.
- **Selected map providers** may receive raster tile requests when their
  compatible Peakbagger layer is mirrored in 3D.
- **YouTube** receives player requests when a YouTube trip-report embed is
  displayed in the Rich editor, Markdown preview, or published report,
  including Peakbagger's origin as the required client identification.
- **User-provided media hosts** may receive image or direct-video requests when
  that media is displayed in the Rich editor, Markdown preview, or published
  report.
- **ImgBB** receives a flattened image, upload name, the user's API key, IP
  address, and ordinary request metadata only when the user explicitly uploads
  from the photo editor. It later receives ordinary image requests when the
  public URL is displayed.
- **Windy, Copernicus Browser, NOHRSC, and AirNow** are opened only when the user
  follows their corresponding summit link.
- **GitHub** receives ascent backups (fields, Markdown trip report, and
  Peakbagger's stored GPS track) only after the user enables GitHub backup,
  connects a repository, and clicks Back up, starts a profile backup/refresh,
  or opts into automatic backup. It receives settings or the custom
  favorite-climber list on an explicit backup click, or after a change while
  the corresponding automatic-backup toggle is enabled. It receives
  photo-library metadata and annotations on an explicit backup click or after a
  catalog change while that independent automatic toggle is enabled. It returns
  a fixed root recovery file only on an explicit restore action. Data goes only
  to the user-chosen repository.

Better Peakbagger packages all extension code and libraries locally. A YouTube
player is remote page content isolated in YouTube's cross-origin iframe; it is
never loaded as extension code or given extension privileges.
