# PeakAscents.aspx fixtures

Raw captures of `peakbagger.com/climber/PeakAscents.aspx` taken from the
Wayback Machine (`id_` URLs, so no archive.org rewriting). Use these to develop and
test DOM parsing/sorting/filtering without hitting the live site (which sits behind a
Cloudflare challenge for non-browser clients).

The only modification from the original bytes: the Cloudflare Insights beacon
`<script>` tag is stripped (its public analytics token trips secret scanners, and it
is irrelevant to DOM tests). Do the same when adding new fixtures.

Re-fetch pattern:
`https://web.archive.org/web/<TIMESTAMP>id_/<ORIGINAL_URL>` (response may be gzip; decompress).

| File | Captured | Original URL | Exercises |
|---|---|---|---|
| `2296-rainier-y9999-sort-ascentdate.html` | 2025-08-18 | `PeakAscents.aspx?pid=2296&sort=AscentDate&u=ft&y=9999` | Stress test: ~3,900 ascent rows, 75 year-section rows (incl. an "Unknown Year" section), messy dates (`Unknown`, red `(Unknown)` / `(1948-08-13)` spans, `1915-06 09`, `1941 l`), nested `<table class="std">` inside Route/Gear icon cells |
| `21500-y9999-sort-ascentdate.html` | 2025-06-26 | `PeakAscents.aspx?pid=21500&sort=ascentdate&u=ft&y=9999` | Small full-details view, date ascending |
| `21500-y9998-sort-ascentdated.html` | 2025-06-26 | `PeakAscents.aspx?pid=21500&u=ft&y=9998&sort=ascentdated` | Descending date sort (`sort=ascentdated`), y=9998 view |
| `8241-y9999-sort-quality.html` | 2026-05-29 | `PeakAscents.aspx?pid=8241&u=ft&y=9999&sort=Quality` | Non-date sort: NO year-section separator rows |
| `1039-default-full-columns.html` | 2025-10-31 | `PeakAscents.aspx?pid=1039` | Default view (no `y=`) of a low-traffic peak: full columns rendered |
| `2296-rainier-default-recent-year.html` | 2026-02-12 | `PeakAscents.aspx?pid=2296` | Default view of a high-traffic peak: "Most Recent Year" subset, full columns, per-year links |

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
