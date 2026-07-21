# Better Peakbagger — trip-report drafts manager

Self-contained brief for an implementing agent working in the `better-peakbagger`
repo. Read and follow `AGENTS.md` first (commit discipline: small conventional
commits straight to `main`; architecture boundaries; real-browser verification;
UX bar).

## Goal

Trip-report drafts autosave from the report editor, but today a draft is only
ever surfaced on the *matching* `ascentedit.aspx` page — invisible unless the
user happens to revisit that exact ascent. Add a manager where the user can see
every draft on the device and act on it: a **"Report drafts" section on the
options page** (canonical manager), plus a quiet **"Manage drafts" entry link
in the report editor**. The popup is deliberately out of scope: it already
means something different by "drafts" (prepared ascent drafts from activity
capture), and mixing the two concepts in that small surface invites confusion.

## Context — verified facts

- **Draft store** (`src/report-editor.js`): `storage.local`, key
  `bpbReportDraft:<cid>:<a{aid}|p{pid}|new>` built at report-editor.js:52-54
  (`cid` falls back to `'0'`). Record `{ text, mode, savedAt, source? }` written
  by `saveDraftNow()` (:391-409) — `text` is bracket markup, `mode` is
  `'rich' | 'markdown'` (plain mode never saves, :396), `source` is the exact
  Markdown sidecar in markdown mode. Constants :41-43: TTL 14 days
  (`DRAFT_TTL_MS`), cap 30 (`DRAFT_LIMIT`). Empty text removes the key
  (:399-403). Restore/discard offer bar `offerDraft()` :472-496 — drafts are
  offered back, **never silently applied**; `checkDraft()` :502-520 compares
  normalized text; `pruneDrafts()` :524-536 deletes expired/excess records;
  Save clears the draft (:467-470). `initialize()` awaits `checkDraft()` at
  :825 and fires `pruneDrafts()` at :827. Foot status element `status`
  (`span.bpb-re-status`, role=status) :291-294 shows "Draft saved on this
  device · <time>" (:407).
- **No display metadata**: the record carries no peak name or ascent date; only
  IDs live in the key. The editor page's form has both: `#PeakListBox`
  (fixture `test/fixtures/pages/climber-ascentedit.html:236`) and `#DateText`
  (:194). `src/ascent-snapshot.js` is the one module allowed to know
  ascentedit's field names (its header, :6-11); its internal
  `readPeak(form, params)` :131-140 already resolves `{ id, name }` from
  `PeakListBox` with a URL-`pid` fallback. `report-editor.js` already imports
  `ascentSnapshot` (:25).
- **Edit-URL precedent**: the background worker opens draft tabs at
  `https://peakbagger.com/climber/ascentedit.aspx?pid=<pid>&cid=<cid>`
  (background.js:603, :844).
- **Markdown rule**: `reportMarkdownBody()` (report-editor.js:438-441) — exact
  Markdown source when authored in markdown, else
  `Markup.bracketToMarkdown(text)`. `src/report-markup.js` is pure and exports
  `reportMarkup.bracketToMarkdown` (:1119).
- **Options page**: flat single-level nav (`options/options.html:22-27`),
  sections `#general #capture #map-chart #beta #github #about`; section markup
  pattern at :33 (`section.settings-section` + `h2.section-title` +
  `.card` rows); shared status line `p#status[role=status]` :344.
  `options/options.js`: per-control change-listener wiring :139-194; dynamic
  row precedent (terrain cache usage) :32, :65-89; a `storage.onChanged`
  listener already exists :198-199 (sync-area, terrain); scroll-spy
  `initSectionNav()` :223-298 builds entries from `a.nav-item` anchors and
  handles click/hashchange. Manifest `options_ui.open_in_tab: true`
  (manifest.json:38-40). The two-level-nav restructure (5-feature plan Unit 4)
  has **not** landed — the drafts section is top-level under either IA.
- **Bundles** (`scripts/build-config.mjs`): options tail bundle
  `options/options.js` = `['terrain-cache.js', 'options-main.js']` (:60), head
  bundle applies theme pre-paint (:59). Page bundles mix `src/` modules with
  page-local files via the `PAGE_LOCAL` alias map (:27-30); pure modules a root
  imports are still listed explicitly in `sources` (see the
  `content/ascent-editor.js` entry listing `report-markup.js` beside
  `report-editor.js`, :42).
- **Opening the manager from a content script**: content scripts cannot call
  `runtime.openOptionsPage()` (extension-page/background API; the popup uses it
  at popup/popup.js:58), and a web page cannot navigate to a
  `chrome-extension://` URL that is not web-accessible. The background worker
  can `tabs.create` its own extension URLs without any extra permission — route
  through a background message.
- **Tests**: `test/options.test.mjs` drives the real options page in jsdom via
  `loadOptions()`, whose harness already accepts a `local` storage seed and a
  `hash` deep-link. `test/report-editor.test.mjs` covers editor/draft behavior
  against the masked ascentedit fixture. Never write real user identifiers;
  the fixtures-privacy test guards this.

Four units, ordered as independently committable pieces.

---

## Unit 1 — shared pure module `src/report-drafts.js`

The options page must parse keys the editor builds; a shared pure module keeps
the two from drifting (same arrangement as `settings-schema.js` /
`gpx-metrics.js`). No DOM, no extension APIs.

Export `reportDrafts` with:

- `PREFIX` (`'bpbReportDraft:'`), `TTL_MS` (14 d), `LIMIT` (30) — moved from
  report-editor.js:41-43.
- `keyFor({ cid, aid, pid })` → the exact string report-editor.js:53-54 builds
  today (`cid || '0'`; `a<aid>` when aid, else `p<pid>` when pid, else `new`).
- `parseKey(key)` → `{ cid, kind: 'ascent' | 'peak' | 'new', id }` or `null`
  for anything that doesn't round-trip (unknown suffix letter, empty cid,
  non-digit id).
- `editUrl(parsed)` →
  `https://peakbagger.com/climber/ascentedit.aspx?aid=<id>&cid=<cid>` /
  `?pid=<id>&cid=<cid>` / `?cid=<cid>` for `new`; omit `cid` when `'0'`.
  Match the background's URL shape (background.js:603).
- `validRecord(value)` → the guard from checkDraft (:507): object with string
  `text` and numeric `savedAt`.
- `fallbackTitle(parsed)` → `'Ascent #<id>'` / `'New ascent · peak #<id>'` /
  `'New ascent'` — display for pre-existing records without a label.
- `remainingMs(record, now)` → `TTL_MS - (now - savedAt)` for expiry display.

**Refactor** `src/report-editor.js` to import the constants and `keyFor`
(behavior byte-identical — existing report-editor tests are the regression
net). Add `'report-drafts.js'` to the `content/ascent-editor.js` sources entry.

**Tests**: new `test/report-drafts.test.mjs` — keyFor/parseKey round-trips for
all three kinds plus the `'0'`-cid fallback, junk-key rejection, editUrl
shapes, fallback titles.

---

## Unit 2 — label metadata at autosave

- `src/ascent-snapshot.js`: export a small `label({ form, params })` →
  `{ peak, date }` reusing internal `readPeak` (:131-140) for the peak name and
  the raw trimmed `DateText` field value for the date (display string, not the
  normalized identity date). Cap peak at 200 chars, date at 20. This keeps the
  field-name knowledge inside the module that owns it.
- `src/report-editor.js` `saveDraftNow()` (:404-406): attach
  `record.label = AscentSnapshot.label({ form, params })`, dropping empty
  members and omitting `label` entirely when both are empty. Wrap in
  try/catch — a label failure must never block the autosave.
- Backward compatible: old records simply lack `label`; the manager falls back
  to `fallbackTitle(parseKey(key))`.
- Privacy: the label stays inside the same device-local record that already
  holds the full report text; nothing new leaves the device, `PRIVACY.md`
  unchanged.

**Tests**: `test/ascent-snapshot.test.mjs` — `label()` from the ascentedit
fixture (peak name from the selected `PeakListBox` option, date from
`DateText`; empty form → empty members dropped).
`test/report-editor.test.mjs` — an autosaved record carries the expected
`label`; autosave still succeeds when the peak select is absent.

---

## Unit 3 — "Report drafts" section on the options page

**Markup** (`options/options.html`): new top-level
`<section id="drafts" class="settings-section" aria-labelledby="drafts-heading">`
between `#github` and `#about`, plus nav item `Report drafts` — a top-level
entry under the current flat nav and equally under the pending two-level IA.
Static content: the `h2.section-title`, one `.card` holding an intro line
("Trip-report drafts autosave on this device while you write and expire after
two weeks."), an empty-state paragraph, a `ul#drafts-list`, and a
`button#drafts-delete-all.secondary` ("Delete all drafts"). Rows are built by
JS.

**New page-local script** `options/drafts.js`, aliased as
`'options-drafts.js'` in `PAGE_LOCAL` (build-config.mjs:27-30); options tail
bundle becomes
`['terrain-cache.js', 'report-markup.js', 'report-drafts.js', 'options-main.js', 'options-drafts.js']`.
It imports `reportDrafts` and `reportMarkup` as ES modules; IIFE body like
`options-main`.

Behavior:

1. **Load**: `storage.local.get(null)`, keep `PREFIX`-keyed entries passing
   `validRecord`, delete expired ones outright (the manager is a legitimate
   pruning surface — same semantics as `pruneDrafts`), sort by `savedAt`
   descending, render.
2. **Row**: title (`label.peak` + `label.date` when present, else
   `fallbackTitle`), meta line (saved time · mode badge `Rich`/`Markdown` ·
   "Expires in N days" / "Expires today"), one-line ellipsized excerpt of
   `text` (~160 chars), and three actions:
   - **Open** — plain `<a class="secondary" target="_blank" rel="noopener">`
     with `href = editUrl(parsed)`. The existing restore-offer bar on that page
     takes over; restore logic is not duplicated and the "never silently
     applied" invariant is untouched.
   - **Copy Markdown** — `navigator.clipboard.writeText` of the exact source
     for markdown-mode records with a `source` string, else
     `bracketToMarkdown(text)` — the same rule as `reportMarkdownBody()`
     (report-editor.js:438-441). Feedback ("Copied"/failure) via the shared
     `#status` line. Works on the click gesture in both browsers; no
     `clipboardWrite` permission added — on rejection show the failure, don't
     crash.
   - **Delete** — remove the key immediately, swap the row content to
     "Draft deleted · Undo" for ~6 s (then remove the placeholder). Undo
     re-`set`s the held record verbatim. Undo-toast over confirm-dialog per
     the UX bar (reversible > interrogative).
3. **Delete all**: same pattern — remove all listed keys at once, one undo
   affordance in the card restoring all held records.
4. **Live refresh**: `storage.onChanged` (`'local'` area, `PREFIX` keys) →
   re-render, debounced; rows in the pending-undo state survive a re-render
   (keep a Map of key → { record, timer } and merge it in), so an autosave in
   another tab can't strip an active Undo.
5. **Empty state**: show the paragraph, hide the list and Delete all.

**CSS** (`options/options.css`): row layout, mode badge, one-line excerpt
(`text-overflow: ellipsis`), reuse existing `.secondary` button and
focus-visible treatments, existing theme variables for light/dark.
**A11y**: real list semantics; per-row buttons carry aria-labels including the
draft title; status feedback through the existing `role=status` line.

**Tests** (`test/options.test.mjs`; harness already takes `local` and `hash`):
seeded drafts render sorted newest-first with labels and fallbacks; an expired
seed is deleted on load and not rendered; Open hrefs for all three key kinds;
Copy uses `source` for markdown records and `bracketToMarkdown` otherwise
(stub `navigator.clipboard`); Delete removes the key and Undo restores the
record deep-equal; Delete-all + undo; empty state; `storage.onChanged` seed
mutation re-renders; nav contains the section and a `#drafts` deep link
activates it.

---

## Unit 4 — "Manage drafts" entry in the report editor

- **Editor** (`src/report-editor.js`): one quiet static link-style button
  `bpb-re-manage` ("Manage drafts") in the foot next to `status` (:291-294).
  Always visible in the editor — it is the discovery point for drafts from
  *other* ascents, so gating it on this page's draft state would defeat it.
  Click → `ext.runtime.sendMessage({ type: 'OPEN_DRAFTS_MANAGER' })`.
- **Background** (`src/background.js`, in the message switch): handle
  `OPEN_DRAFTS_MANAGER` from Peakbagger-tab senders only →
  `ext.tabs.create({ url: ext.runtime.getURL('options/options.html') + '#drafts' })`.
  No new permission (`tabs.create` with an own-extension URL needs none), no
  `web_accessible_resources` change. The `#drafts` fragment deep-links via the
  existing scroll-spy hash handling.
- **CSS** (`src/report-editor.css`): style as a small quiet link matching the
  foot's status text; visible focus state.

**Tests**: `test/report-editor.test.mjs` — link present, click sends the
message. Background test (beside the other handshake tests) — the message from
a Peakbagger tab creates a tab with the options URL + `#drafts`; a
non-Peakbagger sender is refused.

---

## Cross-cutting

- **Commits**: four conventional commits straight to `main`, one per unit,
  bodies stating the checks actually run.
- **Checks**: `npm test` every unit; `npm run verify:extension` after Units 1
  and 3 (both touch `scripts/build-config.mjs`); visual inspection of the
  options section per the UX bar — light + dark, wide + narrow-nav layouts,
  populated + empty states — via a hidden Chrome-for-Testing session, never the
  user's browser.
- **Docs**: update `docs/trip-report-editor.md` (record shape gains `label`;
  manager exists) and the options-page mention in `docs/architecture.md` if it
  enumerates sections; CHANGELOG entry per user-visible unit. When shipped,
  move this plan to `docs/archive/` per `docs/plans/README.md`.
- **Fixtures**: reuse `climber-ascentedit.html`; any new fixture content uses
  masked identifiers and must pass the fixtures-privacy test.

## Risks / notes

1. **Pending IA restructure** (5-feature plan Unit 4, not landed) touches
   `options.html/css/js`. The drafts section is top-level in both IAs, so
   whichever lands second resolves mechanical merge conflicts only.
2. **Delete while the editor is open**: deleting a draft in the manager while
   its ascentedit tab is mid-edit means the next keystroke autosaves it back.
   Accepted — the manager reflects it on the next `storage.onChanged`.
3. **`new`-kind drafts** collapse onto one key per climber by design (existing
   behavior); Open lands on the blank ascentedit form where the offer bar
   restores the draft.
4. **`'0'`-cid keys**: `editUrl` omits `cid`; Peakbagger may bounce through
   login first. Accepted — the user still lands on the right form.
5. **Clipboard**: extension-page `clipboard.writeText` on a user gesture works
   in current Chrome and Firefox; the failure path is a status message, not a
   broken row. Verify once in the real-browser pass.
