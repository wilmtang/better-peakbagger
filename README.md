# Better Peakbagger

**Spend less time wrestling with Peakbagger and more time planning the next summit.**

Better Peakbagger adds free 3D maps, summit weather, and interactive route charts
to [Peakbagger](https://www.peakbagger.com/). Turn Garmin, Strava, or GPX tracks
into ascent drafts, find useful beta faster, and tell the story with rich-text
reports and photo topos. Optional GitHub backup keeps a copy of your climbing
history in your hands.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kndjohodnpdoejmjkiiakejfehoodedn?style=for-the-badge&logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store&color=4285F4)](https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn)
[![Firefox Add-ons](https://img.shields.io/amo/v/better-peakbagger?style=for-the-badge&logo=firefoxbrowser&logoColor=white&label=Firefox%20Add-ons&color=FF7139)](https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/)

Works with Chrome, Edge, Brave, and Firefox. No userscript manager required.
No analytics or telemetry.

![Better Peakbagger over a mountain landscape](store-assets/promo-marquee-1400x560.png)

## Install

Install from your browser's store:

- [Chrome Web Store](https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn) — Chrome, Edge, and Brave
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/) — Firefox

Visit Peakbagger to see the new tools. To capture a Garmin Connect or Strava
activity you own, open it and click the Better Peakbagger icon. Find Settings
in the extension's Details or Preferences page.

## Feature tour

### Free weather for the next summit—and the last one

See summit weather without an account, API key, or subscription, powered by
[Open-Meteo](https://open-meteo.com/).

- **Plan ahead:** up to 16 forecast days with temperature, rain, snow, and wind.
- **Check recent conditions:** browse the past 16 days and compare weather models.
- **Relive a climb:** historical ascent-day weather, with coverage back to 1940
  where available—even without a GPX.

Expand a day for hourly charts and conditions in mountain-local time. Hover
or select a timed GPX point to see that hour's weather on saved ascents.
These are summit model estimates; check local mountain forecasts before
heading out.
[Forecast details](docs/peak-weather.md) · [Historical weather](docs/ascent-weather.md)

### Explore the mountain in free 3D

![GPX analysis moving from a chart-synchronized 2D map into 3D terrain](store-assets/screenshot-3D-map-sync-resize-billboard-1.5x.gif)

Follow ridgelines, faces, and basins in interactive 3D at true vertical scale.
Explore peak maps and saved routes, or compare several tracks on a Full Screen
GPS map with their distinct colors preserved. Nearby peak markers link to
their Peakbagger pages.

Enable 3D when you want it. Choose compatible basemaps or experimental
OpenFreeMap styling; cached terrain makes return visits faster.
[3D map guide](docs/3d-map.md)

Made possible by free, open elevation data from [Mapterhorn](https://mapterhorn.com/).

### See recent satellite imagery

Add **Sentinel-2 (experimental)** imagery to 2D or 3D maps. Choose a capture
from the last 30 days and check its date, estimated coverage, and full-image
cloud cover. Microsoft Planetary Computer supplies the imagery; clouds and
gaps may still hide the terrain.

### Turn an activity into ascent drafts

Open your own Garmin Connect or Strava activity and click Better Peakbagger.
Choose from explained **Strong** and **Probable** summit matches to prepare
ascent drafts with route statistics, a privacy-reduced GPX, and the activity
link. Multi-peak trips and overnight details are filled when enabled. You
review every draft and press Save yourself.

![Garmin and Strava activity capture with privacy-reduced Peakbagger drafts](store-assets/showcase-activity-capture.gif)

### Turn a GPX file into a climb log

Choose a GPX on Peakbagger's **Add Ascent** form to calculate route details and
find summits along the track. Prepare a whole multi-peak trip, retain waypoint
names and coordinates if you choose, and fit large tracks to Peakbagger's point
limit. The original file stays on your device; you review each draft before Save.

### Relive the route, one chart point at a time

![Three-day GPX analysis with chart-synchronized map marker and custom route](store-assets/showcase-gpx-map-sync.gif)

Follow the GPX chart and watch the map move with you. Explore elevation,
distance, gain, grades, and multi-day timing in the mountain's timezone. Select
a point by mouse or keyboard to copy its coordinates, and customize route
colors, width, and outline across embedded and Full Screen GPS maps.

Gaps stay visible. Review flagged segments and switch back to the original
view at any time; downloads stay unchanged.
[Track data guide](docs/gpx-data-quality.md#resulting-chart)

### Take a saved route to your favorite mapping app

Send a saved ascent's original GPX to **Gaia GPS**, **onX Backcountry**,
**AllTrails**, or **CalTopo** for import. Grant access once, then review and
confirm in your mapping app. Choose the buttons and their order in Settings.
The destination's membership and file limits apply.
[Gaia guide](docs/gaia-import.md) · [onX guide](docs/onx-import.md) · [CalTopo guide](docs/caltopo-import.md)

### Plan around the Sun and Moon

Check sunrise, sunset, Moon phase, and Sun and Moon directions on a peak map
or GPX route. The calculator works offline in mountain-local time. Select a
recorded point or move the time slider to explore another moment.

Times assume a level horizon and do not account for terrain shadows.
[Sun and Moon guide](docs/sun-position.md)

### Find useful ascent beta faster

Filter ascent lists by trip report, GPS track, external link, or favorite
climber. Combine filters, set a minimum report length, and see live counts
without reloading. Reorder the filters to suit you; column headers also sort
ascent, peak, and Buddy lists instantly.

![Ascent beta filters and in-page sorting](store-assets/showcase-2-beta-filter.png)

### Keep trusted climbers close

Use your Peakbagger Buddy List or build a searchable favorites list. Hide
reports from ignored climbers, with a temporary reveal when you want another
look. Hover over a name—or open its **⋯** button—for Favorite, Ignore, and
Buddy actions.

Ignored lists stay local unless you choose GitHub backup or two-way sync.
[Climber lists guide](docs/climber-lists.md)

### Write trip reports, not bracket tags

Write with rich text or GitHub-flavored Markdown, including tables, photos,
video, and live preview. Better Peakbagger handles Peakbagger's bracket tags.
Local autosave and a draft manager help you resume, copy, or restore work;
Plain mode keeps the native editor available for legacy markup.

**Paste photos directly into Rich text.** With your own ImgBB key configured,
photos stay local until you save the report, then upload with visible progress.
[Report editor guide](docs/trip-report-editor.md)

![Rich-text trip report editor with formatting controls and local draft recovery](store-assets/showcase-5-trip-report-editor-light.png)

### Draw and reuse photo topos

Draw routes, freehand lines, labels, and climbing symbols over a photo. Upload
a flattened, metadata-free JPEG or PNG to ImgBB with your own API key, or
download it to share. Your original stays unchanged; the searchable local
library keeps editable projects and published versions ready to reuse.

Download and import project bundles to preserve originals and annotations
together. Your saved ImgBB key stays in device-local extension storage.
[Photo guide and limits](docs/photo-topo-editor.md)

![Photo Topos editor with an annotated alpine route and direct ImgBB upload](store-assets/showcase-6-photo-topos.png)

### Keep a copy of your climbing history

Back up one ascent or your full history to your own GitHub repository: readable
Markdown reports, ascent details, and saved GPX files. Enable automatic backup
after saving an ascent to keep later edits in sync. Backups never change your
Peakbagger records.

You can also back up and restore settings, climber lists, and photo-library
recovery data. Photo recovery includes annotations and links; keep project
downloads for original images. [Backup guide](docs/github-ascent-backup.md)

### Bring the rest of your planning into reach

Open location-aware weather, satellite imagery, fire and smoke information,
or regional avalanche bulletins from a peak page. Jump to Gaia GPS, AllTrails,
or onX maps at the same mountain, and reorder planning links to keep favorites
within reach. Availability varies by region; bulletin links do not assess
your route's avalanche danger.

### Give maps and reports room to breathe

Resize peak and ascent maps, adjust the divider between a saved trip report
and its summary, and move the ascent's weather card beneath either column.
Pointer and keyboard controls make room for the view you need. Your choices
are remembered for future visits.

### Make Peakbagger easier on the eyes

Choose dark, light, or system appearance. Set map and chart preferences, hide
weather or Sun & Moon cards, and mix units—for example, miles and feet with
Celsius. Export and import settings to carry your setup with you.

Exports omit credentials by default. **Include saved credentials** adds your
ImgBB key and GitHub connection to an unencrypted file; keep it private.

![Better Peakbagger settings beside Peakbagger dark mode](store-assets/showcase-3-dark-mode-settings.png)

## Privacy by design

No Better Peakbagger account, analytics, telemetry, advertising, or developer
data server. Raw Garmin and Strava GPX is processed on the activity page.
Weather services receive summit coordinates; maps request tiles for the area
you view; authorized backups, photo uploads, and track transfers go to their
chosen services. [Privacy and data handling](PRIVACY.md) explains each connection.

## FAQ

### Is this an official Peakbagger extension?

No. It's an independent passion project. Share bugs in
[GitHub Issues](https://github.com/wilmtang/better-peakbagger/issues) or ideas on
the [discussion board](https://github.com/wilmtang/better-peakbagger/discussions).
**Settings → About** also links to feedback and store ratings.

### How are the 3D maps free?

[MapLibre](https://maplibre.org/projects/gl-js/) renders the map locally using
public elevation tiles from [Mapterhorn](https://mapterhorn.com/). There's no
Better Peakbagger subscription. Community services can have outages, and tile
providers receive the viewed area and ordinary request data, including your
IP address. Peakbagger's 2D maps remain available.

### Does it make extra requests to Peakbagger?

Yes—for summit lookup, saved tracks, nearby peaks, Buddy lists, weather context,
and backups. Requests are bounded and cached where practical; full-history
backups read one ascent at a time and skip existing backups by default. The
extension uses your signed-in page session and respects rate limits and human
checks. It never solves CAPTCHAs or bypasses blocks.

### Why doesn't Better Peakbagger update Peakbagger ascents automatically?

Capture starts with your toolbar click and grants temporary access to that
activity. Better Peakbagger never receives your password or keeps permanent
Garmin or Strava access. Summit matches need your judgment, so the extension
prepares drafts and leaves every final Save to you.

### Can it capture any Garmin or Strava activity?

Only your own activities while signed in. Capture stops if ownership cannot
be verified. Click the toolbar icon for each activity you want to capture.

### What should I do when a capture stops?

Follow the popup's suggested action, such as signing in, reloading, or completing
a Peakbagger human check. Then return to the activity and click the icon again.
If a retry time is shown, wait until it passes.

### What do Strong and Probable mean for a captured activity?

**Strong** means several route signals agree; these matches are selected by
default. **Probable** means the evidence is weaker or ambiguous and needs your
selection. Neither proves you reached the summit. Review matches and every
draft before Save.

## Development

Start with the [architecture guide](docs/architecture.md) and
[development workflow](docs/development.md). See the
[documentation index](docs/README.md) for focused guides and the
[release guide](docs/releasing.md) for store publishing.

Run `npm ci` first. Load and package the built extension from `dist/`.

```sh
npm test
npm run test:scale
npm run lint
npm run verify:browsers
```

## License

[AGPL-3.0-or-later](LICENSE). Free to use, improve, and share.
If you adapt and distribute this code, your version must also be open source
under the same license, with source code available to users.

Third-party license notices and project credits are in
[ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
