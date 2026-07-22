# Codebase audit — 2026-07-22 follow-up

Scope: verification of every item in the executed
[codebase-audit-2026-07-22](../archive/codebase-audit-2026-07-22.md) (21
commits, `29ade5b..909328d`), then a fresh read of the refactored background
worker (`background.js`, `github-routes.js`, `terrain-prefetch.js`), the popup,
all options-page modules and the new shared modules (`options-utils.js`,
`section-nav.js`, `panel-theme.js`, `theme-resolve.js`, `capture-phases.js`,
`ui/dom.js`), the GitHub client/auth/backup domain, and the ascent-backup,
ascent-upload, and profile-backup content surfaces. Baseline: clean tree at
`909328d`; `npm test` passes (692/692); `npm run lint:js` is clean.

## Verification of the executed 2026-07-22 plan

All 18 execution steps landed or were deliberately closed:

- **B1–B5, U1** verified in code: popup honors `data-bpb-theme` with pre-paint
  bootstrap and explicit light/dark overrides; `no-matches` and `no-gps` both
  offer "Check again" wired to a forced capture; the singular draft label
  survives error recovery; opened jobs stay reachable via "Show opened drafts";
  the settings-backup panel gates on `permissionGranted && connected`; the
  spinner honors reduced motion.
- **E1–E10** verified: the worker is a 1,171-line coordinator delegating to
  injected `github-routes`/`terrain-prefetch` modules; draft opening shares
  `prepareDraftSelection`/`makeDraft`/`openNewDraftTabs`; terminal phases,
  theme resolution, storage keys, and the options DOM/messaging helpers each
  have one owner with guard tests; missing-element failures log loudly;
  `github-error-copy.js` is unambiguous.
- **U2–U4** verified in `options.html` and `github.js` copy; the E5 undo-
  machinery item was closed with a recorded rationale rather than forced, which
  was the plan's stop condition working as intended.

One process note: eleven of the commit bodies contain literal `\n\n` escape
sequences instead of blank lines (e.g. `4c1695c`, `44acb55`) — the body text
was passed through a shell layer that does not interpret escapes. History
stays as-is; future codex commits should use real newlines (heredoc or `-F`)
so `git log` renders the explanatory style AGENTS.md asks for.

Overall: the refactors are high quality. The findings below are almost all
new observations in seams the refactors did not reach, plus two behavior gaps
adjacent to the fixes that landed.

---

## 1. Bugs and behavior contradictions

### B1 — Changing the selection after drafts open silently does nothing
**Severity: medium · [popup.js:141-148](../../popup/popup.js),
[popup.js:187-189](../../popup/popup.js),
[background.js:609-617](../../src/background/background.js)**

In the `opened` phase the peak checkboxes stay live. Any change runs
`refreshSelection`, which relabels the button back to "Open N drafts" and
stores the new selection (`updateSelection` accepts the `opened` phase). But
`openDrafts` short-circuits whenever fresh drafts exist for the job: it
refocuses the existing tabs and returns `reused: true` without comparing the
requested selection. The user asks for "Open 3 drafts" and gets a refocus of
the original 2. The popup test pins the refocus but never exercises a changed
selection, so this survives the suite.

Fix (smallest honest change): while the job is `opened` (and `previewed`),
disable the checkboxes and stop `refreshSelection` from clobbering the
"Show opened drafts" label; add one hint line ("Delete captured track data to
change the selection" — the button for that is already on screen). The
alternative — diffing the selection and opening only the missing drafts —
touches suffix reassignment and trip-info sequencing and is not worth it.
Popup regression test for the changed-selection click.

### B2 — `previewed` strands a user who lost their draft tabs before Save
**Severity: medium-low · [popup.js:190-193](../../popup/popup.js),
[background.js:599](../../src/background/background.js)**

After GPS Preview completes on every draft, the drafts still need the user's
manual Save — that is the product's core promise. Yet at exactly that moment
the popup shows a disabled "Preview submitted" button, and the background gate
(`!job.uploadGpx || (phase !== 'ready' && phase !== 'opened')`) throws for
`previewed` jobs, so the refocus path that B5 restored for `opened` is
unreachable one phase later. A user who lost the draft tabs among their others
has no way back to them.

Fix: in `openDrafts`, run the existing-drafts refocus path for any fresh job
whose drafts still exist, before the `uploadGpx`/phase gate (opening *new*
tabs keeps the strict gate). In the popup, keep the button enabled as
"Show opened drafts" in `previewed` while drafts remain, and handle the
all-tabs-closed error with the existing error-card pattern. Background + popup
tests.

### B3 — Settings-backup GitHub panel goes stale after an in-page repo selection
**Severity: low · [settings-backup.js:124-131](../../options/settings-backup.js),
[settings-backup.js:170-181](../../options/settings-backup.js),
[favorites.js:814-823](../../options/favorites.js)**

`refreshGithub` runs once at first populate and then only on window `focus`.
Connecting a repository happens *inside the same options page* (choose-repo →
`selectRepo`), which fires no focus event, so the panel keeps saying "Connect
GitHub above to back up settings." until the user clicks away and back. The
favorites panel already solved this correctly by watching the exported
`bpbGithubAuth`/`bpbSettings` storage keys — the two sibling panels diverge
again, one audit after B3 (permission gating) made them match.

Fix: add the same `storage.onChanged` subscription favorites uses (the keys
are already exported), keeping the focus refresh for the permission-revocation
case that storage events cannot see. Options test.

### B4 — Ascent-form Apply can hang forever if the worker is unreachable
**Severity: low · [ascent-upload.js:207-234](../../src/ascent/ascent-upload.js),
[ascent-upload.js:362-369](../../src/ascent/ascent-upload.js)**

`applySelection` awaits `ext.runtime.sendMessage` with no rejection handling,
and the card's click handler invokes it with `void`. `processFile` wraps its
own send in try/catch, but on the apply path a rejected promise (extension
reloaded, worker torn down mid-request) leaves the card's buttons disabled at
"Filling form…" with no way out. Wrap the send like `processFile` does and
route failures through the existing `fail()`.

---

## 2. Engineering smells

### E1 — Three `sendMessage` wrappers, two contradictory portability claims
[options-utils.js:4-13](../../options/options-utils.js) (callback form),
[profile-backup.js:21-25](../../src/profile/profile-backup.js) (callback
form), and [ascent-backup.js:30-35](../../src/ascent/ascent-backup.js)
(promise form, with a comment asserting the callback form "is not portable to
Firefox's browser namespace"). The comment is contradicted by the repo's own
Firefox verification, which asserts the profile-backup panel mounts — and it
can only mount if the callback form works on `browser.runtime.sendMessage`.
So either the comment is wrong, or the Firefox check is passing for the wrong
reason; both are bad states to leave in place. The 07-22 audit's E5
consolidated the options-page copies but stopped at the content-script
boundary.

Fix: one shared helper module (settings-schema-style, bundleable into the
content and page bundles alike — `src/ui/` already plays this role for the
DOM builder), used by all three call sites, with one comment stating the
verified cross-browser truth. Verify with `npm run verify:extension` and the
Firefox verification, since this touches every backup surface's messaging.

### E2 — The repository marker's base64 twin is hand-encoded and unguarded
[github-client.js:34-39](../../src/github/github-client.js)

`REPOSITORY_MARKER_CONTENT` (written into trees) and
`REPOSITORY_MARKER_BASE64` (used both to validate an existing marker blob and
to seed an empty repository) must encode identical bytes, but nothing checks
this — no test decodes the constant (verified: none references it). If the
JSON literal is ever edited without re-encoding, every repository initialized
by the new build fails the old build's marker validation (and vice versa) with
`REPO_CONFLICT` — a self-inflicted lockout that no unit test would catch. The
module already uses `atob`, so compute one constant from the other at module
load (`btoa` exists in the worker, jsdom, and Node), or pin equivalence with a
one-line test. Computing is better: it deletes the twin instead of guarding it.

### E3 — `drafts.js` self-initializes and double-owns the `#status` element
[drafts.js:39-44](../../options/drafts.js),
[options.js:54-60](../../options/options.js)

Every other options module exports an `init*({ flash, save })` that
`options.js` composes; `drafts.js` is a self-running IIFE that grabs
`#status` directly and runs its own show/hide timer — 2,200 ms against the
controller's 1,200 ms, each clearing only its own timer. Concretely: delete a
draft, then toggle any setting inside the next second, and the controller's
timer hides "Draft restored" early. Convert to `initDrafts({ flash })` (its
messages pass through one owner with one duration) — this also removes the
one module the missing-element logging (E6) treats differently, since it
`return`s instead of returning a no-op `populate`.

### E4 — Dead `unsupported` branch in the popup's error actions
[popup.js:66-73](../../popup/popup.js), [popup.js:96](../../popup/popup.js)

`errorState` returns early for `code === 'unsupported'`, so the
`code === 'unsupported'` half of the final actions ternary is unreachable.
Delete it when touching the popup for B1/B2 — no dedicated commit.

### E5 — Nits (fix when adjacent code is touched)
- `'bpbThemePref'` is declared independently in
  [panel-theme.js:10](../../src/theme/panel-theme.js) and
  [theme.js:32](../../src/theme/theme.js). The two mirrors live in different
  origins (extension pages vs peakbagger.com), so they are *not* shared state
  — but the identical literal implies they are. Either export one constant
  both import, or add a one-line comment to each stating the origins differ
  on purpose.
- `settings.js`, `github-auth.js`, and `github-client.js` carry a leftover
  4-space top-level indent from their IIFE-to-module conversion. A
  whitespace-only commit is cheap but churns blame; owner's call — if done,
  do all three in one mechanical commit with no other changes.

---

## 3. UX — counterintuitive or unpolished

### U1 — Favorites "Restore from backup" replaces the list with no impact preview
**[favorites.js:635-652](../../options/favorites.js)**

The three destructive replacements of the custom favorites list have three
different ceremonies: Mirror shows a confirmation with exact added/removed
counts and a signature recheck; settings restore shows an import confirmation;
favorites restore replaces the list *immediately* on click, with only the
6-second undo between the user and a fully rewritten 1,500-entry list. The
mirror dialog exists because bulk removals deserve a preview — a GitHub
restore can remove just as much.

Fix: route the restore through the same confirmation pattern —
`membershipChanges(favorites.entries, parsed.favorites.entries)` already
computes the counts — with copy like "N favorites will be added, M removed.
The list will match the backup from ⟨repo⟩." Keep the undo afterward. Reuse
the mirror-confirmation styling; do not invent a second dialog design.

### U2 — "Possible and weak results are intentionally hidden" names internal tiers
**Severity: low, owner call · [popup.js:213](../../popup/popup.js)**

The visible vocabulary everywhere else is Strong and Probable; "Possible" and
"weak" are the detector's internal classifications and appear nowhere else in
the UI. Suggested: "Only Strong and Probable matches are shown, and nothing
met that bar for this track. Nothing was opened or uploaded." Copy-only,
bundled with any other popup commit.

### What's already good (keep it)
- The B5 "Show opened drafts" reuse path, mirror confirmation, per-item and
  bulk undo, and fail-closed gating all held up under this re-read; B1/B2
  above are gaps *beside* those fixes, not regressions in them.
- The four extracted shared modules all follow the established pure-module
  pattern, and each landed with a guard test that fails on a reintroduced
  local copy — exactly the settings-schema discipline the audit asked for.
- `github-routes.js` kept every sender gate and the serialized write queue
  injected rather than re-created; the worker split introduced no new
  authority.

---

## 4. Execution plan

Each numbered step is one focused commit (AGENTS.md discipline: `npm test`
before every commit; `npm run verify:extension` for steps touching bundle
composition or worker messaging; hidden real-browser visual pass for UI
steps).

### P0 — housekeeping
1. Move the fully executed `codebase-audit-2026-07-22.md` to `docs/archive/`
   per the plans-directory contract, updating its inbound links.
   *(Done in the same change that records this audit.)*

### P1 — behavior fixes (small, independent)
2. **B1 + E4 + U2**: opened/previewed selection lock in the popup, dead-branch
   removal, and the no-matches copy tweak (copy pending owner approval — drop
   that hunk if declined); popup test for the changed-selection click.
3. **B2**: refocus path for `previewed` jobs with surviving drafts; background
   + popup tests, including the all-tabs-closed fallback.
4. **B3**: storage-key subscription in the settings-backup panel; options test
   for in-page repo selection updating the panel without a focus event.
5. **B4**: rejection guard on `applySelection`; ascent-upload test with a
   rejecting `sendMessage`.

### P2 — engineering
6. **E1**: shared runtime-messaging helper across options-utils,
   ascent-backup, and profile-backup; one verified portability comment.
   Gate: `npm run verify:extension` **and** the Firefox verification, both
   asserting the GitHub/profile surfaces still mount.
7. **E2**: derive `REPOSITORY_MARKER_BASE64` from `REPOSITORY_MARKER_CONTENT`
   (or pin equivalence in `test/github`); pure, no behavior change.
8. **E3**: `initDrafts({ flash })` composition; single `#status` owner; keep
   observable draft-manager behavior identical (the focused tests already pin
   it).

### P3 — UX
9. **U1**: impact-count confirmation on favorites restore, reusing the mirror
   dialog pattern; options test asserting the counts and that cancel leaves
   the list untouched; visual pass at regular and narrow options widths.

### E5 nits
No dedicated commits; apply when the named files are already being touched,
except the optional indentation normalization, which — if the owner wants it —
is one mechanical whitespace-only commit.

### Explicitly out of scope
- Undo-machinery unification and popup polling — closed in prior audits with
  rationale that still holds.
- Mixed `www.`/bare `peakbagger.com` URL literals — both hosts are in
  `host_permissions`; normalizing would churn many files for no behavior
  change.
- `test/options/options.test.mjs` (1,843 lines) and
  `scripts/verify-extension.mjs` (1,916 lines) are large but cohesive test
  tooling; splitting them risks more than it buys today.
- Rewriting the `\n\n` commit bodies — history is immutable here; the process
  note above is the fix.
