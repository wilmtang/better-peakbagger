# Codebase audit — 2026-07-23 (ascent sync UX round)

Scope: the four reported ascent-lifecycle and backup-UX defects, then a full
read of the paths they touch — the saved-ascent router, the GitHub ascent
backup status machine and auth store, draft identity and the trip-report draft
lifecycle, the custom-favorites mutation paths, the settings store and its
cross-world bridge, and the analyzer's inline controls. Baseline: clean tree at
`a788d13`; `npm test` 692 passing.

Executed in 15 commits, `144cb0a..cb2846a`. The first six landed during the
audit session; the session then hit its provider usage limit mid-pass, leaving
the remaining work uncommitted. The last nine commits are that work reviewed,
corrected, split, and verified.

## Execution result

The four reported problems are fixed. The broader pass found and fixed five
further defects — three of them data-integrity bugs rather than cosmetics —
plus one broken commit the audit session itself introduced.

Final verification on the completed tree (`cb2846a`):

- `npm test`: 760 passed, 0 failed.
- `npm run lint:js`: clean.
- `npm run lint` (web-ext lint on `dist/`): 0 errors; the pre-existing
  `innerHTML` notice is unchanged.
- `npm run package`: produced `web-ext-artifacts/better_peakbagger-3.1.0.zip`.
- `npm audit`: 0 vulnerabilities.
- `npm run verify:chrome`: passed. Hidden Chrome for Testing, new headless,
  real unpacked MV3 `dist/` — the MV3 worker booted, storage and the
  cross-world bridge round-tripped, and the analyzer, favorites, filter, draft,
  and trip-report surfaces all initialized from the real manifest load order.
- `npm run verify:firefox`: passed. Hidden/headless Firefox 153.0 at 1000×760.
- Every one of the nine new commits was checked out in a scratch worktree and
  run individually: `eslint` clean at all nine; test results as recorded in
  each commit message.
- After the verifiers, no test browser, helper process, or disposable profile
  remained. The only Firefox processes on the machine belong to the user's own
  `default-release` profile, which was never touched.

## The four reported problems

### 1. Saved ascent sometimes jumps to `ascent.aspx?aid=1` — fixed (`144cb0a`)

Root cause: the saved-ascent router trusted the first numeric `aid` it found
anywhere on the page, and Peakbagger emits `1` as a fallback/sentinel in some
post-save markup.

`aid=1` was checked against the live site before choosing a fix: it is a real
1910 Denali record, so special-casing the value would have been a hack that
also breaks for whoever legitimately views that ascent. The fix narrows the
trusted sources instead — only the edit URL or the unique success-panel "Add
Photos" link — and refuses to navigate when they disagree. Fail closed.

### 2. Mirror ascent deletion into GitHub — fixed (`633062a`, `1ccf14f`)

Added as an explicit opt-in setting, implemented as a two-phase transaction:
record intent on the native Delete submit, then require Peakbagger's
authenticated all-years ascent list to prove the ascent is actually gone before
touching GitHub. Only extension-owned files are removed, so a `notes.md` or any
other user-added file in the backup folder survives. A tombstone blocks a stale
in-flight backup from resurrecting the deleted ascent.

The deletion is never inferred from a click. If Peakbagger's confirmation
cannot be obtained, nothing is deleted from GitHub.

### 3. "Backing up to GitHub" shown before "Checking GitHub" — fixed (`2bc9219`)

The status machine announced the terminal state before the check that decides
it. The panel now reports what is actually happening, in order.

### 4. Mountain name missing in options draft management — fixed (`2816327`)

Not a missing concept — the metadata existed. The draft label only read the
peak search box, which is normally empty on the edit page; the real page
exposes the name in its title. Draft identity now carries the name through.

## Defects found beyond the four reported

### D1 — Custom favorites lost concurrent edits (`bbaed22`)

Every surface wrote the custom list with its own `storage.local`
read-modify-write: the options manager, the climber-page star, and the
confirmed-Buddy sync. `storage.local` has no compare-and-swap, so two tabs
editing favorites raced and the later whole-object write silently discarded the
other's change. The options manager also enforced the 1,500-entry bound and the
duplicate check against its own rendered copy, so a concurrent addition could
truncate an existing tail entry during cleaning.

Fixed as an invariant, not with retries: `src/background/favorites-store.js` is
a single worker-owned mutation queue. Add, remove, and Buddy merge carry
*intent* and are applied to a fresh read, so independent operations compose.
Destructive replacements — mirror, GitHub restore, bulk Undo — must carry the
`backupSignature` of the list the user actually reviewed; a different current
signature is rejected as stale and returns the latest list unwritten.

### D2 — A transient settings storage failure could reset unrelated settings (`0b8917c`)

`settings.set()` was a read-modify-write in whatever context called it, and it
swallowed storage errors. Two distinct failures fell out of that:

- A failed read fell back to schema `DEFAULTS`, and the write that followed
  persisted those defaults merged with the patch. One transient `storage.sync`
  read failure could reset every setting the caller did not name.
- A failed write was reported as success — options controls, the settings
  import confirmation, and the analyzer's inline controls all displayed a value
  that storage never accepted.

Writes now go to the worker as a `SETTINGS_PATCH` operation with a single
authoritative read-clean-write queue. Reads stay deliberately fail-soft so a
page still renders; writes are deliberately not. Callers keep their last
confirmed settings and roll back on failure. The page-world write allowlist is
unchanged — the bridge still filters to the analyzer-owned keys before anything
leaves the isolated world.

### D3 — A storage failure was rendered as "GitHub disconnected" (`36c7ebf`)

The auth store swallowed every storage error: `read()` returned `null` on a
failed `get()`, `write()` dropped a failed `set()`, `clear()` ignored a failed
`remove()`. A `storage.local` failure was therefore indistinguishable from "no
credential stored", so Settings showed a disconnected panel for an account that
was still connected, and Disconnect announced success while the token was still
on disk.

Storage errors now propagate, disconnect returns the known cleared state rather
than re-reading the record it just removed, and every status consumer in the
options panel renders a retryable error instead of a false disconnected state.

### D4 — The delete-mirroring toggle reset on every reload (`dc59ab7`)

The GitHub options controller keeps a local settings snapshot for re-rendering,
and rebuilt it from only two of the three fields it needs.
`removeGithubBackupOnDelete` saved correctly and came back unchecked on the next
Settings load — the new opt-in from problem 2 looked like it did not stick.

Found during a visual review pass, which is the only reason it was caught: the
save path was correct and every test passed.

### D5 — Auto units were unreachable from the analyzer panel (`04728fa`)

Units default to Auto, which reads metric/imperial off the page. The inline
control listed only Imperial and Metric, so it rendered the *resolved* value as
though the user had chosen it, and once changed there was no way back to Auto
from the panel the user was looking at.

### D6 — Trip-report draft recovery could lose its only Undo copy (`05c201f`)

Draft recovery is now transactional: a transient storage failure can no longer
leave the user with neither the draft nor the copy that would have restored it.

### D7 — `05c201f` was committed broken

The audit session's last commit added both a "preference couldn't be saved"
status string and the test asserting it, but the change that makes
`settings.set()` actually reject was still uncommitted in the working tree. The
suite was run against the full tree, not against the commit, so this was not
visible. `main` has been red at `05c201f` since then; `0b8917c` clears it.

This is the one process failure worth naming: running the suite against the
working tree does not verify a partial commit. Every commit in this round's
nine was checked out and run on its own for exactly that reason, which is also
how the orphaned-helper lint error in an earlier draft of `0b8917c` was caught.

## Engineering cleanups

- `applyBuddyMutationToFavorites` was removed. Once the worker owned applying a
  confirmed Buddy action to the stored list, that function was a second
  implementation of the same semantics, reachable only from its own test — the
  classic drift setup. Its behavior stays covered where it now lives, in the
  climber-favorite tests that drive both removal policies end to end.
- `SETTINGS_PATCH` and `FAVORITES_MUTATE` were given one shared sender gate
  (extension pages and Peakbagger content scripts). `SETTINGS_PATCH` shipped
  ungated in the working-tree draft. Not reachable from page-world code, which
  cannot call `runtime.sendMessage` — but every neighbouring privileged route
  gates, and a mutation boundary should fail closed by construction rather than
  by an argument about what happens to be reachable today.
- `.label { cursor: pointer }` applied to non-interactive rows too; the terrain
  cache row carried a one-off `cursor: default` override for exactly that
  reason. Scoped to `label.label` and the override dropped.
- "Casing" — cartographic jargon nothing on the page explains — renamed to
  "Outline" in Settings and in the analyzer control. Setting keys and stored
  values unchanged.
- The settings import confirmation now stays open and retryable when
  persistence fails, cancels on Escape while idle but not mid-write, and
  returns focus to the control that opened it.
- `"type": "module"` declared. Every file the repo runs under Node was already
  an ES module; without the declaration Node parsed each directly-imported
  `src/*.js` as CommonJS, failed, and reparsed it.
- `web-ext` 10.5.0 plus two narrow `overrides` (`adm-zip` 0.6.0 under
  `firefox-profile`, `shell-quote` 1.9.0 under `fx-runner`) whose direct parents
  have not published a patched range. npm's own "fix" was an invalid web-ext
  downgrade. Build/packaging dependencies only — nothing here ships in `dist/`.

## Closure ledger

### Fixed and verified

Reported problems 1–4 (`144cb0a`, `2bc9219`, `2816327`, `633062a`, `1ccf14f`);
D1–D7 and every engineering cleanup above. Each has focused regression
coverage; the full suite, both real-browser verifiers, lint, package, and audit
all pass on the final tree; and each commit was independently checked out and
run.

### Intentionally not changed

- **Peakbagger's `aid=1` sentinel.** Rejecting the ID would break a real
  ascent record. The router validates its *sources* instead.
- **Deletion mirroring stays opt-in and off by default.** Owner choice.
  Deleting from a backup is destructive and should be asked for.
- **The favorites boundary is a race boundary, not durability.** A crashed
  worker or a rejected `storage.local.set()` still loses the in-flight
  operation. The caller reports that as a failure rather than absorbing it. A
  raw DevTools write can still bypass the queue; the next queued operation
  rereads it, and a reviewed replacement still fails its signature check.
- **The web-ext `innerHTML` lint notice.** Pre-existing, unrelated to this
  round, and not a defect in the flagged path.

### Changed but not fully proven

- **No rendered visual review of the new/changed UI at real page sizes.** Both
  verifiers are hidden/headless and prove behavior, DOM, and startup — not
  spacing, wrapping, clipping, or focus rings. Specifically uninspected: the
  analyzer's inline unit control with its new three-option width, the "Outline"
  labels in Settings and on the map control, and the settings-import
  confirmation in its new busy state. The audit session had a visual
  verification pass in flight — extending `scripts/verify-extension.mjs` with
  screenshot hooks for these controls — when it hit its usage limit. That
  extension was not completed and is the most useful next step.
- **The live delete-mirroring transaction has not been exercised against real
  Peakbagger.** The two-phase design, the confirmation requirement, and the
  extension-owned-files-only removal are covered by fixture and worker tests,
  and the shipped bundle boots in both browsers. An actual delete of an actual
  ascent with an actual GitHub repository has not been performed, deliberately:
  it is destructive and belongs to the owner.
- **`storage.sync` quota and throttling behavior under the new write path is
  unmeasured.** Writes are serialized through one worker queue now, which if
  anything reduces write frequency, but no quota testing was done.

## Loose ends

- Branch `temp` still points at `81ab7028` ("uncompleted codex ultra"), the
  user's safety commit of the interrupted working tree. Its content is fully
  represented in `main` and it can be deleted.
- The audit session left artifacts in `/tmp/bpb-*` — fetched Peakbagger HTML,
  response headers, and options-page screenshots. They are not referenced by
  any check and can be removed.
