# Settings hierarchy audit — October 25, 2026

Scope: the Settings page's heading hierarchy, General feature switches,
subsection spacing, and related narrow/zoomed layout defects. Reviewed with
the repository's UI/UX skill and the existing shared panel design language.

## Fixed and verified

- **Subsection headings were smaller than their content.**
  [Options CSS](../../options/options.css) styled every subsection heading as
  muted 13px text while the shared panel body was 14px. The new browser
  assertion failed on the rendered Units heading at exactly those sizes.
  Section headings now use 22px, subsection headings 17px with primary text
  color, and body/control text retains the shared 14px scale. Explicit heading
  line heights permit wrapping. The check covers every rendered subsection,
  its content labels, section headings, and pane/row overflow.
- **General mixed appearance and feature enablement.**
  [Settings markup](../../options/options.html) now keeps Theme in its own card
  directly under General. The six existing feature switches belong to a
  labelled Features subsection, followed by Units. Features has a matching
  sidebar entry and deep link; the existing subsection/sidebar order guard
  covers it. The grouping test failed before the change and passes afterward.
- **Spacing depended on a one-off Units rule.** Cards and following
  subsections now share a 24px separation; top-level sections use 32px.
  Heading-to-content spacing follows each heading tier.
- **Controls clipped at narrow widths and enlarged text.** The browser
  regression reproduced Theme, chart, route, viewport, beta-filter and Garmin
  label overflow at 390×1000 with 200% CSS zoom. Real Firefox additionally
  exposed clipping in the settings-file transfer row at its minimum window
  width. Card container queries now stack rows according to available space,
  smaller map-control grids keep their labels above the controls, beta signals
  can wrap, and Garmin labels can shrink below their previous 180px minimum.
  Controls keep their ordinary sizes when room is available.

Validation:

- Full shipped-bundle suite: **3,544 tests passed**. After the final responsive
  breakpoint adjustment, all **227 options/Garmin UI tests** passed. Focused
  ESLint and documentation-link checks passed.
- Rebuilt unpacked extension passed in hidden Chrome **156.0.8078.4** and
  Firefox **158.0.1**. Navigation, Features deep links, heading styles and frame
  containment were exercised in both themes at requested 1982×1000,
  1000×760, 1000×420 and 480×760 window sizes. Firefox privileged windows have
  a 500px minimum, so its narrow content viewport was 500×675; other Firefox
  content viewports were 1982×915, 1000×675 and 1000×347.
- All six switches were toggled both ways using native keyboard activation in
  each browser, with saved preferences and focus checked. Checkbox, row,
  Features panel/heading, following Units group and scroll geometry remained
  within 1px. Garmin on/off additionally ran through the existing full
  size/theme navigation matrix. Repeated full switch matrices had exhausted
  Chrome's native sync-write quota; a disposable diagnostic confirmed the
  exact quota error. The verifier now exercises each switch once per browser
  instead of repeating those writes at every viewport.
- All **16 Garmin fixture cases** passed in hidden Chrome 156/Firefox 157:
  both themes at 1180×1000 and 390×1000, with settings typography and overflow
  checks at 100% and 200% CSS zoom. Connection pending, rejection, retry,
  permission recovery and waiting/account-bound status retain their geometry.
  The fixture uses HTTPS on a real Peakbagger hostname and preserves real
  markup/styles; provider and session responses are synthetic.
- Desktop, narrow and enlarged screenshots of General, Features, Garmin,
  map labels and controls were visually inspected. These were DOM/CSS checks;
  no WebGL-renderer claim is made. Disposable browser profiles and processes
  were checked after teardown.

## Intentionally not changed

- The semantic outline remains one page/brand h1, section h2 headings and
  subsection h3 headings. The sidebar's compact brand and navigation styles
  remain separate from content headings.
- Compact descriptions/status metadata, native checkbox/select behavior,
  palettes, feature copy, defaults and privacy/Save boundaries are retained.
- Narrow navigation keeps the existing parent-chip layout; subsection deep
  links still work and activate their owning General/Capture parent.

## Changed but not fully proven

- Hidden protocol checks do not establish OS focus/window placement, native
  browser menus or permission prompts, physical touch use, or screen-reader
  announcements. No live provider session or remote write was exercised.
- Enlarged layout was checked with CSS zoom rather than native browser zoom
  or OS text-size settings. The static Garmin fixture leaves unrelated
  settings controllers idle; the unpacked-extension checks exercise real
  settings persistence and the new switch grouping.
