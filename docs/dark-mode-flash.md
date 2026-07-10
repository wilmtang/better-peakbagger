# Dark mode: flash of the light page on load

## Symptom

With the theme set to dark, every page load briefly rendered Peakbagger's
native light palette before snapping to dark. Reported on Brave, where it
reproduced on every refresh; Chrome often masked it.

## Root cause

Dark mode is applied in two parts:

1. `src/site-dark.css` is injected via the manifest at `document_start`, but
   every rule is scoped under `html[data-bpb-theme="dark"]` — the sheet is
   inert until that attribute exists.
2. `src/theme.js` also runs at `document_start`, but it only set the attribute
   after reading the theme preference from `chrome.storage.sync.get()`, which
   is asynchronous (an IPC round-trip to the browser process).

That makes the first paint a race: if the renderer paints the page before the
storage promise resolves, the user sees one or more frames of the native light
site, then dark mode lands. Peakbagger pages are light HTML that paint almost
instantly — especially on a refresh served from cache — so the race is easy to
lose. Which browser "wins" is just timing: Brave backs `storage.sync` locally
(it has no Google account sync) and consistently lost the race; the bug was
always present in Chrome too, just usually hidden.

The original code assumed this was unavoidable ("unavoidable without
synchronous storage"). It isn't: `chrome.storage` is the only *extension*
storage that holds the setting, but a content script at `document_start` does
have synchronous storage available — the page origin's `localStorage`, which
isolated-world content scripts share with the site.

## Fix

`src/theme.js` now mirrors the theme preference into the page's
`localStorage` (key `bpbThemePref`) and uses it to set the attribute
synchronously, before first paint:

1. **Pre-paint (synchronous):** read `bpbThemePref` from `localStorage` and
   set `data-bpb-theme` immediately. The mirror stores the *preference*
   (`system` / `light` / `dark`), not the resolved color, so a `system` user
   whose OS theme changed between visits still resolves correctly via
   `matchMedia` (which is synchronous and available at `document_start`).
2. **First visit (no mirror):** `resolveTheme(null)` falls back to the OS
   preference — correct for everyone whose setting matches their system.
3. **Reconcile (asynchronous):** the existing `chrome.storage` read and
   `subscribe` listener remain authoritative; when they resolve they re-apply
   the theme and refresh the mirror.

All `localStorage` access is wrapped in `try`/`catch` since site storage can
be blocked (e.g. by browser privacy settings); the extension then degrades to
the old async-only behavior.

## Remaining edge cases (accepted)

- **Very first visit** by a user whose explicit setting contradicts their OS
  theme: one flash, once, until the mirror is written.
- **Setting changed from another device/tab** without visiting Peakbagger: the
  next load briefly shows the stale mirrored theme before the sync'd setting
  reconciles.
- The mirror is one small extension-owned key in the site's `localStorage`;
  the extension already uses page `localStorage` for other per-visit state
  (see `CHANGELOG.md` 1.0.0), so this adds no new class of storage use.
