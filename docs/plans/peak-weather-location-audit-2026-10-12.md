# Peak weather location audit — 2026-10-12

Scope: audit the map-location feature introduced in `2907189c`, including
request state, reset/retry behavior, map/world boundaries, focus, dismissal,
accessibility, and rendered layout. Fixes are authorized; each independent
group is committed after its checks pass. Preserve unrelated working-tree edits.

## Findings and acceptance checks

| ID | Finding | Evidence | Acceptance | Status |
| --- | --- | --- | --- | --- |
| L1 | A failed point cannot be retried through the same map action; Refresh names the displayed summit but targets the failed point. | `src/weather/peak-weather.js`: `chooseLocation` rejects equality with the requested subject even after failure. A bundled probe kept the request count at 2 after reselecting the failed point. | Reselecting retries; the card retains truthful previous readings and the retry control names its actual target. | Fixed in location-state unit |
| L2 | Reset failure can hide the only reset control. | Select a point before the first summit response, then fail the summit reset: point readings remain and Reset is disabled/hidden. | Failed reset remains retryable; pending and displayed location identities determine the control state. | Fixed in location-state unit |
| L3 | Cached reset erases the cooldown explanation while controls stay disabled. | After a 429 at a selected point, Reset restores summit readings and replaces the rate-limit warning with a partial-day notice. | Reset preserves the warning; suspension, preferences and visibility cannot bypass the known cooldown. | Fixed in location-state unit |
| L4 | Reset fails to restore the summit's regional-model choices. | HRRR summit → Tokyo point → Reset shows GFS in the picker above cached HRRR readings. | Restore both summit period choices with the summit result, without writing a synthetic preference. | Fixed in location-state unit |
| L5 | Tab from the popup restarts navigation at the page's first link and scrolls to the top. | Hidden Chrome: scrollY 921 → 0; focus moves to the Peakbagger logo link. `src/weather/peak-weather-location.js` hides the focused button before default Tab traversal. | Tab and Shift+Tab dismiss and return focus to the map without moving the viewport. | Open |
| L6 | Map wheel zoom does not dismiss the menu for the old point. | Hidden Chrome: a wheel event in the native frame leaves the popup visible; `src/maps/peak-weather-map.js` only observes pointerdown. | Zoom/scroll and interactions with 3D controls dismiss the menu without affecting the map gesture. | Open |

Menu/focus and visual findings will be added only after reproduction. Location
state fixes form one commit; menu interaction and visual fixes form separate
coherent commits if needed.

## Closure ledger

### Fixed and verified

- L1–L4: 66/66 focused weather/client/documentation tests. Bundled regressions
  cover same-point retry, initial-request replacement and failed reset, both
  summit model choices, and cooldown/BFCache preservation. Hidden Chrome
  153.0.8010.12 passes the real-extension weather suite at 375/768/1440×1100,
  including same-point failure recovery, with light/dark screenshot inspection.

### Intentionally not changed

- Provider forecasts remain estimates. Selected coordinates stay in page
  memory, and the isolated card owns credential-free weather requests.
- Preserve the existing options-page edit and other unrelated work.

### Changed but not fully proven

- No runtime fixes yet. Hidden browser fixtures do not establish screen-reader
  speech, physical touch, OS focus/window placement, or live-site/provider
  accuracy. These proof limits remain explicit after remediation.
