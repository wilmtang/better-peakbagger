# Dark mode: flash of the light page on load

## Symptom

With the theme set to dark, every page load briefly rendered Peakbagger's
native light palette before snapping to dark. Reported on Brave, where it
reproduced on every refresh; Chrome often masked it.

## Root cause

Showing dark mode with no flash requires **two** things to be live before the
browser's first paint:

1. **The stylesheet** — the dark rules, every one scoped under
   `html[data-bpb-theme="dark"]` (inert until that attribute exists).
2. **The attribute** — `data-bpb-theme="dark"` on `<html>`, set by
   `src/theme/theme.js`.

If either lands after the first paint, the user sees a frame (or several) of
the native light site. Peakbagger pages are light HTML that paint almost
instantly — especially a refresh served from cache — so any lag shows.

There were three independent lags, fixed in turn:

**Lag A — the attribute (async storage).** `theme.js` originally set the
attribute only after `chrome.storage.sync.get()` resolved, an async IPC
round-trip to the browser process. The renderer often painted first. Fixed by
mirroring the preference into the page's `localStorage` (key `bpbThemePref`),
which an isolated-world content script can read **synchronously** at
`document_start`, and setting the attribute from that before reconciling with
the authoritative stored value.

**Lag B — the stylesheet (declarative `css` channel).** Fixing Lag A wasn't
enough: the sheet was still injected via the manifest's `content_scripts.css`
array. That's a *separate* renderer subsystem from the content-script JS, and
it is **not guaranteed to be applied before first paint** — on Brave and on
cache-served loads it frequently lagged. So the attribute was set instantly but
the rules it triggers arrived a frame late: still a flash.

**Lag C — full-bundle startup.** The Lag B fix put both DOM writes in one
function, but that function still lived behind the complete theme bundle.
After the ES-module migration, Chromium had to parse the settings schema,
storage adapter, full site stylesheet, and theme controller before the first
dark DOM write. `document_start` controls when content-script execution is
scheduled; it does not make that parsing free. Brave could still show the
default white canvas on a cache-served page before the bundle reached
`ensureSheet()`.

The previous investigation described "inject the stylesheet and marker in the
same tick" as the complete Dark Reader technique. Source inspection showed the
important missing stage: Dark Reader registers a tiny `fallback.js` before its
full `index.js`. That fallback immediately paints a broad neutral-dark canvas;
the dynamic engine later replaces it with parsed, watched overrides. Better
Peakbagger now uses the same two-stage lifecycle, adapted to its explicit
`system` / `light` / `dark` preference.

## Fix

Use two JavaScript stages at `document_start`; the manifest `css` channel is
still unsuitable because it cannot keep the stylesheet and theme preference in
one ordered path:

1. `content/theme-early.js` is first in the manifest. It contains only
   `theme-resolve.js`, `theme-bootstrap.js`, and `theme-early.js` (about 2 KB in
   a development build): no settings schema, storage adapter, or dynamic color
   engine. It synchronously reads the `bpbThemePref` mirror, injects a broad
   neutral-dark fallback when needed, then sets `data-bpb-theme`.
2. `src/theme/site-dark-css.js` exports the complete reviewed site rules as a
   string, and `src/theme/theme.js` imports them into the second
   `content/theme.js` bundle.
3. `src/theme/theme.js` creates a `<style>` with that text and
   appends it to `document.documentElement`. `<html>` exists this early even
   though `<head>` does not yet; a `<style>` in `<html>` applies fine, and its
   `!important` author rules outrank the site's own sheets regardless of order.
4. Once the complete sheet and inline-color watcher are active, `theme.js`
   removes the broad fallback. That handoff order prevents a white frame
   between the two stages.
5. **Reconcile (asynchronous):** the existing `chrome.storage` read and
   `subscribe` listener remain authoritative; when they resolve they re-apply
   the attribute and refresh the mirror.

### Dynamic inline colors

Peakbagger also emits literal inline colors, including the black
`(Updated every 24 hours)` caption inside a dark table heading. Static
name-specific selectors fixed known `navy` and `maroon` spellings but left every
new or differently encoded color as another latent contrast bug.

`src/theme/dynamic-inline-colors.js` now handles inline `color`,
`background-color`, legacy `color`, and legacy `bgcolor` declarations:

1. Parse the declared color through the browser (with direct legacy/hex/RGB
   parsing for the common path).
2. Remap foreground and background lightness into the dark palette while
   retaining semantic hue; opaque text is raised to at least WCAG AA contrast
   against the dark table surface.
3. Store the mapped value in an extension-owned custom property and activate it
   through a data attribute. The source declaration is never rewritten, so
   light mode remains native.
4. Watch inserted nodes and relevant attribute changes with a
   `MutationObserver`.

This is deliberately narrower than Dark Reader's general-purpose engine: it
does not rewrite arbitrary stylesheet rules, gradients, images, SVG, or shadow
trees. The reviewed site sheet still owns Peakbagger's static CSS. The light
photographic header is a site-specific exception, and extension-owned controls
keep their component themes.

### Keeping the sheet and the attribute in lockstep

The attribute and the stylesheet are two separate DOM writes, and only the pair
renders dark. If the attribute is ever set *without* the sheet, the page stays
light while anything that themes itself independently — notably the GPX chart,
which colors its own elements via JS `element.style` (CSSOM, never gated on our
sheet) — goes dark: a confusing "dark chart on a light page." (Reloading an
unpacked dev build while Peakbagger tabs are open can leave a page in exactly
this half-applied state until it's reloaded.)

To make that state unreachable, sheet injection is **idempotent** (`ensureSheet()`,
guarded by the `bpb-site-dark` id) and tied to **every** `apply()` — not just the
one `document_start` pass. So the authoritative `chrome.storage` read and every
live toggle re-assert the sheet before setting the attribute; if the initial
injection was ever skipped or the node was removed, the next `apply()` restores
it. `test/theme/theme-inject.test.mjs` locks in the invariant.

The mirror stores the *preference* (`system` / `light` / `dark`), not the
resolved color, so a `system` user whose OS theme changed between visits still
resolves correctly via `matchMedia` (synchronous, available at
`document_start`). All `localStorage` access is wrapped in `try`/`catch` since
site storage can be blocked by privacy settings; the extension then degrades to
the old async-only behavior.

Keeping the CSS as a JS string (rather than a `.css` file) is what lets
`theme.js` inject it synchronously — there's no synchronous way to read an
extension file's text from a content script, and a `<link>` to it would load
asynchronously and reintroduce the flash.

## Remaining edge cases (accepted)

- **Very first visit** by a user whose explicit setting contradicts their OS
  theme: one flash, once, until the mirror is written.
- **Setting changed from another device/tab** without visiting Peakbagger: the
  next load briefly shows the stale mirrored theme before the sync'd setting
  reconciles.
- **Blocked page-local storage:** without the synchronous mirror, an explicit
  theme that differs from the OS still waits for `storage.sync`. The fallback
  can only safely follow what is known synchronously.
- The mirror is one small extension-owned key in the site's `localStorage`;
  the extension already uses page `localStorage` for other per-visit state
  (see `CHANGELOG.md` 1.0.0), so this adds no new class of storage use.
