# Privacy and data handling

Better Peakbagger has:

- no Better Peakbagger account;
- no analytics, telemetry, or advertising; and
- no developer-operated data server.

The extension uses data only for the features described here. It does not sell
data or use or transfer it for unrelated purposes or credit decisions.

Data leaves the browser only when a feature requires it:

- **Peakbagger** receives summit lookups and user-approved GPS Preview data.
- **3D map providers** receive tile requests for the viewed area only after the
  user enables 3D.
- **GitHub** receives only the data types the user explicitly or automatically
  backs up to their selected repository.
- **ImgBB** receives a flattened image only when the user uploads it.
- **Media hosts** receive ordinary browser requests when remote report media is
  displayed.

The Sun and Moon calculator is not a data-transfer feature. Its coordinate,
date, time, map bearing, and astronomical results remain in the Peakbagger tab.

## Browser permissions

| Permission | Purpose and limits |
| --- | --- |
| `storage` | Stores preferences, credentials, caches, drafts, and other extension data as detailed below. |
| `activeTab` | Temporarily accesses only the Garmin Connect or Strava activity tab where the user clicks the toolbar button. There is no persistent provider host access. |
| `scripting` | Injects packaged adapters into the clicked provider tab to verify ownership and request its same-origin GPX export, and into a Peakbagger tab for the login and summit requests described below. It never downloads or executes remote code. |
| `tabGroups` | Groups newly opened ascent drafts under **Peak Drafts** without inspecting or reorganizing unrelated groups. |
| `alarms` | Removes expired session records every five minutes and schedules the one-minute debounce and bounded retries for user-enabled automatic backups. |
| Peakbagger host access | Supports GPX analysis, offline Sun and Moon planning, filters, theme, login and summit checks, draft filling, and favorite management on Peakbagger. |
| Optional GitHub host access | Access to `github.com` and `api.github.com` is requested only when the user connects GitHub. It supports device-flow sign-in and the one repository the user grants. |
| Optional ImgBB host access | Access to `api.imgbb.com` is requested only from the photo editor when the user uploads or from Settings when the user saves an API key. It does not inspect unrelated browsing. |

Firefox's `locationInfo` declaration is a data-handling disclosure, not
permission to read device location. It covers:

- activity coordinates sent to Peakbagger for summit lookup and GPS Preview;
- viewed-area tile coordinates sent to Mapterhorn, OpenFreeMap, or a selected
  compatible map provider when 3D is used; and
- a Peakbagger-stored GPS track written to the user's GitHub repository when
  the user backs up an ascent.

### Where browser data is stored

| Storage | Contents | Retention and sync |
| --- | --- | --- |
| `storage.sync` | Theme, units, chart, map, capture, editor, beta-filter, favorite-source, and backup-toggle preferences | May sync through the user's browser account. |
| `storage.local` | DEM cache index, custom favorites, owner-scoped Buddy List cache, GitHub token/repository, ImgBB API key, report drafts, and automatic-backup state | Device-local; never browser-synced. |
| `storage.session` | Capture-job metadata, generation-scoped reduced GPX payloads, prepared drafts, save-time backup snapshots, ascent-deletion intents/tombstones, and pending GitHub device authorization | Capture, draft, snapshot, and deletion records expire after 30 minutes. Authorization is removed when it completes, fails, or expires. |
| CacheStorage | Bounded DEM response cache | Browser-managed and subject to eviction. |
| IndexedDB | Photo catalog, projects, original and thumbnail image blobs, upload journal, ImgBB delete URLs, and deletion tombstones | Device-local; never browser-synced. |
| Peakbagger `localStorage` | Page-specific filter state and the early theme mirror | Remains with the Peakbagger site data. |

## Activity capture

Activity capture is a short-lived, user-started transaction:

1. **Ownership check:** capture stops before reading coordinates unless the
   activity page unambiguously proves that the signed-in Garmin or Strava user
   owns the activity. Profile and author identifiers are compared on the page;
   only the verdict, provider, and activity id reach the extension.
2. **Settings check:** capture stops before parsing or retaining data if current
   capture settings cannot be read. UI defaults never authorize capture or
   become an exported or remote settings backup.
3. **Local analysis:** raw provider GPX is parsed on the activity page. It is
   never persisted, sent to the developer, or forwarded as source XML.
4. **Peakbagger session and summit lookup:** a Peakbagger tab makes the login
   check and the small bounding-box requests derived from the track corridor.
   The extension does not request cookie-reading permission or copy cookie
   values; the site handles its own signed-in session. A page freshly opened or
   loaded for capture may satisfy the login check from a small allowlist of
   Peakbagger's global account-navigation links and their consistent climber ID;
   ambiguous evidence and already-loaded tabs use the live account-page check.
   No arbitrary page text or form data is copied. Every required lookup must
   succeed before results appear.
5. **Prepared drafts:** derived ascent fields and a generation-scoped reduced
   track stay separately in `storage.session`, are bound to the expected tabs,
   and expire after 30 minutes.
6. **GPS Preview:** after the user selects **Open drafts**, Peakbagger receives a
   newly serialized GPX. Trackpoints and waypoints share a 3,000-point limit.
7. **Review and Save:** the extension may prepare GPS Preview, but it never
   clicks a Peakbagger Save control. Publication remains with the user.

The reduced GPX can contain:

- trackpoint latitude, longitude, optional elevation and timestamp, and segment
  boundaries;
- waypoint latitude, longitude, and name, when enabled; and
- an activity or track name only when enabled for multi-peak Trip Info.

It excludes heart rate, cadence, power, temperature, device fields,
descriptions, routes, waypoint elevation/time/symbols, and extension elements.
Derived form values such as date, ascent times, distance, gain, per-day
statistics, and nights out remain only in the prepared draft until it expires
or is discarded.

## Processing a GPX file you upload

The optional **Process** action beside Peakbagger's GPS Track field follows the
same rules as activity capture:

- The file is parsed on the Peakbagger page. Raw XML never leaves the page, the
  original file is not changed, and Peakbagger does not receive that source file
  through the extension.
- Only allowed analysis fields reach the background worker: trackpoint
  latitude, longitude, elevation, and timestamp; waypoint coordinates and
  names; and the track name when capture settings allow it.
- Timezone lookup runs offline from the track's starting coordinate using
  packaged `tz-lookup` data.
- Peakbagger receives the same post-login summit-corridor lookups.
- Applying the result replaces the upload field with the privacy-reduced GPX
  and uses the same 30-minute expiry, exactly-once GPS Preview, and manual-Save
  rules as capture.

The extension may also fill an empty Ascent Date on a fresh form with today's
date. That happens entirely locally.

## Peakbagger page features

### GPX Analyzer and preferences

- The GPX Analyzer fetches only the GPX linked from the current Peakbagger
  ascent and processes it locally.
- Cross-page preferences use `storage.sync`; page-specific filter state and the
  early theme mirror use Peakbagger's `localStorage`.

### Sun and Moon calculator

- Peak pages calculate from the already validated summit coordinate. GPX pages
  calculate from the selected route point, its valid timestamp when present,
  and otherwise only a complete saved ascent date plus an ephemeral preview
  time.
- Timezone lookup and astronomy run locally with packaged `tz-lookup` and
  SunCalc code. The displayed Moon position, phase, and illuminated percentage
  use the same selected instant as the Sun position. The calculator makes no
  request, adds no permission or storage key, and does not persist its
  coordinate, date, time, bearing, or result.
- Opening or moving the calculator cannot start 3D or another provider request.
  If 3D is already open, the calculator receives only the accepted map bearing
  so its decorative compass follows the view.
- Sunrise and sunset are astronomical level-horizon events. The result does not
  model terrain obstruction, shadows, weather, smoke, or actual direct light.

### Favorites and Buddy List

- **Buddy List mode:** the extension fetches the signed-in user's own Buddy List
  when its owner-scoped cache is absent or stale, after a requested refresh or
  import, or after a native Add/Remove Buddy action. Visiting the Buddy List can
  refresh the cache from the rendered page without another request.
- The cache stores the owner's id and fetch time plus third-party climber ids
  and displayed names. Its ordinary refresh interval is seven days. A stale
  cache may remain usable after a failed refresh.
- To verify a native Buddy action after navigation, that tab briefly stores the
  target id, intended action, and timestamp in Peakbagger `sessionStorage`.
  The marker is consumed on the next supported page, ignored after five
  minutes, and never copied to extension storage, browser sync, or GitHub. The
  extension verifies the resulting Buddy List before changing custom favorites.
- **Custom mode:** up to 1,500 climber ids, names, added-at timestamps, and
  manual/Buddy provenance stay in `storage.local`. Adding an id or link fetches
  the public climber page to verify it. The list is not browser-synced.
- A confirmed Buddy addition can add that climber to custom favorites. A Buddy
  removal changes custom favorites only when **Keep Buddy removals in sync** is
  enabled; only that preference, not the list, uses browser sync.

### Trip-report drafts and remote media

- Rich and Markdown report drafts are device-local. They are keyed to the
  climber and ascent or peak, become eligible for cleanup after 14 days, and are
  pruned toward 30 drafts during maintenance. Plain mode does not store drafts.
- A differing local draft is offered for explicit restoration; it never
  silently replaces server text. See the [trip-report editor design](docs/trip-report-editor.md#device-local-trip-report-draft-lifecycle).
- Displaying a user-provided remote image, direct video, or YouTube embed sends
  an ordinary request to that host, including the browser's IP address. Local
  image and direct-video requests use no referrer. YouTube receives only
  Peakbagger's origin as the required embedding-client identifier, not the
  ascent path or query string. Published remote media is also requested by
  readers' browsers.

## Photo topo editor and ImgBB upload (optional)

The photo editor stores the selected image, thumbnail, source metadata,
annotation project, title, and alt text in device-local IndexedDB. Source image
bytes can contain camera metadata; they stay local and are never uploaded by
Better Peakbagger.

Before upload, the editor creates a new JPEG or PNG containing only flattened
pixels. It excludes EXIF and other source metadata, the source file name,
project JSON, local/report identity, API key, and delete URL.

| Topic | Policy |
| --- | --- |
| Local limits | Decodable images: at most 64 megapixels and 16,384 pixels per side. Source processing/storage: at most 128 MiB. Editable bundles: at most 40 MiB. The original file is never changed. |
| Upload | Only after **Upload and insert**, ImgBB receives the flattened image, chosen upload name, the user's API key, IP address, and ordinary request metadata. ImgBB applies its own upload-byte limit. |
| API key | The saved key remains in device-local extension storage. The background worker gives it only to Better Peakbagger's exact packaged photo page for a direct ImgBB upload; it is never exposed to Peakbagger, another website, GitHub, browser sync, or status UI. Removing it does not affect earlier uploads. |
| Catalog | Stores public URLs, source/export metadata and hashes, upload/reachability state, lineage, report references, and local asset availability because ImgBB's v1 API has no account-gallery listing operation. |
| Delete URL | Stored separately in device-local IndexedDB. It is never placed in a report or GitHub backup. Removing a local entry or report reference does not delete the remote ImgBB image. |
| Recently Deleted | Removed items can be restored locally. After 30 days their image and project assets become eligible for pruning; tombstones remain to prevent older backups from resurrecting them. |

The public image URL may be inserted into a report, where Peakbagger and report
readers request it as remote media. ImgBB governs remote retention. Because an
interrupted upload can have an unknown provider outcome, the extension does not
automatically retry and risk a duplicate upload. Clearing extension data or
uninstalling can remove the local library without deleting uploaded images.

The API key can leave local storage only through an upload to ImgBB or an
explicit manual settings export that includes saved credentials, as described
below. Uploads use the user's own key; Better Peakbagger has no ImgBB relay or
developer account.

## Optional 3D terrain

3D is off by default. The first click shows a provider and privacy confirmation;
declining keeps it off.

After confirmation:

- Mapterhorn receives DEM tile requests for the route, summit area, and later
  map movements.
- Hovering or focusing the enabled 3D button may pre-request Mapterhorn tiles
  for that view. This requires that interaction and never happens merely because
  the page loaded.
- OpenFreeMap receives requests only when OSM Vector is selected.
- A compatible selected Peakbagger map layer may request raster tiles from its
  existing provider for the 3D camera's view.

Tile requests reveal the viewed area and the user's IP address to the provider.
Page messages alone cannot start them: extension code must observe a real
pointer or keyboard action and obtain a short-lived, one-use authorization.
Missing, expired, reused, mismatched, or disabled authorizations start no
renderer or prefetch.

The renderer receives coordinate segments or a summit focus and a bounded map
layer descriptor. It does not receive source GPX, timestamps, elevation samples,
activity metadata, or Peakbagger identity. DEM responses may be reused from a
bounded local cache. Returning to 2D stops tile activity; the renderer may stay
parked and idle for a few minutes before release, and the cache is not cleared.

## GitHub connection and backup (optional)

GitHub is disconnected by default. Connecting requires the user to grant host
access, authorize the extension, and select one repository. Ascent backup and
automatic backups for settings, favorites, and photo metadata are separate and
off by default. Backup never blocks or changes Peakbagger Save.

### What a backup contains

| Backup | Included | Excluded |
| --- | --- | --- |
| Ascent | User-entered ascent fields, Markdown trip report, and Peakbagger's stored, user-approved GPS track | Raw Garmin or Strava GPX |
| `settings.json` | Validated settings, export time, schema version, and extension version | Credentials, repository choice, favorites, drafts, caches, ascents, activity, and GPS data |
| `favorite-climbers.json` | Custom climber ids, displayed names, added-at timestamps, provenance, and export time | Buddy cache and credentials |
| `photo-library.json` | Catalog metadata, public URLs, sanitized source file name, hashes/dimensions, title/alt state, lineage, report references, annotation projects, tombstones, and version/export metadata | Image bytes, ImgBB key and delete URLs, upload journal, transient editor state, and GitHub credentials |

### When a backup happens

- **Ascents:** after **Back up to GitHub**, **Back up all ascents**, or a
  confirmed **Refresh all**; or after each save when automatic ascent backup is
  enabled. Profile runs read each owned ascent from Peakbagger and send one at a
  time. Existing repository folders act as resume checkpoints.
- **Settings and favorites:** after an explicit backup, or after a change when
  that data type's automatic-backup toggle is enabled.
- **Photo metadata:** after an explicit backup, or after a catalog change when
  its separate automatic toggle is enabled.
- **Restore:** always requires an explicit Settings action and confirmation.
  Photo restore previews changes/conflicts and restores metadata and annotations
  only, not pixels, thumbnails, or ImgBB deletion capability.

Backups go only to the selected repository. Ascents use named mountain folders
plus a small repository marker; other data uses the fixed root files above. A
populated repository is inspected and requires confirmation before selection,
and unrelated files are preserved. Automatic ascent backup never changes the
three root recovery files.

### Deletion, ownership, and authorization

- If **Remove backup files after I delete an ascent** is separately enabled,
  the extension first verifies the ascent is absent from the authenticated,
  complete My Ascents list. It then removes only Better Peakbagger's
  `report.md`, `ascent.json`, and `track.gpx` from the current branch. User files
  and Git history remain. Failed or unconfirmed deletion does not change GitHub.
- Ascent backup appears only for ascents owned by the signed-in climber.
  Full-profile actions also verify the user's My Ascents identity and edit
  access for every parsed row, failing closed otherwise.
- GitHub sign-in uses device flow with a public client id and no client secret.
  Repository scope is selected on GitHub. The token is kept in
  `storage.local`, held by the background worker, never browser-synced, and
  never exposed to a web page. Disconnecting removes the local connection;
  uninstalling the Better Peakbagger GitHub app revokes its GitHub-side access.

## Manual settings files

The user can export and import settings without GitHub:

- **Export settings** downloads an unencrypted JSON file only after a click. By
  default it contains validated settings and no credentials.
- **Include saved credentials** adds the ImgBB API key and, when connected, the
  GitHub token and selected repository in plain text. The Settings page warns
  the user to keep the file private and resets the checkbox after each export.
- Import validates the file and requires confirmation before replacing
  settings, the API key, or an included GitHub connection.
- Before accepting imported GitHub credentials, the extension requests host
  access if needed and verifies the token, account, repository grant,
  writability, branch, and backup-path safety with GitHub.
- A file without GitHub credentials leaves the current connection unchanged.
  The extension never uploads the settings file.

## Third-party services

| Service | When it receives data |
| --- | --- |
| Peakbagger | Summit-corridor lookup and user-approved GPS Preview; normal operation of Peakbagger page features. |
| Mapterhorn | DEM tiles after 3D activation, including an interaction-triggered pre-request when 3D is enabled. |
| OpenFreeMap or selected map provider | Style, vector, or raster tiles only when its compatible layer is used in 3D. |
| ImgBB | A user-initiated flattened image upload and later requests for its public URL. |
| YouTube or a user-provided media host | Remote report media requested by the editor, preview, published report, or report reader. |
| GitHub | User-triggered or separately enabled automatic backups to the selected repository; validation reads for an imported connection; explicit restores. |
| Windy, Copernicus Browser, NOHRSC, and AirNow | Only when the user follows the corresponding summit link. |

All extension code and libraries are packaged locally. A YouTube player is
remote page content isolated in YouTube's cross-origin iframe; it is never
loaded as extension code or given extension privileges.
