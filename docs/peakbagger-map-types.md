# Peakbagger map types

Peakbagger's `MasterMap.aspx` and `BigMap.aspx` pages use the `t` query
parameter as a map-context discriminator. It decides which subject, markers,
and routes the native map loads. It does not select the basemap; the `l`
parameter carries the pipe-delimited layer selection.

This is an undocumented Peakbagger implementation detail, not a public API.
The names and behavior below were verified against the live
`MasterMap.aspx` Leaflet renderer on 2026-07-21. Treat changes to the upstream
page as compatibility changes that need fixture and live-page verification.

## Values handled by the native renderer

| `t` | Native name | Map behavior |
| --- | --- | --- |
| `P` | Peak | Shows a peak, its key col, and related area markers. `d` is the peak ID. |
| `U` | ApplyUpdate | Compares the old and proposed peak and key-col locations while applying an update. |
| `E` | Edit | Adds or edits a peak and its key-col location. |
| `K` | KeyCol | Shows prominence saddle and parent relationships for a peak. |
| `A` | Ascent | Shows one ascent's GPS track and waypoints. `d` is the ascent ID. |
| `G` | GPS group | Shows multiple ascent tracks for one peak. `d` is the peak ID. |
| `L` | List | Shows the peaks in a peak list. `d` is the list ID. |
| `W` | Wilderness | Shows a wilderness center, inscribed circle, and boundary. |
| `I` | Isolation | Shows a peak, isolation limit point, nearest higher point, and isolation circle. |
| `J` | Jut | Shows a peak and its jut base. |
| `S` | ShoreDistance | Shows a peak and its shore-distance point. |
| `R` | Range | Shows mountain-range high points and range polygons. `d` is the range ID. |
| `C` | Climber | Shows a climber's peaks, colored by elevation or prominence. `d` is the climber ID. |
| `F` | Reference | Internal reference view that records the current map and pixel bounds in cookies. |
| `M` | CompletionMap | Shows completion-map vectors; the current Leaflet path labels these as USA county-high-point vectors. |

The explicit set currently handled by the renderer is therefore:

```text
A C E F G I J K L M P R S U W
```

## Route-bearing types

The route cases relevant to Better Peakbagger's 3D terrain coordinator are:

- `t=A`: a single ascent track. Native map popups and waypoints belong to that
  ascent.
- `t=G`: multiple ascent tracks associated with a peak. Each route can link to
  its own ascent/trip report.
- `t=P`: a peak rather than a GPS route. The 3D view uses the peak coordinates
  as its subject and may fetch surrounding peak markers separately.

`src/big-map.js` intentionally admits only these three contexts. Adding another
native type to that allowlist requires defining what bounded geometry becomes
the terrain subject; recognition by Peakbagger alone is not enough.

## `t=G` and `gt`

`t` and `gt` are different discriminators. `t=G` selects the multi-track GPS
map. Within that map, `gt` selects the group:

| `gt` | Meaning |
| --- | --- |
| `rc` | The most recent GPS tracks for the peak |
| `rt` | Different routes for the peak |

For example, `t=G&d=2296&gt=rc` means "the recent grouped GPS tracks for peak
2296." `gt` has no corresponding role on `t=A` or `t=P` maps.

## Other overloaded parameters

The subject identifier in `d` depends on `t`: it can be a peak, ascent, list,
range, or climber ID. Code must parse `t` first and must not treat `d` as a
peak ID globally.

Other commonly observed parameters include:

- `c`: the signed-in climber ID used to personalize climbed/unclimbed peak
  markers. This differs from `t=C`, where `d` identifies the climber whose map
  is being displayed.
- `hj`: the prominence cutoff for hiding minor peaks.
- `a`: whether applicable area markers are shown.
- `kcx` / `kcy`: key-col longitude and latitude on peak maps.
- `l`: the ordered, pipe-delimited basemap and overlay layer IDs.

Only rely on parameters a feature actually needs. Unknown or inconsistent
combinations should leave Peakbagger's native map usable rather than guessing
at a different context.
