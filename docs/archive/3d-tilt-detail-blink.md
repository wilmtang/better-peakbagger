# Plan: stop the 3D map blinking when you tilt it

Status: completed. Steps 1–3 were implemented and measured, and step 4 was
integrated as the owner's choice to keep a fixed map scale while panning. See
section 12 for the closure ledger, which is the authoritative record of what
shipped, what did not, and what is not fully proven. Sections 1–11 are the
original investigation, left as written so the plan's predictions can be
compared with what the implementation actually measured — and in two places
they were wrong. Section 12 says where.

## 1. The complaint

Tilting the 3D map by a couple of degrees sometimes makes the whole landscape
visibly drop in quality for about half a second — the hills go soft and lumpy,
the shading flattens, the draped map goes fuzzy — and then it all snaps back to
sharp. It reads as a blink or a flash rather than as loading.

An earlier investigation concluded this was simply how MapLibre (the mapping
library the 3D view is built on) behaves. That conclusion was too generous to
us. Two of the three causes are ours, and one of them is a setting we already
apply to one half of the map and never applied to the other half.

## 2. The short version

The 3D view is assembled from square pieces of data. Each piece comes in
several sizes, from very coarse to very fine, and the map picks a size for each
part of the screen based on how far away it is. Tilting changes those
distances, so tilting changes the sizes.

That much is unavoidable and every 3D map does it. The blink comes from three
things stacked on top of it:

1. **The ladder of available sizes has rungs missing.** In one frame the ground
   near you is drawn at full detail while the horizon is drawn *sixteen times*
   coarser, with the two intermediate steps never used at all.
2. **When the tilt asks for a size we have not downloaded yet, the map falls
   back to whatever it does have** — and because of the missing rungs, that
   fallback is three steps down instead of one. It stays there until the
   download finishes, which we measured at half a second to nearly a second.
3. **The recovery is an instant swap, not a fade.** So the return to full
   detail lands as a single visible jolt.

Cause 1 is a number we choose. Cause 2 is a download we could have started
earlier — we already have all the machinery to do so. Cause 3 is genuinely
MapLibre's, but it only decides whether the recovery is a fade or a jolt; the
collapse itself comes from 1 and 2.

## 3. How the 3D view actually builds a picture

Three plain-language ideas are enough to follow the rest of this document.

**Tiles.** Maps are not one big image. They are a grid of small square images,
called tiles. To cover the world at a fine level of detail you need an enormous
number of small tiles; to cover it roughly you need only a few large ones. The
map downloads only the tiles it needs for what is on screen.

**Levels.** The same patch of ground exists as a tile at many different levels.
Level 13 covers some area; level 14 splits that area into four tiles, so each
one carries four times the detail; level 12 merges it into a quarter of a tile,
so a quarter of the detail. Each step up or down the ladder is a factor of four
in information, or a factor of two in how fine things look. **Going down two
levels makes the picture four times blurrier in each direction.** Going down
three makes it eight times blurrier.

**Two separate things are tiled.** The 3D view stacks two independent products:

- **The shape of the land.** Downloaded from Mapterhorn as elevation tiles.
  These are what give the mountains their form. They also drive the shading —
  the hillshade and the colour-by-height relief are both computed from this
  same elevation data.
- **The picture painted on top.** The topo map, satellite imagery, or whatever
  layer the user picked from the drape menu. Downloaded from that layer's own
  provider.

The two are tiled and downloaded separately, at their own levels. **The
elevation tiles matter more.** They control the mountain silhouettes *and* the
shading, so when they drop a level the entire frame changes character. When the
painted picture drops a level it just gets a bit soft.

There is also a third, invisible step. MapLibre does not paint the topo map
directly onto the screen. It paints it into a set of intermediate square
canvases, one per patch of ground, and then wraps those canvases over the
mountain shape. Those intermediate canvases are themselves chosen from a ladder
of levels — and, critically, **their level is picked using the elevation
tiles' settings, not the painted map's settings.** This is the detail that
undoes an earlier fix; see section 6.

## 4. Why tilting changes the levels

Looking straight down, everything on screen is roughly the same distance away,
so almost everything gets the same level. Tilt the camera and the top of the
screen becomes the far distance and the bottom becomes right under your feet.
Now the screen spans a huge range of distances, so it spans a range of levels.

MapLibre recalculates this from scratch on every single frame, using a smooth
formula, and then rounds the answer down to a whole number. Because the formula
is smooth, the boundaries between levels slide continuously as you tilt. Because
the answer is rounded down, a patch of ground crosses a boundary at some exact
tilt angle and changes level all at once.

There is no memory in this. Nothing says "we were happy with level 12 a moment
ago, stay there." Tilt from 61° to 64° and the set of tiles the map wants is
simply a different set, computed fresh.

That, on its own, is fine. Every 3D map does something like it, and if all the
tiles were already downloaded it would be nearly invisible — we measured that
directly, and it is (section 5, "warm" results).

## 5. What we measured

### Method

We drove the real MapLibre renderer — the exact version the extension ships,
5.24.0 — in a hidden browser window with real graphics hardware (confirmed as
Apple M3 Pro through Metal; we check this rather than trust it, because a
software fallback would invalidate the whole measurement). Window 1100×700.

We built the same map the extension builds: Mapterhorn-shaped elevation tiles,
colour relief, hillshade, and a painted drape with the same settings
[terrain-frame.js](../../src/terrain/terrain-frame.js) uses.

Elevation data was generated locally rather than downloaded, from a continuous
mathematical mountain range (valleys at 300 m, summits at 2900 m, ridges about
1.5 km apart). This keeps the test offline, repeatable, and free of live
Mapterhorn traffic, while behaving like real terrain. Tiles were served with a
140 ms delay each, which is a realistic download time.

For each camera position we sampled a grid of screen pixels and recorded which
tile level each pixel was actually being drawn from. That means every percentage
below is a percentage of the picture the user sees, not a percentage of tiles.

### Result 1 — the ladder has rungs missing

With MapLibre's stock settings, here is what is on screen at once, by share of
the visible ground:

| Tilt | What the frame contains |
| --- | --- |
| 60° | level 13 (83%), level 12 (17%) |
| 62° | level 13 (82%), level 12 (16%), **level 9 (2%)** |
| 66° | level 13 (81%), level 12 (12%), **level 9 (8%)** |
| 70° | level 14 (5%), level 13 (74%), level 12 (8%), **level 9 (13%)** |

Levels 10 and 11 never appear. The horizon band skips straight from 12 to 9 —
that band is drawn from elevation data **eight times coarser** than the ground
beneath the camera, when two perfectly good intermediate steps exist.

Changing one setting (section 7, step 2) turns the same frames into level 13 /
12 / **10**, closing most of the gap.

### Result 2 — with everything downloaded, tilting is nearly invisible

Warm cache, realistic terrain, one degree of tilt at a time:

- Between 45° and 74°, at most **5%** of the picture changes level per degree.
- Two screenshots taken 120 ms apart across a 2° tilt were **byte-for-byte
  identical**.

So the level changes by themselves are not the blink. This ruled out our first
hypothesis and is the reason the fix is about downloads, not about the formula.

### Result 3 — with a cold cache, a 3° tilt collapses the picture

Same test, but starting from an empty cache with 140 ms per tile:

| Tilt | Time to settle | Worst shortfall while settling |
| --- | --- | --- |
| 55° → 58° | 1522 ms | none |
| **58° → 61°** | **739 ms** | **3 levels too coarse over 9% of the surface** |
| **61° → 64°** | **520 ms** | **3 levels too coarse over 9% of the surface** |
| 64° → 67° | 338 ms | none |
| 67° → 70° | 596 ms | none |
| 70° → 73° | 453 ms | none |
| 73° → 70° | 381 ms | none |

Three levels too coarse means that part of the landscape is being drawn from
elevation data with **one sixty-fourth** of the intended information, for half
a second, and then it snaps back. That is the blink.

Note that it does not happen on every tilt — only on the ones that cross a
boundary into a level we have never downloaded. This matches the reported
experience that some small tilts are fine and others are not.

### Result 4 — better settings move the problem, they do not remove it

The same cold-cache run with the improved ladder setting:

| Tilt | Time to settle | Worst shortfall |
| --- | --- | --- |
| 58° → 61° | 340 ms | none |
| 61° → 64° | 797 ms | none |
| **67° → 70°** | **866 ms** | **3 levels too coarse over 13% of the surface** |

The collapse moved from 58–64° to 67–70°. This is important for the plan: the
ladder setting is worth doing for its own reasons, but **it is not a fix for
the blink on its own.** Only having the tiles ready is.

## 6. Two things we found along the way

### The "crisper drapes" fix only did half its job

The extension calls MapLibre's detail-tuning function for the painted map
layer, in [terrain-frame.js](../../src/terrain/terrain-frame.js), with a
comment explaining that it is deliberately not applied to the elevation data
because elevation tiles are expensive. (Both the line number this originally
cited and that comment are gone; section 12 records what replaced them.)

The problem is the invisible intermediate canvases from section 3. Their level
is chosen using the *elevation* source's settings. So tuning only the painted
map raises how many topo tiles we download without raising the ceiling those
tiles are painted into.

Measured: the intermediate canvases end up at byte-identical levels with and
without the setting, while topo tile requests roughly double — from about 37–83
tiles per view to about 64–139.

This does not mean the setting is useless. Below that ceiling it does buy real
sharpness, which is what the release notes claimed and what a previous check
observed. It does mean **we are paying roughly double the topo traffic for
sharpness that is capped by a ladder we never adjusted**, and that is worth
re-measuring once the elevation ladder is adjusted (section 7, step 2).

### A separate bug: the view jumps when you finish a pan

MapLibre has a default behaviour where, at the end of every drag, it re-derives
the zoom level from the height of the ground under the middle of the screen, so
that "zoom" means a consistent height above the terrain.

On flat maps this does nothing. On mountains it means that dragging from a
valley to a ridge and releasing the mouse changes the zoom in a single
instantaneous step. We measured **−0.097 zoom levels** on a 60-pixel drag with
our test terrain; the arithmetic gives up to a **full level** at higher zoom
over 600 m of relief. Turning the behaviour off eliminated it exactly.

**This is not the tilt bug** — tilting pivots around the centre of the screen,
so the ground under the middle does not move and the recalculation does
nothing. We confirmed this: centre elevation stayed at 1988 m across a tilt. But
it is a real, separate jolt on panning, and it is listed as step 4 below.

## 7. The fix plan

Ordered by how much of the blink each step removes.

### Step 1 — have the tiles before the tilt asks for them (the real fix)

**What.** Extend tile pre-loading so that while the 3D view is open, we quietly
fetch the elevation tiles that a small tilt in either direction would need,
before the user tilts.

**Why this is the fix.** Result 2 showed that when the tiles are present, the
level change is invisible. Result 3 showed the entire blink is the wait for a
download. Remove the wait and there is nothing left to see.

**Why it is achievable here.** The extension already has every piece:

- [terrain-tiles.js](../../src/terrain/terrain-tiles.js) already works out which
  tiles a given view needs, as pure arithmetic with no browser dependency, and
  already returns the target level plus its parent.
- [terrain-cache.js](../../src/terrain/terrain-cache.js) already stores fetched
  elevation tiles in a persistent, size-limited cache keyed by tile address, and
  is already what MapLibre reads through inside the 3D frame. Anything we warm
  is automatically a cache hit for MapLibre later.
- [terrain-prefetch.js](../../src/background/terrain-prefetch.js) already does
  exactly this warming — but only *before* 3D opens, triggered by hovering the
  3D button, and capped at 32 tiles.

**Work.**

1. Extend `tilesForView` to optionally return the tiles for the levels a tilt
   would demand, not just the current level and its parent. The tilt band is
   predictable from the camera, so this stays pure arithmetic and stays
   node-testable.
2. Inside the 3D frame, after the view settles, warm those tiles through the
   existing cache. The frame already holds a cache instance, so this is a call
   into code that exists, not a new network path.
3. Give it its own modest budget and its own idle trigger so it cannot compete
   with the tiles the user is actually waiting for. Only warm when the camera
   has been still for a moment.

**Costs and limits to respect.**

- More Mapterhorn requests. The existing prefetch is capped at 32 tiles and
  rate-limited to one burst every 15 seconds; the in-view warming needs an
  equivalent explicit cap, and must not fire during an active gesture.
- Only run when the elevation cache budget is above zero and 3D is enabled, the
  same gates the existing prefetch uses.
- **Documentation is not optional here.** The privacy table in
  [3d-map.md](../3d-map.md) currently describes elevation pre-fetching as
  happening on "3D enabled plus idle-toggle hover/focus". Warming while 3D is
  open is a new row in that table and must be written down before it ships.

### Step 2 — close the gaps in the detail ladder

**What.** Apply MapLibre's detail-tuning function to the elevation source as
well, at roughly `(6, 1.5)`.

**Why.** It removes the missing rungs. The horizon band goes from level 9 to
level 10 — four times more information in the part of the frame that currently
looks worst — and there is no longer a three-level cliff for a fallback to drop
down.

**What it does not do.** It does not fix the blink; Result 4 showed it relocates
the collapse rather than removing it. It is worth doing for quality, and it
makes step 1's job easier by shrinking how far a fallback can fall, but it must
not be shipped as "the fix".

**Costs.** More elevation tiles and more intermediate canvases: peak canvas
count went from 14 to about 15 at `(6, 1.5)`. MapLibre keeps a pool of 30 of
these, each a large render target, so there is headroom — but settings we
tested that were more aggressive than this pushed the count to 20 and made the
per-degree behaviour worse, not better. `(6, 1.5)` was the best of the settings
tried; anything tighter is a regression.

**Follow-on.** Once this lands, re-measure whether the painted map still needs
its `(4, 3)` setting, or whether a thriftier value now gives the same visible
sharpness for half the topo traffic. Section 6 explains why that number is
currently doing less than it appears to.

### Step 3 — stop discarding tiles we may come straight back to

**What.** Raise the map's tile-retention setting so tiles from the tilt angle
you just left are not evicted.

**Why.** Tilting a few degrees and tilting back is an extremely common gesture.
MapLibre's default keeps roughly five levels' worth of off-screen tiles; the
cost of keeping more is memory, and the benefit is that reversing a gesture is
instantaneous.

**Cost.** Memory only, and it is bounded and tunable. This is a small change
with a small, well-understood cost.

### Step 4 — the pan jolt (separate bug, separate change)

**What.** Decide whether to keep MapLibre's ground-following zoom behaviour.

**Options.**

- Turn it off. Removes the jolt completely. The trade-off is that zoom then
  means a fixed map scale rather than a fixed height above the terrain, so
  panning from a valley onto a summit brings the ground closer without the view
  compensating. MapLibre separately guards against the camera ending up inside a
  mountain, so that failure mode is covered either way.
- Keep it, and accept the jolt.

**Recommendation.** Try turning it off behind the existing 3D verification
harness and look at it. This is a feel question, not a correctness question, and
it should be decided by looking at the real thing rather than by argument. It
should be a separate commit from steps 1–3 regardless of the outcome.

## 8. What we cannot fix from here

MapLibre deliberately disables cross-fading for painted map layers whenever 3D
terrain is switched on, and it discards and rebuilds the intermediate canvases
whenever their level changes. So even a perfectly prepared level change arrives
as an instant swap rather than a dissolve.

We are not going to patch or fork MapLibre for this. It is worth an upstream
issue, and it is worth knowing about, but it only governs whether the *recovery*
is smooth. With steps 1 and 2 done there should be nothing substantial left to
recover from, and an instant swap between two nearly identical frames is not
something a user notices.

Note also that the extension explicitly sets fade durations to zero on both the
map and the drape layer. Under 3D terrain those settings are ignored by
MapLibre anyway, so they are not a cause — but they would need revisiting if
MapLibre ever enables fading under terrain.

## 9. How we will know it worked

The measurement harness built for this investigation is the acceptance test, and
it should be turned into something repeatable alongside the existing
`terrain:verify` check. The pass criteria:

1. **No collapse on a small tilt from cold.** Repeat the Result 3 sweep —
   3° tilts across 55°–75°, cold cache, realistic per-tile delay. No step may
   leave any part of the surface more than **one** level below its intended
   detail. Today two steps out of eight fall three levels short.
2. **No missing rungs.** Repeat the Result 1 census. No frame may contain two
   levels more than **two** steps apart. Today the gap reaches four.
3. **Reversing a tilt is free.** Tilt 3° and back; the return must produce no
   shortfall at all.
4. **Traffic stays bounded.** Record elevation and topo tile counts per view
   before and after, and state the increase explicitly. A fix that removes the
   blink by quietly tripling Mapterhorn traffic is not a fix we ship without
   saying so.

State plainly in the resulting notes which of these ran hidden, on what
graphics hardware, and at what window size — and remember what this harness
cannot see: it does not exercise the real extension bundle, the real drape
providers, or the real Mapterhorn service. A live spot-check through
`terrain:verify` is still required before release.

## 10. Decisions still needed

1. **How wide a tilt band to pre-load in step 1.** Wider means fewer blinks and
   more traffic. This should be chosen from a measurement of how far a typical
   drag actually tilts, not guessed.
2. **Whether step 4 ships at all**, which is a feel judgement to be made in
   front of the real map.
3. **Whether the painted map keeps its `(4, 3)` setting** after step 2, which
   depends on a measurement that cannot be taken until step 2 exists.

## 11. Technical appendix

Everything above in the library's own terms, for whoever implements it.

**Versions and locations.** MapLibre GL JS 5.24.0. Extension 3D frame:
[src/terrain/terrain-frame.js](../../src/terrain/terrain-frame.js).

**The level formula.** `createCalculateTileZoomFunction` in
`geo/projection/covering_tiles.ts`. Per-tile desired zoom is continuous in
pitch, then floored (`roundZoom` is false for terrain-backed sources —
`tile/tile_manager.ts` forces it off when `usedForTerrain`). `allowVariableZoom`
in `geo/projection/mercator_covering_tiles_details_provider.ts` returns true
whenever terrain is present, at any pitch.

**The render-to-texture grid.** `TerrainTileManager.update` in
`tile/terrain_tile_manager.ts` calls `coveringTiles` with
`calculateTileZoom: this.tileManager._source.calculateTileZoom` — the *DEM*
source's function. `map.setSourceTileLodParams(a, b, id)` assigns
`source.calculateTileZoom` (`ui/map.ts`), so tuning `'basemap'` cannot reach the
RTT grid. RTT tile size is `source.tileSize * 2 ** deltaZoom` = 1024; each is
rendered into a `tileSize * qualityFactor` = 2048 px target from a pool of 30.

**The `deltaZoom` offset.** `TerrainTileManager.getSourceTile` resolves the DEM
tile as `tileID.overscaledZ - deltaZoom`, with `deltaZoom = 1`. Any shortfall
metric must subtract this or it reports a permanent one-level deficit that does
not exist. This caught out an earlier draft of the measurement.

**No fading under terrain.** `tile/tile_manager.ts` guards raster fade updates
with `isRaster && this._rasterFadeDuration > 0 && !terrain`. RTT tiles absent
from the new key set are deleted and recreated with an empty `rtt`; each
arriving DEM tile triggers `terrain.tileManager.freeRtt(tileID)`.

**The pan jolt.** `centerClampedToGround` defaults to true (`ui/map.ts`).
`recalculateZoomAndCenter` runs from `ui/handler_manager.ts` at the end of an
interactive move and from `ui/camera.ts` after an eased move, re-deriving zoom
from the terrain elevation under the screen centre; it early-returns when that
elevation is unchanged, which is why tilt does not trigger it.
`_elevateCameraIfInsideTerrain` in `ui/camera.ts` runs regardless of the
setting, so disabling it does not risk burying the camera.

**Tile retention.** `maxTileCacheZoomLevels` defaults to 5
(`util/config.ts`); `TileManager.updateCacheSize` multiplies it by the
approximate on-screen tile count.

**Settings tried for the elevation ladder**, worst single-degree re-level and
peak RTT tile count: stock (9.314, 3) — 21%, 14 tiles; (8, 3) — 21%, 18;
(7, 3) — 32%, 18; (6, 3) — 12%, 20; **(6, 1.5) — 11%, 15**; (5, 3) — 38%, 20.
The per-degree figure is terrain- and zoom-dependent and should not be treated
as precise; the level-gap and peak-tile-count figures were stable across runs.

## 12. Closure ledger

Everything below was measured with `npm run terrain:lod`, which is section 9's
harness in checked-in form. It ran hidden, in headless Chrome on the real
hardware renderer (reported as ANGLE Metal on an Apple M3 Pro), against the
built `dist/` frame at 1098×698 CSS pixels, with locally generated Terrarium DEM
tiles served at 140 ms each. It does not exercise the real Mapterhorn service,
the real drape providers, or anything about window placement; `npm run
terrain:verify` remains the live spot-check and was run and passed.

### Fixed and verified

**Step 2 — the detail ladder** (`fix: close the missing rungs…`). The elevation
source now gets `setSourceTileLodParams(6, 1.5)`, not just the drape. The settled
census went from level 13/12/11/8 to 12/11/9, and the widest gap between levels
present in one frame went from 3 to 2 at both 66° and 70°, so section 9's
no-missing-rungs criterion passes. Peak render targets went from 12 to 15 against
MapLibre's pool of 30 — in line with the plan's predicted 14→15.

**Step 3 — tile retention** (`fix: keep the 3D tiles a reversed tilt…`). Retention
raised from MapLibre's 5 screenfuls per source to 8. Verified to reach MapLibre:
`terrain:lod` reports the resulting ceiling as 60 retained elevation tiles before
the change and 96 after.

**Step 1 — warming** (`fix: warm the elevation tiles a 3D tilt…`), for what it
does reach. Every tilt in the 55–76° sweep now fetches **0** elevation tiles where
1–8 were fetched before, and the 61°→64° transient went from 4 levels short for
234 ms to 4 levels short for **22 ms**. Reversing a tilt produces no shortfall at
all, so section 9's criterion 3 passes.

**Traffic, stated as section 9 requires.** Across one full run: 64 elevation tiles
total (17 on boot, 47 across the sweep, 0 across the census) against 47 before
step 1, and 112 drape tiles. Warming is capped at 32 tiles per pass, one pass per
800 ms, 2 concurrent fetches, and never re-fetches a tile it already warmed.

### Changed but not fully proven

**The 67°→70° step still collapses.** Distant tiles stay 3 levels short for about
214 ms. It fetches **nothing** while doing so, which locates the wait precisely:
it is CacheStorage read plus image decode plus DEM parse for eight tiles, not
download. A warm cache cannot reach it. It is likely smaller against Mapterhorn's
WebP than against this harness's larger PNG tiles, but that is an expectation, not
a measurement. `terrain:lod` reports this as a criterion failure and exits
non-zero rather than passing quietly.

**Two places where this plan was wrong**, both found by implementing it:

1. Section 7 called step 1 "the real fix" on the reasoning that having the tiles
   present makes the level change invisible. Half of that holds. Warming removes
   the download wait, but it cannot change how *deep* a fallback goes: MapLibre
   draws a band it lacks a tile for from an ancestor it has **already loaded**, and
   nothing outside MapLibre can hand it an ancestor it never requested. So depth
   belongs to step 2's ladder and duration belongs to step 1's warming. Section 9's
   criterion 1 is written as a depth rule and cannot be satisfied by warming alone;
   `terrain:lod` therefore holds a deeper-than-one-level fallback to a duration
   budget, and says so in the script where the criterion is applied.
2. Section 5's Result 3 — a cold 3° tilt leaving 9% of the *visible surface* three
   levels short — did not reproduce. At this camera and viewport the coarse horizon
   band is largely hidden behind nearer ridges, so tiles that want a level they
   have not got contribute few or no pixels. The harness reports shortfall per
   visible pixel **and** per render-to-texture tile for exactly this reason; a
   pixel-only check would have read "nothing was short" while three-level
   shortfalls were live. This is reported as measured rather than tuned away.

Note also that step 2 slightly *introduced* a visible transient: before it, no
tilt in the sweep left any visible pixel short; after it, 61°→64° leaves 1% of the
surface short (for 22 ms once step 1 landed). A finer ladder asks for more
distinct levels, including one far away. This is the right trade — the settled
picture is a level sharper across the horizon band — but it is a trade.

### A limit of the harness, found by using it

The showcase drape comes from a live Leaflet layer, and
`src/terrain/terrain-basemap.js` gives every live layer `stockLod: true` on
purpose — an unknown host on unknown terms does not get tripled tile requests. So
the shared fixture cannot exercise the tuned drape level-of-detail path at all:
three wildly different settings produced byte-identical drape levels, because none
of them was ever applied. `terrain:lod` now swaps the fixture's layer for a drape
code the extension carries a spec for and answers that host from the interceptor,
with the CORS headers a real provider would send. The swap happens in the check's
own server, so `terrain:verify` and `showcase:render` render exactly what they
rendered before.

This is the shape of mistake worth remembering: the first three runs agreed
perfectly, which looked like a clean result and was in fact the measurement not
running.

### Owner choices resolved

**Step 4, the pan jolt — disabled.** The owner chose the fixed-scale behavior
described in the [comparison note](pan-jolt-comparison.md).
`centerClampedToGround: false` now prevents MapLibre from re-deriving zoom when
a drag ends. The comparison branch's `Shift+J` toggle and diagnostic notices did
not ship. This remains a deliberate feel choice, not a correctness claim, and
section 6 confirms it is separate from the tilt bug.

**Whether the drape keeps its `(4, 3)` setting** — measured, and the answer is
**yes**, which contradicts what section 6 expected. `terrain:lod` now censuses the
drape's chosen levels against the ceiling each render-to-texture band can carry:
256-pixel drape tiles are painted into 2048-pixel targets, so a band at level Z
can carry a drape at Z+3, and a pitched frame holds several bands at once.

| drape setting | drape tiles on screen | levels present | against the ceilings |
| --- | --- | --- | --- |
| `(4, 3)` — current | 119–144 | 16–12 | matched at every pitch measured |
| `(9.314, 3)` — MapLibre stock | 53–57 | 16–8 | 2–3 levels coarser at the horizon |
| `(6, 1.5)` — matching the elevation ladder | 67–76 | 16–10 | 1–2 levels coarser at the horizon |

Section 6 was right that `(4, 3)` buys nothing *beneath the camera*: the near band
sits at level 16 under all three settings, because that is where the ceiling is.
It was wrong that the rest is therefore waste. The extra tiles go to the horizon
band, and they land **below** the ceiling, not above it — detail the pipeline
carries rather than discards. A thriftier setting is a strictly less sharp
picture, not the same picture for less traffic. `(4, 3)` stays.

**How wide a tilt band to pre-load** (section 10 decision 1). Section 10 asks for
this to be chosen from a measurement of how far a typical drag tilts. There is no
such measurement and no way to take one: the extension has no analytics, by
design. It was instead resolved geometrically — the warm set follows the camera's
own visible rectangle, and each coarser rung takes a rectangle twice the size of
the rung above it, because a coarser level is used further away. What that costs
is measured and capped rather than estimated.
