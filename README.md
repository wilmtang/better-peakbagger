# Better Peakbagger

**Plan the climb. Log the summit. Share the story.**

Bring your climbs to life on [Peakbagger](https://www.peakbagger.com/) with free
3D maps, summit weather, and interactive route charts. Turn recorded adventures
into ascent drafts, find the beta that matters, and create trip reports worth
sharing—all with a free, open-source browser extension.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kndjohodnpdoejmjkiiakejfehoodedn?style=for-the-badge&logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store&color=4285F4)](https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn)
[![Firefox Add-ons](https://img.shields.io/amo/v/better-peakbagger?style=for-the-badge&logo=firefoxbrowser&logoColor=white&label=Firefox%20Add-ons&color=FF7139)](https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/)

Works with Chrome, Edge, Brave, and Firefox. No userscript manager required.
No Better Peakbagger account, ads, or telemetry.

![Better Peakbagger over a mountain landscape](store-assets/promo-marquee-1400x560.png)

## Get started

Install from your browser's store:

- [Chrome Web Store](https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn) — Chrome, Edge, and Brave
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/better-peakbagger/) — Firefox

Visit Peakbagger and open a peak or ascent to explore the new tools. To log a
climb, open your own Garmin Connect or Strava activity and click the
Better Peakbagger toolbar icon, or choose a GPX on Peakbagger's **Add Ascent**
form. You review every draft and press Save yourself.

Find Settings in the extension's Details or Preferences page.

## Plan your next summit

### See the mountain in free 3D

![GPX analysis moving from a chart-synchronized 2D map into 3D terrain](store-assets/screenshot-3D-map-sync-resize-billboard-1.5x.gif)

Explore the ridgelines, faces, and basins around your next objective in
interactive 3D at true vertical scale. Follow a saved route, compare several
tracks on a Full Screen GPS map, and discover nearby peaks with a click.

Switch to 3D when you want it, with compatible basemaps and free, open elevation
data from [Mapterhorn](https://mapterhorn.com/). For a more recent view, try
**Sentinel-2 (experimental)** imagery in 2D or 3D: choose a satellite capture
from the last 30 days and check its date, estimated coverage, and full-image
cloud cover. Microsoft Planetary Computer supplies the imagery; clouds and
gaps may still obscure the terrain.
The compact **Overlays** menu at the upper-left combines Sentinel imagery,
slope angle, public lands and SNOTEL, with independent raster opacity.
Public lands includes individual land-type checkboxes and quick **Only** actions.
The basemap selector stays at the upper-right in both 2D and 3D.
[Map overlays](docs/map-layers.md) · [Regional coverage table](docs/map-overlay-coverage.md) · [3D map guide](docs/3d-map.md)

### Put weather and daylight in context

See what's forecast for the summit, then look back at the conditions on past
climbs. Weather is powered by [Open-Meteo](https://open-meteo.com/), with no
weather account, API key, or subscription required.

- **Plan ahead:** up to 16 forecast days with temperature, rain, snow, and wind.
- **Check recent conditions:** browse the past 16 days and compare weather models.
- **Relive a climb:** historical ascent-day weather, with coverage back to 1940
  where available—even without a GPX.

Expand any day for hourly detail in mountain-local time. On saved ascents,
hover or select a timed GPX point to see the weather for that hour. Weather
cards show model estimates; check local mountain forecasts before heading out.

The **Sun & Moon**, **Summit weather**, and **Nearby snow** cards can be collapsed
by clicking their headings. Drag their grips to reorder them or move them to
either column; click a grip for move options. Arrow keys also move a focused
grip. Card positions and collapse choices are remembered across peak pages.

On western US and Alaska peaks, **Nearby snow** adds public NRCS SNOTEL snow
depth and water-equivalent observations, station distance/elevation, and a
seven-day trend. The compact **Overlays** menu adds station markers and NRCS links to ascent,
peak and Full Screen maps in 2D or supported 3D. Nearby stations describe their own location; route and summit
conditions can differ. **Settings → General → Show SNOTEL** disables the whole
feature independently of weather. [Nearby snow guide](docs/nearby-snow.md).

Check sunrise, sunset, Moon phase, and Sun and Moon directions on a peak map
or GPX route with the offline **Sun & Moon** calculator. Move the time slider
to explore the light throughout the day. Times assume a level horizon and do
not account for terrain shadows.
[Forecast guide](docs/peak-weather.md) · [Historical weather](docs/ascent-weather.md) · [Sun and Moon guide](docs/sun-position.md)

### Find useful ascent beta faster

Get to the reports and tracks you came for. Filter ascents by trip report, GPS
track, external link, or favorite climber, combine filters, and sort lists
without reloading the page.

![Ascent beta filters and in-page sorting](store-assets/showcase-2-beta-filter.png)

Keep trusted climbers close with your Peakbagger Buddy List or a searchable
favorites list. Favorite, Ignore, and Buddy actions are a hover or **⋯** click
away. Hide reports from ignored climbers and reveal them whenever you choose.

Ignored lists stay local unless you choose GitHub backup or two-way sync.
[Climber lists guide](docs/climber-lists.md)

Peak pages also put weather, satellite imagery, fire and smoke information,
regional avalanche bulletins, and your favorite mapping apps within reach.
Planning links vary by region; bulletin links do not assess avalanche danger
on your route.

## Log the climb with less typing

### From recorded adventure to ascent drafts

Turn your own **Garmin Connect** or **Strava** activity into ascent drafts with
route statistics, a privacy-reduced GPX, and the activity link. Explained
**Strong** and **Probable** summit matches help you choose which peaks to log;
multi-peak trips and overnight details are filled when enabled.

![Garmin and Strava activity capture with privacy-reduced Peakbagger drafts](store-assets/showcase-activity-capture.gif)

Choose a GPX file on **Add Ascent** to calculate route details,
find summits along the track, and prepare a multi-peak trip. Keep waypoint names
and coordinates if you choose, and fit large tracks to Peakbagger's point limit.
Your original file stays on your device. Every draft is yours to review and Save.

To leave recorded times out of uploads, enable **Remove GPX timestamps**
in Settings → Capture & reports → GPX capture. Dates and calculated durations
still fill normally, and you can include timestamps for an individual capture
or file.

### Relive the route, one point at a time

![Three-day GPX analysis with chart-synchronized map marker and custom route](store-assets/showcase-gpx-map-sync.gif)

Move through an interactive chart and watch the map follow your route. Explore
elevation, distance, gain, grades, and multi-day timing in the mountain's
timezone. Select a point by mouse or keyboard to copy its coordinates, and
make the route yours with custom colors, widths, and outlines.

Missing data stays visible as gaps. Review flagged segments and return to the
original view at any time; downloads stay unchanged.
[Track data guide](docs/gpx-data-quality.md#resulting-chart)

### Take the route to your favorite mapping app

Send a saved ascent's original GPX to **Gaia GPS**,
**onX Backcountry**, **AllTrails**, or **CalTopo** for import. Review and confirm
in your mapping app; its membership and file limits apply.
[Gaia guide](docs/gaia-import.md) · [onX guide](docs/onx-import.md) · [CalTopo guide](docs/caltopo-import.md)

## Share the story. Keep the memories.

### Write trip reports with more than words

Bring the day together with rich text or GitHub-flavored Markdown, photos,
tables, video, and live preview. Better Peakbagger handles the bracket tags so
you can focus on the story. Local autosave and a draft manager help you pick
up where you left off; Plain mode remains available for legacy markup.

**Paste photos directly into Rich text.** With your own ImgBB key configured,
photos stay local until you save the report, then upload with visible progress.
[Report editor guide](docs/trip-report-editor.md)

![Rich-text trip report editor with formatting controls and local draft recovery](store-assets/showcase-5-trip-report-editor-light.png)

### Show the line with photo topos

Make route beta easier to follow. Draw routes, freehand lines, labels, and
climbing symbols over a photo, then download it or upload a flattened,
metadata-free JPEG or PNG to ImgBB with your own API key. Your original stays
unchanged, and a searchable local library keeps projects ready to edit and reuse.

Download and import project bundles to preserve originals and annotations
together. Your saved ImgBB key stays in device-local extension storage.
[Photo guide and limits](docs/photo-topo-editor.md)

![Photo Topos editor with an annotated alpine route and direct ImgBB upload](store-assets/showcase-6-photo-topos.png)

### Keep a copy of your climbing history

Your climbing history deserves a copy you control. Back up one ascent or your
full history to your own GitHub repository as readable Markdown reports, ascent
details, and saved GPX files. Enable automatic backup to keep later saves in
sync. Backups never change your Peakbagger records.

You can also back up and restore settings, climber lists, and photo-library
recovery data. Photo recovery includes annotations and links; keep project
downloads for original images. [Backup guide](docs/github-ascent-backup.md)

## Make Peakbagger feel like yours

Give maps and reports room to breathe. Resize maps and adjust the column
divider on peak and saved-ascent pages. Move ascent weather above or below the
report, summary, or GPS links. Drag a grip, click it for move options, or use
the arrow keys. Your layout is remembered for future visits.

Choose dark, light, or system appearance, style your maps and charts, and mix
units—for example, miles and feet with Celsius. Reorder filters and planning
links, hide cards you don't use, and export your settings to take your setup
to another browser.

Exports omit credentials by default. **Include saved credentials** adds your
ImgBB key and GitHub connection to an unencrypted file; keep it private.

![Better Peakbagger settings beside Peakbagger dark mode](store-assets/showcase-3-dark-mode-settings.png)

## Privacy by design

Enjoy the tools without a Better Peakbagger account, ads, analytics, or
telemetry. There is no developer data server. Raw Garmin and Strava GPX is
processed on the activity page, and saving an ascent always stays in your hands.

Weather services receive summit coordinates; maps request tiles for the area
you view; authorized backups, photo uploads, and track transfers go to their
chosen services. [Privacy and data handling](PRIVACY.md) explains each connection.

## FAQ

### Is this an official Peakbagger extension?

No. Better Peakbagger is an independent passion project. Ideas and bug reports
are welcome in [GitHub Issues](https://github.com/wilmtang/better-peakbagger/issues)
and the [discussion board](https://github.com/wilmtang/better-peakbagger/discussions).
**Settings → About** links to feedback, bug reports, source code, the license,
and the rating page for your browser's store.

### How can Better Peakbagger offer 3D maps for free? What's the catch?

Most elevation data is public or openly licensed; the costly part is turning it
into map tiles and serving them at scale. Better Peakbagger renders 3D locally
with open-source [MapLibre](https://maplibre.org/projects/gl-js/) and uses
public terrain tiles from
[Mapterhorn](https://mapterhorn.com/), a project supported by grants, sponsors,
and donated infrastructure. Better Peakbagger runs no map server and has no
subscription, advertising, or sale of user data.

The trade-off is relying on community-supported services without guaranteed
availability. Better Peakbagger reuses a bounded local elevation cache and may
show less distant detail at steep angles to limit traffic. After you enable 3D,
tile providers receive the area viewed and ordinary request data such as your
IP address. You can disable 3D at any time; Peakbagger's 2D maps remain
available.

### Why does the weather differ from Windy.com or other forecasts?

Even with the same model, location, and forecast hour, services can use different
model runs, nearby forecast points, elevation adjustments, and weather icons.
Better Peakbagger uses [Open-Meteo](https://open-meteo.com/), which adjusts
temperatures to the summit elevation when available. That can make a summit
forecast cooler than one for the model's lower terrain. “Overcast” can also mean
high cloud above the mountain, without fog at the summit. Open **Source details**
in the weather card to explore the model, forecast location, and elevation used.
[More about summit weather](docs/peak-weather.md).

### Does Better Peakbagger place extra demand on Peakbagger or bypass its protections?

Some features make additional requests, so zero impact would be misleading.
Activity capture searches small areas along the route; the GPX Analyzer reads
the track linked from an ascent page; 3D requests Peakbagger's nearby-peak feed
after the camera settles; and Buddy or backup features read only the account
data they need. Buddy data is cached for seven days, and full-profile backups
are explicit, read Peakbagger ascents one at a time, and skip existing backups
by default.

Better Peakbagger is an interactive client, not a crawler. It uses your normal
signed-in session through a Peakbagger page, without requesting permission to
read cookie values, and stops or pauses for rate limits or human checks. It
never solves CAPTCHAs, rotates identities or proxies, or evades blocks.

### Why doesn't Better Peakbagger update Peakbagger ascents automatically?

There is no safe, reliable hook for a small independent extension to receive new
activities automatically. [Strava requires a subscription][strava-api] to
create an API application, even when the developer reads only their own data.
The [Garmin Connect Developer Program][garmin-api] is limited to approved
business and enterprise integrations. An unattended workaround would require
brittle login automation and another copy of sensitive activity data.

Better Peakbagger instead works through the provider page you already opened
and signed in to. A toolbar click grants temporary access to that one activity;
the extension never receives your password or keeps permanent Garmin or Strava
access.

Summit matching is also evidence, not certainty, and an ascent log is your
record. Better Peakbagger does the repetitive work, then stops before Save so
you can review every ascent.

[strava-api]: https://developers.strava.com/docs/getting-started/
[garmin-api]: https://developer.garmin.com/gc-developer-program/program-faq/

### Can it capture any Garmin or Strava activity?

No. You must be signed in, the activity must belong to your account, and the
page must provide unambiguous ownership signals. Better Peakbagger fails closed
if it cannot verify those conditions. You must click the toolbar icon for each
capture; the extension does not keep permanent provider access.

### What should I do when a capture stops?

Follow the one action shown in the popup. Depending on the cause, Better
Peakbagger will ask you to reload the activity, sign in, return to the provider,
open the exact Peakbagger human-check page, wait until a rate limit passes, try
again after a temporary outage, or use a shorter track. After completing a
sign-in, reload, or human check, return to the activity and click the extension
again; the new click rechecks the page instead of replaying the old failure.
Better Peakbagger never solves a CAPTCHA or retries through a stated cooldown.

### What do Strong and Probable mean for a captured activity?

They describe the evidence that your recorded route encountered a summit—not a
claim that you reached it. Better Peakbagger compares closest approach, the
track's elevation near the summit, whether it forms a local high point, and
track quality. **Strong** means several signals agree and is selected by
default. **Probable** means the route is close enough to consider but the
evidence is weaker or ambiguous, so it is never selected automatically. Review
both before opening drafts, and review every draft before Save.

### Which third-party services can receive my information?

Better Peakbagger has no developer data server, account, analytics, advertising,
or telemetry. Garmin or Strava is accessed only after your toolbar click, and
the raw activity GPX is processed on that page rather than sent to the
developer.

Optional services are contacted only for the feature you use. Map tiles are
requested from Mapterhorn and your selected map provider after you enable 3D.
GitHub receives only the backups you authorize for your chosen repository.
ImgBB receives a flattened image only when you provide an API key and choose
**Upload & insert**. Gaia or onX receives the saved ascent GPX only when you
click that destination's **Send** button. Remote report media contacts its host when displayed. See
[Privacy and data handling](PRIVACY.md) for the complete field-level list.

### Will Better Peakbagger add a developer-run server or telemetry in the future?

There are no plans to. Running a reliable service costs money and creates a
long-term maintenance commitment, so Better Peakbagger is designed to work
without a developer-run data server or telemetry. This is also why it favors
backups you control: if Peakbagger or Better Peakbagger ever disappears, your
backed-up trip reports can remain in your GitHub repository.

If a future feature truly requires a service, it will not be introduced
silently. The feature will require your explicit choice, collect and retain
only the data it needs, and be documented in the README and privacy policy
before you use it.

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
npm run verify -- browsers
```

## License

[AGPL-3.0-or-later](LICENSE). Free to use, improve, and share.
If you adapt and distribute this code, your version must also be open source
under the same license, with source code available to users.

Third-party license notices and project credits are in
[ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
