# Site-page fixtures

Whole-page captures of Peakbagger (not the `PeakAscents.aspx` list — those live
in `../peakascents/`), used to ground the dark-mode contrast checks and to
develop against real site chrome without hitting the live site (which sits behind
a Cloudflare challenge for non-browser clients).

## Provenance & masking

These are **real captures saved from the live site** (browser "Save as MHTML",
then extracted to HTML) — not Wayback `id_` captures. They were taken from a
signed-in session, so every page carried the account holder's identity. All of
it has been **masked** before committing:

- Real name → the pseudonym **`Alex Doe`** (`Doe, Alex`).
- Real climber id `40786` (as `cid=`/`c=`/`d=`) → `900001`.
- The user's own ascent ids → fake ids; every non-Peakbagger link (Strava,
  Instagram, Flickr, YouTube, Mountain Project, blogs, …) → `https://example.com/`,
  as both `href` and any visible URL text. This keeps `<a href>` structure (so
  link-detection counts are unchanged) while removing social/identity URLs.
- On the two **personal** pages (`climber-*`), which are entirely the user's
  data, peak names + ids, ascent dates, ranges, US state codes, and the free-text
  bio (which held a home city and social handles) are additionally genericized.

`test/fixtures-privacy.test.mjs` fails the build if a raw identifier reappears
(e.g. when refreshing a capture). Re-run the masking when adding new captures.

| File | Original page | Exercises |
|---|---|---|
| `home-default.html` | `https://www.peakbagger.com/` | Site home page — mainly the shared header **banner** (`.mainbanner` / `.mainmenu` over `image/header.jpg`): title + nav links with inline `color:black` that must stay dark in dark mode. Grounds the dark-mode contrast test. |
| `peak-rainier.html` | `peak.aspx?pid=2296` (Mount Rainier) | A high-traffic **peak home page**: heading, stats tables (`table.gray`), a long public ascent list, map. Public peak identity (Rainier) is kept; only the account holder's identity is masked. |
| `peak-garibaldi.html` | `peak.aspx?pid=875` (Mount Garibaldi) | A second peak home page, for cross-checking site chrome across peaks. |
| `climber-home.html` | `climber.aspx?cid=…` (personal home page) | A climber's personal home/stats page, fully genericized. |
| `climber-ascents.html` | `ClimbListC.aspx?cid=…` (personal ascent list) | A climber's own ascent list (`ClimbListC.aspx`), fully genericized (peaks → `Sample Peak N`, dates → `2020-01-01`, etc.). |

## Structural notes (shared site chrome)

- The header is a `<table style="background-image:url(image/header.jpg); height:60px">`.
  Row 1: `<td class="mainbanner">` holding the `Peakbagger.com` title link plus a
  `<td class="mainmenu">` with the Quick Search box. Row 2: several
  `<td class="mainmenu">` cells, each a nav link (`Peak Lists`, `Climbers`,
  `Ranges`, `Geography`, `Help`, `Search`, `Log In` / logged-in menu).
- Every banner link is an `<a>` with inline
  `style="... text-decoration:none; color:black"`. The dark theme's global
  `a { color: #7ab6ff !important }` would otherwise override that inline black and
  wash the links out over the light photo, so `src/site-dark-css.js` re-darkens
  `.mainbanner a` / `.mainmenu a` back to `#000`.
