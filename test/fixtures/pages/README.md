# Site-page fixtures

Raw captures of whole Peakbagger pages (not the `PeakAscents.aspx` list — those
live in `../peakascents/`). Same provenance rules: Wayback Machine `id_` URLs so
there's no archive.org rewriting, and the Cloudflare Insights beacon `<script>`
is stripped (its public token trips secret scanners and it's irrelevant to DOM
tests). Decompress if the response is gzip.

Re-fetch pattern:
`https://web.archive.org/web/<TIMESTAMP>id_/<ORIGINAL_URL>`

| File | Captured | Original URL | Exercises |
|---|---|---|---|
| `home-default.html` | 2026-06-07 | `https://www.peakbagger.com/` (Default.aspx) | The site home page, primarily for the shared header **banner** (`table.mainbanner` / `.mainmenu` over `image/header.jpg`) — the title + nav links that carry inline `color:black` and must stay dark in dark mode so they read on the light photo. Used by the dark-mode contrast test. |

## Structural notes (shared site chrome, verified against this capture)

- The header is a `<table style="background-image:url(image/header.jpg); height:60px">`.
  Row 1: `<td class="mainbanner">` holding the `Peakbagger.com` title link plus a
  `<td class="mainmenu">` with the Quick Search box. Row 2: several
  `<td class="mainmenu">` cells, each a nav link (`Peak Lists`, `Climbers`,
  `Ranges`, `Geography`, `Help`, `Search`, `Log In`).
- Every banner link is an `<a>` with inline
  `style="... text-decoration:none; color:black"`. The dark theme's global
  `a { color: #7ab6ff !important }` would otherwise override that inline black and
  wash the links out over the light photo, so `src/site-dark-css.js` re-darkens
  `.mainbanner a` / `.mainmenu a` back to `#000`.
