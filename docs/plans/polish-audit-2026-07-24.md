# Polish audit — 2026-07-24 (feedback, dark mode, and shared-idiom round)

Status: **in remediation**. Per-finding status is recorded in each heading and
summarised in the [closure ledger](#closure-ledger) at the end of this file.
Baseline before remediation: `d3d33af`, `npm test` 772 passing.

Scope: a fresh read of the surfaces the user actually touches — the capture
popup, the settings page and its four sub-controllers, the background
coordinator's draft-opening and selection routes, the settings bridge and the
GPX Analyzer's inline controls, the ascent-list filter and its two-file theme,
and the ascent-form upload flow. Baseline: clean tree at `d3d33af`; `npm test`
772 passing.

This round deliberately does **not** re-audit what
[`codebase-audit-2026-07-23.md`](../archive/codebase-audit-2026-07-23.md)
closed. Two findings below (F4, F13) are that round's fixes landing on only one
of the surfaces that needed them.

## What was verified, and how

Every finding marked **verified** below was reproduced, not reasoned about:

- **F1** — a faithful jsdom harness driving the shipped `dist/popup/popup.js`,
  with the background returning a fresh object per message the way `publicJob()`
  does. Output recorded inline in the finding.
- **F10** — jsdom cascade: the light `STYLE` string from `ascent-filter.js` and
  the shipped `darkCss` loaded into one document with
  `data-bpb-theme="dark"`, then `getComputedStyle` on both header controls.
- **F11** — WCAG 2.1 relative-luminance math on the shipped color pair, using
  the same formula `test/theme/dark-contrast.test.mjs` uses.
- **F2, F3, F12, F15, F16** — direct source and computed-CSS inspection with
  the counts quoted in each finding.

Not verified: nothing here was checked in a real browser. Spacing, wrapping,
clipping, and focus-ring rendering remain uninspected, and the Firefox side of
F5 is explicitly flagged as unestablished.

---

## A. User-visible defects

### F1 — The popup offers "Open N drafts" after drafts are already open, and the click does nothing — **verified** · **fixed**

[popup.js:290](../../popup/popup.js:290) updates only the button's label after
`CAPTURE_OPEN_DRAFTS` succeeds. It never re-renders the results, so `currentJob`
keeps `phase: 'ready'` — polling has already stopped, because `ready` is
terminal. The lock affordances that exist for exactly this state
(`checkbox.disabled` in [popup.js:179](../../popup/popup.js:179) and the
`selection-lock-hint` paragraph) engage only when the popup is closed and
reopened.

Harness output, driving the shipped bundle:

```
after open      -> checkbox disabled : [ false, false ]
after open      -> lock hint hidden  : true
after uncheck   -> button label      : "Open 1 draft"
after uncheck   -> button enabled    : true
CAPTURE_SELECTION sent while opened  : [ [1,2], [1,2], [1] ]
```

The worker accepts that selection change —
[background.js:495](../../src/background/background.js:495) permits
`updateSelection` in phase `opened` — and then
[`openDrafts`](../../src/background/background.js:583) short-circuits on
`existingForJob.length` and returns `{ reused: true }`. So the user deselects a
peak, the popup says "Open 1 draft", they click it, and the old tabs are
re-focused with the deselected peak's tab still open. The popup promises an
action it cannot perform and reports no failure.

**Fix.** Two layers, because either alone leaves a lie in the system:

- Popup: on a successful open, re-render from the returned state rather than
  patching a label. `CAPTURE_OPEN_DRAFTS` should return the public job so
  `renderResults` can apply the lock in the same turn.
- Worker: `updateSelection` should reject in phase `opened`/`previewed` instead
  of accepting a write that can never take effect. The selection that produced
  the open tabs is the one that matters.

Regression test: the existing popup tests all *start* in `phase: 'opened'`
(`test/popup/popup.test.mjs:232`, `:283`). Add the missing transition case —
open from `ready`, then assert the checkboxes are disabled and the hint visible
without a reopen.

**Resolution.** Both layers landed. `openDrafts` now returns
`job: publicJob(...)` on both its reuse and its fresh-open path, and the popup
calls `renderResults(response.job)` instead of patching a label. The worker's
`CAPTURE_SELECTION` route gained a `SELECTION_LOCKED_PHASES` guard that refuses
the write in `opened`/`previewed` and answers with the unchanged job; the
permissive mutation survives as `applySelection`, which `openDrafts` still needs
for the recovery path where every draft tab was closed. Two regression tests:
`popup locks the selection in the same turn the drafts open` (written first,
observed failing on `checkboxes lock on open`) and `an opened job refuses
selection writes and hands the popup its locked state`.

### F2 — Settings feedback is severity-blind, 1.2 seconds long, and rendered where the user is not looking — **verified** · **fixed**

[`flash()`](../../options/options.js:56) is the settings page's only transient
channel. It has **51 call sites** across the four controllers, and **28 of them
report a failure or block the action** — "Settings couldn't be saved. Try
again.", "Couldn't delete the drafts", "That settings file could not be read.",
"Couldn't merge buddies", and so on. Six of those 51 deliver the extension's own
structured recovery copy: `GithubError.message(...)` and
`PeakbaggerError.message(...)`.

All 51 render identically:

- `.status` is `color: var(--accent)` — the success color — with no error
  variant ([options.css:651](../../options/options.css:651)); the file's only
  two `.status` rules are that block and `.status.show { opacity: 1 }`.
- It fades out after 1200 ms whether it said "Saved" or "couldn't".
- It is a plain in-flow `<p>` at the very end of `.wrap`
  ([options.html:591](../../options/options.html:591)). `.content` is the
  scroll container (`overflow-y: auto`), and `options.css` contains **no**
  `position: fixed` or `position: sticky` rule at all — so the status line is on
  screen only when the user has scrolled to the About section at the bottom.

A user toggling anything in General, Activity creation, or Map therefore cannot
see the confirmation *or* the failure. The D2 fix from the 2026-07-23 round made
`settings.set()` reject properly and made the page roll back; the message
explaining why is delivered somewhere the user is not looking. Carefully written
GitHub and Peakbagger error copy — the kind with a recovery action in it — gets
the same 1.2-second accent-colored fade as "Saved".

**Fix.** Make the status line a sticky, severity-aware region: pin it to the
bottom of `.content`, give errors a distinct role (`alert`) and color, and
**do not auto-dismiss failures** — successes may keep the 1.2 s fade,
failures should persist until the next interaction or an explicit dismiss.
This is one component change that repairs 28 paths at once.

**The below-the-fold claim is now confirmed on screen**, closing the gap this
plan flagged for it. Headless Chrome for Testing (`channel: 'chromium'`,
`headless: true`) loading the real unpacked `dist/` at a 1100×800 viewport, on
the options page at `scrollTop: 0`: `#status` sits at `top: 3620` in an 800 px
viewport (`.content` `scrollHeight` 3672, `clientHeight` 800) — 2820 px past
the fold — with computed `position: static`. Enumerating every reachable CSS
rule in the page returned **no** rule with `position: sticky` or `fixed`.
Selecting a value in General then produced `textContent: "Saved"` with
`opacity: 1` and the element still at `top: 3620`: confirmed, the user cannot
see it.

**Resolution.** One component change plus per-call-site severity, because the
component cannot infer severity without being told and string-sniffing the
message would be the wrong contract.

- `options.html`: the single `<p class="status">` became a `.status-dock`
  holding **two sibling live regions** — `#status` (`role="status"`, polite)
  and `#status-error` (`role="alert"`) with its own dismiss button. Two regions
  rather than one whose `role`/`aria-live` is rewritten per message, because
  assistive technology does not reliably pick up a role change on a live
  element.
- `options.css`: `.status-dock` is `position: sticky; bottom: 0`, collapsing to
  zero padding when idle (`:not(:has(.show))`) so it never eats viewport
  height. `.status-error` uses `--danger`/`--danger-bg`/`--danger-border`
  instead of the success `--accent`. The fade honours
  `prefers-reduced-motion`.
- `options.js`: `flash(msg, { error })`. Successes keep the 1.2 s fade;
  failures go to the alert region, keep the danger colour, and clear only on
  dismiss or the next report.
- **30** of the 51 call sites are marked `{ error: true }` across `options.js`
  (2), `drafts.js` (6), `favorites.js` (16), and `settings-backup.js` (6);
  `github.js`'s 5 are all successes. That is two more than this finding's
  count of 28 — the extra two are `No settings/favorites backup found in …`,
  which report that the requested action did not happen and read as failures at
  the call site.

**Rendered visual review** (headless Chrome for Testing, real unpacked
extension, 1100×800 and 560×700): the dock sits at `top: 709` of an 800 px
viewport — on screen — in light success, dark failure, and narrow failure. The
failure pill computes to `#ffaaaa` on `#382326` in dark and `#912f2f` on
`#fff4f4` in light, no horizontal overflow at 560 px, no clipping of the
dismiss control. Screenshots were inspected and then deleted.

Regression tests: `settings feedback separates severity: successes fade,
failures persist and alert` (asserts the alert region is used, survives 1.4 s,
and dismisses) and `the settings feedback dock stays on screen from any scroll
position`. Nine existing tests that read failure copy out of `#status` were
retargeted to `#status-error-text` — that is the assertion those tests should
always have been making, since severity is now part of the contract.

### F3 — The popup is the only surface that ignores the Units setting — **verified**

[`evidenceText`](../../popup/popup.js:134) hardcodes metres: `"${…} m from
summit"`, `"${…} m elevation difference"`, and the track summary line reports
`max deviation ${…} m`. The popup bundle's sources are
`['capture/capture-phases.js', 'popup-main.js']`
([build-config.mjs:66](../../scripts/build-config.mjs:66)) — it has no settings
module and literally cannot read the preference today.

Meanwhile `ascent-upload.js` resolves display units
([`resolveDisplayUnits`](../../src/ascent/ascent-upload.js:99)) and the GPX
Analyzer resolves them ([`resolveUnits`](../../src/gpx/gpx-analyzer.js:142)).
An imperial user therefore gets feet and miles everywhere in the product except
the one panel that opens from the toolbar.

**Fix.** Add `settings/settings-schema.js` + `settings/settings.js` to the popup
bundle and format through the shared helper introduced in F15. `units: 'auto'`
has no page to sniff in the popup — resolve it to the same value the last
Peakbagger surface used, or fall back to imperial, and say which in a comment.

### F4 — The analyzer's inline controls roll back silently on a failed write — **fixed**

[bridge.js:47](../../src/settings/bridge.js:47) answers a rejected write with
`{ kind: 'setResult', ok: false }` and no message. The MAIN-world client
([gpx-analyzer.js:106](../../src/gpx/gpx-analyzer.js:106)) deletes the pending
patch and calls `recompute()`, so the unit dropdown or route color snaps back to
its old value with nothing said.

That is the same defect D2 fixed on the options page in `0b8917c`, on the other
half of the same write path. The options page now says "Settings couldn't be
saved. Try again."; the analyzer panel says nothing.

**Fix.** Carry the failure message across the bridge and surface it in the
analyzer's existing `terrainMessage` region (already a `role="status"` element
with an error tone). No new UI component.

**Resolution.** `bridge.js` adds `message` to the `setResult` protocol (the
header comment is updated) carrying the same sentence the options page uses,
"Settings couldn't be saved. Try again."; the underlying exception is
`console.warn`ed and never sent, per F5's rule. The MAIN-world `BPB` client
gained `onWriteFailed(fn)`, fired after `recompute()` has already snapped the
control back, and `initChart` wires it to `showTerrainMessage(message,
'error')` — the existing region, no new component.

The message crosses the trust boundary AGENTS.md names, so the analyzer
re-validates it: `failureMessage()` accepts only a non-empty string of at most
200 characters and otherwise substitutes its own `That setting couldn't be
saved.` This is UI copy, not a schema default or bound, so it is not the kind
of local copy the settings-schema rule forbids.

Regression tests: the bridge test now pins the full `setResult` payload
including `message`, and the analyzer test asserts the panel states the reason
after a rejected route-colour write, then that a malformed (non-string)
`message` falls back instead of reaching the DOM.

**Residual, not fixed (out of this finding's scope):** if the isolated world
never answers at all, the client's `pending` entry is never deleted and the
optimistic patch is never rolled back — there is no timeout on the round trip.
That is a distinct defect from the silent-rollback one this finding names, and
it is not addressed here.

### F5 — Raw JavaScript error text reaches users; the Firefox path is unestablished — **fixed**

[background.js:572](../../src/background/background.js:572) builds
`` `Drafts opened, but tab grouping failed: ${error.message}` `` and ships it to
two surfaces:

- [ascent-upload.js:229](../../src/ascent/ascent-upload.js:229) renders it
  verbatim in the status line — so a user can see a raw exception string.
- [popup.js:300](../../popup/popup.js:300) collapses it to the button *label*
  `"Drafts opened without group"`, which uses the primary action's label as a
  status message and never explains what happened.

Separately: `manifest.json` requests the `tabGroups` permission and the same
manifest ships to Firefox — [`createFirefoxManifest`](../../scripts/build-firefox-package.mjs:19)
changes only `options_ui.open_in_tab`. If `tabs.group` is unavailable or
restricted on the supported Firefox floor (`strict_min_version: 140.0`), every
Firefox capture lands in this path, and the user's only signal is a button that
says the grouping did not happen. **This has not been verified on Firefox** and
should be established before the copy is rewritten — the answer decides whether
this is a rare edge case or the normal Firefox experience.

**Fix.** Never interpolate `error.message` into user copy here. Grouping is
cosmetic: on failure say so once, in the status region, in plain language
("Drafts opened. Your browser didn't group the tabs."), and keep the primary
button's label a label. Log the underlying error for diagnosis instead.

**The Firefox question is now answered: grouping works, and this is a rare edge
case rather than the normal Firefox experience.** Two independent checks agree:

- **Live probe**, headless Firefox 153.0 on macOS via Selenium, loading the real
  derived Firefox source (`prepareFirefoxSource`) as a temporary add-on and
  evaluating from the extension's own options page: `typeof browser.tabs.group`
  is `"function"`, `browser.tabGroups.update` is `"function"`, and an actual
  `tabs.group({tabIds:[a,b]})` on two blank tabs returned a group id, followed
  by a successful `tabGroups.update(id, {title:'Peak Drafts', color:'green'})`.
  The manifest read back inside that run listed `tabGroups` among its
  permissions, so this exercised the shipped permission set.
- **Compatibility floor**, from the vendored `@mdn/browser-compat-data`:
  `tabs.group` `version_added: "138"`, `tabGroups` and `tabGroups.update`
  `"139"`, and the `tabGroups` manifest permission `"139"`. All three sit below
  the manifest's `strict_min_version: 140.0`, so no supported Firefox lacks the
  API.

The probe was a throwaway script, not committed; it is reproducible from the
description above. `npm run lint` (`web-ext lint`) reports 0 errors and raises
no compatibility warning against the 140.0 floor.

**Resolution.** `groupWarning` became a boolean flag. `openNewDraftTabs` sets
`groupWarning = true` and `console.warn`s the underlying error instead of
interpolating `error.message`; each surface owns its own copy:

- `popup/popup.js` + `popup.html` + `popup.css`: a new `#open-note`
  `role="status"` line carries "Drafts opened. Your browser didn't group the
  tabs.", and the primary button's label goes back to being a label.
  `renderResults` clears the note so it never outlives the job it describes.
- `src/ascent/ascent-upload.js`: the sibling-drafts status line no longer
  claims "in the Peak Drafts group" when grouping failed, and the bound-primary
  path states the same plain sentence.

Regression tests: `a tab-grouping failure is a flag, never raw exception text
handed to a surface` (asserts the exception string appears nowhere in the
response) and `popup reports a grouping failure in the status line, not on the
primary button`.

### F6 — Bulk draft deletion uses a native `confirm()`; every other destructive action uses an in-page card — **fixed**

[drafts.js:264](../../options/drafts.js:264) calls `globalThis.confirm(...)`.
The favorites mirror confirmation
([options.html:402](../../options/options.html:402)) and the settings-import
confirmation ([options.html:503](../../options/options.html:503)) are both
in-page `role="alertdialog"` blocks with Cancel/confirm buttons, Escape
handling, and focus return. The native dialog cannot follow the extension's
dark theme, cannot be styled, and blocks the page.

**Fix.** Reuse the existing confirmation component for "Delete all N drafts".
The markup pattern already exists twice; this is a third host, not a new design.

**Resolution.** `options.html` gained a third host reusing the *same classes*
as the settings-import block (`.settings-backup-confirmation`,
`-title`, `-detail`, `-actions`, `.settings-backup-confirm`) rather than a
parallel set, so the three stay visually identical by construction; the only new
rule is `.drafts-confirmation`, which adds the full border and rounding the
block needs when it sits inside a panel instead of on a card edge.
`drafts.js` replaces `globalThis.confirm` with `askDeleteAll` /
`hideDeleteAllConfirmation`, matching the existing pattern's Escape handling
and focus return, and `render()` closes a confirmation whose drafts another tab
has already removed.

Regression: the existing `delete all states the count, requires confirmation,
and retains a failed Undo for retry` was rewritten against the in-page dialog —
it now installs a `window.confirm` that *throws*, so a regression to the native
dialog fails the test, and it covers Cancel, Escape, focus return to the
opener, and initial focus on the confirm button.

Rendered visual review (headless Chrome for Testing, real unpacked extension,
1100×800, both themes): the block renders inside the drafts panel on
`#382326`/`#704046` in dark and `#fff4f4`/`#dfb1b1` in light, with the confirm
button focused and its focus ring visible, and no horizontal overflow — the
dark-theme rendering being precisely what the native dialog could not do.

**Observation, not changed:** `src/ascent/ascent-delete.js:67` also calls
`globalThis.confirm`. That is a content script interrupting Peakbagger's own
destructive form submit on Peakbagger's page, not an extension-owned surface
with this design system available, so it is outside this finding — which names
the settings page — and was deliberately left alone.

### F7 — Deleting a single draft drops keyboard focus — **fixed**

[`beginDeleteAll`](../../options/drafts.js:257) explicitly calls
`undoAllButtonEl.focus()` after the bulk delete.
[`beginDelete`](../../options/drafts.js:101) does not: `render()` replaces the
row with a deleted-row containing an Undo button, the Delete button the user
activated is removed from the DOM, and focus falls to `<body>`. `render()`
restores focus only when it was already on an undo control
([drafts.js:207](../../options/drafts.js:207)).

A keyboard user deleting a draft loses their place and has to tab back in — and
the Undo they now need is 6 seconds from expiring.

**Fix.** Move focus to that row's Undo control, matching the bulk path.

**Resolution.** `beginDelete` calls `undoControlFor(draft.key)?.focus()` right
after the `render()` that replaces the row — the same accessor `render()`
already uses to restore focus, and the same intent as `beginDeleteAll`'s
`undoAllButtonEl.focus()`. The assertion was added to the existing `deleting
one draft is reversible and its Undo survives a live refresh` test and
confirmed to fail against the unfixed `drafts.js` (`AssertionError: deleting a
draft must not drop focus to the document body`) before being confirmed green
with the fix.

### F8 — The GitHub panel re-queries GitHub on every window focus, and can destroy a confirmation the user is reading

[github.js:573](../../options/github.js:573) listens on `window.focus`, clears
`currentAscentSummary`, and re-runs the whole flow. `renderAscentConnected` then
calls `refreshAscentSummary`, which paints "Checking existing backups…" and
sends `GITHUB_ASCENT_BACKUP_SUMMARY` — a real GitHub API call
([`githubAscentBackupSummary`](../../src/background/github-routes.js:534) →
`client.getAscentFolders()`).

So with Settings open and ascent backup connected, **every alt-tab back to the
browser costs one GitHub API request and one visible "Checking…" flash.**

Worse: [`renderExistingRepoConfirmation`](../../options/github.js:184) sets
`choosingRepo = true`, and the focus handler branches on that flag straight into
`refreshRepos({ choose: true })` — which replaces the panel. Focus another
window while reading "*owner/repo* already contains files" and come back, and
the confirmation is gone.

**Fix.** The focus listener exists for one reason: the user returns from
GitHub's install page. Scope it to that — arm it when a GitHub tab is opened,
disarm it once consumed — and never let it run while a confirmation is
displayed. Cache the ascent summary with a short TTL rather than invalidating
it on focus.

### F9 — A transient poll failure declares the capture dead and shows browser-internal text — **fixed**

[popup.js:237](../../popup/popup.js:237): `poll()`'s catch calls
`errorState({ message: error.message })`. Three things follow from one failed
tick:

- The card reads "Capture stopped" while the worker is very likely still
  running the capture — `poll()` only reschedules itself for non-terminal
  phases, so this is exactly the in-progress window.
- `error.message` is rendered as user copy. A torn-down MV3 worker produces
  "Could not establish connection. Receiving end does not exist." — browser
  internals, shown as an explanation.
- The catch schedules no further tick and leaves `pollTimer` as it was, so the
  popup never recovers on its own even when the capture completes. The only way
  out is "Try again", which calls `beginCapture(true)` and force-restarts a
  capture that may have been seconds from finishing.

**Fix.** Tolerate a small number of consecutive poll failures before declaring
anything, keep the current card underneath while retrying, and never put a raw
`error.message` from runtime messaging into the card's detail line.

**Resolution.** `poll()` now counts consecutive failures against
`POLL_FAILURE_TOLERANCE = 5` (≈2.2 s at the 450 ms tick), reschedules itself
under the untouched current card while under the threshold, and resets the
counter on any successful tick — so the popup recovers on its own when the
worker wakes back up. Past the threshold it renders "Couldn't reach the
extension / The capture may still be running. Check again in a moment." with a
**Check again** action that calls `beginCapture(false)`; the non-forced start
reuses a fresh job (`background.js:409`) instead of destroying a capture that
was seconds from finishing. The cause goes to `console.warn`, never the card.

Beyond the finding as written: `beginCapture`'s own `.catch` two lines below
leaked `error.message` the same way, on the same surface, for the same reason
(the worker reports its real failures as a `phase: 'error'` job, so a rejection
there is the messaging layer). It got the same treatment rather than being left
as a known copy of the defect.

Regression tests: `popup rides out a transient poll failure instead of
declaring the capture dead` (two failed ticks mid-capture, then recovery
without user action, asserting the raw string reached the log and not the card)
and `popup gives up on a sustained poll outage with recoverable, plain copy`
(asserting **Check again** sends `force: false`).

---

## B. Dark mode and accessibility

### F10 — Non-date sort headers become boxed buttons in dark mode — **verified** · **fixed**

Every ascent-list column control is a `<button class="pbaf-table-sort">`; the
date column additionally gets `pbaf-date-sort`
([ascent-filter.js:353](../../src/ascent/ascent-filter.js:353)). The dark
stylesheet overrides only `button.pbaf-date-sort`
([site-dark-css.js:167](../../src/theme/site-dark-css.js:167)). Every other
header falls through to the generic form-control rule at
[site-dark-css.js:125](../../src/theme/site-dark-css.js:125), whose
`!important` beats the light `.pbaf-table-sort` rule.

Computed styles in one dark document:

```
NON-DATE header : color #e6e1d8   background #2b2f34   border 1px solid #4a5058
DATE header     : color #7ab6ff   background transparent   border 0
```

In light mode both are bare underlined navy links. In dark mode the Date column
is a link and every other column is a grey box — inside a table header.
`test/theme/dark-contrast.test.mjs` pairs only `button.pbaf-date-sort`, so
nothing catches it.

**Fix.** Give `.pbaf-table-sort` a dark rule alongside `.pbaf-date-sort`, and
extend the grounded-selector list in the contrast test to cover it.

**Resolution.** Landed with the F13 consolidation, which is where the fix
belongs — see [F13](#f13--the-beta-filter-bars-theme-has-two-owners-in-two-files--fixed)
for the token change, the `pbaf-control` exemption that made the dark rule
unnecessary rather than merely present, the extended contrast pairs, and the
rendered dark PeakAscents check showing both header kinds now computing to the
same colour, background, and border.

### F11 — Focus rings in the beta-filter bar fail WCAG AA in dark mode — **verified**

`.pbaf-chip:focus-visible`, `.pbaf-reset:focus-visible`,
`.pbaf-table-sort:focus-visible`, and `.pbaf-words input:focus-visible` all use
`outline: 2px solid #2f6b3f` ([ascent-filter.js:404](../../src/ascent/ascent-filter.js:404)
and following). There is no dark override, so in dark mode that ring sits on the
bar's `#23262a` background:

| pair | ratio | required |
| --- | --- | --- |
| `#2f6b3f` on `#23262a` (dark) | **2.38 : 1** | 3 : 1 (WCAG 2.1 §1.4.11) |
| `#2f6b3f` on `#ffffff` (light) | 6.37 : 1 | 3 : 1 ✓ |

The dark-contrast test checks text pairs only; focus indicators are outside its
pairing table.

**Fix.** Add a dark focus color (the bar's own dark accent `#69b58a` is 5.4:1
and already in the palette) and add a non-text-contrast section to
`dark-contrast.test.mjs` so focus rings are guarded the way text is.

### F12 — A dark rule ships for an element the code no longer creates — **verified** · **fixed**

[site-dark-css.js:141](../../src/theme/site-dark-css.js:141) styles
`.pbaf-divider`. That class appears nowhere in `ascent-filter.js`, and
`test/ascent/ascent-filter.test.mjs:85` asserts the divider is *absent* from the
bar. Dead CSS shipping in the injected stylesheet.

**Fix.** Delete the rule. The "grounded pairings" test already exists for this
class of problem — extend it to assert every `.pbaf-*` selector in the dark
sheet matches a real element in a fixture.

**Resolution.** The rule died with the F13 consolidation — the whole `.pbaf-*`
block left `site-dark-css.js` and `.pbaf-divider` was not carried over. The
guard the fix asks for is stronger than proposed: rather than extending a
hand-maintained list, the grounding test now derives the styled class list from
the bar stylesheet itself, so any future dead selector fails without anyone
remembering to add it. Verified by temporarily re-adding a `.pbaf-divider`
rule and watching the assertion fire.

---

## C. Structural stinks

### F13 — The beta-filter bar's theme has two owners in two files — **fixed**

The light palette is a JS template string inside
[`ascent-filter.js`](../../src/ascent/ascent-filter.js:393); the dark palette is
a separate block of per-property `!important` overrides in
[`site-dark-css.js`](../../src/theme/site-dark-css.js:133). Nothing binds them.
Counting the classes each file defines:

- light-only, no dark rule: `.pbaf-chip-label`, `.pbaf-spacer`,
  `.pbaf-sort-arrow`, `.pbaf-table-sort`, `.pbaf-tick`
- dark-only, no light class: `.pbaf-divider` (F12)

F10, F11, and F12 are all instances of this one split. Every new control needs a
developer to remember a second file, and nothing fails when they don't.

**Fix.** Move the bar to CSS custom properties defined once, with the dark
values supplied under the existing `html[data-bpb-theme="dark"]` scope. The
`!important` overrides then collapse into variable reassignment, and a missing
dark value becomes impossible rather than merely unlikely. This is the highest
structural leverage in the plan — it retires a whole failure class.

**Resolution — F13, F10, and F12 landed as one change**, because they are one
change: the plan's own text says F10, F11, and F12 are instances of the split,
and once the split is closed the missing dark values *are* the consolidation.
Splitting them would have meant an intermediate commit where the non-date
headers rendered navy-on-dark, which is worse than today.

`src/ascent/ascent-filter.js`'s `STYLE` now declares **24 `--pbaf-*` tokens** on
`:root` and reassigns every one of them under `html[data-bpb-theme="dark"]`, in
the same string, adjacent to each other. Every rule reads a token. The bar's
`.pbaf-*` block is deleted from `src/theme/site-dark-css.js`, which carries a
comment saying not to reintroduce it.

The blanket `input`/`button` repaint in the site sheet was the reason the old
overrides needed `!important` at all, so extension-owned bar controls now opt
out of it via a `pbaf-control` marker class — the same exemption idiom the sheet
already used for `.bpb-re-swatch`, with the same rationale. That is what lets
dark mode be pure variable reassignment. One `!important` survives, on
`#pbaf-bar .pbaf-note a`, because a link cannot carry the exemption without also
opting out of the site's link semantics elsewhere; it is commented in place.

Two intentional behaviour changes fell out of the consolidation, both
improvements: a disabled chip in dark mode now uses an explicitly muted
`#a29c92` rather than the enabled colour at 55 % opacity, and non-date sort
headers gained the hover colour the date header already had.

Three new guards, all in `test/theme/dark-contrast.test.mjs`:

1. The bar's contrast pairs are now resolved *through the tokens* out of
   `ascent-filter.js` — the file that declares them — and the pair table grew
   to cover `.pbaf-table-sort` (F10), its hover, the disabled chip, the words
   input, and the reset hover. A parallel `LIGHT_PAIRS` table checks the same
   pairs in light mode, since one file now owns both.
2. `every filter-bar theme token has a dark counterpart` asserts the two token
   sets match in both directions, that every colour the bar paints goes through
   a token rather than a literal, and that `site-dark-css.js` declares no
   `.pbaf-*` rules again.
3. The grounding test now derives the class list from the stylesheet itself
   instead of a hand-maintained array, so **any** styled `.pbaf-*` selector with
   no matching fixture element fails. Re-adding a `.pbaf-divider` rule was
   confirmed to fail it: *the filter-bar stylesheet styles ".pbaf-divider",
   which no fixture element matches*.

**Rendered verification** — the plan states a real dark PeakAscents render is
the only thing that can prove F10, and the hidden verifiers cannot establish
it. Done: headless Chrome for Testing, real unpacked `dist/`, the HTTPS fixture
server from `scripts/browser-verification-fixtures.mjs` mapped to
`www.peakbagger.com`, theme switched to Dark through the extension's own
settings page, at `PeakAscents.aspx?pid=1039` (12 sort headers). Computed
styles on the rendered page:

```
NON-DATE header : color rgb(122,182,255)  background rgba(0,0,0,0)  border none
DATE header     : color rgb(122,182,255)  background rgba(0,0,0,0)  border none
```

Identical, against this finding's recorded before-state of `#e6e1d8` on
`#2b2f34` with a `1px solid #4a5058` border. The screenshot confirms every
column header is a bare underlined blue link, and the bar itself renders on
`#23262a` with the pressed chip on `#2f6b3f`.

### F14 — `gpx-analyzer.js` is one 1,190-line closure with two theming systems

[`initChart`](../../src/gpx/gpx-analyzer.js:159) runs from line 159 to 1349 and
owns: map viewport resize (pointer drag, keyboard steps, debounced persist),
panel construction, panel theming, the Chart.js instance and all its callbacks,
terrain coordination and consent, the Leaflet route overlay, map-layer
preference sync, timezone resolution, and GPX parsing. It carries ~35 mutable
closure variables.

Concrete consequences, all in this one file:

- **Two theming systems.** `PALETTES` + `applyPanelTheme()` (JS, inline styles)
  for the panel; `data-theme` + `terrain-map.css` for the floating 3D toggle.
- **Three copies of the same selector.** The MasterMap iframe query appears at
  [:171](../../src/gpx/gpx-analyzer.js:171), inside
  [`findMapIframe`](../../src/gpx/gpx-analyzer.js:755), and again inline in the
  chart's `onHover` at [:1071](../../src/gpx/gpx-analyzer.js:1071) — the last of
  which re-queries the DOM on **every hover event**.
- **Manual bookkeeping.** `appliedSettings = { ...BPB.get() }` is repeated after
  six separate `BPB.set()` calls; forgetting one silently breaks the
  change-detection in the subscriber.
- **One string, two literals.** `"Double-click point to copy coordinates"` is
  written at [:425](../../src/gpx/gpx-analyzer.js:425) and again at
  [:486](../../src/gpx/gpx-analyzer.js:486).
- **Typography drift.** `"Analyzing GPX data..."` and
  `"Double-click point..."` use ASCII ellipses and title case, against the
  polished `…` copy used in the popup and settings page.

**Fix.** Extract in the order that reduces risk fastest, one commit each:
`mapViewport` (resize + persist + invalidate), then the route overlay and layer
sync, then the panel + palette. Move the panel's inline styles into a real CSS
file the way `terrain-map.css` already works, so the JS palette can be deleted
rather than duplicated. Hoist the iframe accessor to one memoized function.
Fold `appliedSettings` into the `BPB` client so callers cannot forget it.

### F15 — Unit conversion is duplicated four times, and "auto" is detected two different ways

`FEET_PER_METER = 3.28084` and `METERS_PER_MILE = 1609.344` are redeclared in
`capture/capture-core.js`, `ascent/ascent-draft.js`, `ascent/ascent-upload.js`,
and `gpx/gpx-analyzer.js`.

More consequential: resolving `units: 'auto'` against the page is implemented
twice, with **two unrelated heuristics**:

| module | heuristic |
| --- | --- |
| [`detectPageMetric`](../../src/gpx/gpx-analyzer.js:137) | finds the `Elevation:` cell, tests its sibling for an `m` suffix |
| [`detectPageUnits`](../../src/ascent/ascent-upload.js:91) | reads the DOM order of the `#UpMi`/`#UpKm` and `#StartFt`/`#StartM` field pairs |

They run on different pages today, so they cannot visibly disagree — which is
precisely why a divergence would ship unnoticed. AGENTS.md already names this
pattern ("shared math must stay there so drafted and displayed values cannot
diverge"), and the 2026-07-23 round removed
`applyBuddyMutationToFavorites` for being the same shape of duplicate.

**Fix.** One pure `src/ui/units.js`: the constants, `formatDistance` /
`formatElevation` / `formatApproach`, and a `resolveUnits(settings, probe)`
that takes the page probe as an argument so each surface supplies its own
detector against one contract. F3 consumes it from the popup.

### F16 — The shared DOM builder is adopted by a quarter of the UI

`src/ui/dom.js` exports `element()` and is imported by exactly four modules:
`profile-backup.js`, `ascent-backup.js`, `report-editor.js`, and
`options/github.js`. The other twelve UI modules hand-roll
`document.createElement` + `setAttribute` + `append` — `gpx-analyzer.js` 21
times, `ascent-upload.js` 20, `ascent-filter.js` 18, `popup.js` 12,
`options/drafts.js` 11, `options/favorites.js` 10.

Half-adopted idioms are worse than none: a reader cannot tell whether a file
uses `element()` without checking, and the builder's conveniences (event props,
`text`, null-child filtering) are re-implemented ad hoc in each holdout.

**Fix.** Either adopt it in the surfaces being touched anyway (F1, F6, F7, F14
all edit these files) or decide it is options-page-only and say so in a comment.
Do not leave the split undocumented. This is cleanup that should ride along with
other work, never its own commit.

### F17 — Fixed-attempt polling gives up silently

[`scheduleRouteOverlay`](../../src/gpx/gpx-analyzer.js:934) and
[`scheduleMapLayerSync`](../../src/gpx/gpx-analyzer.js:920) both retry
`setInterval(…, 250)` for exactly 20 attempts, then stop. On a slow load the
extension's route overlay never appears and the remembered map layer is never
applied — with no error, no retry, and no signal that a feature silently did not
run. AGENTS.md makes this argument about test fixtures ("gate on the condition,
never on a fixed sleep"); it applies at least as strongly to shipped code.

**Fix.** Gate on the condition instead: a `MutationObserver` on the map
container plus the existing iframe `load` handler covers late frames without a
wall-clock budget. Keep a generous ceiling as a backstop only.

### F18 — Two tab-opening helpers with different failure behavior in one file

[options/github.js:73](../../options/github.js:73) defines `openTab` (uses
`window.open`, and swallows a popup block in `catch { /* popup blocked */ }`)
and [:74](../../options/github.js:74) defines `createTab` (prefers
`tabs.create`, falls back to `openTab`). GitHub URLs go through `openTab`;
Peakbagger URLs go through `createTab`. So clicking **"Open
github.com/login/device"** — the single action the whole device-flow depends on
— can do nothing at all, with no message, if the browser blocks the popup.

**Fix.** Route everything through `createTab` and report the failure the way the
Peakbagger path already does.

---

## Proposed sequencing

Each stage is independently shippable and independently verifiable. Commit per
finding, not per stage.

**Stage 1 — user-facing correctness (F1, F5, F9).** Start here: F1 is the only
finding where the product tells the user something untrue. Add the missing
popup transition test first, watch it fail, then fix both layers. Establish the
Firefox `tabs.group` answer before rewriting F5's copy.

**Stage 2 — the feedback channel (F2, F4, F7, F6).** F2 is one component change
that repairs 28 paths, so it precedes the others; F4 then has a place to put its
message, and F6/F7 are small once the confirmation and focus patterns are the
ones already in use.

**Stage 3 — dark mode (F13 first, then F10, F11, F12).** Do the custom-property
consolidation *before* the individual fixes: done in the other order, F10–F12
are three patches to a structure that is about to be replaced. Extend
`dark-contrast.test.mjs` with a non-text-contrast section and a
"every dark `.pbaf-*` selector matches a fixture element" assertion, so this
class of defect cannot return.

**Stage 4 — shared idioms (F15, F3, F14, F17, F8, F18).** F15 lands the units
module; F3 immediately consumes it. F14 is the largest single item and should be
several commits with the suite green at each — it is refactoring with no
behavior change, so any test movement is a signal to stop.

## Verification plan

Per commit: `npm run lint:js` and `npm test`, run against **the commit**, not
the working tree — the D7 failure in the 2026-07-23 round came from exactly that
gap.

Per stage:

- Stages 1 and 2 touch the popup, worker routes, and the options page:
  `npm run verify:chrome` and `npm run verify:firefox`.
- Stage 3 touches the injected site theme: `npm test` covers the contrast and
  grounding assertions, but a rendered dark PeakAscents page is the only thing
  that proves F10's header controls actually look right. This needs a real
  render; the hidden verifiers cannot establish it.
- Stage 4 touches content scripts and `scripts/build-config.mjs`:
  `npm run verify:extension` is mandatory (it is the only check that loads the
  real manifest), plus `npm run terrain:verify` for F14.

## Known gaps in this plan

- **No rendered visual review informed any finding here.** F10 and F11 were
  established from the cascade and the color math, which is sound for *what
  color a rule computes to* but says nothing about how the bar looks at real
  widths. F2's central claim — that the status line sits below the fold — is
  derived from `overflow-y: auto` on `.content` and the absence of any sticky
  rule; it should be confirmed on screen before the fix is designed.
- **The Firefox `tabs.group` question is open** and gates part of F5.
- **F14 has no behavioral test to protect it.** The GPX Analyzer's coverage is
  thin relative to its size, and the extraction is proposed on the strength of
  the suite plus `terrain:verify`. If that feels too thin when the work starts,
  characterization tests come before the refactor, not after.
- **Effort was not estimated.** The sequencing reflects risk and dependency
  order only.
