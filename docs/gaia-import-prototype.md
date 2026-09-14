# Gaia GPX import prototype

This is a separate, manually loaded Chrome/Chromium extension. It prepares a
Peakbagger ascent's saved GPX in Gaia's web importer. **Saving remains manual.**
It is not part of Better Peakbagger's shipping `dist/`, release packages, or
permissions. It can be loaded alongside Better Peakbagger.

## Try it

From the repository root:

```sh
node scripts/prototypes/gaia/build.mjs
```

1. In Chrome's extensions manager, enable Developer mode and choose **Load
   unpacked**. Select `web-ext-artifacts/gaia-prototype/dist` in this repository.
2. Sign into [Gaia GPS](https://www.gaiagps.com/map/) in that browser profile.
3. Open a Peakbagger **ascent** page with a saved GPS-track download link.
4. Open the **Better Peakbagger — Gaia prototype** toolbar popup and click
   **Prepare in Gaia**. Grant access to `www.gaiagps.com` when prompted.
5. The prototype opens a fresh Gaia tab. Once the importer shows items ready to
   save, it brings that tab forward. Review the track and click Gaia's **Save**
   button yourself.

If preparation fails, the popup explains the result and offers **Open Gaia**
when a target tab exists. If the file was already supplied or the response was
lost, inspect that tab before sending again. The prototype never automatically
retries the handoff or clicks a Save control. Closing the popup does not cancel
an in-flight background operation; reopen it to see the last completed result.

Signing into Gaia does not imply authorization to the Trails Offroad partner
API. This prototype needs no API key, account-linking backend, or developer
server: it uses Gaia's ordinary web importer and the browser's existing session.

## What is transferred

Only the saved GPX linked from the selected Peakbagger ascent is accepted. Its
download URL must be on the same Peakbagger origin, use `GPXFile.aspx`, and match
that ascent's `aid`. Conflicting links, malformed XML, DTDs, GPX without track or
route points, and exports over the prototype's conservative 4 MiB ceiling are
rejected. The existing bounded Peakbagger reader handles network failures and
challenge pages.

The **complete saved GPX** is supplied to Gaia, including its names, timestamps,
waypoints, segments, and any other metadata in the export. This is an explicit
transfer to Gaia, not a local-only preview: Gaia controls its own subsequent
processing, including any elevation requests. The original provider GPX from
Garmin/Strava capture and the analyzer's reduced arrays are not inputs.

The prototype retains GPX only in memory during the handoff. It does not read,
copy, or persist Gaia credentials. Session storage holds only the last result
message and target-tab ID, and clears when the browser session ends. No analytics
or developer-operated service is added. Gaia's own site behavior still applies.

## Implementation

- `scripts/prototypes/gaia/manifest.json` defines this experimental extension's
  permissions; `build.mjs` bundles only its three entry points into its own `dist`.
- `source.mjs` reads and validates Peakbagger's saved export in an isolated
  content-script world, reusing the existing Peakbagger request boundary.
- `background.mjs` accepts requests only from its own popup, prevents concurrent
  operations, opens a new Gaia tab, and passes the file to the isolated adapter.
- `adapter.mjs` locates Gaia's **Import Data** button and its file input, supplies
  a `File` through `DataTransfer`, and dispatches one bubbling **input** event.
  It waits for a visible, enabled **Save N items** button with a nonzero count.
  That establishes an import preview, not server persistence or mobile sync.
- `popup.mjs` requests optional Gaia host access directly from the user's click.
  There is no `postMessage` bridge or page-facing privileged upload endpoint.

The selectors and event were inspected in Gaia's public web application on
2026-09-14:

- [Map application](https://www-static.gaiagps.com/assets/29817877-48232d33/map-BRveDDyW.js)
  exposes `button[aria-label="Import Data"]` and disables it while signed out.
- [Import sidebar](https://www-static.gaiagps.com/assets/29817877-48232d33/ImportSidebar-CGL5Ynv0.js)
  uses `input[type=file]` with the placeholder `Drag and drop to import files`,
  a GPX accept entry, and React's `onInput` handler. Its Save handler is separate.
- [Gaia's import instructions](https://help.gaiagps.com/hc/en-us/articles/360052763513-Import-GPX-KML-KMZ-GeoJSON-or-FIT-Files-on-gaiagps-com)
  describe file selection, review, saving, and mobile sync.

These are inspected website details, not a supported integration contract. Gaia
can change them without notice. No private API is called by the prototype.

## Verification and remaining evidence

```sh
node --test test/project/gaia-prototype.test.mjs
npx eslint scripts/prototypes/gaia test/project/gaia-prototype.test.mjs
node scripts/prototypes/gaia/verify.mjs
node scripts/prototypes/gaia/verify.mjs --live
```

The fixture verifier loads the actual packed prototype in hidden Chrome for
Testing. It serves both sites over HTTPS at their real hostnames, with DNS
redirecting only the disposable browser to a local fixture server. This matters
because Playwright request interception missed the first navigation of an
extension-created tab during initial development. Fixtures never need Gaia
credentials or account writes.

The checks exercise a trusted popup click, the background worker, the original
GPX read, and the isolated-world file handoff. They assert one download, one input
event, exact preservation of the test GPX, zero Save clicks, signed-out rejection,
uncertain-handoff reporting, suppression of a repeated handoff in the same
document, wrong-origin rejection, and status-only session storage. Unit coverage
also rejects conflicting links, mismatched ascent IDs, bad XML, external URLs,
oversized exports, and shipping-manifest integration.

The `--live` probe uses a fresh signed-out profile, checks Gaia's disabled import
control, and asserts rejection **before supplying a file**. It requires a hardware
WebGL renderer and records its identity. It performs no authenticated import.

Evidence is written under `web-ext-artifacts/gaia-prototype/evidence/`, including
JSON results and popup screenshots. Test profiles, browsers, fixture servers,
certificates, and keys are disposed after each run, including failures.

Recorded on 2026-09-14: all five unit tests and the focused ESLint check passed;
the packed-prototype fixture verifier and live signed-out probe passed; and
`npm run verify:chrome` passed for the shipping extension. Both prototype browser
runs were hidden Chrome for Testing 153.0.8010.12 at 1280 × 900. The live renderer
was ANGLE Metal on Apple M3 Pro. The static popup was visually inspected in light
and dark mode at 344 × 400; the Gaia importer preview itself was represented by
the contract fixture, not an authenticated live page.

**Still unproven:** authenticated Gaia parsing of the supplied file; native
optional-permission prompts; the native toolbar popup's placement/focus;
Gaia saving to an account; mobile sync; and Firefox. The importer fixture matches
the observed DOM/event contract, but a fixture pass does not prove the live React
importer accepts a synthetic file-input event.

Before promoting this into Better Peakbagger, complete an authenticated manual
trial with a known GPX, verify all segments/waypoints in Gaia, save it once, and
check the result in Saved Items and on mobile. Update the shipping privacy
documentation and browser coverage if a production feature is then approved.
