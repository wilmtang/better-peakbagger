# PeakAscents.aspx fixtures

Captures of `peakbagger.com/climber/PeakAscents.aspx`. Use these to develop and
test DOM parsing/sorting/filtering without hitting the live site (which sits behind a
Cloudflare challenge for non-browser clients).

**Two provenances (see the Source column):**

- **live** — saved from the live site (browser "Save as MHTML", extracted to HTML)
  from a signed-in session, then **masked** for the account holder's identity: real
  name → `Alex Doe`, real climber id → `900001`, the user's own ascent ids →
  fakes, and every non-Peakbagger link (Strava/etc.) → `https://example.com/`
  (href *and* visible text). The `<a href>` structure is preserved, so link counts
  are unchanged. `test/project/fixtures-privacy.test.mjs` fails the build if a raw
  identifier reappears; re-run the masking (see `../pages/README.md`) when
  refreshing these.
- **wayback** — raw Wayback Machine `id_` captures (no archive.org rewriting), of
  peaks with no personal data. Re-fetch:
  `https://web.archive.org/web/<TIMESTAMP>id_/<ORIGINAL_URL>` (may be gzip). The
  Cloudflare Insights beacon `<script>` is stripped (its token trips secret
  scanners and it's irrelevant to DOM tests).

Both kinds are **self-contained**: the site's `pb.css` `<link>` is replaced by
an inline `<style>` block (fetched from a Wayback `id_` capture of `pb.css`)
and MHTML `cid:` stylesheet leftovers are dropped, so opening or testing a
fixture never touches the live site.

| File | Source | Captured | Original URL | Exercises |
|---|---|---|---|---|
| `2296-rainier-y9999-sort-ascentdate.html` | live | 2026-07 | `PeakAscents.aspx?pid=2296&sort=AscentDate&u=ft&y=9999` | Stress test: ~4,145 ascent rows, 75 year-section rows (incl. an "Unknown Year" section), messy dates (`Unknown`, red `(Unknown)` / `(1948-08-13)` spans, `1915-06 09`, `1941 l`), nested `<table class="std">` inside Route/Gear icon cells |
| `21500-y9999-sort-ascentdate.html` | wayback | 2025-06-26 | `PeakAscents.aspx?pid=21500&sort=ascentdate&u=ft&y=9999` | Small full-details view, date ascending |
| `21500-y9998-sort-ascentdated.html` | wayback | 2025-06-26 | `PeakAscents.aspx?pid=21500&u=ft&y=9998&sort=ascentdated` | Descending date sort (`sort=ascentdated`), y=9998 view |
| `8241-y9999-sort-quality.html` | wayback | 2026-05-29 | `PeakAscents.aspx?pid=8241&u=ft&y=9999&sort=Quality` | Non-date sort: NO year-section separator rows |
| `1039-default-full-columns.html` | wayback | 2025-10-31 | `PeakAscents.aspx?pid=1039` | Default view (no `y=`) of a low-traffic peak: full columns rendered |
| `2296-rainier-default-recent-year.html` | live | 2026-07 | `PeakAscents.aspx?pid=2296` | Default view of a high-traffic peak: "Most Recent Year" subset, full columns, per-year links |

## Structural notes (verified against these captures)

- Header markup for the date column (one `<th>`, two anchors):
  `<a href="...&sort=ascentdate">Ascent&nbsp;Date</a><br><a href="...&sort=ascentdated">[sort&nbsp;desc]</a>`
  — `ascentdate` = ascending, `ascentdated` = descending. Both anchors are always
  present regardless of the current sort; the page gives no visual indication of the
  active sort.
- Other observed sort keys: `climbername`, `ascenttypeid`, `gps`, `words`, `routename`,
  `VertPeakFt`, `TripUpFt`, `TotalKm`, `TripKm`, `RouteString`, `GearString`, `Quality`,
  `urllink`.
- The table opens with a stray double `<tr><tr>` (`<table class="gray"><tr><tr><th>...`);
  the browser parser yields one empty row before the header row.
- Year separator rows exist only when sorted by date: a single `<td colspan="N">` with
  `<b><a name="YYYY"></a>YYYY</b>` (or `Unknown Year`).
- Date cells: `<a href="ascent.aspx?aid=..."><nobr>YYYY-MM-DD</nobr></a>`, but partial
  and malformed dates occur, and unverified/red entries are wrapped in
  `<span style="color:red">(...)</span>`.
- Column set varies by view (e.g. `Type`, `Trip-Ft`/`Trip-Mi` appear only on some
  peaks/views), so columns must always be resolved from header text, never by index.
