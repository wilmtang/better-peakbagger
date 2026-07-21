# Profile backup "Peakbagger returned HTTP 200" failures — root cause and fix plan

Investigated 2026-07-20. Symptom: a full-profile GitHub backup finishes with
**"Backed up 121; skipped 33; failed 10."**, and every failed ascent shows the
same reason: **"Peakbagger returned HTTP 200."** — a success status presented
as a failure.

## Root cause (confirmed against the live site)

Two independent defects compound. The first causes the failures; the second
makes them unreadable.

### 1. Peakbagger renamed its GPS-track download endpoint

The profile backup constructs the track URL from the ascent id
([profile-backup.js:227](../../src/profile-backup.js)):

```
/climber/GetAscentGPX.aspx?aid=<aid>
```

That contract came from the 2026-07-19 research
([archive/full-profile-backup.md](../archive/full-profile-backup.md), "The
stored track URL is deterministic"), which confirmed the URL **shape** against
the captured ascent-page fixture — the response body itself was never
live-verified. The site has since renamed the endpoint. Verified 2026-07-20 in
a real browser session (read-only, logged out, a public Rainier ascent,
`aid=3099790`, four requests at ≥2 s spacing, same fetch options the extension
uses):

- `GET /climber/GetAscentGPX.aspx?aid=3099790` → **302 to
  `/PBError.aspx?aspxerrorpath=/climber/GetAscentGPX.aspx`**, which answers
  **HTTP 200** with an HTML error page (`<title>Error - Peakbagger.com</title>`,
  `text/html`). No `cf-mitigated` header, no challenge markers.
- The live ascent page's download link is now
  **`GPXFile.aspx?aid=<aid>&sep=1`** with the text "Download this GPS track as
  a GPX file". `GET /climber/GPXFile.aspx?aid=3099790&sep=1` → HTTP 200,
  `Content-Type: text/gpx; charset=utf-8`, a real
  `<gpx version="1.1" creator="Peakbagger.com">` document (~282 KB). The `sep`
  parameter is optional (body differs by a few bytes — segment separation);
  the site's own link uses `sep=1`.
- The list row's GPS marker is unchanged: `../image/GPS.gif`, title
  "Ascent has GPS track" — exactly what `parseAscentList`'s `hasGpx` detection
  matches, so the flag itself is correct.

So for **every track-bearing ascent**, `loadAscent` fetches the dead endpoint,
follows the redirect, and gets a 200 HTML error page.
`classifyResponse(..., { kind: 'gpx' })`
([profile-backup-core.js:116-133](../../src/profile-backup-core.js)) correctly
rejects it (`no <gpx` in body → `wrong-content`), and `loadAscent` fails the
whole ascent — deliberately, because re-runs skip existing folders, so a
committed folder must be complete. That policy is right; the URL is wrong.

This explains the exact failure set:

- Only ascents with the GPS icon fetch the track URL, so **the 10 failures are
  precisely the track-bearing ascents** (the motivating profile had 164
  ascents, 9 with tracks, when live-verified on 2026-07-19; 121 + 33 + 10 =
  164). All ten listed peaks are GPS-watch climbs; text-only ascents sailed
  through.
- `wrong-content` is not retried and does not pause the run (correct — the
  response is deterministic), so all ten landed in the failure list.
- Nothing was corrupted: a failed ascent commits no folder, so a re-run after
  the fix retries exactly those ten.

Why every other GPX surface kept working: the ascent-page analyzer
([gpx-analyzer.js:127](../../src/gpx-analyzer.js)) and the per-save backup
([ascent-page.js:57-62](../../src/ascent-page.js)) find the download link **by
its link text** on the live page ("Download this GPS track…" still prefix-
matches the new wording), so they followed the rename automatically. Only the
profile backup builds the URL itself — it has no ascent page to scrape, only
the list row.

### 2. The failure message reports the status even when the status was fine

`responseText` ([profile-backup.js:167-179](../../src/profile-backup.js))
formats **every** non-`ok` classification as
`Peakbagger returned HTTP ${response.status}.` — even when the status is 200
and the classifier rejected the *body*. It also returns the requested URL,
discarding `response.url`, which in this case pointed straight at
`PBError.aspx` — the diagnosis in one line, thrown away. Result: ten failures
that look like nonsense and hide the redirect that explains them.

## Fix plan

Three units, independently committable, smallest-safe-change each
(per [AGENTS.md](../../AGENTS.md)).

### Unit 1 — `fix:` fetch tracks from the current endpoint

- [profile-backup.js:227](../../src/profile-backup.js): build
  `/climber/GPXFile.aspx?aid=${item.aid}&sep=1` (mirror the site's own link,
  including `sep=1`, so the backup stores byte-for-byte what a user clicking
  the page link gets — and what the analyzer reads).
- [profile-backup.js:197](../../src/profile-backup.js): the challenge-probe
  kind detection must recognize the new path —
  `/GPXFile\.aspx|GetAscentGPX\.aspx/i`.
- Tests: `test/profile-backup.test.mjs` currently stubs pages with **no
  GPS-flagged rows**, so the GPX branch of `loadAscent` is never exercised at
  the page level — the gap that let this ship. Add a scenario with a
  GPS-icon row: assert the fetched URL is `GPXFile.aspx?aid=<aid>&sep=1` and
  that the track text reaches the batch entry's `gpx` field.

### Unit 2 — `fix:` failure reasons that describe what actually happened

In `responseText` ([profile-backup.js:167-179](../../src/profile-backup.js)):

- Status outside 2xx → keep `Peakbagger returned HTTP ${status}.`
- 2xx with a rejected body → per-kind copy in plain language, e.g.
  "Peakbagger sent an error page instead of the GPS track." /
  "…instead of the ascent form." / "…instead of the ascent list."; when
  `response.redirected`, append the destination page name
  (e.g. "(redirected to PBError.aspx)").
- Return `url: response.url || url` in the non-`ok` branch too, so the
  failure entry links to the page that actually answered.

Tests: a 200 `text/html` PBError-shaped response for the `gpx` kind produces a
reason that names the GPS track and the redirect — and never says "HTTP 200".

### Unit 3 — `chore:` refresh the stale contract in fixture, test, and docs

- [test/fixtures/pages/climber-ascent.html:37](../../test/fixtures/pages/climber-ascent.html):
  update the captured link to `GPXFile.aspx?aid=7654321&sep=1` with the new
  link text, keeping the masked ids (fixtures-privacy stays green).
- [test/ascent-page.test.mjs:40](../../test/ascent-page.test.mjs): assert the
  new URL. This also keeps the text-based link matcher honest against the
  live wording.
- Record the endpoint fact in the maintained
  [GitHub backup design](../github-ascent-backup.md#gpx-semantics); the archive
  research doc stays as a historical record per
  [docs/plans/README.md](README.md).

### Optional hardening (flagged, not required for the fix)

- [ascent-backup.js:72](../../src/ascent-backup.js) (per-save flow) accepts
  any `res.ok` body as the track with no `<gpx` validation — had that flow
  also constructed URLs, this rename would have **silently committed HTML
  error pages as `track.gpx`**. Run the fetched text through
  `Core.classifyResponse(..., { kind: 'gpx' })` and fall back to
  no-track on rejection.
- The analyzer/per-save link matchers survive on link text alone; matching
  the href (`GPXFile.aspx`, plus the legacy name) as a fallback would protect
  against a future rewording.

## Verification

- `npm test` — new regressions above plus the existing classifier, runner,
  privacy, and fixture suites.
- Real-browser check per AGENTS.md: re-run **Back up all ascents** on the
  affected profile. Expected: 154 skipped, the 10 previously failed ascents
  commit with `track.gpx`, failed 0. No "Refresh all" needed — the failed
  ascents left no folders.
- On shipping, move this plan to [docs/archive/](../archive/) and update the
  pipeline doc with the resulting behavior.
