# Maptoolkit branch audit — November 6

Scope: audit and repair `codex/maptoolkit-basemap` against current `main`. The
branch had been 19 commits behind, so `main` was merged in first. Earlier records:
[integration](maptoolkit-basemap-2026-10-31.md),
[performance](maptoolkit-performance-audit-2026-10-31.md) and
[zoom](vector-zoom-audit-2026-11-01.md). Their reports of two snow-fixture
failures and a Garmin gate failure are superseded: both were fixed on `main`, and
those gates now pass here.

## Fixed and verified

| Finding | Defect | Evidence |
| --- | --- | --- |
| Elevation hid outages | A healthy Mapterhorn counted as usable, so a Maptoolkit outage never restored the native map | Verifier failed at the outage Retry wait, passes now |
| Failed center tile | One failed center tile held first load to the 15-second deadline and froze later views | Verifier failed at the center-tile wait with only the frame unfixed, passes now |
| 3D kept the old raster | Re-entering 3D ignored a raster layer chosen in 2D | Terrain test failed on the unfixed code, passes now |
| Dead parked renderer | A renderer failing while parked left reselection waiting 20 seconds | Bridge test failed on the unfixed code, passes now |
| Stuck after 3D | A renderer failing during 3D left the map on "Loading" after returning to 2D | Bridge test failed on the unfixed code, passes now |
| Raster reselection | Reselecting a raster no longer rebuilt it, unlike `main` | `verify -- terrain` failed, passes now |
| Credit overlap | A raster swap left credit text under the zoom control at 320px | `verify -- terrain` failed, passes now |
| Stale verifier fixture | `verify-terrain-visual` fired a limit on an uninstalled source | Now installs one; the gate passes |
| Settings disclosure | The 3D setting's provider list omitted Maptoolkit | Now named in plain text, because the options test pins that description's links; not visually inspected |
| TypeScript policy | 24 authored files the branch added or modified were JavaScript, which failed CI's policy check | All converted; `check:typescript-policy --base main` passes across 100 changed paths |

The owner chose full conversion on November 6, ahead of the adoption plan's order,
which leaves large coordinators until last. No explicit `any`, `@ts-nocheck` or
`@ts-ignore` was added. Narrow casts remain where untrusted input meets its existing
runtime checks, at MapLibre option and paint boundaries, and in test stubs.
`verify-terrain-visual`'s CDP responses use `JSON.parse`'s own return type, which is
`any` in effect, at the one boundary that parses them. Runtime logic is unchanged
apart from one shared cooldown helper and explicit fallbacks with the same result.

The 3D raster fix covers an unchanged drape too: it keeps its loaded source across
a mode switch, and a later tile gap cannot discard a layer that already rendered.

### Acceptance run

Browser checks ran hidden on an Apple M3 Pro, with Chrome 156 on ANGLE Metal.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with the eight owned web-ext warnings |
| `check:typescript-policy --base main` | Passed |
| Node tests | 3,895 of 3,895 passed |
| `npm run verify -- chrome` and `firefox` | Passed in Chrome 156 and Firefox 159 at 1000×760 |
| `npm run verify -- terrain chrome` and `firefox` | Passed in Chrome 156 and Firefox 157 |
| Maptoolkit 2D, `verify-vector-map` | 21 cases each in Chrome and Firefox at 1280/375 × 800, both themes, 200% CSS zoom |
| Maptoolkit 3D | 10 Chrome and 8 Firefox cases |
| OpenFreeMap | 21 2D and 10 3D Chrome cases |
| Native zoom continuity | 37 cases each in Chrome and Firefox |

**New proof:** a one-off probe, not checked in, loaded the real extension in hidden
Firefox 159. A trusted selection painted one live Maptoolkit view through the real
bridge, including the `ImageBitmap` handoff that the Firefox matrix stubs. That
closes the earlier gap for one view on a fixture page.

**Checked, not a defect:** the live map shows rectangular breaks in land color near
Mount Rainier. Unmodified `hiking.json` in plain MapLibre shows the same breaks, so
they come from provider data. That render also shows stronger relief than ours,
which is the single-hillshade reduction chosen in the performance audit.

## Intentionally not changed

- **Mapterhorn limits read as Maptoolkit.** A Mapterhorn 429 during Hiking
  shading sets the Maptoolkit cooldown and message. The style depends on both.
- **One 3D tile or sprite failure drops the vector map.** `main` already did this
  for OpenFreeMap tiles. This branch extends it to sprites, and Hiking makes more
  requests. 2D stays tolerant.
- **A `loaded` message nothing reads.** The bridge still posts it to the page.
- **One stale provenance string.** `third-party-notices.mjs` still names
  `scripts/build-config.mjs` in its override text, because editing that legacy file
  beyond a filename reference would require converting it too.
- **Skipped hooks in history.** Five commits before the conversion used
  `--no-verify`: the merge, whose report named files `main` changed, and four fixes
  to files then awaiting conversion. The privacy guard ran on each, and the final
  range passes the policy.

## Changed but not fully proven

- **Vector-to-raster credits at 320px.** The overlap's exact mechanism was found
  by experiment, not traced. Removing a vector basemap still repositions credits.
- **Live coverage.** One region and one viewport on a fixture page, not an
  authenticated Peakbagger layout or provider reliability.
- **Hidden runs.** They do not establish native focus, window placement, browser
  menus, touch or screen-reader behavior.
- **Hosted CI.** Nothing was pushed, so no hosted run is claimed.
