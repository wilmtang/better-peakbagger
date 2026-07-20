# Options page sidebar navigation — investigation and execution plan

Status: implemented 2026-07-19. See "Deviations from the plan" at the end.

Goal: give the extension's settings page (`options/options.html`) a left sidebar
that lists the settings sections, like Sidebery's setup page — clicking an entry
scrolls to that section, and the highlighted entry follows as the user scrolls.

Decisions already made (with the user):

- **Scroll-to-section**, not view switching: the page stays one continuous
  scrollable column; the sidebar is navigation within it.
- **Keep our visual language**: the sidebar is styled with the existing options
  CSS variables and light/dark themes. Only Sidebery's layout *pattern* is
  borrowed (fixed left column, indent levels, pill highlight on the active
  entry), not its flat dark aesthetic.
- The plan lives in this doc so a later session can execute it.

## How Sidebery does it

Reference checkout: `~/Dev/sidebery` (github.com/mbnuqw/sidebery). Sidebery is a
Vue 3 app; ours is a vanilla HTML/CSS/JS page, so the mechanism matters, not the
code.

**Layout** — `src/styles/page.setup/setup.styl`. `.root` is a full-viewport flex
row (`body { overflow: hidden }`). Inside it:

- `.nav` (lines 106–120): fixed-width, `flex-shrink: 0`, its own
  `overflow-y: auto`, slightly darker translucent background and an inset
  right border.
- The content view `.Settings` (`src/styles/page.setup/settings.styl:3-8`) is
  the scroll container (`overflow-y: auto`), with sections centered at
  `max-width: 640px` — the same content width our page already uses.

**Nav model** — `src/services/setup-page.fg.ts:71-109`. One flat array of
entries, each with a `lvl`: 0 = separate top-level view (Settings, Keybindings,
Snapshots…), 1 = section within the settings view, 2 = sub-section. The template
(`src/page.setup/setup.vue:6-12`) renders each as `.option` / `.sub-option` /
`.sub-sub-option` with `data-active` when it matches the active section.
Sub-levels get indentation, smaller font, and lower resting opacity
(`setup.styl:122-178`); the active entry gets a rounded pill drawn by a
`::before` at ~0.2 opacity plus full-opacity text.

**Click → hash → scroll** — clicking a nav entry just sets `location.hash`
(`setup.vue` `navigateTo`, lines 112–119). A `hashchange` listener runs
`updateActiveView` (`setup-page.fg.ts:206-296`), which:

1. immediately marks the target section active,
2. sets a `navLock` flag with a ~1250 ms timeout so the scroll-spy cannot fight
   the animation,
3. calls `scrollIntoView({ behavior: 'smooth', block: 'start' })` on the
   section's element (sections register themselves in an `els` map via
   `registerEl`).

**Scroll-spy** — a passive `scroll` listener on the content container
(`src/page.setup/components/settings.vue:62-66`) calls `updateActiveSection`
(`setup-page.fg.ts:310-328`): walk the nav list **bottom-up** and activate the
first entry whose element satisfies `scrollTop >= el.offsetTop - 8`. No
IntersectionObserver — a deterministic offset comparison.

Level-0 entries swap whole views instead of scrolling. Our page has a single
view, so that half of the machinery is irrelevant.

## Our options page today

- `options/options.html` — plain page: `.wrap` (max-width 640 px, centered)
  containing a header and four `.settings-section` blocks, each a small
  `.section-title` label plus a `.card` of rows. The **body** is the scroll
  container (`body { padding: 32px 20px }`).
- Sections (headings already carry ids via `aria-labelledby`): General
  (`#general-settings-heading`), Activity capture, Map & GPX chart, Ascent beta
  filters.
- `options/options.js` — populate/save controller over `src/settings.js`; no
  navigation code. `options/theme.js` applies the theme pre-paint.
- Build (`scripts/build-config.mjs:57-58,79-80`): `options.html` and
  `options.css` are copied verbatim; `options.js` is the entry of the already
  existing tail bundle. **Adding nav markup, styles, and a small controller
  needs no build-config or manifest change.**
- `manifest.json` has `options_ui.open_in_tab: true`, so the page always gets a
  full tab — a sidebar layout is viable.
- `test/options.test.mjs` drives the real page end-to-end in jsdom. jsdom has
  **no layout** (`offsetTop` is always 0 and nothing scrolls), which bounds what
  the scroll-spy tests can assert.

## Translation to this codebase

Same pattern, better-native building blocks:

- **Real anchors, not click-handler divs.** Nav entries are
  `<a href="#general">` links. That gives keyboard operability, focus states,
  and hash navigation for free (AGENTS.md UX bar: native browser feel), and the
  browser itself scrolls the target into view — even inside an inner scroll
  container.
- **App frame in CSS.** `html, body { height: 100% }`; body becomes a flex row
  of `<nav class="side-nav">` + `<main class="content">` where `.content` is
  the scroll container holding the existing `.wrap` unchanged. The header
  (logo + title) moves to the top of the sidebar, mirroring the screenshot.
- **Section targets.** Give each `.settings-section` a stable id (`#general`,
  `#capture`, `#map-chart`, `#beta`) and `scroll-margin-top` — the clean
  replacement for Sidebery's `- 8` offset fudge.
- **Smooth scrolling in CSS**, not JS: `scroll-behavior: smooth` on `.content`,
  reverted to `auto` under `@media (prefers-reduced-motion: reduce)`.
- **Active state = `aria-current="true"`** on the nav link, styled via
  `[aria-current]` — accessibility and styling from one attribute instead of a
  parallel `data-active`.
- **Scroll-spy stays JS but stays small** (~40 lines in `options.js`): passive
  `scroll` listener on `.content`, bottom-up `offsetTop` walk exactly like
  Sidebery's. Two additions Sidebery lacks or solves differently:
  - *Bottom clamp*: if `scrollTop + clientHeight >= scrollHeight - 2`, activate
    the last entry — otherwise a short final section can never win.
  - *Nav lock*: on nav click / `hashchange`, set the clicked entry active
    immediately and suppress the scroll-spy until the animation ends — release
    on the `scrollend` event (supported in current Firefox and Chrome) with a
    ~1250 ms timeout fallback, rather than Sidebery's timeout-only lock.
- **Styling with existing tokens.** Nav uses `--card`/`--border`/`--sub` for
  the resting state and an accent-tinted pill for the active entry (e.g.
  `color-mix(in srgb, var(--accent) 14%, transparent)`, with a solid fallback
  variable per theme if `color-mix` support is a concern — both target browsers
  ship it). Resting entries use `--sub`, hover and active use `--text`.
- **Responsive.** Below ~720 px the sidebar column becomes a horizontal,
  scrollable chip row above the content (keeps the feature on narrow windows
  without a hamburger). The existing 480 px row-stacking media query is
  untouched.
- **No sub-levels yet.** Four flat entries. The indent pattern
  (`.sub-option`-style) is documented here for when a section grows sub-anchors,
  but adding speculative levels now would fail the restraint bar.

## Execution steps

Each step is a commit-sized unit; run `npm test` before committing.

1. **Markup** — `options/options.html`: add the `.side-nav` (header block plus
   four anchor links) and wrap the existing content in `<main class="content">`.
   Add section ids. Keep every existing element id and `aria-labelledby`
   untouched so `options.js` and the tests keep working. `aria-label` the nav
   ("Settings sections").
2. **Styles** — `options/options.css`: app frame, sidebar column, nav-item and
   active-pill styles in both themes, `scroll-margin-top`, smooth scroll +
   reduced-motion override, ~720 px breakpoint. Verify no horizontal scroll at
   narrow widths.
3. **Controller** — `options/options.js`: scroll-spy + nav lock as specified
   above. Guard the whole feature on the nav's presence so the module stays
   inert if markup is absent. Initial state: honor `location.hash` if present,
   else first section.
4. **Tests** — extend `test/options.test.mjs`:
   - every nav link's `href` hash resolves to an existing section id (guards
     drift when sections are added or renamed);
   - exactly one link has `aria-current` after load, and `hashchange`
     (dispatchable in jsdom) moves it;
   - the scroll-spy tolerates jsdom's zero-layout world (no exceptions, no
     wrong state). The offset math itself is **not** provable in jsdom — that
     is what step 5 is for.
5. **Real-browser verification** (AGENTS.md rules): hidden Chrome for Testing
   (`channel: 'chromium'`, `headless: true`, `--load-extension` per
   `scripts/verify-extension.mjs`), open `options/options.html`, and check:
   click-to-scroll, highlight tracking while scrolling, bottom clamp on the
   last section, deep link (`#map-chart`) on load, light + dark, narrow
   viewport, and keyboard Tab order/focus rings. Screenshot the page, not the
   display. State renderer/viewport in the report. `npm run verify:extension`
   is not strictly required (no manifest/build-config change) but is cheap
   insurance.
6. **Docs** — flip this doc's status line to "implemented" and note any
   deviations.

## Risks and edge cases

- **Last section too short to reach the top** → handled by the bottom clamp.
- **Smooth scroll + scroll-spy fighting** → handled by the nav lock; without it
  the highlight sweeps through intermediate entries during the animation.
- **jsdom can't see layout** → scroll-spy correctness rests on step 5; keep the
  jsdom assertions to structure and hash-driven state.
- **`scrollend` support** → fine in current Firefox/Chrome; the timeout
  fallback covers older builds either way.
- **Hash-on-load jump** → native anchor jump happens before `options.js` runs;
  acceptable (no animation on first paint is correct anyway).

## Deviations from the plan

Recorded during implementation (steps executed against
`options/options.{html,css,js}` and `test/options.test.mjs`):

- **Scroll-spy uses `getBoundingClientRect`, not `offsetTop`.** The plan
  specified Sidebery's bottom-up `offsetTop` walk. An `offsetTop` comparison is
  only correct when each section's `offsetParent` is the scroll container, which
  would force a `position: relative` on `.content` and padding bookkeeping.
  Comparing viewport-relative section tops against a marker just below the
  content's top edge is equivalent, layout-correct without those assumptions,
  and still a deterministic top-down walk (sections are in document order). The
  `scroll-margin-top` anchor-landing offset is kept as planned.

- **Deep-link loads engage the nav lock.** The plan assumed a hash-on-load did
  an instant jump ("no animation on first paint"). In a real browser the
  content's `scroll-behavior: smooth` animates the *initial* fragment scroll, so
  the scroll-spy swept the highlight through the intervening sections. The
  controller now locks a deep-link target exactly like a click, holding the
  highlight until the animated scroll settles. Confirmed in hidden Chrome for
  Testing (see below).

- **Commit grouping.** Markup + styles + the structural test shipped as one
  commit (a styled static sidebar with native anchor scroll — markup without
  styles would have been a broken intermediate); the scroll-spy controller +
  behavioral tests as a second; the deep-link nav-lock fix as a third once
  real-browser verification surfaced it.

- **Real-browser verification (step 5).** Ran hidden Chrome for Testing
  (`channel: 'chromium'`, `headless: true`, real unpacked `dist/` via
  `--load-extension`) over `chrome-extension://…/options/options.html` at
  1000×760 and 700×760, screenshotting the page (not the display). Verified:
  click-to-scroll (target lands ~24px below the content top), scroll-spy
  tracking each section, the bottom clamp activating the last section,
  deep-link-on-load holding `#beta` through and after the animated scroll,
  light + dark, the narrow chip row with no horizontal overflow, and a visible
  keyboard focus ring reachable by Tab. No page errors; the options page also
  loaded and read/wrote settings cleanly in the real extension context, which
  is why the optional `npm run verify:extension` pass was not additionally run.
