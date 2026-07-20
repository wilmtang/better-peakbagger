# Plan: Process an uploaded GPX on the ascent form

Status: implemented 2026-07-19 (steps 1–6 of section 4). The maintained
descriptions now live in [../architecture.md](../architecture.md)
("Local-file entry point") and [../../PRIVACY.md](../../PRIVACY.md)
("Processing a GPX file you upload"); this plan is kept as the design record.

Activity capture today starts on a Garmin/Strava page. This feature respects
the other instinct users have: open Peakbagger's own "Add Ascent" form and
just upload a GPX file. The extension should meet them there — auto-fill
today's date on a fresh form, and when they choose a GPX file, offer a
one-click **Process** that runs the same detection/analysis pipeline the
activity capture uses and fills the form for them. Review and Save stay
manual, exactly as in the capture flow.

## 1. User stories

### A. Same-day logging (date autofill)

> I got home from a climb and opened the peak's "Add Ascent" page.

The Ascent Date field already reads today's date (local time, `yyyy-mm-dd`).
Most ascents are logged the same day, so most users type nothing. Anyone
logging an older climb edits the field as before — the extension fills it
only when the field is empty, and never touches an existing ascent being
edited.

### B. Upload a GPX and let the extension do the work

> I have a GPX from my watch (or a friend, or CalTopo) — no Garmin/Strava
> activity page to capture from.

1. The user opens **Add Ascent** for the peak (or from a capture-opened
   draft tab — same page) and picks their file in Peakbagger's native
   **GPS Track** file field.
2. The moment a `.gpx` file is chosen, the native **Preview** button is
   replaced in place by a visually distinct **✦ Process** button — a quiet
   gradient-ringed button that comes alive with a colorful sheen on hover
   (see 3.2). Peakbagger's **Remove** button stays untouched beside it.
3. Clicking **Process** parses the file *on the page*, resolves the climb's
   local timezone offline from the track's starting coordinate, looks up
   summits along the corridor in Peakbagger's own database, and computes the
   same derived values capture computes: ascent date, start/end elevation,
   up/down distance and time splits, net/extra gain, day-by-day stats for
   multi-day tracks, wilderness nights.
4. The form fills itself, a privacy-cleaned ≤3,000-point copy of the track
   (waypoints per the user's capture settings) replaces the file in the
   upload field, and Peakbagger's GPS Preview is triggered exactly once so
   the map renders. The familiar Strong/Probable confidence banner appears.
5. The user reviews everything and clicks **Save Ascent** themselves. No
   extension path ever clicks Save.

### C. The track crosses several summits

> My GPX is a traverse over three peaks.

Processing detects all three. What happens next is the open UX decision in
section 3.4 — the recommended flow: a small on-page summit card lists the
detected peaks with confidence chips, the current page fills for the peak it
belongs to, and one click opens prepared draft tabs (the familiar green
"Peak Drafts" tab group) for the others, with dates, suffixes, and trip info
coordinated exactly as capture does today.

## 2. Constraints this feature inherits

These are existing invariants (AGENTS.md, PRIVACY.md) that the design must
preserve, not new decisions:

- Raw GPX is parsed on the page it lives on and never leaves it; only
  allowlisted analysis fields (track segments, optional waypoint
  lat/lon/name, track/activity name) reach the background worker. The
  uploaded file is a **newly serialized** reduced GPX, never the source XML.
- Summit lookup must be complete before results are shown; partial corridor
  responses fail closed.
- Prepared drafts live in `storage.session` with a 30-minute TTL and are
  delivered only after tab/job/peak/climber identity checks.
- GPS Preview fires exactly once per draft; Save is always manual.
- Peakbagger login is verified before anything is prepared.
- Shared math stays in `src/gpx-metrics.js` / `src/capture-core.js`; no
  second implementation of gain, distance, or detection.

## 3. Design

### 3.1 Date autofill on a new ascent form

- Surface: the existing ascent-editor content script bundle on
  `ascentedit.aspx` (isolated world, `document_end`).
- Behavior: if `#DateText` exists and its value is empty, set it to the
  browser's local date as `yyyy-mm-dd` and dispatch `input`/`change`
  (matching `setTextField` in `src/ascent-draft.js`).
- An edit page (existing ascent) arrives with the date populated, so the
  if-empty guard is the create/edit discriminator — no URL heuristics.
- The capture draft flow sets the date unconditionally after its handshake,
  so ordering between autofill and draft delivery cannot corrupt a draft.

### 3.2 The Process button

**Appearance and swap.** When `#GPXUpload` receives a user-initiated
`change` event (`event.isTrusted === true` — the capture draft flow attaches
files programmatically, so its synthetic `change` never triggers the swap)
with a candidate `.gpx` file:

- Hide the native `#GPXPreview` (kept in the DOM; the form post still needs
  it) and insert the extension's **Process** button in its place.
- Clearing the file selection or clicking Peakbagger's **Remove** restores
  the native button. Any processing failure also restores it, so
  Peakbagger's plain upload path is always one state away.

**Visual language** (the "AI button" treatment, tuned to the repo's UX bar —
colorful but composed, not a strobe):

- Same box metrics and typography as the neighboring native buttons, with a
  rounded-rect silhouette, a leading ✦ glyph, and the label **Process**.
- A 1.5px conic-gradient ring (indigo → violet → magenta → amber) with a
  soft outer glow. At rest the ring is static and the glow faint.
- On hover/focus-visible the ring rotates slowly (a `@property`-animated
  conic angle) and the glow blooms; on press it compresses slightly.
- While processing, the label cycles through real states — "Reading track…",
  "Finding summits…", "Filling form…" — and the ring keeps a slow rotation
  as the busy indicator; the button is disabled.
- `prefers-reduced-motion: reduce` disables all rotation/bloom; the button
  keeps its static gradient identity. Light and dark themes both get
  sufficient contrast; focus ring and `aria-label`/`aria-busy` are provided.
- Styles ship in the existing ascent-editor stylesheet
  (`src/report-editor.css` is already delivered on this page; the button
  styles land beside it or in a small dedicated CSS file added to the same
  manifest entry).

**Post-click lifecycle.** GPS Preview is an ASP.NET postback — the page
reloads after the extension triggers it. On the reloaded page the upload
field is empty and the native buttons render normally; the confidence
banner (existing draft machinery) reports the result. The Process button is
therefore short-lived by design.

### 3.3 Processing pipeline

The pipeline is deliberately the capture pipeline with a different entry
point. One new content-script module and two background message types; all
algorithms are reused.

```text
user picks file (ascentedit.aspx)
  -> [page] FileReader reads the file; shared GPX parser extracts
     segments / waypoints / track name; tz-lookup resolves the start
     coordinate's IANA zone -> utcOffsetMinutes (raw XML stays on the page)
  -> [worker] GPX_PROCESS_START (sender-verified Peakbagger tab):
     verify Peakbagger login (cid)
     sanitizeTrack -> buildQueryBoxes -> complete corridor lookup
     detectPeaks -> reduceTrack -> serializeUploadGpx
     calculateDraftFields per match, day stats, nights, trip name
     -> storage.session job (30-min TTL), same shape as a capture job
  -> [page] result: matches + bound-peak resolution -> summit UX (3.4)
  -> [worker] GPX_PROCESS_APPLY (selection): register prepared drafts —
     the current tab first when its peak is selected, sibling tabs for the
     rest — then DRAFT_PROCEED to the current tab
  -> [page] src/ascent-draft.js fills, attaches the cleaned GPX, triggers
     GPS Preview exactly once; the chain proceeds tab by tab as today
  -> user reviews and clicks Save
```

Key points:

- **Parser sharing.** `parseGpxData` moves from `src/provider-page.js` into
  a new pure `src/gpx-parse.js` imported by both the provider adapter and
  the new upload module, so a Garmin export and a hand-made file are read by
  the same code. (`provider-page.js` keeps its provider-specific ownership
  and metadata logic.)
- **Timezone.** Provider metadata carries an activity's local start; a bare
  file does not. The upload module resolves the offset offline exactly as
  the GPX Analyzer does (packaged `tz-lookup` raster + `Intl`, per
  `docs/mountain-local-time.md`) and passes `utcOffsetMinutes` through the
  existing `providerMeta` shape — `capture-core.js` needs no change. The
  vendor script is added to the ascentedit content-script list. Fallback on
  tz failure: the labelled longitude estimate, same as the analyzer. A
  timeless GPX keeps the autofilled today-date and leaves durations at zero.
- **Background reuse.** The post-capture stage of `processCapture()`
  (sanitize → lookup → detect → reduce → serialize → derive) is extracted
  into a shared `analyzeTrack()` used by both entry points; no behavioral
  change to activity capture. Local-file jobs reuse the same job map, TTL,
  cleanup alarm, draft registration, ordering, suffix assignment, and the
  `DRAFT_READY`/`DRAFT_PROCEED`/`DRAFT_PREVIEW_STARTED` handshake.
- **Identity.** `pid` comes from the URL (capture-opened and peak-page "Add
  Ascent" links carry it); `cid` from the URL or the login check. The
  current tab may serve as a draft tab only when both are present and match
  the job — the same fail-closed identity rule drafts already enforce.
- **What gets uploaded.** The user's original file never reaches Peakbagger
  through the extension. The upload field is repopulated with the newly
  serialized, privacy-validated GPX (≤3,000 points shared with optional
  waypoints; no heart rate, sensor extensions, descriptions, or symbols).
  The original file on disk is untouched. This mirrors capture and also
  quietly solves Peakbagger's 3,000-point rejection for big files.

### 3.4 Multi-summit handling — Option C (hybrid) chosen

The track may encounter several database peaks. The page is bound to at most
one peak (`pid`). Four behaviors were considered; **Option C is the agreed
design**, the others are kept for the record:

**Option A — Fill first, offer the rest (progressive disclosure).**
Fill the current page immediately for its bound peak (or the top match) and
show a dismissible banner: "Also detected: Peak B · 92%, Peak C · 74% —
Open 2 drafts". Zero added friction in every case; but when the page is
unbound or the auto-pick is wrong, work happens before the user had a say,
and the banner is easy to dismiss and lose.

**Option B — Summit picker card, always.**
After processing, an on-page card (visual language of the popup's match
list: name, Strong/Probable chip, confidence %, encounter time and distance
along track) with checkboxes, strong matches and the bound peak preselected.
Primary action reads "Fill this ascent" or "Fill + open N drafts". Fully
explicit and handles every binding case uniformly — but costs one extra
click even for the single-summit majority.

**Option C — Hybrid (chosen).**
- Exactly one detected summit and it is (or the page is unbound and becomes)
  the page's peak → fill immediately, no card; the existing confidence
  banner names the peak, consistent with capture.
- More than one summit → Option B's picker card. The current page fills for
  its bound peak; other selected summits open as prepared draft tabs in the
  green "Peak Drafts" group with track-order suffixes, shared trip name, and
  day stats — full parity with multi-peak capture.
- Rationale: the common case stays one click ("respect the instinct to just
  upload a GPX"); ambiguity is the only thing that earns UI. This is the
  same shape capture uses (auto-select strong matches, ask when ambiguous).

**Option D — Strictly page-scoped.**
Fill only the bound peak; other summits are mentioned in a status line
("track also crosses Peak B and Peak C") with no tab machinery. Smallest
build, but it walks away from an already-solved problem — capture's draft
tabs — and makes a traverse tedious to log.

Cross-cutting rules (apply to whichever option is chosen):

- **Bound peak not on the track.** Detection stays fail-closed (no silent
  100 m+ matches), but the user knows what they climbed: show "Your track's
  closest approach to ⟨peak⟩ is 240 m from the summit" with an explicit
  **Use ⟨peak⟩ anyway** action that fills from the closest-approach point,
  plus the detected-summit list as the alternative.
- **Unbound page (no `pid`).** Peak selection on the native form is a
  postback that reloads the page, so in-place filling can't precede it.
  After the user picks a summit, the extension navigates the tab to
  `ascentedit.aspx?pid=…&cid=…` with the prepared draft registered — the
  standard draft delivery then fills the reloaded page. One mechanism, no
  special case.
- **No summits detected at all.** Named error with the honest reason
  (corridor searched, nothing within range) and, when a peak is bound, the
  same "use anyway" escape hatch. Native Preview is restored.

### 3.5 Failure and edge behavior

| Case | Behavior |
| --- | --- |
| File is not parseable GPX / no trackpoints | Inline error banner naming the problem; native Preview restored so Peakbagger's own path still works (e.g. waypoint-only files it accepts). |
| Not signed in to Peakbagger | Fail closed with the existing sign-in message; nothing prepared. |
| Corridor lookup partially fails | Fail closed ("summit lookup could not complete"), never "no peaks". |
| > 50 segments, mandatory-point overflow | Existing `reduceTrack` errors surfaced verbatim. |
| Timeless GPX | Date stays the autofilled today; durations zero; day stats omitted. |
| Draft flow drives the page (capture) | No swap: programmatic `change` is not `isTrusted`; the draft filler clicks Preview itself. |
| User re-picks a different file mid-flow | Any in-flight job for this tab is superseded (same tab-keyed job map rule capture uses). |
| Job expires (30 min) before Apply | Existing freshness gates reject it; the user re-processes. |

### 3.6 Module ownership

| Module | Change |
| --- | --- |
| `src/gpx-parse.js` (new, pure) | GPX text → segments/waypoints/name. Moved from `provider-page.js`. |
| `src/ascent-upload.js` (new, isolated world) | Date autofill, file-change detection, Process button + states, on-page parse + tz resolve, summit card, `GPX_PROCESS_*` messaging. Joins the `content/ascent-editor.js` bundle. |
| `src/background.js` | Extract shared `analyzeTrack()`; add `GPX_PROCESS_START` / `GPX_PROCESS_APPLY` handlers reusing the job/draft maps and handshake. |
| `src/ascent-draft.js` | Unchanged in behavior; it already fills any identity-verified draft tab and honors `DRAFT_PROCEED`. |
| `src/capture-core.js`, `src/gpx-metrics.js` | Unchanged. |
| `manifest.json`, `scripts/build-config.mjs` | `vendor/tz-lookup.js` added to the ascentedit script list; bundle composition updated; CSS entry for the button/card. |
| `PRIVACY.md`, `docs/architecture.md` | Document the local-file entry point: file parsed on-page, only derived fields to the worker, corridor boxes to peakbagger.com as with capture, cleaned upload replaces the original. |

No new settings. The existing capture preferences (`fillAscentDetails`,
`fillTripInfo`, `fillWildernessNights`, `retainWaypoints`) govern this flow
identically — one mental model for "what the extension fills".

## 4. Implementation plan

Commit-sized, each independently green:

1. **`refactor(provider): extract shared gpx parsing into gpx-parse.js`**
   — pure move; provider-page imports it; existing provider tests keep
   passing, parser tests relocate/extend.
2. **`refactor(background): extract analyzeTrack from processCapture`**
   — no behavior change; `background-capture.test.mjs` stays green.
3. **`feat(ascent-editor): autofill today's date on a new ascent form`**
   — smallest user-visible slice; fixture tests for empty/pre-filled/edit.
4. **`feat(ascent-editor): process an uploaded gpx into a prepared draft`**
   — single-summit path end to end: button + swap + states, on-page parse
   and tz resolve, `GPX_PROCESS_START`/`APPLY`, current-tab draft delivery,
   exactly-once Preview. Manifest/build changes ⇒ run
   `npm run verify:extension`.
5. **`feat(ascent-editor): summit handling for multi-peak tracks`**
   — the chosen 3.4 option: picker card and/or sibling draft tabs, suffix
   and trip-info parity, closest-approach override, unbound-page navigation.
6. **`docs: gpx upload processing`** — PRIVACY.md, architecture.md,
   README/CHANGELOG; move this plan's decided state into the maintained
   docs.

Steps 1–3 are safe to land before the 3.4 decision; step 5 depends on it.

## 5. Automated testing

Mirroring the repo's boundary-per-test-file convention:

- **`test/gpx-parse.test.mjs`** — parser unit tests: multi-segment, multi
  track, waypoints, missing ele/time, malformed XML, huge files, entity
  decoding; provider-page tests keep covering ownership/export.
- **`test/ascent-upload.test.mjs`** (jsdom + `climber-ascentedit.html`
  fixture):
  - Date autofill: empty → today; pre-filled → untouched; dispatches
    `input`/`change`.
  - Swap: `isTrusted` user change shows Process and hides native Preview;
    programmatic change (draft flow) does not; Remove/clear/failure restore
    native; button exposes accessible name, `aria-busy`, disabled state.
  - States: label progression, error banner content, reduced-motion class
    honored (no animation styles asserted via computed class).
  - Summit card: rendering, preselection (strong + bound peak), action
    label ("Fill this ascent" vs "Fill + open N drafts"), closest-approach
    override row.
- **`test/background-gpx-process.test.mjs`** (stubbed fetch/tabs/storage):
  - Pipeline: segments in → job with matches/uploadGpx/dayStats out; job
    shape identical to a capture job; fail-closed on partial corridor
    responses and signed-out Peakbagger.
  - Draft registration: current tab first in preview order; sibling tabs in
    confidence order; suffixes by track order among shared dates; unbound
    navigation path registers before the tab URL changes.
  - Supersede/TTL: re-process replaces the tab's job; expired jobs rejected.
- **Privacy assertions:**
  - Serialized upload passes `validatePrivateGpx` (with and without
    waypoints).
  - The stored job and every message crossing to the worker contain no
    source-XML markers (assert absence of the fixture file's `creator`
    string and extension tags).
  - `fixtures-privacy.test.mjs` covers any new fixture GPX files (masked,
    synthetic coordinates).
- **End-to-end in jsdom** (extend `ascent-draft.test.mjs` harness): user
  change → Process → job → apply → form filled → `GPXPreview.click()`
  observed exactly once; second `DRAFT_READY` after simulated reload yields
  the banner, not a second preview.
- **Real-browser:** `npm run verify:extension` (manifest + bundle changed);
  a hidden Playwright pass over the fixture page for the button's rendered
  visual states in light/dark and reduced-motion (screenshot the page, not
  the display), per the AGENTS real-browser rules. Live Peakbagger check
  stays minimal and read-only before release.

## 6. Decisions

Both open questions were settled with the user on 2026-07-19:

1. **Multi-summit UX: Option C** — fill immediately when one summit is
   detected; show the picker card when several are, with sibling prepared
   drafts in the capture tab group.
2. **Upload copy: cleaned serialization** — the upload field is repopulated
   with the newly serialized ≤3,000-point GPX (privacy default, mirrors
   capture); the user's original file on disk is untouched.
