# Peak-page presentation follow-up — 2026-10-12

Scope: the supplied peak-page and Settings screenshots, the weather picker/source
coordinate discrepancy, matching weather header actions, and additional map links.

## Why earlier audits missed this

- `src/maps/peak-map.js` inserted Sun & Moon immediately after the map viewport,
  separating the map from its native marker legend and full-screen link. The unit
  test and both real-manifest smoke verifiers explicitly required that position.
  Those assertions protected the wrong presentation contract.
- Weather was appended to the right-hand table. The captured Rainier fixture
  places its map last, so that happened to keep weather next to the map. The
  supplied page places the map first, leaving the native peak details between
  Sun & Moon and weather. Earlier geometry assertions established only that
  weather was below the map and inside the right table.
- Reset to summit had its own smaller font and padding. Header wrapping checks
  compared summit/location states without comparing the two buttons' heights.
- The weather client correctly kept requested and returned coordinates separate,
  but Source details displayed only the latter as “Response grid.” The test
  fixture normally echoed the requested coordinates, concealing the ambiguity.

Repeatedly passing those checks did not establish coherent page presentation.
The replacement checks protect the map/legend/panel order, a map-first native
layout, equal action heights, and displaced provider grid coordinates.

## Fixed and verified

| Change | Commit | Evidence |
| --- | --- | --- |
| Unit examples precede the unit controls. | `f62e3cc7` | Three unit-options tests; rendered light/dark at 1280 and 390 px. |
| Full AGPL license attribution sits beneath Version and links to GitHub. | `fcfe41ec` | Three About tests; rendered light/dark at 1280 and 390 px. |
| Native map and legend stay together, followed by Sun & Moon and an adjacent weather row. | `a3137198` | 72 focused map/weather tests, map-first fixture, combined page screenshots, Chrome/Firefox weather suites. |
| Reset to summit and Refresh use the same type and padding. | `cffb1949` | Browser assertions compare heights across 280–500 px card widths in summit/location states; selected-location screenshots inspected. |
| Source details labels the requested location and returned weather grid separately. | `557d4405` | 58 peak-weather tests, including the exact supplied coordinate pair and reset; rendered source disclosure at desktop/narrow widths. |
| Gaia GPS, AllTrails and onX Backcountry links appear in a distinct BPB inset beneath native Web Map Links. | `b3e731e4` | Six link tests cover targets, native-link preservation, geographic bounds, ambiguity and idempotence; light/dark rendering at 1440, 768 and 375 px. Destination proof limits are below. |
| Real-manifest smoke checks protect the native legend before Sun & Moon. | `a40399c0` | Full Firefox verifier passed; the corrected peak assertion passed in Chrome, whose separate helper probe remains open below. |

The full `npm test` run passed **2,712/2,712**. Focused ESLint and documentation
checks passed. Hidden real-extension peak-weather suites passed in Chrome for
Testing **153.0.8010.12** and Firefox **157.0.1**, light/dark at
**1440×1100, 768×1100 and 375×1100**. Settings used hidden Chrome at
**1280×1000 and 390×1000**. Rendered page, button, link and source-disclosure
screenshots were inspected. These changes concern DOM/SVG presentation; no
WebGL renderer or terrain accuracy claim is made.
This evidence covers the presentation commits above, not the unrelated,
in-progress avalanche changes that appeared in the shared working tree during
the handoff; those edits were preserved and excluded from these commits.

The first broad Chrome smoke run failed solely because its obsolete assertion
still required Sun & Moon between the map and legend. Both browser smoke
assertions were corrected to require the complete native legend before the panel.
The full Firefox **157.0.1** smoke suite then passed at its base **1000×760**
viewport and named responsive cases, including BFCache and teardown. Chrome's
corrected peak assertions passed, but its overall run failed at an unrelated
durable helper-adoption probe. The earlier Chrome run passed that same probe.
This is retained as a verification defect or product race to isolate, not
dismissed as noise or reported as an overall pass.

All launched verification processes exited. A final process-command inspection
found no remaining task-owned Chrome/Firefox, profile or fixture processes.

## Intentionally not changed

- The picker location **46.4947, −121.4636** and returned grid point
  **46.5074, −121.4852** are about **2.2 km** apart. This is expected under the
  [Open-Meteo response contract](https://open-meteo.com/en/docs): returned
  coordinates identify the weather grid cell and may differ by kilometres.
  The request still sends the selected location; provider coordinates are not
  rewritten to conceal that distinction.
- Native map links, map resizing, coordinates, provider selection, weather
  requests and manual final Save boundaries retain their existing behavior.
- The native relative order of peak-detail rows is retained. Mapless peaks
  continue to receive weather at the end of the native right table.

## Changed but not fully proven

- **Chrome full smoke check remains red:** `scripts/verify-extension.mjs`
  timed out waiting for durable helper adoption. The probe injects helper leases
  directly into `storage.session` while the worker handles tab events, so a
  fixture/worker ordering race is a hypothesis, not a confirmed root cause.
  No background/helper implementation was changed in this presentation work.
- The BPB links and their coordinate targets are locally verified. Public onX
  client routing was inspected and confirms `latlon=latitude,longitude,zoom`.
  Gaia uses its published map-location format; AllTrails uses its map bounds.
  Authenticated provider destination rendering was not established. The public
  AllTrails page returned a bot-check page, which was not bypassed.
- No usable live Peakbagger tab was exposed through the connected browser tools.
  The screenshots establish the reported layout; HTTPS fixtures on a real
  Peakbagger hostname establish the fixes. A live authenticated peak-page reload
  remains a manual release check.
- Hidden checks do not establish native focus/window placement, physical touch,
  screen-reader speech, live forecast accuracy or store publication. No push,
  release or store submission was performed.
