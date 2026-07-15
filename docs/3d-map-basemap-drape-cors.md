# 3D map: the layer drape usually fails to load

Status: Investigation note
Prepared: July 14, 2026
Code reviewed: `main` commit `74dadfd842c6bab9d8a8617a2f98716fb23d9a92`
Method: Static source inspection of the extension and the vendored MapLibre CSP
build; no authenticated live run (the live site is Cloudflare-blocked).

## Symptom

When the user opens the experimental 3D terrain map, most of the time it shows
only the bare shaded-relief terrain — no map imagery draped over it. The
draped topo/aerial layer (what the user selected in Peakbagger's 2D map) is
missing. It works for *some* layers, which is what makes it look flaky rather
than broken.

The badge in the corner reads **"Terrain only"** in the failing case
(`src/terrain-frame.js:292`) instead of `"<layer name> · 3D terrain"`.

## What the pieces are

The 3D view is a MapLibre GL scene rendered inside an extension-owned iframe
(`terrain/terrain.html`), kept off Peakbagger's origin so MapLibre and its
worker run with a real extension origin. The scene stacks four things
(`src/terrain-frame.js:245-286`):

1. `terrain-background` — a flat background color.
2. `terrain-relief` — color-relief computed from the DEM.
3. `basemap` — the raster **drape**: the topo/aerial tiles, at 0.78 opacity.
4. `terrain-hillshade` — hillshade computed from the DEM.

The "bare base map" the user sees is items 1, 2, and 4 — the terrain surface
itself. The missing piece is item 3, the `basemap` drape.

The drape's tile URL is lifted out of Peakbagger's live Leaflet map: the
selected layer's tile template is read from the `MasterMap.aspx` iframe,
its `{s}`/`{r}` placeholders are expanded, and it is normalized to a
`{z}/{x}/{y}` template (`src/gpx-analyzer.js:808-844`, helper
`expandLeafletTileUrl` at `:776-806`). That template is handed to the terrain
frame, validated, and used to build the `basemap` raster source
(`src/terrain-frame.js:253-267`).

## Root cause: the drape's tiles fail a CORS check

The drape is stripped at load time because its tiles fail a cross-origin
read check. The relevant distinction is **displaying** an image versus
**reading its pixels**.

### 1. The browser separates "display" from "read"

A cross-origin image can always be *displayed* (`<img src="https://any/x.png">`
just works). But the moment code wants to *read the pixels* — draw it to a
`<canvas>` and `getImageData()`, or upload it to a WebGL texture — the browser
blocks it unless the serving origin opted in with an
`Access-Control-Allow-Origin` (ACAO) response header. Without that opt-in the
image "taints" the canvas/GPU context and any read throws `SecurityError`.
The opt-in header *is* CORS. The rule exists because the browser fetches images
with the user's cookies; letting arbitrary code read those pixels would be a
data-exfiltration hole.

### 2. WebGL texture upload counts as a "read"

MapLibre is a WebGL renderer. It does not lay `<img>` tags on the page — it
uploads every tile into a GPU texture via `gl.texImage2D`. That is a read from
the browser's security standpoint, so WebGL refuses to upload a tainted
(non-CORS) cross-origin image. The tile fails.

### 3. So MapLibre must request tiles in CORS mode

The browser only enforces CORS on an image if the `crossOrigin` attribute is
set:

- `crossOrigin` absent → plain load: displays, but is **tainted** → unusable in
  WebGL.
- `crossOrigin="anonymous"` → CORS request: succeeds **only** if the server
  returns ACAO; otherwise the load fails outright (`onerror`).

MapLibre needs an untainted image for the GPU, so it takes the second path. The
vendored bundle confirms this. Its same-origin test:

```js
// vendor/maplibre-gl-csp.js
function _t(e){
  if(!e || e.indexOf("://")<=0 || e.startsWith("data:image/") || e.startsWith("blob:")) return true;
  const t=new URL(e), i=window.location;
  return t.protocol===i.protocol && t.host===i.host;
}
```

and the loader sets `crossOrigin="anonymous"` whenever the tile URL is
cross-origin (`!_t(o)`):

```js
… (s && "same-origin" === s || !_t(o)) ? n.crossOrigin = "anonymous" : …
```

From the terrain frame the tile URL is *always* cross-origin: the frame's
origin is `chrome-extension://<id>`, and the tiles are `https://<provider>/…`.
So MapLibre always opts into CORS, and any provider that omits ACAO fails.

### 4. Who asks to read, and who permits it

`crossOrigin` is easy to misattribute, so to be precise: it is a **client-side
DOM attribute** on the `<img>`, set by whatever JavaScript creates the image.
It is not a network message, and not something the tile server or the hosting
page emits. It is the client declaring intent — *"I mean to read this image's
pixels, so make this a CORS request and only give it to me if the server
allows."* A cross-origin read needs **both** halves, and they are set by two
different actors:

| Half | Set by | Meaning |
| --- | --- | --- |
| `crossOrigin="anonymous"` | the **client** library creating the `<img>`/fetch | opt *into* CORS mode ("I want to read the pixels") |
| `Access-Control-Allow-Origin` | the tile **server** | opt *into* being read ("cross-origin reads allowed") |

Mapping that onto the actors here:

- **The tile server** never sets `crossOrigin`; its only lever is whether it
  sends `Access-Control-Allow-Origin`.
- **Leaflet** creates the `<img>` but leaves `crossOrigin` unset by default, so
  its tiles are plain display-only loads.
- **MapLibre** sets `crossOrigin="anonymous"` for cross-origin tiles (the
  `_t()` logic above), because it must read the pixels for WebGL.
- **peakbagger.com** instantiates Leaflet but passes no `crossOrigin` option, so
  it stays unset.

MapLibre is the only actor asking to read, which is why it is the only one told
"no."

### 5. Why the same tiles work in Peakbagger's 2D map

Leaflet runs on Peakbagger's own origin and creates plain
`<img src="https://provider/…">` with **no** `crossOrigin` attribute. The
browser does a no-CORS load; the tile displays even with zero ACAO. Leaflet
never reads the pixels, so tainting is irrelevant. That is the whole paradox:
the identical tile server is blank in the 3D map yet visible in the 2D map —
not because the server changed, but because Leaflet never asks to read what
MapLibre is forced to read.

This also pins down the diagnosis without a network trace: the 2D map works, so
Peakbagger's tiles are being loaded without `crossOrigin` (display only). If
those servers *did* send ACAO, MapLibre's `crossOrigin="anonymous"` request
would succeed too and the drape would not be failing. The drape failing while
the 2D map works is therefore direct evidence that both (a) Leaflet omits
`crossOrigin` and (b) the servers omit ACAO — MapLibre is simply the only one
of the three asking to read.

### 6. Why the DEM terrain is immune

The DEM never touches an `<img>`. It is fetched through the `bpb-dem://`
custom protocol whose handler does its own `fetch()` and returns raw
`ArrayBuffer` bytes to MapLibre (`src/terrain-frame.js:378-381`,
`src/terrain-cache.js:189-206`). MapLibre builds the texture from bytes already
in JS memory — there is no cross-origin image element, so there is no taint to
trip over. (Mapterhorn also sends ACAO, but the bytes path is the structural
reason.) This is exactly the trick the fix borrows.

## Why "most of the time," not always

Providers that *do* send `ACAO: *` drape fine — e.g. OpenTopoMap, which is the
layer hard-coded in the passing test at `test/terrain-map.test.mjs:72`.
Peakbagger's default and many of its layers (USGS topo, aerials, and other
providers consumed by Leaflet as plain images) send no ACAO and fail. So the
outcome splits by which layer happens to be selected, which reads to the user
as flakiness.

## Secondary aggravator: one bad tile removes the whole drape

The error handling is all-or-nothing. A single `error` event tagged
`sourceId: 'basemap'` — one 404 edge tile, one transient blip — sets
`basemapFailed` and removes the entire layer
(`src/terrain-frame.js:398-405`, and again on `load` at `:428`, via
`removeFailedBasemap` at `:295-303`). So even a CORS-capable provider is
fragile: one missing tile collapses the drape to "Terrain only."

## This limitation is already known in the code

The behavior is deliberate graceful degradation, not an accidental crash. The
existing test asserts it by name:

```js
// test/terrain-map.test.mjs:309-311
map.handlers.get('error')({ sourceId: 'basemap' });
assert.match(window.document.querySelector('.bpb-terrain-badge').textContent, /^Terrain only/,
    'a selected layer that fails CORS must not take down the terrain renderer');
```

The team knew these layers fail CORS and built the terrain-only fallback. The
user simply hits that fallback most of the time.

## Why not co-locate the origins?

A natural first instinct is to sidestep CORS by making the terrain document
share Peakbagger's origin. It does not work, for two independent reasons.

**You cannot relabel the frame's origin.** A resource served via
`chrome.runtime.getURL('terrain/terrain.html')` is permanently on the origin
`chrome-extension://<id>` (origin = scheme + host + port; the scheme is
`chrome-extension:`). There is no API that lets an extension-served document
claim `https://www.peakbagger.com` — that relabeling is precisely what the
same-origin policy exists to prevent. The frame is on the extension origin on
purpose, so MapLibre and its worker run with extension privileges rather than a
content-script sandbox (`src/terrain-map.js:4-6`).

**Even if you could, it would fix nothing.** The CORS check compares the *tile
server's* origin against the *document's* origin — not the frame against
Peakbagger. The tiles come from third-party providers (USGS, ESRI,
OpenTopoMap, …), which are cross-origin relative to `www.peakbagger.com` just as
much as to `chrome-extension://<id>`. Running MapLibre directly inside the
Peakbagger page (a MAIN-world content script, genuinely on Peakbagger's origin)
would still make `_t()` classify `https://provider/…` as cross-origin, still
set `crossOrigin="anonymous"`, and still require ACAO — while additionally
inheriting Peakbagger's CSP, which would likely block MapLibre's worker. The
only tiles co-location helps are the ones Peakbagger serves from its own domain,
a minority. **No origin you can give the terrain document makes third-party
tiles same-origin.**

## The hard platform constraint

There is **no way** to drape a non-CORS third-party tile onto a WebGL map
without the extension holding a host permission for that tile's host. Every
escape hatch is closed:

- `fetch(url, { mode: 'no-cors' })` → opaque response; `arrayBuffer()` is empty.
- Plain `<img>` with no `crossOrigin` → taints the WebGL texture; `texImage2D`
  throws.
- `declarativeNetRequest` header injection to add ACAO → the rule only applies
  to hosts the extension already has permission for.
- Delegating the fetch to the background service worker → an MV3 SW `fetch` is
  still subject to CORS for hosts outside `host_permissions`.

And note that extension host permissions grant a CORS bypass for `fetch`/`XHR`
only — **not** for `<img crossOrigin>` element loads, which is MapLibre's
default path. The manifest currently grants only `peakbagger.com`
(`manifest.json:20-23`), and there is no runtime-permission plumbing anywhere
in the codebase yet.

So a real fix must both (a) turn the un-bypassable `<img>`-CORS load into a
bypassable `fetch`, and (b) obtain host permission for the (dynamic) tile hosts.

## Proposed fix

### Tier 1 — stop nuking the drape on sparse errors (small, no new permissions) — *done*

**Implemented.** The error handler no longer strips the drape on the first
failed tile. Instead the frame tracks two facts as MapLibre events arrive: a
successful raster tile fires a `data` event of `dataType: 'source'` carrying a
`tile` (→ `basemapContentLoaded`), and a non-404 tile failure fires an `error`
with `sourceId: 'basemap'` (→ `basemapErrored`). The keep/drop decision is made
exactly once, at the first map `idle` (which fires only after every requested
tile has settled): the drape is removed **only** when it errored and loaded
zero tiles — a whole layer blocked by CORS — and is otherwise kept through
partial coverage gaps. The design is fail-safe: removal requires a real error,
so a fully working layer is never dropped even if success detection misses.

This makes every CORS-capable provider drape reliably and fully. It does not
help the non-CORS majority — that is Tier 2. See `src/terrain-frame.js`
(`basemapErrored` / `basemapContentLoaded` / `basemapChecked` and the
`error`/`data`/`idle` handlers), covered by `test/terrain-map.test.mjs`.

### Tier 2 — make non-CORS providers work (the actual feature fix)

1. Route the basemap through a custom `bpb-basemap://` protocol, mirroring the
   DEM path: set the source `tiles` to the protocol template, keep the
   validated real template in a frame variable, and in the handler substitute
   `{z}/{x}/{y}`, `fetch()` the real tile, and return `{ data }`. Bytes via
   `addProtocol` produce a CORS-clean texture — no `crossOrigin`, no taint.
   (Bonus: the LRU cache in `src/terrain-cache.js` can be generalized to cache
   basemap tiles too.)
2. The handler's `fetch()` still needs cross-origin permission, so add
   `optional_host_permissions` and request it at runtime, gated behind the
   explicit **3D terrain** activation action.
   Fall back to Tier-1 terrain-only if the user declines or a provider still
   fails.

### The open decision: permission scope for Tier 2

- **Broad** (`*://*/*`, requested on demand) — robust for every current and
  future Peakbagger layer, but a scarier prompt and a real privacy surface (the
  extension fetches arbitrary hosts on the user's behalf). Firefox's
  `data_collection_permissions` disclosure (`manifest.json:187-192`) would need
  updating.
- **Curated allowlist** of Peakbagger's known providers — gentler prompt, but
  brittle: breaks whenever a layer uses an unlisted host.

Recommendation: ship Tier 1 now (pure win, no permission question), and do
Tier 2 with a **broad optional** permission requested only at activation time —
the only approach that reliably delivers the feature as designed, while keeping
today's safe default for anyone who declines.

## Verification notes

Per the fixtures workflow, the live site is Cloudflare-blocked, so Tier 2 can't
be exercised end-to-end against real providers locally. It will rely on the
stubbed MapLibre harness in `test/terrain-map.test.mjs` plus a manual check in a
real browser against a known non-CORS Peakbagger layer.

## Reference index

| Concern | Location |
| --- | --- |
| Terrain scene / layer stack | `src/terrain-frame.js:245-286` |
| `basemap` raster source built from raw https tiles | `src/terrain-frame.js:253-267` |
| Basemap keep/drop decision (Tier 1: error/data/idle handlers) | `src/terrain-frame.js:404-425` |
| `removeFailedBasemap` / "Terrain only" badge | `src/terrain-frame.js:295-303`, `:292` |
| DEM via custom protocol (the working path) | `src/terrain-frame.js:378-381`, `src/terrain-cache.js:189-206` |
| Tile URL extraction from Leaflet | `src/gpx-analyzer.js:808-844`, `:776-806` |
| Consent gesture to gate a permission request | `src/gpx-analyzer.js:719-722` |
| MapLibre `crossOrigin` / same-origin test | `vendor/maplibre-gl-csp.js` (`_t`) |
| Test acknowledging CORS failure | `test/terrain-map.test.mjs:309-311` |
| Extension-origin rationale for the frame | `src/terrain-map.js:4-6` |
| Host permissions (peakbagger only) | `manifest.json:20-23` |
