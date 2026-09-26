# CalTopo saved-GPX handoff

**Send to CalTopo** appears beside a saved ascent's GPX download. After granting
optional access to `https://caltopo.com/*`, the extension opens a fresh
`https://caltopo.com/map.html` tab and supplies the exact saved GPX to CalTopo's
visible file importer. CalTopo sends the file to its own server for parsing.
The extension waits for the populated **Import Data** dialog, where the user
reviews the objects and clicks **Import**. Saving the map also remains manual.
See [CalTopo's import guide](https://training.caltopo.com/all_users/import-export/import).

The source must match the current Peakbagger ascent and its stored GPX link.
The shared worker consumes a one-use, sender-bound trusted-action grant and
checks optional permission before injecting the packaged adapter. No GPX is
persisted in extension storage, and no provider credentials are read. The
extension enforces a 15 MiB transfer budget; this is not CalTopo's published
service limit. Raw activity-provider GPX is outside this workflow.

The adapter is scoped to the blank-map path, the sidebar Import action, the
visible `Importer` panel, and its sole file input. After file selection it
requires object rows and an enabled final Import control in one visible
`Import Data` panel. Existing imports and ambiguous controls fail closed.
A timeout after selection is an uncertain handoff: inspect the CalTopo tab
before trying again. An explicit repeat opens a fresh tab.

CalTopo's live DOM and public client script were inspected on 2026-09-26.
File selection triggers its parser automatically; the extension does not
click either Import control. The later object-review Import writes objects
to the map and must always stay manual. Provider markup can change.

Regression tests cover adapter admission, exact payloads, one-use grants,
optional access, populated versus empty reviews, and duplicate attempts.
`npm run verify:map-handoffs` exercises the packaged worker and source button
against masked HTTPS fixtures, including CalTopo's two-panel flow. This does
not prove the live parser or native browser permission prompt.
