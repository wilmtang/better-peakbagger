# Peak weather location audit — 2026-10-12

Scope: audit the map-location feature introduced in `2907189c`, including
request state, reset/retry behavior, map/world boundaries, focus, dismissal,
accessibility, and rendered layout. Fixes are authorized; each independent
group is committed after its checks pass. All 12 reproduced findings are closed
locally; no push or release was performed. Preserve unrelated working-tree edits.

## Findings and acceptance checks

| ID | Finding | Evidence | Acceptance | Status |
| --- | --- | --- | --- | --- |
| L1 | A failed point cannot be retried through the same map action; Refresh names the displayed summit but targets the failed point. | `src/weather/peak-weather.js`: `chooseLocation` rejects equality with the requested subject even after failure. A bundled probe kept the request count at 2 after reselecting the failed point. | Reselecting retries; the card retains truthful previous readings and the retry control names its actual target. | Fixed: `a2c101f7` |
| L2 | Reset failure can hide the only reset control. | Select a point before the first summit response, then fail the summit reset: point readings remain and Reset is disabled/hidden. | Failed reset remains retryable; pending and displayed location identities determine the control state. | Fixed: `a2c101f7` |
| L3 | Cached reset erases the cooldown explanation while controls stay disabled. | After a 429 at a selected point, Reset restores summit readings and replaces the rate-limit warning with a partial-day notice. | Reset preserves the warning; suspension, preferences and visibility cannot bypass the known cooldown. | Fixed: `a2c101f7` |
| L4 | Reset fails to restore the summit's regional-model choices. | HRRR summit → Tokyo point → Reset shows GFS in the picker above cached HRRR readings. | Restore both summit period choices with the summit result, without writing a synthetic preference. | Fixed: `a2c101f7` |
| L5 | Tab from the popup restarts navigation at the page's first link and scrolls to the top. | Hidden Chrome: scrollY 921 → 0; focus moves to the Peakbagger logo link. `src/weather/peak-weather-location.js` hides the focused button before default Tab traversal. | Tab and Shift+Tab dismiss and return focus to the map without moving the viewport. | Fixed: `5138fd6c` |
| L6 | Map wheel zoom does not dismiss the menu for the old point. | Hidden Chrome: a wheel event in the native frame leaves the popup visible; `src/maps/peak-weather-map.js` only observes pointerdown. | Zoom/scroll and interactions with 3D controls dismiss the menu without affecting the map gesture. | Fixed: `5138fd6c` |
| L7 | An open popup stays disabled after a cooldown expires. | Bundled probe: Refresh disabled=false while the popup item disabled=true after the cooldown refresh. | Update the open item's availability and restore usable keyboard focus without reopening or fetching. | Fixed: `5138fd6c` |
| L8 | Escape on the 3D layer picker exits the entire terrain view. | Hardware Chrome integration: after picker Escape, the toggle reads 3D and the frame has opacity 0/pointer-events none. `src/terrain/terrain-frame-runtime.js` handles Escape from every control. | Native editable/control Escape stays local; canvas Escape still exits and closes nearer extension popups first. | Fixed: `ba41a729` |
| L9 | A suspended 3D renderer can still open a weather context menu. | Bundled bridge probe: a valid generation's weatherContext is forwarded after destroy parks the frame at opacity 0. `src/terrain/terrain-map.js` checks loaded state but not suspended state. | Ignore context/dismiss messages from a suspended renderer and preserve active-generation checks on resume. | Fixed: `f9276fec` |
| L10 | Selecting a point before initial summit weather loads gives the pending point summit metadata. | Bundled Tokyo probe at a cross-zone date boundary shows Summit weather, At the summit, 14406 ft and Previous dates while loading Tokyo coordinates. | With no usable previous result, show the requested point's identity, terrain elevation and local day immediately; preserve old labels only when retaining real readings. | Fixed: `364ca588` |
| L11 | Modified Escape exits 3D inside the frame despite the maintained keyboard contract. | Bundled control-Escape probe reports defaultPrevented=true and an exit message. | Leave Ctrl/Meta/Alt/Shift Escape untouched; keep unmodified canvas and popup Escape behavior. | Fixed: `d7922815` |
| L12 | The full suite misclassifies the weather Cloudflare challenge fixture as an authenticated capture. | `test/project/fixtures-privacy.test.mjs` exempts only the older challenge fixture and requires synthetic climber 900001 in the newer identity-free weather challenge. | Explicitly review both exact fixture paths as identity-free; continue all PII/external-link scans and assert they contain no climber identity. | Fixed: `681747b4` |

The findings above were reproduced before correction. Location state, popup
interaction, terrain Escape/lifecycle, initial loading identity and fixture
classification have focused commits with their acceptance evidence retained.

## Closure ledger

### Fixed and verified

- L1–L4: 66/66 focused weather/client/documentation tests. Bundled regressions
  cover same-point retry, initial-request replacement and failed reset, both
  summit model choices, and cooldown/BFCache preservation. Hidden Chrome
  153.0.8010.12 passes the real-extension weather suite at 375/768/1440×1100,
  including same-point failure recovery, with light/dark screenshot inspection.
- L5/L7: 96/96 focused map/weather/terrain tests; hidden Chrome 153.0.8010.12
  and Firefox 157.0.1 weather suites at 375/768/1440×1100 include Tab, Shift+Tab,
  viewport preservation, and native-frame wheel dismissal. Cooldown expiry,
  blur, outside focus and passive native/3D handlers have bundled regressions.
- L6: real 3D popup, Tab, exposed-canvas wheel zoom, layer control dismissal,
  location/reset and right-drag rotation pass in hidden Chrome on Apple M3 Pro
  Metal at 375/1440×1100. The verifier waits for camera settlement rather than
  starting a gesture while a previous zoom is still active.
- L8: 27/27 terrain tests preserve picker/input/textarea Escape and the existing
  canvas/popup Escape behavior. Hardware Chrome on Apple M3 Pro Metal at
  375/1440×1100 verifies both the open picker and focused picker stay in 3D;
  location/reset and right-drag coverage remains green.
- L9: 27/27 terrain tests cover parked context/dismiss rejection and
  old-generation rejection after resume. The hardware verifier sends a real
  current-generation parked-frame message and confirms no popup appears.
- L10: 55/55 weather tests include Tokyo/summit civil-day divergence and
  canceled first-load replacement. Hidden Chrome and Firefox at
  375/768/1440×1100 verify held first-load selection and subsequent reset;
  inspected narrow loading screenshots. Location has polite, atomic accessible
  status semantics; actual screen-reader speech remains unproven.
- L11: 30/30 terrain/documentation tests cover all four modifiers; hardware
  Chrome 3D tests verify Control+Escape stays in 3D at both widths. Unmodified
  canvas and nearer-popup Escape regressions remain green.
- L12: 7/7 fixture privacy tests. Both exact challenge paths remain in all
  banned-identifier and external-link scans; their identity-free exception now
  rejects climber-ID query fields and the synthetic owner's ID.

Final verification after all runtime/test corrections:

- `npm test`: **2,666/2,666 passed**, including a fresh `dist/` build.
- Repository-wide ESLint passed. Shipped `web-ext` lint passed with six existing
  owned warnings for the cross-browser manifest and reviewed upstream vendor
  code; no new warning allowance was introduced.
- Real-manifest Chrome 153.0.8010.12 check passed, hidden at 1000×760, including
  BFCache restoration and teardown.
- Final peak-weather suites passed in hidden Chrome 153.0.8010.12 and Firefox
  157.0.1, light/dark, at 375/768/1440×1100. Inspected menu, selected-location,
  recovery and initial-loading screenshots. These are SVG/DOM weather surfaces.
- Final real 3D integration passed in hidden Chrome on Apple M3 Pro Metal at
  375/1440×1100, including native/modified Escape, exposed-canvas wheel zoom,
  right-drag, Tab, reset and parked-frame message rejection.
- Inspected remaining process command lines for the owned verifier/profile
  prefixes and confirmed removal of nine exact successful weather/3D profile
  paths. Disposable screenshots, probes and logs were removed after review.

### Intentionally not changed

- Provider forecasts remain estimates. Selected coordinates stay in page
  memory, and the isolated card owns credential-free weather requests.
- Preserve the existing options-page edit and other unrelated work.

### Changed but not fully proven

- The corrected location announcements have accessible DOM semantics but no
  screen-reader speech proof. Hidden fixtures cannot establish physical touch,
  OS focus/window placement, or native browser menu behavior.
- Live Peakbagger layouts and live forecast accuracy remain external/manual
  proof boundaries; fixtures and provider estimates do not prove either.
- No known reproduced runtime finding remains open in this scope. This is a
  bounded source/browser audit, not a guarantee against every possible bug.
