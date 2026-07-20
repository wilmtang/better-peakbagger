# Privacy and data handling

Better Peakbagger has no account, analytics, telemetry, advertising, or
developer data server. It uses data only for the user-facing features described
here, does not sell it, and does not use or transfer it for unrelated purposes
or credit decisions.

Captured activity data leaves the browser only for the Peakbagger summit lookup
and GPS Preview actions described below. Optional 3D map providers receive tile
requests for the viewed area only after the user enables that feature.

## Browser permissions

- **`storage`** saves theme, units, chart, map, capture, editor, and beta-filter
  preferences in `storage.sync`. It keeps the bounded DEM cache index and
  GitHub backup token/repository in `storage.local`; short-lived capture jobs,
  prepared drafts, save-time backup snapshots, and an in-progress GitHub device
  authorization live in `storage.session`. Capture, draft, and snapshot records
  expire after 30 minutes; pending authorization is removed when its GitHub
  device code completes, fails, or expires. DEM response
  bytes live in browser-managed CacheStorage and may be evicted under storage
  pressure.
- **`activeTab`** grants temporary access to the one Garmin Connect or Strava
  activity page where the user clicked the toolbar button. It replaces
  permanent provider host permissions.
- **`scripting`** injects the packaged provider adapter into that clicked tab's
  page world so it can verify ownership and make the provider's authenticated,
  same-origin GPX export request. It does not download or execute remote code.
- **`tabGroups`** groups newly opened ascent drafts under **Peak Drafts**. It
  does not inspect or reorganize unrelated groups.
- **`alarms`** runs cleanup every five minutes so expired capture jobs and
  draft payloads are removed from session storage.
- **Peakbagger host access** enables GPX analysis, ascent filtering, theme,
  login and summit checks, and validated draft filling on Peakbagger. There is
  no persistent Garmin Connect or Strava host access.
- **Optional GitHub host access** (`github.com`, `api.github.com`) is requested
  only when the user turns on GitHub backup, and only then. It authorizes the
  extension to sign in via GitHub's device flow and to write ascent backups to
  the one repository the user grants. The GitHub user token lives in
  `storage.local` (never `storage.sync`), is held only by the background worker,
  and is never exposed to any web page.
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

Trip-report drafts are stored locally by the extension. They are keyed to the
climber and ascent or peak, expire after 14 days, and are limited to 30 drafts.
The editor offers a differing draft for explicit restoration; it does not
silently replace the server's text.

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

## Optional 3D terrain

The 3D feature is off by default, but its control remains visible. The first
click shows a provider and privacy confirmation. Declining keeps the feature
off; it can still be enabled later in Settings.

After confirmation, Mapterhorn receives DEM tile requests covering the route or
summit area and subsequent map movements. Selecting OSM Vector sends tile
requests to OpenFreeMap. Selecting a compatible Peakbagger Leaflet layer may
request raster tiles from that layer's existing provider for the 3D camera's
view. These requests necessarily disclose the viewed location and the user's IP
address to the provider.

The renderer receives coordinate segments or a summit focus plus a bounded,
transient map-layer descriptor. It does not receive source GPX, timestamps,
elevation samples, activity metadata, or Peakbagger identity. Successful DEM
responses may be reused from the bounded, best-effort local cache. Returning to
2D destroys the renderer and stops that session's tile activity, but does not
clear the cache.

## GitHub backup (optional)

GitHub backup is off by default and takes effect only after the user enables it
in Settings and connects a repository. It never blocks or alters the Peakbagger
save; the extension never clicks a Peakbagger Save control.

- **What leaves the browser:** for an ascent the user chooses to back up, the
  extension sends that ascent's structured fields (the values the user entered),
  the trip report as Markdown, and Peakbagger's *stored* GPS track — the same
  reduced, user-approved track Peakbagger already publishes on the ascent page,
  not the raw provider GPX, which still never leaves the activity page. It goes
  only to the single GitHub repository the user granted, over the GitHub API.
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
  without one of those opt-ins.
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

## Third-party services

- **Peakbagger** receives summit-corridor lookups and user-approved GPS Preview
  uploads.
- **Mapterhorn** receives DEM tile requests only for an activated 3D view.
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
- **Windy, Copernicus Browser, NOHRSC, and AirNow** are opened only when the user
  follows their corresponding summit link.
- **GitHub** receives ascent backups (fields, Markdown trip report, and
  Peakbagger's stored GPS track) only after the user enables GitHub backup,
  connects a repository, and clicks Back up, starts a profile backup/refresh,
  or opts into automatic backup. Data goes only to the user-chosen repository.

Better Peakbagger packages all extension code and libraries locally. A YouTube
player is remote page content isolated in YouTube's cross-origin iframe; it is
never loaded as extension code or given extension privileges.
