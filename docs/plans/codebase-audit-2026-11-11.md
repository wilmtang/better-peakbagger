# Repository bugs, performance, engineering and UX audit — 2026-11-11

Status: findings and plan only. No runtime code was changed by this audit.

Baseline: clean `main` at `400a7c1b`, version 4.1.0, macOS on Apple silicon.
Findings describe that tree.

## Scope and method

This was a sampled static audit, not a full re-read of ~85,000 authored lines.
The areas audited on November 8 (maps, 3D, summit cloud) were deliberately
skipped; attention went to code added or converted since the October 28 audit
and to surfaces older audits covered least. An independent reviewer then
checked every finding against the code and added three (see
[Review record](#review-record)).

Files read, in full or in the part relevant to a finding:

- Garmin inbox: `src/garmin/garmin-imports.ts`, `garmin-store.js`,
  `garmin-badge.ts`, `options/inbox.js`, `options/inbox.html`,
  `options/garmin.js`, and the Garmin call sites in
  `src/background/background.js`
- Popup: `popup/popup.ts`
- Photo topo output and downloads: `src/photos/photo-output.ts`, the download
  and confirmation call sites in `photos/photos.ts`
- Report protection inspector and format painter:
  `src/reports/report-script-source.ts`, `report-script-notice.ts`,
  `report-format-painter.ts`
- Ignored-report surfaces: `src/ascent/ascent-report-visibility.js`,
  `src/favorites/peak-report-filter.js`
- Network helpers: `src/weather/open-meteo-client.js`, `src/net/*`,
  `src/background/peakbagger-request-scheduler.js`
- Weather day/week windows: `src/weather/weather-day.js`, `weather-week.js`
- Export helpers: `options/settings-backup.js`, `options/climber-files.js`

Not audited: capture core and provider adapters, the rest of the background
worker, GitHub backup, GPX analyzer, ascent filter internals, terrain/maps,
report editor internals, photo store and renderer, theme. The absence of a
finding in those areas means nothing. No real browser was launched; every UX
statement below is derived from code and is marked where it still needs a
rendered check.

### Baseline checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `eslint src options popup photos scripts test` | Passed (source lint only; the build and web-ext lint halves of `npm run lint` were not run) |
| `npm run audit:ci` | Passed: no advisories in shipped code; development-only advisories remain for addons-linter, deepmerge, node-forge and web-ext, as already tracked in [follow-ups](follow-ups.md) |
| `npm test`, `npm run verify -- …` | Not run |

## Findings

P2 is a defect reproduced or established from an unambiguous code path, or a
measured cost, with a realistic trigger. P3 is a narrow-trigger defect, an
unreproduced risk, or a demonstrated smell whose everyday impact is small.
Within the files read, no manual-Save gate was found broken; F9 is a capture
dead end, not a gate bypass. One privacy-contract deviation was found in the
later capture-path pass (F16). Findings F12–F18 from that pass are in their own
table in the [addendum](#addendum--full-read-of-the-capture-path).

| ID | Priority | Kind | Finding | Evidence |
| --- | --- | --- | --- | --- |
| F9 | P2 | Bug | A Garmin toolbar capture that opened drafts once can never be captured again, even though nothing was saved. | Code path; reproduced by the reviewer on the built worker. |
| F10 | P2 | Bug | Hitting the inbox byte cap re-downloads and re-analyzes the same activity every 60 seconds indefinitely. | Code path; simulated by the reviewer with production modules. |
| F3 | P2 | UX | Dismissing an inbox activity gives no visible confirmation and its 60-second Undo sits inside a collapsed disclosure; expired Undo buttons stay forever. | Code path; needs a rendered check. |
| F1 | P2 | Performance | Every Garmin inbox write rewrites every stored route; cost grows linearly with the backlog. | Synthetic benchmark through the production store: 345 ms per trivial write at 100 full-size items. Not a browser measurement. |
| F2 | P3 | Risk (unreproduced) | Three export paths revoke their download URL immediately or after 1 s, against the lifetime the fourth documents; the largest has no download proof in any browser. | Code comparison and verifier inventory. |
| F4 | P3 | Bug | Inbox history keeps "the last 200 receipts" by object key order, which puts small-numbered Garmin IDs first regardless of when they were dismissed. | Node reproduction of the ordering. |
| F11 | P3 | Bug | A second Dismiss on an already-dismissed item makes Undo leave it permanently invisible. | Code path; simulated by the reviewer. |
| F5 | P3 | UX | Nine native `confirm()`/`alert()` calls remain although two modules record why the product replaced them; two confirm actions that already offer Undo. | Call-site inventory. |
| F6 | P3 | Performance | Settings and the inbox poll the worker on fixed 5 s and 2.5 s timers; Settings requests the full item list to read summary fields. | Code path. |
| F7 | P3 | Smell | The inbox guesses the confidence scale, the popup types it as a string, and the two surfaces word the same reading differently. | Code comparison. |
| F8 | P3 | Smell | The popup writes the selection to the worker on every result render, without handling rejection. | Code path. |

IDs F9–F11 were added in review and keep their numbers; the table is in
priority order.

### F9 — An unsaved toolbar Garmin capture blocks every later capture of that activity

**Trigger.** Capture a Garmin activity from the toolbar, choose **Open drafts**,
then do not save: delete the captured track data, or let the 30-minute draft
lifetime lapse. Capture the same activity again.

**Root cause.** Opening drafts calls `reserveCapture`
(`src/background/background.js` lines 2599–2601), which writes a receipt bound
to that job's id (`src/garmin/garmin-imports.ts` lines 445–450). It runs
whenever IndexedDB exists; it is not gated on the Garmin inbox being enabled.
Admission then refuses any capture whose stored receipt names a different job
(`background.js` lines 1925–1933). Nothing releases a toolbar receipt: the
inbox Undo (`garmin-imports.ts` line 401) needs an inbox item this activity
never had, and the only other deletion is wiping all local Garmin data
(line 167). Once the original job is cleared or expires, the comparison is
against `undefined` and fails forever. (Refusal after a real Save is the
intended duplicate protection and is not part of this finding.)

**Reproduction.** The reviewer drove the built `dist/background.js`: Garmin
capture → Open drafts → Delete captured track data → Capture again returns
`garmin-inbox-activity` ("This Garmin activity is already in your import
history. Open the activity inbox to review its drafts."). The same result
occurs with `enableGarminInbox` off. The 30-minute expiry variant was
established by reading only. I confirmed the code path but did not rerun the
reproduction.

**Impact.** The user is told to open an inbox that has no entry for the
activity; with the inbox feature off, the popup instead sends them to enable a
feature that still will not show it (`popup/popup.ts` lines 226–228). The only
escape is "Delete local Garmin data", which is itself unavailable while the
feature is off (`options/garmin.js` lines 82 and 181), so that user must enable
the inbox first. Manual capture of a real activity is blocked by an abandoned
attempt.

**Direction and acceptance.** Prefer letting a new job for the same activity
and climber adopt a toolbar receipt that recorded no saved peak (`peaks`
empty). The alternative — releasing the receipt when its job is cleared,
cancelled or expires — has a hazard: a draft tab that outlives the release can
still be saved, and `captureSaved` then ignores it (line 455), so the inbox
could later import an activity that was in fact saved. Keep the duplicate
protection for receipts with at least one saved peak and for genuine inbox
items. Decide explicitly whether the toolbar path should consult import history
at all while the inbox feature is off. Add a worker regression in
`test/background/` for clear → recapture, expiry → recapture, and "recapture,
then Save from a surviving draft tab of the first job", in both feature states,
and run it against the unfixed worker first.

### F10 — Byte-capacity failure retries the same activity every minute

**Root cause.** When storing a prepared item would exceed 20 MiB,
`runCheck` throws `capacity` from inside the write (`garmin-imports.ts` lines
304–305). The catch rethrows it (line 309), so the pass never reaches the
statement that recomputes `preparePending` (line 325), and the item keeps
`phase: 'waiting'` with no `retryAt`. `check` records `error: capacity`
(line 336). `reconcile` stops scheduling for a capacity error only when
`preparePending` is false (lines 112–113); it was left true by the previous
pass, so it arms a 60-second alarm (lines 114–117). The continuation skips
discovery, picks the same item (line 265) and repeats.

**Evidence.** The reviewer simulated this with the production modules: after
the cap, each pass performs one Garmin identity call, one recording download
and one `prepare` (Peakbagger corridor lookups) with no progress, and the alarm
is always re-set at +60 s. It needs a signed-in Peakbagger tab; without one the
pass pauses at binding instead. The existing test
(`test/garmin/garmin-imports.test.mjs` line 260) covers only the 200-item count
cap. I confirmed the control flow by reading.

**Impact.** For a user at the storage cap, the worker wakes every minute and
sends Garmin and Peakbagger requests that cannot succeed, until they remove an
item. That is exactly the traffic pattern the rate-limit handling elsewhere is
built to avoid.

**Direction and acceptance.** On a byte-capacity failure, clear
`preparePending` in the same epoch-guarded write that records the error, and do
not attempt preparation while at the byte cap. (Stamping the item with a
`retryAt` instead is weaker: line 265 would move on to the next waiting item
and waste one download and analysis per waiting item per hour.) The paths that
clear a capacity error when an item leaves the store (lines 180, 408, 481) do
not set `preparePending`, so they must set it when waiting items remain;
otherwise resumption silently waits for the next scheduled check or Peakbagger
visit. Add a unit test: fill to the byte cap, advance the clock through several
alarm periods, assert no further recording or prepare calls, then remove an
item and assert preparation resumes promptly.

### F3 — Dismiss has no visible confirmation, and its Undo is hidden

**Trigger.** In the activity inbox, open an activity and choose Dismiss.

**Code path.** The handler (`options/inbox.js` lines 159–168) sends
`GARMIN_DISMISS`, hides the review, shows the list and moves focus to **Check
now**. `busyAction` wrote "Working…" to `#inbox-review-status`, which is inside
the now-hidden review; `refresh` sets the list's `#inbox-status` to its
ordinary "Last checked…" text (line 136). The only Undo is the button `refresh`
adds to the receipt row in `#inbox-history-list` (lines 114–121), inside
`<details id="inbox-history">`, which is collapsed by default and never opened
by code (`options/inbox.html` line 13). Undo expires 60 seconds after the
dismissal (`garmin-imports.ts` line 391) with no countdown.

A related defect in the same rows: once the window lapses the button is only
marked `aria-disabled` (line 124) and is never removed, so every dismissed
receipt keeps a dead "Undo" button permanently. A test pins that state
(`test/garmin/garmin-ui.test.mjs` lines 224–229). AGENTS.md requires that
completion status "must not look clickable unless it has a real action".

No earlier audit declined a visible Undo; the archived design only describes
history as a secondary view
(`docs/archive/garmin-personal-api-draft-inbox.md`).

**Impact.** A mis-click on Dismiss makes the activity disappear with no
acknowledgement, and the user has one minute to discover that recovery is
inside a collapsed "Completed & dismissed" section. Done, by contrast, is
guarded by a blocking confirm (F5).

**Direction and acceptance.** After a successful dismissal, state it in the
list's status row with an adjacent Undo for the undo window, reusing
`GARMIN_UNDO` and reserved space so the list and **Check now** do not move.
The implementation must also:

- hold that state against the 2.5-second poll, which otherwise overwrites
  `#inbox-status` (the existing `statusError` hold is the model);
- report an Undo failure without losing the control;
- define consecutive dismissals (the newest replaces the previous notice; the
  earlier one remains undoable from history until it expires);
- remove the history Undo button when `undoAvailable` is false, moving focus
  predictably if it was focused (the rule at lines 118–120 is the model), and
  update the test that pins the disabled button.

Verify in hidden Chrome and Firefox per the layout-stability rules: idle →
dismissing → dismissed-with-Undo → undone, and → expired, at 100% and 200%
text, comparing the list heading and **Check now** geometry across states.
Confirm the current behaviour in a rendered page before coding; it was derived
from code only.

### F1 — Garmin inbox state is one IndexedDB record

**Root cause.** `createGarminStore` keeps the whole inbox — connection, scan
cursor, receipts and every item's reduced route — under the single key
`current` (`src/garmin/garmin-store.js` lines 23–37). `mutate` reads that
record, runs the callback, and writes the whole record back, plus the summary.
Stored items normally are full-size: `prepare` persists the reduced route
(`background.js` lines 3651–3657), and the reducer fills its 3,000-point budget
for any longer track.

Consequences in the callers (line numbers in `garmin-imports.ts` unless noted):

- `runCheck` performs two whole-record writes per prepared activity (line 280,
  then 299 on success or 313 on failure), one more per pass (line 325), and two
  per listing page (line 235, then 254 or 261).
- The capacity guard serializes every item to JSON for each prepared activity
  (line 304).
- The full record is read where only membership or metadata is needed: once
  per Garmin toolbar capture (`background.js` line 1926); on every turn of the
  `peakbaggerVisited` loop (line 348), which runs on each activation or load of
  a Peakbagger tab (`background.js` lines 4101–4105); and in `reconcile`
  (line 111), which runs after nearly every handler.
- `settingsChanged`, on each Settings change, reads the full record and — when
  the feature flag, scope or privacy options moved — rewrites it.

**Measurement.** This script drove the production store over `fake-indexeddb`
(run from the repository root so the import resolves):

```js
import { IDBFactory } from 'fake-indexeddb';
import { createGarminStore } from './src/garmin/garmin-store.js';
const point = i => ({ lat: 46.8 + i * 1e-5, lon: -121.7 + i * 1e-5, ele: 1500 + i * 0.1, time: 1760000000000 + i * 1000 });
const item = id => ({ id: String(id), phase: 'ready', saved: [], summary: { id: String(id), date: '2026-10-01', type: 'hiking' },
    analysis: { matches: [{ id: 1, name: 'x', classification: 'strong', confidence: 90 }],
        route: [Array.from({ length: 3000 }, (_, i) => point(i))], waypoints: [] } });
for (const n of [5, 25, 100]) {
    const store = createGarminStore(new IDBFactory());
    await store.mutate(s => { for (let i = 0; i < n; i++) s.items[20000000000 + i] = item(20000000000 + i); });
    let t = performance.now(); for (let i = 0; i < 5; i++) await store.mutate(s => { s.preparePending = false; });
    const mutate = (performance.now() - t) / 5;
    t = performance.now(); for (let i = 0; i < 5; i++) await store.read();
    const read = (performance.now() - t) / 5;
    const state = await store.read(); t = performance.now();
    const bytes = new TextEncoder().encode(JSON.stringify({ ...state.items })).length; // the line-304 guard
    console.log(n, (bytes / 1048576).toFixed(1), mutate.toFixed(0), read.toFixed(0), (performance.now() - t).toFixed(0));
}
```

| Stored items | Serialized size | Trivial `mutate` | `read` | Size check |
| --- | --- | --- | --- | --- |
| 5 | 1.1 MiB | 16 ms | 7 ms | 2 ms |
| 25 | 5.3 MiB | 78 ms | 40 ms | 9 ms |
| 100 | 21.0 MiB | 345 ms | 158 ms | 34 ms |

`fake-indexeddb` clones with `structuredClone` in-process, so these are a proxy
for serialization cost, not Chrome or Firefox IndexedDB timings. The linear
shape is the finding. The 20 MiB guard is reached at roughly 80–95 full-size
items depending on stored shape (numeric times here; the reviewer reached it at
78 items with string times), so the last row is the designed ceiling.

**Impact.** A user who imports "all history" or leaves a backlog unreviewed pays
worker time per inbox action, per Peakbagger tab activation and per preparation
pass, on the service worker that also serves capture and page messages. A user
with a handful of items sees nothing. No data is lost.

**Direction and acceptance.**

1. Measure in a real browser first: load the unpacked extension, seed 5/25/90
   synthetic items, and record `mutate`/`read` wall time in Chrome and Firefox.
   If the 90-item write is under ~50 ms in both, record that and stop.
2. Otherwise move only the bulky fields out of the hot record. Keep in
   `current` everything read on hot paths: connection, scan, receipts, and per
   item its metadata, `analysis.matches` (read by `saved`, `snapshot` and the
   summary's `!item.analysis` test) and a stored `hasTimestamps` flag (today
   computed by scanning the route, line 198). Store `route` and `waypoints`
   under a per-item key in the same object store.
3. Do not bump the database version: the object store uses out-of-line keys, so
   new keys need no schema change, and a bump would make an older build fail to
   open the database that holds the Garmin key. Migrate lazily inside the first
   readwrite transaction, using the record's existing `version` field; `read`
   is readonly, so readers must accept both shapes until then, and the
   incremental byte total (step 6) is initialised at migration. Accepted limit:
   an older build reading a migrated record finds matches without a route and
   fails closed when opening drafts; the key is unaffected.
4. Every path that removes an item or its analysis must delete the route key
   in the same transaction: `pruneDismissed` (line 176), `GARMIN_DONE`
   (line 407), `saved` (line 480), `disconnect(removeData)` (line 167), and a
   re-preparation that returns `analysis: null` (`background.js` line 3649,
   merged at lines 303–306), where the item survives. A route that survives
   "Delete local Garmin data" would breach the privacy contract.
   `settingsChanged`' timestamp and waypoint scrub must reach the moved fields.
5. Migrate the direct store users in `background.js`: line 3660 reads
   `item.analysis.route`/`waypoints` through `store.read()`; the writes at
   3677, 3702, 3715 and 3722 touch only `handoff` and stay metadata-only.
6. Track the stored byte total incrementally instead of re-serializing every
   item, and give membership-only callers a narrow read.

Preserve the epoch and credential-epoch guards, single-transaction atomicity of
each logical write, the revision counter the public cache relies on, and
device-local storage only. Tests: lazy migration of a version-1 record to an
identical public snapshot; a metadata-only write touches no route key; "no
route key remains" after each of the five removal paths; existing tests that
seed version-1 items directly still pass or are migrated deliberately. Rerun
the script and the browser timing and record before/after.

### F2 — Download URLs are revoked before the browser is known to have read them

**Evidence.** `src/photos/photo-output.ts` (lines 175–198) keeps its object URL
for 60 seconds and attaches the link, with a comment that Firefox reads the URL
after the click returns. That comment arrived in `33f464dc` without a recorded
reproduction. Three other exports are more aggressive:

| Site | Link attached | Revocation | Existing download proof |
| --- | --- | --- | --- |
| `options/climber-files.js` lines 81–86 (list export) | No | Synchronously, in `finally` | Completed download with parsed bytes in hidden Chrome and Playwright Firefox (`scripts/verify-climber-files.mjs` lines 54–58) |
| `options/settings-backup.js` lines 137–143 (settings export, optionally with credentials) | No | Synchronously after `click()` | Chrome only (`scripts/verify-extension.mts`, `verify-map-handoffs.mjs`) |
| `photos/photos.ts` lines 3338–3343 (project bundle including the original image) | No | After 1 second | None; `scripts/verify-firefox-extension.mts` skips it |

**What is and is not established.** Small synchronous-revoke exports demonstrably
complete in Chrome and in Playwright's Firefox build, so this is not a known
failure. Unproven: stock Firefox for the settings export, and the project
bundle — the largest file, with the weakest proof — in any browser.
`climber-files.js` also reports "JSON file exported." unconditionally.

**Direction and acceptance.** Add completed-download assertions for the settings
export in Firefox and for a project bundle of at least 20 MB in both browsers.
Independently of the outcome, route all three through one helper: move
`downloadBlob` and its lifetime constant to a new UI-neutral module under
`src/ui/` rather than importing a photo module into Settings, and
delete the local copies, following the TypeScript-on-modification policy for
the touched `.js` files. Record the result as a bug fix only if a failure
reproduces; otherwise as consolidation of four copies of one browser
constraint.

### F4 — History truncation depends on Garmin ID magnitude

**Root cause.** `snapshot` publishes
`Object.entries(state.receipts).slice(-200)` (`garmin-imports.ts` line 199) as
the history. JavaScript orders integer-like keys below 2³²−1 numerically ahead
of all other keys, so receipts with small activity IDs always sort first:

```text
keys inserted: 21000000001, 21000000002, 3900000000, 21000000003
Object.keys:   3900000000, 21000000001, 21000000002, 21000000003
```

`positiveId` accepts 1–16 digits, so such IDs are admitted. That older Garmin
activities carry IDs below this boundary is an assumption from outside the
repository, not something verified here.

**Impact.** Only for a user with more than 200 receipts (toolbar reservations
count) who dismisses an activity with a small ID: its receipt is cut from the
published history, so its Undo row never appears. Receipts are never pruned,
but each is tiny and they are the de-duplication record; that is noted, not
proposed for change.

**Direction and acceptance.** Stamp receipts when written and select the newest
200 by that stamp (legacy receipts keep current order), always including any
receipt whose item has a live `undoUntil`. Unit-test mixed ID magnitudes with
more than 200 receipts. Do this with F3: same handler and rows.

### F11 — A repeated Dismiss strands the item

**Root cause.** `GARMIN_DISMISS` has no guard for an item that is already
dismissed (`garmin-imports.ts` lines 387–392). A second request stores
`previousPhase: 'dismissed'`. Undo then restores `phase: 'dismissed'`, deletes
`undoUntil` and deletes the receipt (lines 396–401).

**Evidence.** Simulated by the reviewer: Undo returns ok; the item is invisible
(the public list filters dismissed items), is never pruned (`undefined <=
clock()` is false), still counts toward the 200-item and 20 MiB caps, blocks
re-import, and makes the summary's `undoDue` `NaN`.

**Trigger.** Two inbox tabs, with the second Dismiss inside the first tab's
2.5-second poll window. Narrow, but the result is unrecoverable short of
deleting local Garmin data.

**Direction and acceptance.** Return early when the item is already dismissed.
To collect items already stranded, a dismissed item without a finite
`undoUntil` must count as expired in all three places, because both prune
triggers are comparisons that are false for `undefined` or `NaN`:
`pruneDismissed` (line 178), the summary's `undoDue`
(`garmin-store.js` line 14, read at line 186) and the `runCheck` predicate
(line 209). Unit-test dismiss ×2 → undo, and assert a pre-seeded stranded item
is actually collected.

### F5 — Native dialogs remain where the product decided against them

**Evidence.** `options/drafts.js` (lines 383–385) records that native
`confirm()` cannot follow the dark theme, cannot be styled, and blocks the
page; `options/photos.js` (lines 5–10) adds that the browser can suppress it.
The in-page pattern originates in the July 24 polish audit (F6). These sites
still use native dialogs (complete inventory: seven `confirm`, two `alert`):

| Site | Dialog | Note |
| --- | --- | --- |
| `options/inbox.js` 161 | `confirm` — mark activity done | |
| `options/garmin.js` 183 | `confirm` — delete local drafts and history | Destructive. The October 31 service-disconnect audit (D5) reworked and browser-verified this dialog without replacing it |
| `photos/photos.ts` 1401 | `confirm` — continue without an editable copy | |
| `photos/photos.ts` 3322 | `confirm` — bundle includes original metadata | |
| `photos/photos.ts` 3347 | `confirm` — move to Recently Deleted | Followed by a toast with Undo (lines 3363–3366) |
| `photos/photos.ts` 4011 | `confirm` — remove all annotations | Followed by a toast with Undo (lines 4017–4020) |
| `src/ascent/ascent-delete.js` 64, 84, 96 | `confirm` + two `alert`s | Runs on Peakbagger's own page, after an awaited settings read |

No earlier audit explicitly declined replacing them. A suppressed `confirm()`
returns `false`, so on a page where the user ticked "prevent additional
dialogs" these actions silently do nothing.

**Direction.** Owner choice; proposed order by value:

1. Remove the confirmation on **Remove all annotations** and **Move to Recently
   Deleted**: both already show a toast with Undo, so the dialog asks
   permission for something reversible.
2. Move the two Garmin confirmations to the in-page block already hosted three
   times.
3. Leave `ascent-delete.js`: an in-page replacement injected into a host page
   carries more layout and focus risk than it removes. Record it as
   intentionally not changed.

Each replacement needs the layout-stability and focus checks in both browsers.

### F6 — Fixed-interval worker polling

`options/garmin.js` line 194 polls every 5 seconds for the life of the Settings
tab while visible, whichever section is shown. With the feature on it sends
`GARMIN_STATUS` (line 66), whose response carries every item with its matches
and up to 200 history rows, yet the page uses only `configured`, `pending`,
`error`, `checking`, `enabled`, `cid` and `connectedDate` — all present in
`GARMIN_SUMMARY`. `options/inbox.js` line 183 polls every 2.5 seconds. Each
poll is a runtime message, an IndexedDB summary read and a settings read, keeps
the MV3 worker from idling, and after any revision change triggers the
full-record read from F1.

**Direction.**

- Now, independent of F1: switch Settings to `GARMIN_SUMMARY`.
- After F1: have the wrapped `mutate` (already the single write path, already
  driving the badge) broadcast a revision notice, and let both pages refresh on
  that notice, on visibility return and after their own actions, with a slow
  fallback timer for `checking` and undo-expiry transitions. If F1's browser
  measurement shows reads are cheap, record this half as not worth changing.

### F7 — Confidence is handled three ways

`capture-core.js` line 576 defines confidence as an integer percentage. The
inbox multiplies by 100 when the value is `<= 1` (`options/inbox.js` line 52),
which would print a 1% score as 100%; the popup declares `confidence?: string`
(`popup/popup.ts` line 17) and prints "Strong · 92%" (lines 410–411) while the
inbox prints "Strong · 92% confidence".

No user-visible error today, since visible matches score at least 60. Type it
as `number`, delete the scale guess, and format through one helper beside
`matchLabel` in `src/capture/match-confidence.js` so both surfaces and their
accessible names agree. Unit-test the helper.

### F8 — Popup selection write on every render

`refreshSelection` ends with an unconditional
`void ext.runtime.sendMessage({ type: 'CAPTURE_SELECTION', … })`
(`popup/popup.ts` line 360) and `renderResults` calls it (line 415). Opening
the popup on a ready job therefore echoes the worker's own selection back as a
`storage.session` write (`applySelection`, `background.js` lines 2164–2175),
and a rejected send is an unhandled rejection.

The consequence is limited: **Open drafts** sends `selectedIds` itself, so a
lost write affects only what a reopened popup shows. Existing popup tests pin
"no write" for the opening and opened phases only.

**Direction.** Send only from the checkbox `change` path, or when the selection
differs from `job.selectedIds`, and attach a rejection handler. Add a popup
test asserting no `CAPTURE_SELECTION` on the initial render of a ready job.

## Checked and found sound

Recorded so a later audit does not repeat the work. The reviewer re-checked
only the two marked items.

- `report-script-source.ts` tree walk terminates for both element and fragment
  scopes and stays within its declared bounds.
- `report-format-painter.ts` listener lifetime matches armed state; `cancel` is
  idempotent.
- `open-meteo-client.js` shares an in-flight request between callers with one
  owner's signal; safe under its documented one-owner-per-page rule.
  (Re-checked.)
- `peakbagger-request-scheduler.js` settles every entry exactly once across
  queue, abort and stop.
- `weather-day.js`/`weather-week.js` resolve civil days through the zone, not
  fixed 24-hour arithmetic.
- `garmin-badge.ts` coalesces bursts and keeps the last accurate badge on
  error. (Re-checked.)

## Execution plan

One focused commit per step, in this order. Each runs `npm run typecheck`,
`npm run lint` and the narrowest covering tests, follows the
TypeScript-on-modification policy for any touched `.js` file, and — for a
reproduced bug — runs its new assertion against the unfixed code first.

| Step | Item | Gate before coding | Verification |
| --- | --- | --- | --- |
| 1 | F9 toolbar receipt release | Owner decision on consulting import history while the inbox is off | Worker regression: clear → recapture, expiry → recapture, both feature states; `npm run verify -- chrome` |
| 2 | F10 byte-capacity retry loop | — | Unit test across several alarm periods, then resume after removal |
| 3 | F11 repeated Dismiss | — | Unit test dismiss ×2 → undo; stranded item collected; one `npm run verify -- chrome` covering the worker changes in steps 1–3 |
| 4 | F3 + F4 dismiss feedback, visible Undo, stale Undo button, history selection | Rendered confirmation of the current state | Inbox jsdom tests; mixed-ID history test; hidden Chrome and Firefox transition and geometry check |
| 5 | F6a Settings uses `GARMIN_SUMMARY` | — | Settings Garmin tests. The one-word change forces the TypeScript conversion of `options/garmin.js` (197 lines); scope the commit as that conversion plus the change |
| 6 | F1 Garmin store | Real-browser timing at 5/25/90 items | Migration, write-scope and delete-path tests; before/after timings; `npm run verify -- chrome` |
| 7 | F6b push instead of poll | Outcome of step 6 | Notice-driven refresh tests; worker idles with Settings open |
| 8 | F2 shared download helper | New completed-download assertions (Firefox settings export; ≥20 MB bundle in both) | Those assertions against the shared helper |
| 9 | F7 confidence helper | — | Helper unit test; popup and inbox tests |
| 10 | F8 popup selection write | — | Popup test |
| 11 | F5 native dialogs | Owner picks scope | Per replaced dialog: focus and layout checks in both browsers |

Steps 1–3 are small, independent correctness fixes and come first. Step 7 must
follow step 6; the rest are independent of one another.

## Closure ledger

To be filled during remediation; keep all three categories.

### Fixed and verified

None yet.

### Intentionally not changed

None yet. Candidates stated above: `ascent-delete.js` native dialogs (F5),
receipt pruning (F4), and F6b or the later F1 steps if the browser measurement
does not justify them.

### Changed but not fully proven

None yet. Proof limits to carry forward:

- F9 was reproduced by the reviewer on the built worker, not rerun by the
  author; its expiry variant is from reading only.
- F10 and F11 are simulations with production modules, not browser runs.
- F1 timings are from `fake-indexeddb`.
- F2 is not reproduced.
- F3 and F5 are derived from code without a rendered check.
- F12: the reader's throw was reproduced in Node; its mapping to the wrong
  message is from reading. F13 rests on documented alarm semantics, not a run.
  F14–F18 are from reading only; F15, F17 and F18 each name the check that
  would confirm or retire them.
- No live Garmin, Strava or Peakbagger account was used, and `npm test` was not
  run.

## Addendum — full read of the capture path

A second pass read the highest-risk code in full: `src/capture/*`,
`src/net/bounded-text.js`, all 4,169 lines of `src/background/background.js`,
`src/background/sender-policy.js`, `public-errors.js`, `trusted-actions.js`,
`src/peakbagger/*` (request, page, response, account, cloudflare, origin),
`src/gpx/gpx-parse.js`, and the ascent-editor scripts `ascent-draft.js`,
`ascent-upload.js`, `ascent-saved.js`, `capture-save-verification.js` and
`ascent-page.js`. Not read: `src/gpx/gpx-metrics.js` and the route modules the
worker delegates to (GitHub, photos, report drafts, imports, custom layers).
No browser was launched for this pass either.

| ID | Priority | Kind | Finding | Evidence |
| --- | --- | --- | --- | --- |
| F12 | P2 | Bug | A provider error or sign-in page over 4 KB is reported as "This GPX is too large". | Code path; reader's throw reproduced in Node. |
| F13 | P3 | Bug | The capture cleanup alarm restarts its 5-minute period on every worker start, so expired session data is removed later than PRIVACY.md states. | Code path and documented alarm semantics; not run in a browser. |
| F14 | P3 | Bug | An interrupted GPX preparation on the ascent form leaves Save and Preview silently blocked and the file input disabled until the file is re-processed or removed. | Code path. |
| F15 | P3 | Bug (conditional) | Local GPX processing and the Garmin resume-on-visit only work on `www.peakbagger.com`, although the extension runs on the bare host too. | Code path; whether the bare host serves pages is unverified. |
| F16 | P3 | Privacy contract | A capture made before "remove GPX timestamps" was enabled is reused, with timestamps, for up to 30 minutes. | Code path; owner decision. |
| F17 | P3 | Smell | Garmin binding does not skip sleeping Peakbagger tabs and repeats the login request for every prepared item. | Code comparison; effect unverified. |
| F18 | P3 | Risk (unverified) | Draft filling yields a macrotask per field; in a throttled background tab it may outlast its 30-second lease. | Code path; needs measurement. |

### F12 — A provider error page over 4 KB is reported as "This GPX is too large"

`capture` probes a 403 or `text/html` response body with
`readBoundedResponseText` capped at 8,192 bytes / 4,096 characters
(`src/capture/provider-page.ts`, then JavaScript, lines 348–354; limits in
`provider-response.js`). That reader throws `ResourceLimitError` when either
cap is exceeded (`src/net/bounded-text.js`), and the catch maps any limit error
to `gpx-too-large` (`provider-page.js` line 401). The popup renders that code as
a locked card with no action. So an HTML body larger than the probe yields
"This GPX is too large to process safely…" instead of forbidden, human-check or
response-changed. For ASCII HTML the 4,096-character cap bites first; a single
chunk over 8,192 bytes, or a declared `Content-Length` over 8,192, throws
earlier (`bounded-text.js`). All three end in the same wrong message. Realistic
triggers are a 403 block page without the `cf-mitigated` header and a 200
`text/html` application shell.

An adjacent defect in the same lines: an *empty* 403 or `text/html` body makes
the classifier return `needsBodyProbe` again with no code
(`provider-response.js`), so `capture` throws an uncoded failure that surfaces
as `provider-download-failed` rather than `provider-forbidden` or
`provider-response-changed`.

Reproduced the reader's throw in Node with a 9 KB 403 HTML body; the mapping to
`gpx-too-large` is from reading. Existing tests use only tiny probe bodies
(`test/capture/provider-page.test.mjs` lines 485–525). Not affected: the common
signed-out case, a sign-in *redirect* (classified earlier from the final URL),
and challenges flagged by the `cf-mitigated` header.

**Direction and acceptance.** Read the probe as a truncating prefix (stop at the
cap and cancel the stream) rather than a failing bound — the classifier already
slices to the probe length, so this matches its intent — and give an empty
probed body a definite code. Keep the real GPX read's limits unchanged. Add
provider-page tests with a >8 KB 403 HTML body (expect `provider-forbidden`), a
>8 KB 403 challenge page (expect `provider-human-check`), a >8 KB 200
`text/html` login body (expect `provider-signed-out`), an oversized declared
`Content-Length`, and an empty 403 body; run them against the unfixed code
first.

### F13 — The cleanup alarm restarts on every worker start

`ext.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 })` runs unconditionally
when the worker starts (`background.js` line 4160). Creating an alarm under an
existing name replaces it and restarts its schedule. An MV3 worker that is
woken, idles out, and is woken again within five minutes — ordinary Peakbagger
browsing, since every page load messages the worker — keeps postponing
`cleanup`. That function is the only path that deletes expired capture jobs,
drafts and their reduced-GPX payloads, sends `DRAFT_CLEARED` to stale draft
tabs, and runs the GitHub snapshot, trusted-action, photo and report-draft
expiry (lines 3418–3441). Startup runs only orphan-payload and helper-lease
recovery, not expiry.

The delay is bounded, which is why this is P3. Use of expired records is still
refused by `isFresh`; an alarm that fires into a stopped worker is still
delivered after the top-level re-create, so cleanup runs at the first
five-minute gap between worker restarts; and `storage.session` is cleared when
the browser exits. The effect is cleanup roughly "length of a bursty browsing
session plus five minutes" late, and late `DRAFT_CLEARED` notices — a mismatch
with PRIVACY.md line 58 ("removes expired session records every five
minutes"), not open-ended retention. The codebase already guards other alarms
(`climber-list-sync.js` lines 221–224, `github-routes.js` line 1194). That a
same-named `alarms.create` replaces and restarts the alarm is documented Chrome
and MDN behaviour; it was not run here. No test pins this alarm's creation.

**Direction and acceptance.** Create the alarm only when `alarms.get` finds none
or a different period. If a startup expiry pass is also wanted, gate it on a
stored last-cleanup time so six cleanup routines do not run on every worker
wake. Add a worker test that boots twice against the same alarm store and
asserts one creation.

### F14 — Interrupted GPX preparation latches the form shut

`handleFileChange` sets `preparingFile = true` and `upload.disabled = true`
(`src/ascent/ascent-upload.js` lines 704–706) and restores both only
`if (token === requestToken)` in its `finally` (lines 762–767). Several paths
advance `requestToken` without starting a new preparation — notably
`restoreNative` (line 297). While `preparingFile` is true a capture-phase
listener swallows every click on GPS Preview and both Save buttons, and form
submission, with no message (lines 176–186).

**Triggers.** Each needs a preparation still in flight — short for small files,
seconds for a large one being rewritten.

- Tick "Include timestamps for this file" (which re-prepares the file with
  `keepTimestampChoice`, leaving the other controls live), then click **Attach
  GPX**. It calls `restoreNative()` (line 368), which bumps the token; the
  preparation's `finally` skips its reset; and Attach's own
  `nativePreview.click()` (line 373) is swallowed by the listener. Nothing
  offers a retry on this path.
- With the summit card showing, tick the checkbox, then click the card's
  Cancel (lines 587–589). Same latch; here "Process again" is rendered when the
  invalidation succeeds (lines 305–319).
- A page suspend during preparation (`onSuspend`, lines 893–895); `onResume`
  un-latches only if a native file is still present.

**Recovery.** Without a reload, only a new preparation (choosing a file again,
or "Process again" where shown) or GPX Remove (lines 882–891) clears the latch.
Until then Save, Preview and the file input do nothing and say nothing.
`processFile` and `releaseNativeAfterDraftHandoff` cannot latch.

**Direction and acceptance.** Own the latch with the preparation, not the token:
release `preparingFile`/`upload.disabled` when the preparation that set them
settles unless a newer preparation has taken over, and disable Attach GPX and
the card's actions while re-preparing. Add ascent-upload tests for toggle →
Attach GPX and toggle → Cancel, asserting a Save click reaches the form and
the input is enabled.

### F15 — Page-owned Peakbagger requests assume the `www` host

The manifest injects content scripts on both `peakbagger.com` and
`www.peakbagger.com`, and `peakbagger-origin.js` accepts both as senders. The
capture transport does not: the page helper refuses any request unless
`location.origin` is exactly `https://www.peakbagger.com`
(`src/peakbagger/peakbagger-page.js`, `validRequest`), the summit-box URL is
hard-coded to `www` (`background.js` line 1232), the helper-tab lookup queries
only `www` (line 1107), and "canonical tab" means the `www` origin (lines
567–570).

On a bare-host ascent form, `startGpxProcess` routes its login and summit
lookups through that same page (lines 2805–2813), so every request is rejected
and Process fails with copy about an unverifiable account page. The Garmin
queue's "visit Peakbagger to resume" (`resumeGarminOnVisit`, line 4104) never
fires on bare-host tabs. Toolbar capture is unaffected: it opens its own `www`
helper tab.

The repository treats the bare host as live: `peakbagger-origin.js` says
"Peakbagger serves both", and bare-host draft senders are tested
(`test/background/background-gpx-process.test.mjs` lines 838 and 1063), so
draft delivery is deliberately supported there while Process is not. Whether
the live site serves or redirects the bare host was not checked; if it
redirects, this is dormant. **Direction:** make one read-only check of the bare
host first. If it
serves pages, either have the local-GPX path build its URLs from the page's own
origin and let the helper accept both canonical hosts, or fail early with
accurate copy ("open this form on www.peakbagger.com"). Add a
`background-gpx-process` test with a bare-host sender.

### F16 — Timestamp removal is not applied to an existing capture

`sameCapturePreferences` (`background.js` lines 164–169) compares waypoint,
detail, trip, nights and URL preferences but not `removeGpxTimestamps`, and the
payload chosen at draft time follows the job's capture-time preference
(`capturePayloadValue`, lines 214–218). A user who captures an activity, then
turns on "remove GPX timestamps", then opens the popup gets the earlier job
back and can open drafts that send timestamps to Peakbagger Preview: a job
captured with the preference off stored no timestamp-free payload. The popup
copy is accurate about what will be sent, and **Check again** recaptures. But
PRIVACY.md (lines 207–208) says the preference removes recorded times from GPX
sent to Peakbagger, without qualification, so for up to 30 minutes this departs
from the stated contract. The Garmin inbox takes the stricter position: a
privacy-setting change scrubs stored routes immediately (`garmin-imports.ts`
lines 123–135). No test or archived decision makes the omission deliberate.

Owner decision. If the stricter reading is intended, include
`removeGpxTimestamps` in the reuse comparison only in the off→on direction (an
on→off change is already covered by the one-time include checkbox), and add a
worker test.

### F17 — Garmin binding ignores tab state and repeats the login check

`garminBinding` (`background.js` lines 3621–3639) tries every Peakbagger tab
from `tabs.query({})` in turn. `acquirePeakbaggerPage` deliberately skips
discarded, frozen and unloaded tabs because they cannot run the helper (lines
1122–1125); this path does not, so each sleeping tab costs a failed or
timed-out injection (up to the 20-second operation bound) before the next is
tried. It is also called once per prepared item (`garmin-imports.ts` line 279)
and once more when drafts open, each time fetching `Default.aspx` to re-read
the login. What a real browser does on injecting into a discarded tab was not
tested.

**Direction.** Apply the same liveness filter, prefer the active tab, and reuse
one verified binding for the items of a single pass.

### F18 — Field-by-field yielding may outlast the apply lease

`setField` awaits `setTimeout(0)` after every numeric field
(`src/ascent/ascent-draft.js` lines 248–259). `fillForm` awaits it for each
elevation, distance, duration and gain field (lines 413–439) and `fillDayStats`
for ten fields per day (lines 345–358), so a full fill is a few dozen
sequential timer yields. Browsers clamp chained timers in hidden tabs
to about one per second. The apply lease is 30 seconds
(`DRAFT_APPLY_LEASE_MS`), after which `DRAFT_PREVIEW_STARTED` is refused and
the page shows a preview-conflict error. Most fills run in a foreground tab
(the first draft is focused; the next is activated after Save), but
`cleanupRemovedTab` can tell a background draft to proceed (line 4073).

Unverified. **Gate:** measure a fill in a hidden tab in Chrome and Firefox. If
it approaches the lease, yield only where the page's handlers need it, or
activate the tab before applying.

### Checked and found sound in this pass

- `mapWithConcurrency` keeps issuing work after one runner fails, but
  `analyzeTrack` aborts the shared deadline signal in its catch, so remaining
  corridor requests cancel.
- The Peakbagger scheduler stop/resume and cooldown retention keep traffic
  stopped while a cooldown write is pending.
- Draft delivery: sender, page, job, peak, climber and document-lease checks
  hold on every route (`DRAFT_READY`, `DRAFT_PREVIEW_STARTED`,
  `DRAFT_SAVE_CONTEXT`, `DRAFT_SAVE_CONFIRMED`); no path clicks Save.
- `validatePrivateGpx` accepts exactly what `serializeUploadGpx` emits.
- `peakbagger-page.js` is not a general fetch bridge: only `Default.aspx` and a
  validated summit-box query pass.
- `trusted-actions.js` capabilities are one-use, sender-bound and pruned.
- F9 is wider than first stated: `reserveCapture` runs before draft tabs open
  (`background.js` line 2599) and a rolled-back open does not release the
  receipt, so a *failed* open followed by expiry also blocks recapture. The fix
  direction in F9 already covers it; add that case to its regression.

### Additional execution steps

Insert after step 3 of the plan above, one commit each:

| Step | Item | Gate before coding | Verification |
| --- | --- | --- | --- |
| 3a | F12 probe misclassification | — | Three provider-page tests, failing first on unfixed code |
| 3b | F13 cleanup alarm | — | Double-boot worker test; `npm run verify -- chrome` |
| 3c | F14 preparation latch | — | Ascent-upload test; hidden Chrome and Firefox check of toggle → Cancel → Save |
| later | F15 bare host | One read-only check of the bare host | Bare-host sender test |
| later | F16 timestamp reuse | Owner decision | Worker test |
| later | F17 Garmin binding | — | Binding tests with discarded tabs and multi-item pass |
| later | F18 fill timing | Hidden-tab measurement | Draft-recovery verifier with a background draft |

## Review record

**Round 1.** An independent reviewer verified F1–F8 against the code,
read-only, and raised three blocking objections, all accepted:

1. F2 was rated P2 against the document's own rubric and omitted existing
   completed-download coverage. Now P3, with the verifier inventory and a
   narrowed reproduction gate.
2. F1's write counts and two citations were wrong, and its proposed split was
   unsafe as written (matches read on hot paths, orphaned routes on delete, a
   version bump that locks out older builds). Counts corrected; the direction
   now moves only `route`/`waypoints`, migrates lazily, and requires same-
   transaction deletion.
3. "No capture gate was found broken" was unjustified. The reviewer found F9
   (reproduced), F10 and F11 (simulated) in files the audit had read. The
   author confirmed each code path by reading and added them; the scope
   statement is narrowed.

Also accepted: the stale disabled Undo button and poll-overwrite requirement in
F3; both already-undoable confirmations and the corrected `ascent-delete.js`
rationale in F5; the `GARMIN_SUMMARY` shortcut in F6; the limited consequence
in F8; recording the benchmark script; merging F3 and F4 into one step.

**Round 2.** The reviewer re-read the rewritten document against the code and
reported no blocking objections and no disagreement with the priorities or the
F5 direction. Its remaining corrections were applied: F9's wording (a Save does
not unblock; the escape needs the inbox enabled) and the hazard of releasing a
receipt while draft tabs survive; F10's resumption needing `preparePending`
set by the removal paths; F11's stranded-item collection needing all three
expiry comparisons; F1's fifth route-removal path, readonly-read migration
note, downgrade limit and complete script; F3's focus rule; and the
verification and scoping notes on steps 3 and 5. The author and reviewer agree
on this document as it stands.

**Round 3.** The reviewer checked the capture-path addendum (F12–F18) against
the code by reading, reported no blocking objections and no missed findings
beyond adjuncts, and its corrections were applied: F13 lowered to P3 with its
bounded delay stated and the startup-cleanup caveat; F12's cap ordering, the
empty-body misclassification and softened signed-out wording; F14's corrected
recovery, the more likely Attach GPX trigger and the suspend trigger; F15's
in-repo "serves both" evidence; F16 tied to PRIVACY.md and reflected in the
scope statement; F18's uncited count replaced with call sites; and the proof
limits above. The reviewer spot-checked two of the "found sound" bullets
(`mapWithConcurrency` and the F9 widening) and did not re-read the full file
set. The author and reviewer agree on the document as it stands.
