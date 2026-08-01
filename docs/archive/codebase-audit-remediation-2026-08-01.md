# Codebase audit remediation — 2026-08-01

Status: **the twelve reported findings are remediated and the full unit,
packaging-lint, and hidden packaged-browser gates pass.** The terrain LOD stress
gap and live-service proof limits remain explicit below. This ledger reassesses
the supplied audit against local `main` at `a779e66`; maintainability claims
were not treated as product defects until their current owners and failure
paths were established.

## Reassessed findings and disposition

| ID | Finding | Disposition |
| --- | --- | --- |
| F1 | popup exposes rejected browser messaging text | Fixed in `16ddac1` |
| F2 | a selected bound fallback can lose the captured trip name | Fixed in `cd6f870` |
| F3 | fail-soft theme reads can overwrite the pre-paint mirror | Fixed in `36fb128` |
| F4 | the settings schema ownership claim exceeds its structural guard | Resolved in `60678be`: live duplicate resolvers moved to the schema and the remaining scan claim narrowed to what it enforces |
| F5 | Peakbagger sender trust is broader than the manifest and its rationale is false | Fixed in `d370e20` |
| F6 | the showcase dependency guard is vacuous | Fixed in `4e60eb0` |
| F7 | GitHub route access is separated from handler registration | Fixed in `856de3f` |
| F8 | the filter color guard misses border, outline, and shadow shorthands | Fixed in `9446035` |
| F9 | the terrain showcase omits the production timezone raster | Fixed in `703e868`; the same commit repaired relative extension-URL stubs that had silently prevented the terrain frame handshake |
| F10 | extension-authored Peakbagger links have no canonical-host rule | Fixed in `d370e20`: generated links use `www`, while both manifest-authorized served hosts remain accepted |
| F11 | Garmin `/modern/activity` and `/app/activity` handling disagrees | Fixed in `3160506`; both parse to one activity identity and generated links stay on `/app/activity` |
| F12 | the page settings client computes but bypasses its cleaned fallback | Fixed in `60678be` |

`e576cb5` updates the exact generated locations of two already-owned Firefox
lint warnings after the shared schema additions shifted the bundle. It does not
add, remove, or suppress a warning.

## Closure ledger

### Fixed and verified

- **F1 — public popup errors:** transport rejections now render bounded extension
  recovery copy. Typed worker errors remain actionable, so fixing the leak did
  not erase product-authored explanations. Draft opening, capture deletion, and
  cancellation all have regression coverage.
- **F2 — Trip Info precedence:** a visible match plus selectable bound fallback
  preserves the GPX track or activity heading for a later multi-peak selection.
  The selected draft set still decides whether Trip Info is filled.
- **F3 — theme preservation:** startup applies the cleaned synchronous mirror,
  but only an authoritative sync-storage read can replace it. A failed read no
  longer converts explicit dark or light to the default.
- **F4 and F12 — schema ownership:** chart series, report mode, favorite source,
  and beta definition now resolve through `settings-schema.js`. Page-client
  pre-init reads and optimistic writes use the cleaned fallback. The structural
  scan's documentation now names only the route, viewport, and theme literals
  it actually inspects.
- **F5 and F10 — Peakbagger URL policy:** runtime senders require HTTPS and one
  of the two hosts declared by the manifest. Extension-authored navigation and
  backup URLs use `https://www.peakbagger.com`; compatibility readers continue
  to accept both authorized hosts.
- **F6 — dead guard:** the empty dependency table, unreachable helpers, and two
  vacuous tests were removed. Active bundle, HTTPS-fixture, privacy, and renderer
  checks remain.
- **F7 — GitHub access policy:** every route registers its handler and access
  descriptor together. Route-table construction rejects a missing descriptor,
  so a new handler cannot accidentally inherit content-script access.
- **F8 — filter colors:** the source guard now inspects direct colors plus
  `border`, `outline`, and `box-shadow` shorthands while allowing colorless
  `none` and zero declarations.
- **F9 — production terrain fixture:** the analyzer loads the packaged timezone
  raster in manifest order. All three showcase surfaces now return an absolute
  `runtime.getURL()` result, which the route-coordinate bridge requires before
  it sends the frame an init payload.
- **F11 — Garmin routes:** both sides of Garmin's redirect are recognized on the
  exact Garmin host. A read-only live probe on 2026-08-01 returned HTTP 302 from
  `/modern/activity/1` to `/app/activity/1`; pure and bundled page tests cover
  both forms.

Verification evidence:

- Focused suites passed after each commit: 24 popup tests, 16 local-GPX worker
  tests, 12 theme/settings tests, 160 schema-consumer tests, 242 Peakbagger URL
  and integration tests, 7 showcase tests, 58 GitHub-route tests, 11 contrast
  tests, and 37 provider/worker tests.
- `npm test`: **1,122 passed, 0 failed**.
- `npm run lint:js`: passed. `npm run lint`: passed with the same six owned
  cross-browser/vendor warnings.
- `npm run verify:browsers`: the real unpacked `dist/` passed in hidden Chrome
  for Testing new-headless and hidden Firefox 153.0.1 at 1000×760, including
  the MV3 worker, storage, settings bridge, popup, capture/draft, options,
  analyzer, BigMap, Peak, and report-editor surfaces. Chrome also exercised
  narrow 480×760 layouts.
- `npm run terrain:verify`: passed hidden in headless Chrome on the hardware
  `ANGLE Metal Renderer: Apple M3 Pro`; the pending-drape, resize, non-flat DEM,
  basemap, route, peak, failure, and context-loss probes passed at the verifier's
  default and wide viewports.
- `npm run terrain:verify:firefox`: passed hidden in Firefox 151.0 at 1000×760
  with a hardware renderer reported as `Apple M1, or similar`; terrain, drape,
  route, peaks, pointer interaction, and resize passed.
- Teardown inspection found no surviving verification browser process,
  disposable browser profile, fixture certificate, or key. The generated
  terrain screenshots were moved from the temporary directory to Trash rather
  than retained in the workspace.

### Intentionally not changed

- **Speculative `previewOrder` collision:** no reachable collision was
  established. The worker refuses selection writes after the job enters
  `opened`, the popup disables the same selection immediately, and stale-draft
  replacement computes missing tabs from that locked selection before sorting
  all drafts by their stored order. Changing the numbering without a failing
  path would weaken a working transaction.
- **Two served Peakbagger hosts:** bare and `www` remain accepted because both
  are explicitly present in the manifest. Canonicalization applies to links the
  extension creates, not to compatibility boundaries reading the current tab.
- **Settings literal scan:** it was not expanded into a claimed universal
  parser. The known duplicate consumers were removed and the remaining test's
  documented scope now matches its actual structural checks.

### Changed but not fully proven

- The popup leak is proven with bundled jsdom tests and the popup runs in the
  packaged browsers, but an actual MV3 worker outage was not induced in a native
  visible popup.
- Garmin's redirect was checked read-only and both forms are tested, but no
  authenticated live Garmin activity was captured. Live provider DOM and export
  behavior remain release-manual checks.
- Both Peakbagger hosts returned a Cloudflare challenge to unauthenticated
  command-line probes, so live host-redirection behavior was not established;
  the canonical `www` choice is an explicit extension policy.
- `npm run terrain:lod` now reaches the production terrain frame and hardware
  renderer, but one tilt transient measured **130 ms against the existing
  120 ms budget**. The ordinary Chrome and Firefox terrain verifiers passed;
  the LOD performance criterion remains a recorded gap rather than being hidden
  by a rerun or a loosened threshold.
- Terrain verification uses synthetic DEM, basemap, route, and Peakbagger feed
  fixtures. It does not prove the live Mapterhorn or drape providers.
- All browser work was hidden and isolated. It does not prove native focus,
  browser-window placement, toolbar grants, permission prompts, touch, screen
  reader output, or physical-device behavior.
