# Shared map overlays audit — October 21, 2026

Audited the feature at `242f9362` and implemented the findings in focused local
commits. Scope: the shared control; native and terrain adapters; Sentinel catalog
and tile loading; slope and US/Canadian ownership providers; SNOTEL availability,
membership and station popups; settings/worker bridges; Full Screen handoffs;
cancellation, retry, opacity, keyboard use and layout stability. This extends the
[implementation ledger](map-layers-and-overlays-2026-10-21.md). Current behavior
is maintained in [Map overlays](../map-layers.md).

## Findings and acceptance evidence

| ID | Priority | Finding and root cause | Resolution |
| --- | --- | --- | --- |
| O1 | Requested | The shared trigger said Layers although it controls only overlays, alongside a separate native basemap selector. | `89f4b080`: Overlays in visible/accessibility labels and maintained documentation; matching recovery language. |
| O2 | P2 | `installMapLayerBridge` announced its initial false SNOTEL flag when local opacity completed before strict settings. That could clear an enabled handoff. Its late startup read could also overwrite a newer opt-out. | `f72ced2b`: publish availability after strict settings; a newer settings notification supersedes the initial read. Unknown/failed settings cannot authorize provider access. Both new bridge assertions failed before the fix. |
| O3 | P2 | `installMapLayers` requested peak-authorized station membership only during viewport loading. Delayed snow-card readiness did not update existing markers, while unavailability did not immediately remove their stale actions. | `f83e53c5`: readiness requests membership immediately, pending work is coalesced, and invalidated replies cannot restore unavailable actions. Native and terrain regressions failed before the fix. |
| O4 | P2 | Raster sources stop producing tiles below their zoom limit, while the menu could keep showing stale provider errors or loading and offer ineffective Retry. | `cc27db1f`: share `OVERLAY_MIN_ZOOM` between renderers/control and use equivalent active-renderer tile zoom. Show Zoom in with actionable detail; hide inappropriate Retry without losing provider state. The pre-fix control assertion failed on Loading versus Zoom in. |
| O5 | P2 | Native and terrain station identity keys included selectable membership. A conditions-action update rebuilt every marker and closed the popup containing the focused NRCS link. | `47de8745`: when the station list is unchanged, update only its optional action. Keep popup/marker/link identity and focus. Removing a focused action returns focus to the same official link. Both marker regressions failed before the fix. |
| O6 | P2 | Sentinel's existing minimum catalog zoom was reported as Search failed even though validation prevented a search. | `9f4160aa`: share the existing catalog minimum with the control. Below it show Zoom in and hide ineffective Retry; actual catalog failures remain visible at supported zooms. The new assertion failed on the prior Search failed label. |
| O7 | Follow-up | The upper-right native basemap dropdown and its inline white surround stayed light because the scoped MasterMap theme covered only popups. | Extend the native map sheet to theme the select, options and surround with the Overlays palette and an inset keyboard focus ring. Both bundled and hidden Chrome assertions failed before the fix for the picker remaining light. |
| O8 | Follow-up | Each opacity input reapplied unrelated native rasters and station popups, resent terrain station data, repeated regional polygon work and replaced every legend. | `23d4b18a`: scope native opacity application to the edited raster, cache public-land metadata by viewport, and preserve unchanged legend nodes. Three new assertions failed before the fix for unrelated raster updates, repeated terrain marker messages and replaced swatches. |
| O9 | Follow-up | Most of a row opened settings while its small checkbox alone toggled visibility. The menu's palette/type/control shapes also differed from BPB's shared panel language. | Make the name and checkbox one large native label target with a separate SVG settings chevron. Use the shared BPB palette, readable 13px type and 8px surfaces/controls with immediate feedback. The name-toggle regression failed before the change. |

The audit found no additional confirmed defect in the inspected provider
composition, bounded requests, narrow BC worker relay, one-use handoff or
hidden-renderer cancellation contracts. This is a scoped review, not a claim
that no other defect exists.

## Closure ledger

### Fixed and verified

- O9: hidden Chrome 156.0.8078.4 and Firefox 157.0 each passed eight component
  cases at 736/320 × 800, light/dark and normal/doubled text, plus the three
  neighboring native selector theme cases. Checks cover label clicks, Space,
  independent settings, disabled coverage, loading, failure, permission, retry,
  success, opacity feedback, zoom changes, focus and control/map/following-content
  geometry. Both themes and narrow/doubled-text renders were inspected. Palette
  and contrast tests pin overlay and neighboring native-picker colors to BPB's
  shared panel palette. Two enlarged-text shifts reproduced during implementation
  (the long waiting label and zoom guidance); concise messages removed them
  without increasing feedback reservations or clipping text.
  `npm test` passed 3,131 tests on the final source; scoped ESLint and
  `git diff --check` passed. The real unpacked Chrome startup/BFCache check
  passed hidden at 1000 × 760. Final native/3D integration also passed hidden
  at 1000 × 700 with Leaflet 1.9.4 and ANGLE/Metal on Apple M3 Pro; native and
  hardware 3D renders were inspected. Fixtures stub provider responses and do
  not establish live service latency or native OS popup appearance.
- O8: 44 focused map/control/session tests and scoped ESLint passed. Hidden
  Chrome 156.0.8078.4 passed immediate slider feedback, legend reuse, focus and
  stable row/map/following-content checks across all eight component cases.
  Real unpacked Chrome integration passed at 1000 × 700 using Leaflet 1.9.4
  and ANGLE/Metal on Apple M3 Pro, including native/3D alpha, recovery, regional
  cancellation, capture selection and Full Screen handoff. The change removes
  demonstrated redundant work; it does not establish a physical input-latency
  number or accelerate the upstream services.
- O7 follow-up: `npm test` passed 3,126 tests; scoped ESLint and `git diff
  --check` passed. The bundled theme checks light/dark updates, frame reload and
  replacement, top-level selector specificity and text/focus contrast. Hidden
  Chrome 156.0.8078.4 and Firefox 157.0 each passed three native selector cases
  at 1280/375 × 800 and desktop 200% CSS zoom, plus the existing eight control
  cases. Theme updates preserve keyboard focus, picker/surround/map/heading
  geometry and document scroll. Dark narrow and enlarged light/dark renders
  were inspected. The native inline border color is checked in real browsers;
  jsdom does not correctly resolve that inline shorthand against the sheet's
  important border-color. The real unpacked Chrome startup/BFCache check also
  passed hidden at 1000 × 760. This follow-up does not rerun the hardware 3D
  integration described below because it changes only the native 2D stylesheet.
- O1–O6 are implemented in the six commits above. Regression assertions ran
  against the unfixed code for O2–O6 and failed for the intended defects.
- A fresh build followed by the full Node test suite: 3,120 passed, zero failures.
  `npm run lint`: ESLint and web-ext
  passed, with the eight existing reviewed vendor/cross-browser warnings.
  Focused suites, scoped ESLint on the final edits and `git diff --check` also
  passed.
- Hidden Chrome for Testing 156.0.8078.4 and Firefox 157.0 each passed eight
  component cases at 736/320 × 800, light/dark and normal/doubled text. Checks
  cover idle/loading/error/retry/success, repeated Enter/Space, reduced motion,
  unavailable actions, retained focus, panel/row/map/following-content geometry,
  menu scroll, repeated zoom transitions and popup-membership focus.
- Narrow doubled-text dark and desktop light control renders were inspected.
  The real native popup, hardware 3D and zoomed-out hardware render were inspected.
- Real unpacked Chrome integration passed at 1000 × 700 with Leaflet 1.9.4 and
  ANGLE/Metal on Apple M3 Pro; software rendering was rejected. It exercises all
  four native map surfaces, actual MAIN/isolated/worker relay, 0/50/100% pixels,
  bounded transient recovery, pinned captures, partial coverage, BC permission
  setup/recovery, Canadian coverage, native-layer preservation, SNOTEL rendering,
  the real Leaflet popup membership transition, one-use Full Screen handoff and
  2D/3D ownership. Native and hardware 3D zoom limits now have browser assertions.
- The real-manifest Chrome startup/BFCache check passed hidden at 1000 × 760,
  with additional header/layout cases at 1600/800/390 widths and doubled text.
- Browser resource stacks completed teardown, including failed checks. Final
  process command lines and disposable-profile prefixes were inspected and
  absent; task-owned temporary screenshots/logs were removed.
- Two verifier defects surfaced during expansion: rapid animated navigation
  did not complete eight zoom steps, and an outgoing Latest imagery request could
  consume the selected older capture's injected failure. The checks now use the
  real reduced-motion navigation path, scope failure to that older pass and wait
  for Latest to settle. The corrected full integration run passed; the failures
  were not treated as random product errors or fixed with longer sleeps.

### Intentionally not changed

- O9 preserves the menu's persistent behavior, separate upper-right basemap,
  single selected detail, checkbox semantics, native light basemap styling and
  provider/privacy boundaries. The overview remains 232px wide; its height is
  intentionally 158px at normal text and 304px with doubled text so the larger
  label target and wrapping remain readable. No settings or decorative motion
  were added.
- O8 keeps opacity feedback synchronous, existing provider debounce/retry/rate
  limits, zero-opacity cancellation, validated terrain revisions and Full Screen
  state updates. Actual viewport changes still recompute coverage.
- O7 preserves native basemap behavior, light styling, control dimensions,
  border widths and map colors. It adds no theme setting or map-wide filter.
- Only the Overlays button collapses the menu. Existing persistent-menu behavior,
  separate basemap controls, overlay defaults, opacity storage, capture selection,
  provider limits, cooldowns and explicit consent remain intact.
- Station-list changes retain their existing marker replacement behavior. O5
  preserves popups across membership changes for the same station list; it does
  not promise popup persistence across a viewport's replacement result set.
- Privacy and authorization boundaries remain unchanged: no provider GPX or
  account data in handoffs, no NRCS viewport requests, no new permissions, and no
  widened settings or provider-URL relay.
- Unrelated changes to the archive index and CascadeClimbers research note were
  present before this task and excluded from all commits.

### Changed but not fully proven

- O8/O9 establish reduced redundant work and browser-rendered behavior, rather
  than a measured physical input-latency guarantee. Live provider speed, physical
  touch feel and native OS select-popup drawing remain outside these fixtures.
- O7's browser cases use the shipped theme bundle and faithful native selector
  markup with stubbed settings. They establish rendered control styling and DOM
  keyboard focus; native OS dropdown-popup appearance and browser/OS focus
  behavior remain unproven. Tab navigation may deliberately scroll a later
  native link into view; stability assertions cover theme updates while focused.
- Provider responses and permission decisions are synthetic in browser fixtures;
  live Peakbagger/provider DOM, current service availability/completeness and the
  browser's native optional-permission prompt were not exercised.
- Full Firefox native/3D integration, physical touch, screen-reader speech,
  native browser chrome and OS focus/window-placement behavior remain unproven.
  Hidden checks establish DOM focus and rendered layout, not those native effects.
- The startup races have deterministic bundled-bridge regressions and normal
  real-extension handoff coverage; a browser-level delayed sync-storage handoff
  scenario was not added.

No push, publication or release was performed.
