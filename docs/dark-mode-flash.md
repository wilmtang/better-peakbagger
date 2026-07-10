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
   `src/theme.js`.

If either lands after the first paint, the user sees a frame (or several) of
the native light site. Peakbagger pages are light HTML that paint almost
instantly — especially a refresh served from cache — so any lag shows.

There were two independent lags, fixed in turn:

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

## Fix

Do it the way Dark Reader does — never use the manifest `css` channel. Inject
the stylesheet from JavaScript at `document_start`, in the **same synchronous
tick** that sets the attribute, so the parser and renderer can't get ahead of
either one:

1. `src/site-dark-css.js` (a content script loaded before `theme.js`) exposes
   the dark rules as a string, `window.BPBDarkCSS`.
2. `src/theme.js`, at `document_start`, creates a `<style>` with that text and
   appends it to `document.documentElement`. `<html>` exists this early even
   though `<head>` does not yet; a `<style>` in `<html>` applies fine, and its
   `!important` author rules outrank the site's own sheets regardless of order.
3. In the same tick it reads the `bpbThemePref` mirror and sets
   `data-bpb-theme` synchronously. The sheet stays inert until the attribute is
   `"dark"`, so it also serves light mode and later live toggles with no
   re-injection.
4. **Reconcile (asynchronous):** the existing `chrome.storage` read and
   `subscribe` listener remain authoritative; when they resolve they re-apply
   the attribute and refresh the mirror.

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
it. `test/theme-inject.test.mjs` locks in the invariant.

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
- The mirror is one small extension-owned key in the site's `localStorage`;
  the extension already uses page `localStorage` for other per-visit state
  (see `CHANGELOG.md` 1.0.0), so this adds no new class of storage use.
