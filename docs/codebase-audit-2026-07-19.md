# Codebase audit — 2026-07-19

Scope: full read of `manifest.json`, the background worker, all GitHub-backup
modules, the settings/bridge/theme layers, popup and options surfaces, the
report editor, capture core, provider page, and draft filling; targeted review
of the analyzer/terrain/filter surfaces; build config, hooks, and repo hygiene.
Baseline: `npm test` passes (367/367) on a clean tree at `188a3b4`.

Overall assessment: the codebase is in unusually good shape. The pure-module
boundaries (`capture-core`, `gpx-metrics`, `settings-schema`, `github-backup`)
are real and tested, privacy gates fail closed, and the docs match the code.
Most findings below are edge cases in the newest feature (GitHub backup) and
UX polish; nothing here is an exploitable security hole.

## Execution status

- **B1 — Done.** Save-time snapshots now ignore non-Save submitters; regression
  coverage includes GPS Preview, a Save click, and implicit submission.
- **B2 — Done.** Automatic backup accepts only ascent-ID or peak-and-date
  snapshot matches; the visible manual action retains the peak-only fallback.
- **B3 — Done.** The options UI detects a lost flow, while the worker persists
  pending device-flow state in `storage.session` and advances it one poll per
  status message; a worker-restart simulation covers successful resumption.
- **B5 — Done.** Every OS-dark semantic color is explicitly reset when the
  extension theme is light, with selector-completeness and contrast coverage.
- **B6 — Done.** Installation and repository discovery start at 100 items per
  page and follow validated GitHub `Link` pagination, with multi-page coverage.
- **B4 — Done.** Jobs without a recognized provider keep the neutral “Capture
  this activity” subtitle.
- **B7 — Done.** Login detection accepts multiple signed-in account controls,
  remains fail-closed, and ambiguous failures now describe verification rather
  than incorrectly asserting that the user is signed out.
- **E3 — Done.** Bare `web-ext` commands now use `dist`, and the obsolete
  root-packaging ignore list is gone.
- **E6 — Done.** Auth-store mutations are serialized so concurrent
  credential/account/repository writes cannot clobber one another, and
  structured non-2xx OAuth responses retain their typed GitHub error instead
  of being reported as a network outage. The duplicate disconnect branch is
  gone, and declarative page/resource matches now align with HTTPS-only host
  permissions. Arbitrary-case path matching remains deliberately narrow:
  broad manifest globs would inject large vendor and MAIN-world bundles into
  unrelated pages, while the known server-generated casings are covered.
- **E1 — Done.** Global cleanup no longer runs on every message. Contrary to
  the original audit premise, not every reader filtered expiry, so lazy gates
  were added for jobs, drafts, and snapshots before moving physical deletion
  solely to the existing alarm.
- **E4 — Done.** Pushes and pull requests now run lockfile installs, `npm test`,
  and bare `web-ext lint` against `dist` in a least-privilege GitHub Actions
  workflow.
- **E5 — Done.** ESLint 10 now checks source, options, popup, scripts, and tests
  in CI with the audit's three errors-only rules. The initial pass removed
  stale test/verification bindings and explicitly models the manifest-provided
  Chart.js global without weakening the rules project-wide.
- **E2 — Pending.**
- **U1–U2 — Done.** Unsupported pages now show a neutral, actionable empty
  state, and Settings is available from both that state and the header gear.
- **U4 — Done.** Draft notifications now use stylesheet-owned semantic classes,
  follow OS and explicit extension themes, expose CSS focus states, and respect
  reduced motion.
- **U5 — Done.** The device code is a labelled copy control with selection
  fallback, and the approval state shows a live expiry countdown that becomes
  an actionable expired-flow error.
- **U6–U7 — Done.** The casing input exposes its route-relative minimum;
  popup deletion copy names the captured track data; and denied GitHub access
  stays as actionable inline guidance through focus changes.
- **U3 — Done.** Working phases expose Cancel; cancellation immediately drops
  the job and late async results cannot recreate or retain its track data.

---

## 1. Bugs

### B1 — Backup snapshot is captured on *any* form submit, not only Save
**Severity: high (data correctness / user trust) · [report-editor.js:447](../src/report-editor.js)**

`form.addEventListener('submit', captureBackupSnapshot, true)` fires for every
submit-triggering control on `ascentedit.aspx` — including **GPS Preview**
(clicked manually, or programmatically by `ascent-draft.js` during draft
filling). A "save-time" snapshot is therefore stored for form states that were
never saved.

Failure scenario: with **auto backup** on, a user edits ascent 123, clicks GPS
Preview, then abandons the edit and navigates to the saved ascent page (or a
draft flow fills a form that is never saved, and the user later views a
matching ascent). `findSnapshotForPage` matches the pending snapshot and the
worker pushes the *unsaved* numbers and report to GitHub as if they were the
saved state.

Fix: gate the submit-capture on `event.submitter` — capture when the submitter
is `SaveButton`/`SaveButton2` or `null` (implicit Enter submission), skip
otherwise. Keep the existing explicit Save-click listeners.

### B2 — Snapshot matching falls back to "same peak, most recent", which can attach the wrong ascent's data
**Severity: medium · [background.js:889-902](../src/background.js)**

`findSnapshotForPage` matches by ascent id, then peak+date, then **peak id
alone** when the page date could not be parsed. The peak-only fallback means a
snapshot from ascent A (same peak, different date) can be merged under ascent
B's id — `mergeBackupSnapshot` takes the page's `aid` as authoritative while
the numbers and report come from the stale snapshot. Auto mode then pushes it
without a click. Amplified by B1.

Fix: for `auto` pushes require an ascent-id match or peak+date match; reserve
the peak-only fallback for the manual button (where the user sees what
happens), or drop it entirely and accept "no snapshot → page-derived backup".

### B3 — Device-flow auth dies silently on worker restart; options UI polls forever
**Severity: medium · [background.js:713-787](../src/background.js), [options/github.js:156-165](../options/github.js)**

`githubAuthState` and the fire-and-forget `pollForToken()` loop live only in
the MV3 service worker's memory. If Chrome tears the worker down mid-flow
(a `setTimeout` inside `wait()` does not keep an MV3 worker alive), the next
`GITHUB_AUTH_STATE` message wakes a *fresh* worker whose state is
`{ phase: 'idle' }` — and `pollAuth()` in the options page treats any unknown
phase as "keep polling", so the UI shows "Waiting for you to approve on
GitHub…" forever with no error and no timeout.

Fix (two layers):
1. Options page: treat `idle` while a connect is in flight as flow-lost →
   render the error state with a retry.
2. Worker: persist `{ deviceCode, expiresIn, interval, startedAt }` in
   `storage.session` and resume the poll on wake — or restructure so each poll
   is its own message-driven event (`GITHUB_AUTH_POLL` from the options page),
   which removes the long-lived in-worker loop entirely.

### B4 — Popup header claims "Strava activity" on non-provider pages
**Severity: low · [popup.js:159](../popup/popup.js)**

`job.provider === 'garmin' ? 'Garmin Connect activity' : 'Strava activity'`
renders "Strava activity" for error jobs with no provider (the common "clicked
the icon on a random page" case). Fall back to the neutral "Capture this
activity" when `job.provider` is absent.

### B5 — Backup bar light-theme overrides are incomplete
**Severity: low · [ascent-backup.css:79-82](../src/ascent-backup.css)**

The `:root[data-bpb-theme="light"]` block overrides only `.bpb-gh-bar`,
`.bpb-gh-btn`, and `.bpb-gh-primary`. With OS-dark + extension-theme-light,
`.bpb-gh-ok`, `.bpb-gh-err`, `.bpb-gh-link`, and `.bpb-gh-dismiss` keep the
`prefers-color-scheme: dark` palette (`#7ac78d`, `#f2a099`) on the light bar —
low-contrast success/error text. Mirror every dark override in the light block
(the pattern the file itself documents).

### B6 — Repository discovery ignores pagination
**Severity: low · [github-auth.js:197-215](../src/github-auth.js)**

`/user/installations` is fetched without `per_page` (default 30) and
per-installation repositories stop at the first 100 with no `Link`-header
follow. A user with many installed GitHub Apps, or >100 granted repos, silently
sees "installed but no repos". Add `per_page=100` to the installations call and
follow pagination on both endpoints (or document the cap).

### B7 — Fragile Peakbagger login sniff
**Severity: low (brittleness, fails closed) · [background.js:119](../src/background.js)**

`peakbaggerLogin()` regex-matches `cid=(\d+)…My Home Page` out of the homepage
HTML. If Peakbagger reworks that link, every capture reports
"Sign in to Peakbagger" to signed-in users. It fails closed (good), but the
error message would be actively misleading. Consider a second signal (e.g. the
climber link on `/climber/` pages) or an error message that admits the check
itself may be stale.

---

## 2. Engineering — not following best practice

### E1 — `cleanup()` runs at the top of every message
[background.js:949](../src/background.js). Three serialized `storage.session`
round-trips (drafts, jobs, snapshots) per message — including every 450 ms
popup poll during a capture and every draft handshake. The 5-minute alarm
already exists; message-path cleanup adds latency for no correctness benefit
(all readers already filter by `expiresAt`). Move cleanup to the alarm plus
lazy filtering on read.

### E2 — Polling where events would do
The popup polls `CAPTURE_STATUS` every 450 ms; the options GitHub panel polls
`GITHUB_AUTH_STATE` every 2 s. Both work, but a `runtime.connect` port (or
`storage.session.onChanged`) would push state transitions instead, cut message
chatter, and — for the auth flow — remove the B3 keep-alive coupling.

### E3 — Vestigial `webExt` config in package.json
`package.json` carries `webExt.sourceDir: "."` with an `ignoreFiles` list,
while every npm script passes `--source-dir dist`. A bare `npx web-ext build`
would package the repo root (AGENTS.md explicitly forbids packaging the root).
Point `sourceDir` at `dist` and delete the ignore list, so the config and the
scripts agree.

### E4 — No CI
There is no `.github/workflows`; `npm test`, `verify:extension`, and the
release checks run only locally, and the pre-commit hook runs only
`privacy-guard.mjs`. Add a GitHub Actions workflow running `npm test` and
`web-ext lint` on push/PR (headless `verify:extension` per the documented
Chrome-for-Testing recipe is a stretch goal).

### E5 — No linter
No ESLint/formatter config exists; style consistency is currently maintained
by hand. The code is consistent today, but a minimal flat-config ESLint
(errors-only: no-undef, no-unused-vars, eqeqeq) would catch real slips (e.g.
the dead branch in E6) at near-zero noise cost.

### E6 — Small smells
- [options/github.js:194-200](../options/github.js): `disconnect()` ends with
  `if (status) return renderDisconnected(); renderDisconnected();` — both
  branches identical; collapse.
- [github-auth.js:229-243](../src/github-auth.js): `authStore.write()` is a
  read-merge-write without serialization; concurrent writes (poll completion
  vs. repo selection) can clobber each other. Low risk today; a one-line
  promise queue (the pattern `background.js` already uses for `mutateMap`)
  would close it.
- [manifest.json](../manifest.json): content-script `matches` use `*://`
  (http + https) while `host_permissions` are https-only, and only two case
  spellings of each ASP.NET path are matched even though IIS URLs are
  case-insensitive (`AscentEdit.ASPX` would silently get no features).
  Consider https-only matches plus a broader path match with an in-script
  URL check, which is also fewer manifest entries to maintain.
- [github-auth.js:82-101](../src/github-auth.js): `post()` maps every non-2xx
  to `NETWORK` ("Could not reach GitHub"), including a 400 with a JSON error
  body — a misclassified message if GitHub ever returns errors with HTTP
  status codes on these endpoints.

---

## 3. Design / UX — counter-intuitive or unpolished

### U1 — The popup is a dead end everywhere except a provider activity page
**The most common first interaction with the extension is an error card.**
Clicking the toolbar icon on any non-Garmin/Strava page shows "Capture
stopped / Open a Garmin Connect or Strava activity first" styled as an
*error*, with no actions ([popup.js:56-86](../popup/popup.js)). For a new user
this reads as "the extension is broken".

Fix: a neutral empty state — icon, one sentence ("Open a Garmin or Strava
activity to capture it into Peakbagger"), and a link to Settings. Do not use
the error styling for the expected case.

### U2 — No path to Settings from the popup
The options page is only reachable via the browser's extension menu. Add a
small gear affordance in the popup header (`runtime.openOptionsPage()`).
This also gives the GitHub-backup feature a discoverable home.

### U3 — Capture starts with no way to stop it
The popup fires `CAPTURE_START` on open (by design — the click is the explicit
action), but during the working phases there is no Cancel. On a slow network
the user can only close the popup and wait. A cancel that abandons the job
(the storage/TTL machinery already supports discard) would round this out.

### U4 — Draft banner ignores the extension's own dark mode
[ascent-draft.js:23-139](../src/ascent-draft.js) inline-styles a light-palette
banner (`#ecfdf3` etc.) while the site may be running the extension's dark
theme — the one surface that doesn't follow `data-bpb-theme`. The backup bar
(`ascent-backup.css`) already demonstrates the right pattern (media query +
`data-bpb-theme` overrides); move the banner styles to an injected stylesheet
and follow it.

### U5 — Device-code step: no copy affordance, no expiry feedback
The eight-character code is a plain `<span>`; standard device-flow UX is
click-to-copy plus a visible countdown (the code expires in ~15 min). Related:
when the flow dies (B3) the UI never times out. Small additions, big trust
win at the single most fiddly moment of setup.

### U6 — Constraint surprises in options
Setting a casing width below `route width + 2` silently snaps up on save with
no explanation ([settings-schema.js:83-86](../src/settings-schema.js) +
populate round-trip). Either set the number input's `min` dynamically from the
current route width or add one line of helper text ("casing is always at least
2 px wider than the route").

### U7 — Implementation-speak in user copy
"Discard cached capture" / "Cached capture removed" ([popup.js](../popup/popup.js))
name the mechanism, not the user's mental model. "Delete captured track data"
says what the user actually deletes. Similarly, the transient 1.2 s flash
"GitHub access is needed to back up" after a declined permission prompt
([options/github.js:227](../options/github.js)) is easy to miss — persist it
inline in the panel instead.

### What's already good (keep it)
- The popup's plain-language privacy note before opening drafts.
- The options page disclosing exactly which third parties receive what when
  enabling the 3D map.
- Fail-closed ownership/ownership-unverified messaging with distinct badge
  colors.
- The backup bar's restrained inline design with per-state theming (modulo B5).

---

## 4. Execution plan

Ordered by risk; each step is an independent commit per AGENTS.md discipline
(focused subject, checks run before commit). Run `npm test` for every step;
run `npm run verify:extension` for any step touching the manifest or worker.

### P0 — correctness of the backup path (do first, ship together)
1. **B1**: gate `captureBackupSnapshot` on `event.submitter` (Save controls or
   `null`). Regression test in `test/report-editor.test.mjs`: a synthetic
   GPS-Preview submit stores no snapshot; a Save click and an implicit submit
   do.
2. **B2**: restrict auto-mode snapshot matching to ascent-id or peak+date.
   Regression test in `test/github-backup-integration.test.mjs`: peak-only
   match is offered manually but declined for `auto`.
3. **B3 (UI half)**: options `pollAuth` treats `idle`-while-connecting as
   flow-lost → error with retry. Test in `test/github-auth.test.mjs`.
4. **B5**: complete the light-theme overrides in `ascent-backup.css`; extend
   `test/dark-contrast.test.mjs` if it covers this surface.

### P1 — robustness
5. **B3 (worker half)**: persist the pending device-flow state in
   `storage.session` and resume (or move polling to message-driven one-shots).
   This is the largest change in the plan; keep it its own commit with a
   worker-restart simulation test.
6. **B6**: paginate installation/repo discovery.
7. **B4**: neutral provider label fallback in the popup.
8. **E3**: fix the `webExt` config to `sourceDir: "dist"`.
9. **E6 manifest item**: decide on https-only + case-robust matches; this
   touches `manifest.json`, so finish with `npm run verify:extension` in both
   browsers per AGENTS.md.

### P2 — UX polish (each independently shippable)
10. **U1 + U2 + B4**: popup neutral empty state + Settings gear. Visual check
    at real popup size per the UX bar (hidden protocol-driven screenshot).
11. **U4**: theme-aware draft banner via injected stylesheet.
12. **U5**: click-to-copy device code + expiry countdown.
13. **U6 + U7**: copy and constraint-feedback fixes.
14. **U3**: capture Cancel (design first — it interacts with the job TTL and
    the reuse-on-reopen logic; keep discard semantics identical).

### P3 — hygiene
15. **E4**: GitHub Actions workflow (`npm test` + `web-ext lint`).
16. **E1**: move cleanup off the message path.
17. **E5**: minimal ESLint; fix anything it finds (expect only E6-class items).
18. **E2**: optional — port-based state push for popup/options; only worth it
    if E1/B3 leave residual complaints.

### Explicitly out of scope
- Any change to the capture privacy pipeline (`provider-page.js`,
  `validatePrivateGpx`, upload serialization) — reviewed, no defects found.
- The detection scoring model and track reduction — reviewed, sound and
  well-tested.
- Roadmap-level features (full profile export) — tracked in ROADMAP.md.
