# Custom layer Options and backup audit

The original custom-layer implementation linked Options to a standalone editor
and deliberately excluded definitions from every backup. This follow-up makes
the library a first-class Options section and supersedes that exclusion in the
[original implementation ledger](custom-map-overlays-2026-10-25.md). The maintained
contract is [settings storage, export and sync](../settings-storage-and-sync.md).

## Findings

- The Options link offered no shared list, opacity control or removal workflow
  within Settings. The new subsection and sidebar entry use existing panel
  components; Add/Edit reuses the packaged editor inside a native modal.
- Settings transfer selected only portable preferences. Source definitions and
  opacity were absent from files, GitHub content signatures and backup alarms,
  so a successful settings backup could not recover a user's custom layers.
- Restore needed a serialized registry transaction and fresh local revisions.
  Reusing imported revisions could leave stale editors or enabled maps pointing
  at a different provider. A library generation now clears open-map selections.
- An unreadable registry must block export/backup, rather than look like an
  intentional empty library. An older settings file must preserve the destination
  library; a version 6 file can explicitly replace it with an empty library.

## Fixed and verified

- Central **Map & GPX chart → Custom layers** library with shared Add/Edit,
  opacity, confirmed removal, responsive layout and accessible controls. The
  source editor also reads metadata from Options without pretending to test
  coverage at a map location.
- Settings schema v6 includes a validated `customLayers` envelope. Manual
  exports/imports and GitHub backup/restore use the same source schema and local
  store. Content signatures, remote overwrite review and automatic-backup
  triggers account for source-only and opacity-only changes.
- Restore serializes source/opacity replacement, rebases revisions, drops
  previews and clears selections on open maps. Conditional rollback protects
  newer edits when a later credential write fails. Ambiguous persistence failures
  remain explicit; they never report a successful clean rollback.
- Deterministic regressions cover round trips, legacy preservation, invalid
  sources, corrupt export reads, source/opacity concurrency, stale editor
  revisions, rollback, automatic alarms and remote overwrite review.
- Full suite: 3,562 tests passed; 79 focused tests then covered the final corrupt
  export regression and Options copy. Lint passed with eight owned warnings.
  Hidden real-extension Chrome/Firefox startup checks and the custom-layer
  manager matrix passed. The
  browser fixtures exercise actual worker storage, packaged editor frames,
  source management, real file import and map rendering. Chrome checks held
  removal geometry; both browser managers were visually inspected in dark mode.
  Chrome 156.0.8078.4 used 1000×760 and 375×800 viewports; Firefox 158.0.1 used
  1000×760 maps, its narrow Options window and a 375px map editor. 3D used hardware
  ANGLE/Metal on Apple M3 Pro; no software renderer or visible window was used.

## Intentionally not changed

- Definitions remain in local storage and do not enter browser sync. A valid
  library can exceed the sync item quota; file/GitHub transfer handles recovery.
- Direct requests, public-source-only URLs and existing GitHub transfer opt-ins
  stay in place. New/restored sources never enable themselves or fetch tiles.
- Backups include source URLs and their public URL keys. Stored account
  credentials still require the existing manual-file opt-in and never enter
  GitHub settings backup. This distinction is visible in Options and privacy docs.
- Tile bytes, parsed features, selections, previews, credentials and probe
  locations are not custom-layer backup contents. No unrelated working changes
  or dependency changes belong to this fix.

## Changed but not fully proven

- Local fixtures do not establish live GitHub writes, cross-device browser sync,
  native file chooser behavior, screen-reader output or physical window/focus
  behavior. No real account or remote repository was modified.
- Import spans portable settings, local layers and optional credential stores;
  it uses compare-and-swap and rollback rather than claiming one cross-store
  atomic write. Abrupt worker/process termination can still interrupt that larger
  transaction; the source registry and its opacity are one local atomic write.
- New manager checks have no historical pre-feature UI comparison. Model
  regressions and rendered transitions are the recorded evidence.

### Embedded-editor visual cleanup

Visual inspection found that the embedded Options editor repeated the standalone
library above its form. The editor now shows that chooser only when opened as a
standalone page. The new Chrome assertion failed against the unfixed bundle with
four duplicate chooser buttons (`4 !== 0`) before the one-condition fix; both
browser matrices then verify the form-only modal. The Options list remains the
single management view. This is separate from the scroll-boundary fix below.

## Scroll-boundary follow-up

The shared panel stylesheet painted only `body`; Options fixes that body inside
the viewport while its content/sidebar scroll. The source editor also left its
root transparent. Their default boundary policy allowed vertical elastic
scrolling and chaining, exposing an unthemed canvas in dark mode.

### Fixed and verified

- Shared panels and the custom-source editor now paint the root with their own
  theme token. Options content/navigation scroll containers and editor roots use
  `overscroll-behavior-y: none`; dark site roots apply it in both early and full
  theme stages. No event listener intercepts wheel or keyboard input.
- Hidden Chrome/Firefox checks assert computed canvas/boundary policy, exercise
  top → normal in-range scrolling → bottom wheel paths and verify the outer frame
  does not scroll. The existing manager and rendering checks run alongside them.
- Chrome can load the actual prior panel stylesheet from a disposable file via
  `BPB_PREVIOUS_PANEL_CSS`, reproducing its transparent root and automatic
  boundary policy before restoring the fixed stylesheet. This establishes the
  CSS regression; it does not simulate a physical macOS rubber-band gesture.
- Final follow-up checks: 3,565 full-suite tests passed; lint passed with eight
  owned warnings. Chrome and Firefox custom-overlay/Options matrices passed,
  including the previous-canvas proof and vertical wheel boundaries. Owned
  browser processes and custom test profiles were absent after teardown.

### Intentionally not changed

- Horizontal gestures, browser history behavior and map interaction are not
  globally intercepted. The site rule is dark-theme scoped; shared extension
  panels use the same vertical boundary policy in both themes.
- Body/content layout, theme tokens and focus/navigation ownership are retained.

### Changed but not fully proven

- Headless protocol wheel input and screenshots cannot establish native macOS
  trackpad momentum/rubber-band animation, browser chrome or focus placement.
  The CSS policy and opaque canvas are verified; native gesture proof remains
  separate from these hidden checks.
