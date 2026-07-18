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
  preferences in `storage.sync`. It keeps the bounded DEM cache index in
  `storage.local`, and short-lived capture jobs and prepared drafts in
  `storage.session`; that capture data expires after 30 minutes. DEM response
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
- **Firefox `locationInfo` disclosure** reports that activity coordinates are
  sent to Peakbagger for summit lookup and GPS Preview and, when the user loads
  the 3D view, that tile coordinates for the viewed area go to Mapterhorn,
  OpenFreeMap when OSM Vector is selected, and a compatible selected map
  provider. It is a data-handling disclosure, not permission to read device
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
Derived form values such as date, ascent times, distance, gain, and nights out
remain in the prepared draft until it expires or is discarded.

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

## Third-party services

- **Peakbagger** receives summit-corridor lookups and user-approved GPS Preview
  uploads.
- **Mapterhorn** receives DEM tile requests only for an activated 3D view.
- **OpenFreeMap** receives style and tile requests only when OSM Vector is
  selected.
- **Selected map providers** may receive raster tile requests when their
  compatible Peakbagger layer is mirrored in 3D.
- **Windy, Copernicus Browser, NOHRSC, and AirNow** are opened only when the user
  follows their corresponding summit link.

Better Peakbagger packages its executable code and libraries locally. It does
not download or execute remote code.
