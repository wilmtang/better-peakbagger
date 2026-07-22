# Codebase audit — 2026-07-22

Scope: full read of the background worker, popup, all options-page modules
(main, github, favorites, drafts, settings-backup, theme), the GitHub error
modules, ascent-backup and ascent-upload surfaces, build config, and manifest;
targeted review of the analyzer/terrain/filter/report surfaces and user-facing
copy across `options.html`, `popup.html`, and content-script strings.
Baseline: clean tree at `5a32aed`; `npm test` passes (671/671); `npm run
lint:js` is clean.

Relationship to [codebase-audit-2026-07-19](../archive/codebase-audit-2026-07-19.md):
that audit was fully executed (all B/E/U items landed or were deliberately
closed). This audit does not re-litigate its closed decisions — popup/status
polling stays as-is per its E2 rationale. The findings below are almost
entirely in code that landed after it: favorite climbers and buddy sync, the
settings/favorites GitHub backups, the options sidebar, and the growth those
features caused in `background.js` and the options modules.

Overall assessment: still a healthy codebase — pure-module boundaries hold,
privacy gates fail closed, comments carry real invariants, and the new
features shipped with tests. The dominant engineering issue is **accumulated
duplication**: the same helpers, gates, and constants now exist in two to five
places, which is exactly how the settings-schema class of drift starts. The
dominant UX issue is that the newest surfaces don't always match the
extension's own established patterns (theme, permission gating, retry
affordances) or its copy voice.

---

## 1. Bugs and behavior contradictions

### B1 — The popup ignores the extension's own Theme setting
**Severity: medium (the setting's description promises otherwise) ·
[popup.css:149](../../popup/popup.css), [popup/popup.html](../../popup/popup.html)**

The Theme setting says "Dark or light mode for Peakbagger pages **and this
extension's panels**" ([options.html:60](../../options/options.html)). The
options page honors it (`options-head.js` sets `data-bpb-theme` pre-paint; CSS
overrides follow), and content-script surfaces follow `data-bpb-theme`
per the 07-19 audit's U4. The popup does neither: `popup.css` keys dark mode
solely on `prefers-color-scheme`, and `popup.js` never reads the setting. A
user who picks Dark on a light OS gets a light popup; Light on a dark OS gets
a dark popup.

Fix: reuse the options pattern — generalize `options/theme.js` into a shared
panel-theme module (settings-schema-style pure-ish module bundled into both
page bundles), add a `popup-head` entry in `scripts/build-config.mjs`, load it
from `popup.html` before `popup.css` paints (keep the localStorage pre-paint
mirror so the popup doesn't flash), and restructure `popup.css` like
`ascent-backup.css`: media-query defaults plus explicit
`:root[data-bpb-theme="light"|"dark"]` overrides. Extend
`test/theme/dark-contrast.test.mjs` to the popup surface.

### B2 — "No confident summit matches" is a 30-minute dead end
**Severity: medium · [popup.js:207-209](../../popup/popup.js)**

The `no-matches` state card has no action. Reopening the popup calls
`beginCapture(false)`, and `startCapture` returns the cached terminal job
until its 30-minute TTL expires — so there is genuinely no way to re-run the
capture (after fixing a bad GPS setting, or after a transient Peakbagger
data problem) short of waiting. The sibling `no-gps` state already offers
"Check again" wired to `beginCapture(true)`.

Fix: add the same "Check again" secondary action to `no-matches`. Keep the
existing explanatory copy.

### B3 — Settings-backup GitHub panel ignores host-permission revocation
**Severity: low · [settings-backup.js:111-120](../../options/settings-backup.js)**

`renderGithub` gates on `githubStatus?.connected === true` only. The favorites
panel gates on `permissionGranted && connected`
([favorites.js:332](../../options/favorites.js)) because the github.com /
api.github.com host permissions are *optional* and revocable from browser UI.
With the permission revoked, the settings-backup section still shows "Stored
as settings.json in …" with live Back up / Restore buttons that can only fail.
The two panels sitting in the same section behave differently.

Fix: include `hasGithubPermission()` in `refreshGithub` the way favorites
does, and render the same "Connect GitHub above" prompt when it is missing.

### B4 — "Open 1 drafts" after a failed draft open
**Severity: low · [popup.js:292](../../popup/popup.js)**

The error-recovery path resets the button to
`` `Open ${selectedIds().length} drafts` ``, losing the singular form that
`refreshSelection` handles ("Open 1 draft"). Call `refreshSelection()` (or
reuse its label logic) instead of rebuilding the label by hand.

### B5 — Reopened popup shows a dead "Drafts opened" button
**Severity: low · [popup.js:186-189](../../popup/popup.js),
[background.js:558-566](../../src/background/background.js)**

`openDrafts` has a deliberate reuse path: clicking again focuses the existing
draft tabs. But once the job phase is `opened`, the popup disables the button
("Drafts opened"), so the refocus path is unreachable — precisely when a user
who lost the draft tabs among their others would want it. Keep the button
enabled with a "Show opened drafts" label while the drafts still exist; the
background already handles the rest.

---

## 2. Engineering smells

### E1 — `background.js` has become a 1,925-line four-domain module
[background.js](../../src/background/background.js) now mixes: the capture
pipeline (jobs, drafts, provider injection), local-file GPX processing, the
entire GitHub domain (device-flow auth, repo selection, ascent/profile/
settings/favorites backup, auto-backup alarms — roughly lines 1061–1798), and
terrain prefetch. AGENTS.md calls it "the service-worker coordinator"; it has
outgrown that description. The bundle already composes from modules, so this
is a build-config-only split: extract `background/github-routes.js` (auth +
backup message handlers + auto-backup), `background/terrain-prefetch.js`, and
optionally `background/draft-flow.js`, leaving `background.js` as state keys,
shared queues, and the dispatch table. One `dist/background.js` output and the
manifest stay untouched; `test/project/manifest-capture.test.mjs` pins that.
Do this **after** E2–E4 so the extractions move already-deduplicated code.

### E2 — Draft-opening logic exists twice and has already diverged
[background.js:534-613](../../src/background/background.js) (`openDrafts`)
vs [background.js:746-865](../../src/background/background.js)
(`applyGpxProcess`): the track ordering, `sequenceById`, fallback trip name,
trip-info/wilderness gating, tab-group creation ("Peak Drafts", green), and
the draft-record shape are near-verbatim copies. One side has a `makeDraft`
helper; the other builds the object inline, and the shapes differ silently
(`preserveExistingFields` exists only on one path). A future field added to
one literal will quietly miss the other. Extract shared helpers — the pure
parts (ordering, sequencing, trip naming) belong in `capture-core.js`; the
tab/group choreography in one background helper both callers use.

### E3 — The terminal-phase set is defined three times
[background.js:436](../../src/background/background.js),
[background.js:507](../../src/background/background.js), and
[popup.js:21](../../popup/popup.js) each hardcode
`['ready', 'no-matches', 'no-gps', 'error', 'opened', 'previewed']`. Adding a
phase means finding all three. Export it from a tiny pure module (e.g.
`capture/capture-phases.js`) added to both bundles — the established
settings-schema pattern; don't pull all of `capture-core` into the popup
bundle for one constant.

### E4 — The GitHub gate and client construction are hand-rolled five times
`GithubClient.createGithubClient({ fetch: netFetch, token, owner, repo,
branch })` plus the enabled/token/repo triple-gate appear in
`githubProfileBackupStatus`, `backupAscent`, `checkAscentBackup`,
`backupProfileBatch`, and `optionsGithubClient`
([background.js:1446-1664](../../src/background/background.js)). One
`connectedGithubClient({ requireEnabled })` helper returning
`{ client } | { error }` collapses all five and makes the gate order
un-divergeable. Similarly, two ad-hoc concurrency implementations coexist in
the same file: `mapWithConcurrency`
([background.js:171](../../src/background/background.js)) and the inline
queue/worker loop in `terrainPrefetch`
([background.js:1381-1396](../../src/background/background.js)) — use the
former for both.

### E5 — Options-page and content-surface helper sprawl
The same small helpers are now copied across surfaces:

- `send` (promise-wrapped `runtime.sendMessage` with `lastError` swallow):
  [github.js:51](../../options/github.js),
  [favorites.js:84](../../options/favorites.js),
  [settings-backup.js:37](../../options/settings-backup.js), plus the
  `sendBg` variant in [ascent-backup.js:31](../../src/ascent/ascent-backup.js).
- `withGithubBusy`: [favorites.js:599](../../options/favorites.js) and
  [settings-backup.js:127](../../options/settings-backup.js).
- Repo-name fallback formatting: [favorites.js:326](../../options/favorites.js)
  and [settings-backup.js:48](../../options/settings-backup.js).
- DOM builders: `el()` verbatim in [github.js:62](../../options/github.js) and
  [ascent-backup.js:36](../../src/ascent/ascent-backup.js), a `node()` clone
  in [profile-backup.js](../../src/profile/profile-backup.js), and a smaller
  variant in [report-editor.js](../../src/reports/report-editor.js).
- The undoable-delete machinery (`pendingDeletes` map + `pendingBulk` +
  timers + deleted-row rendering) implemented independently in
  [favorites.js](../../options/favorites.js) and
  [drafts.js](../../options/drafts.js).

Consolidate incrementally: a shared options-page util module for
`send`/`withBusy`/repo-name, and one shared DOM-builder module included in
the bundles that need it (the multi-bundle pure-module pattern already
exists). The undo machinery is worth unifying only if it stays genuinely
identical — check before forcing it.

### E6 — Options sections fail silently when one element id is missing
Every options module opens with an all-or-nothing guard —
[favorites.js:54-63](../../options/favorites.js) checks ~25 elements and
returns a no-op `populate` if *any* is missing; github.js, settings-backup.js,
and drafts.js do the same. A single renamed id in `options.html` silently
blanks an entire settings section with no signal. Keep the no-op behavior
(graceful degradation is right) but log one `console.error` naming the
missing ids so the failure is diagnosable in one glance.

### E7 — Cross-module storage keys are hardcoded strings
[favorites.js:806-807](../../options/favorites.js) watches
`changes.bpbGithubAuth` and `changes.bpbSettings`, but those keys are private
constants inside [github-auth.js:224](../../src/github/github-auth.js) and
[settings.js:18](../../src/settings/settings.js). If either key is ever
renamed, the favorites panel's live refresh silently stops. Export the keys
(`STORAGE_KEY`) from their owning modules and import them.

### E8 — Theme resolution is re-implemented in every MAIN-world surface
`prefersDark`/`effectiveTheme` are copied in
[gpx-analyzer.js:74-75](../../src/gpx/gpx-analyzer.js),
[big-map.js:328-331](../../src/maps/big-map.js), and
[peak-map.js:107-110](../../src/maps/peak-map.js), with a fourth variant as
`Settings.resolveTheme` ([settings.js:24-27](../../src/settings/settings.js)).
MAIN-world code can't import `settings.js`, but this is the same situation
`settings-schema.js` solves: one pure `theme/theme-resolve.js` bundled into
the MAIN-world entries and delegated to by `settings.js`. Same rationale as
the schema rule — a drifting copy is invisible until it ships.

### E9 — `github-error.js` vs `github-errors.js`
Two modules whose names differ by one letter hold different things (user-facing
copy vs the typed error/code set). Both are correct; the names are a
findability trap. Rename `github-error.js` to something role-revealing
(`github-error-copy.js` or `github-copy.js`) in the same commit as its import
updates. Purely mechanical; do it whenever adjacent code is touched.

### E10 — `options.js` embeds a 160-line scroll-spy
[options.js:241-405](../../options/options.js) — the section-nav lock/spy/
smooth-scroll machinery is a third of the file and unrelated to settings
wiring. Extract `options/section-nav.js` (already fully self-contained behind
`initSectionNav`). No behavior change.

---

## 3. UX — counterintuitive or unpolished

### U1 — Popup spinner ignores reduced motion
[popup.css:57-69](../../popup/popup.css) animates unconditionally, while
options.css, terrain-map.css, report-editor.css, ascent-upload.css, and the
draft banner all honor `prefers-reduced-motion`. Add the guard (a static
progress glyph is fine); this is the only remaining surface without it.

### U2 — Copy and naming inconsistencies in the options page
Single copy-pass commit over [options.html](../../options/options.html) and
[github.js](../../options/github.js):

- "Github connection" → "GitHub connection"
  ([options.html:43](../../options/options.html),
  [options.html:487](../../options/options.html)) — the only two lowercase-h
  "Github"s in user-facing copy.
- "TR drafts" ([options.html:39](../../options/options.html),
  [options.html:468](../../options/options.html)) — unexplained abbreviation;
  the sibling section spells out "Trip report editor". Use "Trip report
  drafts".
- "Use plugin managed custom list"
  ([options.html:359](../../options/options.html)) — "plugin" is the wrong
  product term (it's an extension) and the phrase reads as broken English.
  "Use a custom list managed here" or similar. The paragraph above it
  ([options.html:355](../../options/options.html)) has the same voice problem
  ("while buddy list has a limit of 100").
- The ascent-history hint ([github.js:267-271](../../options/github.js)):
  "Auto backup on new and edits. To backup all earlier ascents, … It always
  includes every year." — fragments, "backup" as a verb, and a cryptic last
  sentence. Rewrite in the extension's plain voice, e.g. "New saves and edits
  are backed up automatically. To back up ascents saved before you connected,
  open My Ascents and choose Back up all ascents (it covers every year)."
- Favorites row action label "Delete" with aria-label "Remove … from
  favorites" ([favorites.js:233](../../options/favorites.js)) — pick one verb.
  "Remove" fits favorites (the climber still exists); keep "Delete" for
  drafts, where content is destroyed.

### U3 — The Units setting undersells what it controls
[options.html:201-203](../../options/options.html) scopes Units to "Distance
and elevation in the GPX chart", but `ascent-upload.js` also uses it for the
✦ Process summary formatting on the ascent form
([ascent-upload.js:99-101](../../src/ascent/ascent-upload.js)). Broaden the
description ("in the GPX chart and processing summaries") rather than moving
the setting; it lives acceptably under Map & GPX chart.

### U4 — "Sync for nerds" names its audience, not its function
The section title is deliberate personality (it arrived with the settings-
export commits) but sits oddly against the repo's own "senior Apple designer"
bar and describes function-by-audience rather than function ("what's in
here?" is answered by neither word). Rename it to "Backup & sync"; the
playful register can live on in the section description instead. This was a
product-voice call — the owner approved the rename in this plan revision
(2026-07-22).

### What's already good (keep it)
- Fail-closed gating is consistently applied across every new surface
  (favorites site-tab fallback, backup snapshot identity checks, sender
  verification on every background route).
- The mirror-buddies confirmation dialog with explicit impact counts and a
  signature recheck before applying is exactly the right destructive-action
  pattern.
- Per-item and bulk undo on favorites and drafts, with storage-failure
  rollback.
- The typed error modules (`peakbagger-error.js`, `github-error(s).js`) keep
  actionable copy in one place per domain — extend, never bypass, them.

---

## 4. Execution plan

Each numbered step is one focused commit (AGENTS.md discipline: run `npm
test` before every commit; `npm run verify:extension` for any step touching
`scripts/build-config.mjs`, the worker, or bundle composition; visual check
at real popup/options sizes for UI steps, hidden per the real-browser rules).

### P0 — behavior contradictions (small, independent)
1. **B2**: "Check again" action on the `no-matches` card; popup test.
2. **B4 + B5**: draft-button label/state fixes (singular form; enabled
   "Show opened drafts" while drafts exist); popup test for both.
3. **B3**: permission gate in the settings-backup panel, matching favorites;
   options test.
4. **U1**: reduced-motion guard on the popup spinner.

### P1 — popup theme (the one multi-file P0-adjacent feature)
5. **B1**: shared panel-theme module + `popup-head` bundle + `data-bpb-theme`
   overrides in popup.css + dark-contrast coverage. Verify with
   `npm run verify:extension` (build-config change) and a visual pass in
   OS-light/extension-dark and OS-dark/extension-light.

### P2 — deduplication (order matters: dedupe before splitting)
6. **E3**: `capture-phases.js` shared constant; update both bundles.
7. **E4**: `connectedGithubClient` helper + reuse `mapWithConcurrency` in
   `terrainPrefetch`.
8. **E2**: extract shared draft-opening helpers; regression test that both
   entry points produce identical draft records for the same selection
   (this is the test that would have caught the `preserveExistingFields`
   divergence).
9. **E7**: export and import the storage-key constants.
10. **E5**: options util module (`send`, `withBusy`, repo-name) and shared
    DOM builder; migrate one surface per commit if the diff gets large.
11. **E5 (undo machinery)**: unify the undoable-delete machinery between
    favorites and drafts behind one helper, keeping observable behavior
    identical (undo window, rollback on storage failure, bulk semantics);
    if extraction forces behavior changes on either surface, stop and record
    why in this plan instead of forcing it.
12. **E6**: loud missing-id logging in the options section guards.

### P3 — structure
13. **E1**: split `background.js` into coordinator + domain modules via
    `build-config.mjs`; `manifest-capture.test.mjs` and
    `npm run verify:extension` in both browsers are the gates.
14. **E8**: pure `theme-resolve.js` for MAIN-world surfaces, and extend the
    schema-style guard test so a reintroduced hardcoded theme-resolution
    copy fails the suite.
15. **E10**: extract `options/section-nav.js`.
16. **E9**: rename `github-error.js` to `github-error-copy.js` and update
    its imports; mechanical, its own commit.

### P4 — copy pass
17. **U2 + U3**: one copy commit across options.html/github.js/favorites.js;
    update any tests asserting the old strings.
18. **U4**: rename "Sync for nerds" to "Backup & sync" in the sidebar and
    section heading (owner-approved). Keep the `#github*` anchor ids stable
    so deep links and the section-nav keep working; move any wanted
    playfulness into the section description. Update tests asserting the
    old title.

### Explicitly out of scope
- Popup/status polling architecture — closed in the 07-19 audit (E2) with
  rationale that still holds.
- The capture privacy pipeline, detection scoring, and reduction — re-skimmed,
  no new findings.
- The scroll-spy's behavior (only its file location, E10) — it was recently
  tuned (`453c883`) and works.
