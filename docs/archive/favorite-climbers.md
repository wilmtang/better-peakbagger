# Favorite climbers

> **Status:** Implemented on `codex/favorite-climbers` on 2026-07-21. This is the
> completed execution record; maintained behavior lives in
> [`docs/architecture.md`](../architecture.md),
> [`docs/github-ascent-backup.md`](../github-ascent-backup.md), and
> [`PRIVACY.md`](../../PRIVACY.md).
>
> A later follow-up added live totals, fuzzy search, automatic cache refresh
> after native Buddy actions, automatic custom-list additions, and an opt-in
> removal policy. Those additions are intentionally documented only in the
> maintained guides above; the implementation plan below remains historical.

## Why

Peakbagger's Buddy List (`report/report.aspx?r=b&cid=<your id>`) is a dead end:
the only thing you can do with it is open that one page and eyeball your
buddies' latest climbs. This feature turns buddies into **favorite climbers**
you can actually use — most importantly, filtering any peak's ascent list down
to "people I care about" — and lets you outgrow the Buddy List's 100-climber
cap with a curated list of your own.

## The user experience

Vocabulary used below: the **Beta filter bar** is the row of toggle buttons the
extension already adds above a peak's ascent table (`Has beta`, `Trip report`,
`GPS track`, `Link`). This plan adds one more button, **Favorites**, to that
bar. (The code calls these buttons "chips".)

**Filtering a peak's ascents — works on day one, no setup.**
You're on Mount Rainier's ascent list deciding whether a route is in shape. You
click **Favorites** in the Beta filter bar. The first time, the extension
quietly loads your Buddy List page in the background using your normal
logged-in session, remembers it for 7 days, and the table collapses to just
ascents logged by your buddies. The button shows how many rows qualify, like
the other filter buttons, and combines with them — turning on **Favorites** and
**Trip report** together means "trip reports written by people I follow". The
choice sticks across ascent pages, exactly like the existing buttons.

**Staying fresh without thinking about it.**
A week later the saved list is stale. The filter still answers instantly from
the old list while a fresh copy is fetched behind the scenes — you never wait
on it. The extension settings page shows "100 buddies · updated 5 days ago"
with a **Refresh now** button when you want the update immediately. And any
time you visit your actual Buddy List page, the extension refreshes its copy
from what's already on screen — zero extra requests.

**Outgrowing the Buddy List.**
Later you hit the 100-buddy cap, or you want your favorites to differ from your
buddies. In extension settings → **Favorite climbers** you switch the source
from *"Use my Peakbagger Buddy List"* to *"Use a custom list"*. To seed it, one
button **merges** all current buddies into the custom list; another **mirrors**
the Buddy List (replaces the custom list entirely — the button says so plainly,
and after it acts you get a 6-second **Undo**, the same pattern as the trip
report drafts manager; no scary confirmation popups). You add individuals by
pasting a climber page link or typing their id — the extension looks up their
name from the public climber page. The list shows each climber's name (linked),
id, and date added; you can sort by name or newest-first, and remove anyone
with Undo.

**Adding people where you meet them.**
When you're in custom-list mode, every climber's page grows a small
"☆ Add to favorites" button next to their name, which flips to
"★ In your favorites — remove". In Buddy List mode that button stays hidden —
buddies are managed on Peakbagger itself, and the extension never silently
switches your mode.

**Keeping the list safe (and moving it to a new machine).**
If you've connected GitHub trip backup, the Favorite climbers settings section
also offers **Back up favorites** — writes a `favorite-climbers.json` into the same
backup repository — and **Restore from backup**, which replaces your local list
(again with Undo). Backup is always an explicit click; automatic ascent backup
never touches it. On a fresh browser: connect GitHub, hit Restore, done.

**When things aren't right, the button says so.**
Signed out with nothing saved yet → the Favorites button is disabled with
"Sign in to Peakbagger to load your Buddy List." (If a saved copy exists it
keeps working from that copy.) Buddy List unreachable → "Your Buddy List
couldn't be loaded. Open peakbagger.com and try again." Custom mode with an
empty list → "No favorite climbers yet. Add them from a climber's page or in
the extension settings."

Out of scope this round: the Favorites button on the compact ascent view (it
keeps its existing "no beta data" notice), and filtering your own
`ClimbListC.aspx` list (those rows have no climber column — every row is you).

## Decisions already made

- **Scope: everything above ships in this round** (filter + cache, source
  modes, settings manager, climber-page button, GitHub backup/restore).
- **Storage: `storage.local` is the source of truth.** Matches the repo's
  "gate/mode in sync, data in local" discipline (drafts, GitHub auth). A
  100-buddy merge with names would sit right at `storage.sync`'s 8 KB per-item
  cap and could fail mid-merge; sync also wouldn't bridge Firefox↔Chrome.
  Cross-device: in Buddy List mode Peakbagger itself is the sync; custom lists
  travel via the GitHub backup.

## Data model

Synced setting (inside the existing `bpbSettings` item, `src/settings/settings-schema.js`):

- `favoritesSource: 'buddies' | 'custom'`, default `'buddies'`, cleaned like
  `chartDefaultSeries`. No on/off gate — the Favorites button is part of the
  always-on Beta filter bar like every other button there.

`storage.local` (keys owned by the new pure module `src/favorites/favorite-climbers.js`):

- `bpbFavoriteClimbers` → `{ schemaVersion: 1, entries: [{ cid, name, addedAt,
  source: 'buddy'|'manual' }] }` — deduped by cid, names trimmed ≤ 200 chars,
  capped ~500 entries.
- `bpbBuddyCache` → `{ ownerCid, entries: [{ cid, name }], fetchedAt }` —
  `BUDDY_TTL_MS = 7 days`. A cache whose `ownerCid` differs from the currently
  detected login is treated as absent (account switch invalidates it).

GitHub backup file: `favorite-climbers.json` at the backup-repo root:
`{ schemaVersion: 1, exportedAt, entries }`. Safe by construction:
`inspectRootTree` (`src/github/github-client.js:157-194`) considers only the marker
blob and `type === 'tree'` folders, so ascent commits neither prune nor trip
over a root file (verified against current source).

## Implementation

### New `src/favorites/favorite-climbers.js` — pure module (pattern: `src/reports/report-drafts.js`)

No DOM or extension APIs; Documents are passed in, so the content script,
options page, and tests all share one implementation. Exports
`favoriteClimbers`: storage keys and TTL constants; `cleanFavorites`,
`cleanBuddyCache`, `isFresh`, `validEntry`; `buddyListUrl(ownCid, origin)`;
`parseBuddyDocument(doc)` (rows of `#RGridView`, cell-0
`climber.aspx?cid` anchor → `{cid, name}` — grounded by
`test/fixtures/pages/report-buddy-list.html`); `parseClimberInput(text)` (bare
digits or a pasted climber-page URL → cid); `climberPageUrl(cid)`;
`climberNameFromDocument(doc)` (`#TitleLabel h1`, strip the "…Page for "
prefix — grounded by `test/fixtures/pages/climber-home.html:175`);
`mergeBuddies` (additive) and `mirrorBuddies` (replace);
`favoriteSet(mode, favorites, buddyCache)` → the effective cid set for the
filter; comparators `byName` (Intl.Collator) and `byAddedAtDesc`.

### Modified `src/profile/profile-backup-core.js`

Add named exports for `numericParam` and `ownerClimberId` (currently
module-internal; `classifyResponse` already sets the named-export precedent).
Extend `classifyResponse` with two kinds so login/Cloudflare pages keep getting
rejected by the one shared classifier: `'buddies'` (ok ⇢ body has `RGridView`
and `Buddy List`) and `'climber'` (ok ⇢ `<h1>` and `ClimbListC.aspx?cid=`).

### Modified `src/ascent/ascent-filter.js` — the Favorites filter button

- Row records (init loop ~493-519): parse `record.climberId` from the row's
  `climber.aspx` anchor via `numericParam`; rows without one never match.
- `DEFAULT_STATE` gains `fav: false` (old saved state migrates for free via the
  existing spread-merge); `render()` adds
  `if (state.fav && !record.fav) visible = false;` — AND-composed like every
  other button; "Show all" clears it too.
- Button built with the existing `makeChip('fav', 'Favorites', …)`; a
  `refreshFavorites()` sibling of `refreshBeta()` recomputes membership, count,
  and tooltip when the set changes.
- Start a `favoritesPromise` (one `storage.local` read of both keys) at module
  load beside the existing `settingsPromise`, so the bar usually mounts with
  the set already resolved.
- Buddy-mode refresh, filter path (content script, same-origin, credentialed):
  only when the button is active (persisted on, or clicked), the cache is
  stale/absent, and `ownerClimberId(document)` resolves → fetch
  `buddyListUrl`, classify `kind:'buddies'`, `DOMParser`, `parseBuddyDocument`,
  write `bpbBuddyCache`. A stale cache filters immediately
  (stale-while-revalidate); a failed refresh keeps the stale copy.
- Opportunistic zero-network refresh: on the Buddy List page itself (already
  this script's surface, sort-only today), when the page cid equals the
  logged-in cid, parse the rendered DOM and rewrite the cache.
- Live updates: `storage.onChanged` (local, both keys) plus the existing
  `S.subscribe` (for `favoritesSource`) → refresh the set and re-render.

### New `src/favorites/climber-favorite.js` — content script on `climber.aspx`

Renders only in custom mode, and only when the page cid ≠ own cid (no
favoriting yourself). Injects a small style block (same pattern as
`ascent-filter.js`'s `injectStyle`) and appends the pill button after the
`#TitleLabel` h1; clicking toggles the entry in `bpbFavoriteClimbers`
(`source:'manual'`, name from `climberNameFromDocument`). Stays in sync via
`storage.onChanged`. Renders nothing in buddies mode (no implicit mode
switching; Peakbagger's own buddy controls are the management surface there).

### New `options/favorites.js` (+ `options.html` / `options.css` / `options.js` wiring)

Pattern: `options/drafts.js` (imperative `createElement`, soft-delete with 6 s
Undo, 20 ms-debounced `storage.onChanged` refresh, `#status` flash), exposed as
`initFavorites({extensionApi, flash, save})` and called from `options.js` like
`initGithubBackup`. New `<section id="favorites">` between `#beta` and
`#drafts` plus a nav item (the scroll-spy nav auto-discovers it). Owns:

- Source radios → `save({favoritesSource})`.
- Buddy panel: "N buddies · updated X ago" + **Refresh now**. The options page
  fetches and parses itself — extension pages get cross-origin fetch with
  cookies from the existing peakbagger host permissions, and have `DOMParser`
  (the MV3 worker does not) — so no new worker plumbing. It requests the
  signed-in `report/report.aspx?r=b` page without a cid and derives the owner cid
  from that same response. States:
  "Refreshing…", "Never loaded", challenged/signed-out → sign-in link (reuse
  the `options/github.js` pattern).
- Custom panel: add-by-id/URL input (fetch the public `climber.aspx?cid=N`,
  classify `'climber'`, resolve the name; errors: "No climber page found for
  ID 123456." / "Couldn't reach Peakbagger. Try again."); rows with name link,
  `#cid`, "Added <date>", Buddy/Manual tag, Delete + Undo; sort toggle
  "Newest first / Name"; **Merge buddies into favorites** (additive, refreshes
  a stale cache first; flash "Added 5 buddies" / "Your favorites already
  include all buddies"); **Mirror buddy list** with a permanent description
  line "Replaces your custom list with your current Peakbagger buddies." and
  the drafts-style bulk-Undo bar after acting. Merge/mirror enabled only in
  custom mode.
- GitHub row (visible when `enableGithubBackup` and connected; otherwise a
  hint pointing at the GitHub section): **Back up favorites** and **Restore
  from backup** (restore = replace with Undo snapshot; "No favorites backup
  found in <repo>." when absent).

### Modified `src/github/github-client.js`

Two additions on the client object, both via the **atomic Git Data path** (not
a Contents-API PUT), sharing a factored `withConflictRetry(fn)` with
`pushAscentBackups` (`CONFLICT_RETRY_DELAYS`):

- `readRootFile(path)` — `GET /contents/<path>?ref=<branch>`, 404 → `null`,
  validate file/base64, decode with `atob` + `TextDecoder` (both exist in the
  MV3 worker).
- `putRootFile(path, content, commitMessage)` — `resolveRepo` →
  `readHead`/`initializeEmptyRepository` → `inspectRootTree` (fail closed on a
  foreign marker, or if the path exists as a tree) → single-blob tree with
  `base_tree` (+ marker when absent) → commit → **non-forced** ref PATCH. The
  non-forced PATCH is a compare-and-swap on the branch head: a concurrent
  ascent commit conflicts cleanly and the bounded retry rebuilds on the new
  head. Reuses marker validation, empty-repo bootstrap, and the `classify()`
  error taxonomy for free — all things a Contents-API path would duplicate.

### Modified `src/background/background.js` — two worker messages

Both added to the `extensionOnly` guard (`background.js:1623`) and both reuse
the `backupAscent` guard sequence (settings gate → `authStore` → token/repo):

- `GITHUB_FAVORITES_BACKUP { content }` — the options page validates via
  `cleanFavorites` and serializes `favorite-climbers.json`; the worker wraps
  `client.putRootFile('favorite-climbers.json', …)` in the existing GitHub write queue
  so it can never race an ascent commit. Returns `{ok, result}` /
  `{ok:false, error}` mapped through `src/github/github-error.js` on the page.
- `GITHUB_FAVORITES_RESTORE {}` — worker returns `{ok, content|null}`; the
  options page parses/validates (fail closed on unknown `schemaVersion`),
  snapshots the current list, writes, and shows the Undo bar. Keeps
  `favorite-climbers.js` out of the worker bundle entirely.

### Build and manifest

- `scripts/build-config.mjs`: `content/ascent-filter.js` sources gain
  `favorite-climbers.js`; new entry `content/climber-favorite.js` =
  `[settings-schema, settings, favorite-climbers, climber-favorite]`; options
  bundle gains `favorite-climbers.js` + `options-favorites.js`. Background
  bundle unchanged.
- `manifest.json`: one new `content_scripts` block for
  `climber/climber.aspx*` (four host/case variants per existing convention),
  `run_at: document_end`.

## Tests (all fixture data synthetic — `fixtures-privacy` guard; 900001-style ids)

- New `test/favorites/favorite-climbers.test.mjs`: clean/TTL/validation,
  `parseBuddyDocument` against `report-buddy-list.html`,
  `climberNameFromDocument` against `climber-home.html`, input parsing,
  merge/mirror semantics, `favoriteSet` per mode, comparators.
- `test/profile/profile-backup-core.test.mjs`: the two new classifier kinds
  (ok / wrong-content / challenged).
- `test/settings/settings-schema.test.mjs`: `favoritesSource` cleaning.
- `test/ascent/ascent-filter.test.mjs`: extend the `loadPage` helper to seed
  `storage.local` (as `options.test.mjs` already does); button render + count;
  custom-mode filtering with cids read from the fixture's first-column links;
  AND-composition with "Has beta"; disabled-empty state; buddies mode reads
  `bpbBuddyCache`; stale cache triggers one revalidation fetch (stubbed
  `window.fetch`, assert the `report.aspx?r=b` URL and the cache write);
  persisted button state; Buddy List page rewrites the cache from its DOM.
- New `test/favorites/climber-favorite.test.mjs` + new synthetic fixture
  `test/fixtures/pages/climber-other.html` (page cid 900002, logged-in nav cid
  900001): toggle add/remove in custom mode; nothing in buddies mode; nothing
  on your own page.
- `test/options/options.test.mjs`: source radio persists; add-by-id resolves a name
  from stubbed fetch; remove + Undo; merge/mirror + Undo against a seeded
  cache; Refresh now writes the cache; backup/restore exchange
  `GITHUB_FAVORITES_*` via a stubbed `runtime.sendMessage`, restore replace +
  Undo.
- `test/github/github-client.test.mjs`: `putRootFile` tree includes `base_tree` +
  single entry (+ marker when absent), non-forced ref PATCH, conflict retry
  rebuilds on the re-read head, foreign marker → `REPO_CONFLICT`, empty-repo
  bootstrap; `readRootFile` decode and 404 → null.

## Docs

- `docs/architecture.md`: extend the ascent-filter deep-dive; add a Favorite
  climbers deep-dive (keys, modes, which surface fetches/parses where);
  surface-ownership table gains `climber-favorite.js`.
- `PRIVACY.md`: the buddy cache holds third-party climber names/ids locally
  for ≤ 7 days, refreshed only through your own signed-in session; the
  favorites list is device-local; `favorite-climbers.json` leaves the browser only on
  the explicit Back up / Restore clicks; automatic ascent backup never
  includes it.
- `docs/github-ascent-backup.md`: root `favorite-climbers.json` in the repository
  layout section.
- `README.md` feature blurb; `CHANGELOG.md` entry.

## Commit sequence (each an independent conventional commit; checks before each)

1. `feat: pure favorite-climbers module and shared classifier kinds` —
   `src/favorites/favorite-climbers.js`, `profile-backup-core` exports/kinds, their
   tests. Verify: targeted `node --test`, then `npm test`.
2. `feat: favoritesSource setting` — schema + test. Verify: `npm test`.
3. `feat: favorites filter on peak ascent lists` — `ascent-filter.js`,
   build-config, test-helper `local` support, filter tests. Verify:
   `npm test`, `npm run verify:extension`.
4. `feat: favorite climbers manager in settings` — options surface + tests.
   Verify: `npm test`, `npm run verify:extension`, visual pass (light + dark,
   narrow/wide) per the UX bar.
5. `feat: climber page favorite toggle` — new content script, manifest,
   build-config, fixture + test. Verify: `npm test` (includes
   fixtures-privacy), `npm run verify:extension` (manifest changed).
6. `feat: github favorites backup and restore` — `putRootFile`/`readRootFile`
   + retry factoring, worker messages, options GitHub row, tests. Verify:
   `node --test` targeted, `npm test`, `npm run verify:extension` (worker
   touched).
7. `docs: favorite climbers` — all doc updates; move this plan to
   `docs/archive/`. Verify: `npm test`.

Real-browser verification per AGENTS.md: hidden Chrome for Testing profile via
the `scripts/verify-extension.mjs` patterns, fixtures first, any live
Peakbagger check minimal and read-only.

## Risks and notes

- Buddy-page markup drift: the parser keys on the stable cell-0
  `climber.aspx?cid` anchor; an unparseable page fails soft (keeps the old
  cache).
- A Cloudflare challenge on an options-page fetch classifies as
  `'challenged'` → actionable copy, never auto-retried.
- Name formats differ by source ("Surname, First" on the Buddy List,
  "First Last" on climber pages) — cosmetic only; dedupe is by cid.
- GitHub favorites backup is manual-only; `autoGithubBackup` does not include
  it.
