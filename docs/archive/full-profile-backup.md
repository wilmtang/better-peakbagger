# Full profile backup: design

> Archived implementation record. The original implementation below used one serial GitHub
> commit per ascent. It has since been replaced by the bounded, atomic batch
> pipeline documented in the
> [GitHub backup design](../github-ascent-backup.md#full-profile-producer-consumer-pipeline). The ownership,
> challenge, identity, and repository-diff decisions remain applicable.

Status: implemented in focused commits `c986662`, `ba1de43`, `1cd7522`,
`66acdca`, and `14a1a24`. Fixture, queue, UI, and built-worker coverage is
automated. A real, rate-limited scratch-repository run remains a manual
pre-release check because it requires the user's Peakbagger and GitHub sessions.

The GitHub ascent backup (docs/github-ascent-backup.md) fires only on a fresh
save: the edit-page flush hook snapshots the form, and the saved ascent page
pushes one commit. Ascents saved before the feature existed — or saved without
the extension — have no folder. This plan adds a backfill: one explicit action
that walks the signed-in climber's own ascent list and brings the repository to
complete coverage, in the exact same per-ascent folder format.

Peakbagger's own CSV export is not sufficient: it carries most structured
fields and the trip report as rendered HTML, but no ascent or peak ids, no GPX
tracks, no companions, and no report source markup. It is useful only as an
offline cross-check.

## User story

*As a climber with years of ascents, trip reports, and GPS tracks on
Peakbagger, I want one action that archives my whole profile to my own GitHub
repository, so my writing and tracks are safe even if the site or my account
goes away.*

The workflow, from the user's side:

1. **Prerequisite (already shipped).** GitHub backup is enabled and connected
   in the extension options — the one-time device-flow setup from
   docs/github-ascent-backup.md. Nothing new to configure.
2. **Start.** The user opens their own ascent list (My Ascents). Because this
   is their list, the extension shows a **Back up all ascents** control. One
   click starts the run; there is nothing to select or export first.
3. **Watch (or don't).** A progress panel on the page shows a bar with
   n-of-total, the peak currently being backed up, and a note to keep the tab
   open. The run paces itself (~2 s per ascent; a few minutes for a typical
   profile). The user can pause or cancel at any time, or just switch to
   another tab and come back — only closing/navigating this tab stops it.
4. **Finish.** The panel ends with a summary: how many ascents were backed
   up, how many were skipped because they were already in the repository, and
   any failures with a per-ascent reason. Each backed-up ascent is one commit
   in the user's repo, in the same folder format the per-save backup writes.
5. **A human check is a pause, not a failure.** If Peakbagger's protection
   (Cloudflare) interposes a challenge mid-run, the panel pauses and asks the
   user to complete the check in a tab it opens for them; **Resume** picks up
   exactly where the run stopped. Nothing is recorded as failed because of a
   challenge.
6. **Interruption is a non-event.** If the tab was closed, the laptop slept,
   or a few ascents failed, the user just clicks **Back up all ascents**
   again later: ascents already in the repository are skipped automatically,
   so the rerun does only the remaining work. No progress state to manage.
7. **Staying current.** Afterwards, day-to-day coverage comes from the
   existing per-save backup (manual or auto). The backfill can be rerun at
   any time as a safety net; an unchanged profile produces zero commits. A
   separate **Refresh all** option force-resyncs every ascent for users who
   edited old ascents outside the extension.

## Confirmed source facts (live-verified 2026-07-19, logged-in session)

- **The owner's ascent list page is a complete work index.** With `j=-1` and
  `y=9999`, `climber/ClimbListC.aspx` renders every ascent in one page. Each
  row carries: `ascent.aspx?aid=` link (the date cell), `peak.aspx?pid=` link,
  an `AscentEdit.aspx?aid=` link (owner only — doubles as the ownership gate),
  ascent type icon, a **GPS** cell (`GPS.gif`, title "Ascent has GPS track")
  when a stored track exists, and a **TR-Words** cell (`TR-<n>`) when a trip
  report exists. One fetch yields the full aid/pid list plus exactly which
  ascents need a track download.
- **The stored track URL is deterministic:** `/climber/GetAscentGPX.aspx?aid=<aid>`
  (confirmed against the ascent-page fixture's "Download this GPS track" link).
  No ascent.aspx visit is needed to fetch tracks.
- **The edit page is the highest-fidelity field source.** `AscentEdit.aspx?aid=`
  (owner only) serves the same `Form1` the save-time snapshot reads, including
  `JournalText` with the trip report's **raw bracket-markup source** — not the
  rendered HTML. `src/ascent/ascent-snapshot.js` already owns this form's field
  mapping and can be reused nearly verbatim on a `DOMParser`-parsed fetch.
- **No Cloudflare friction for same-origin, logged-in traffic.** The list and
  edit pages loaded normally in the user's session. Backfill fetches run from
  a content script in the user's own tab — same cookies, same origin, ordinary
  browsing shape. Rate-limit anyway (~2 s spacing, matching peakbagger-cli's
  default); the motivating profile (~164 ascents, 74 with reports, 9 with
  tracks) completes in roughly 6 minutes.

## Decisions

- **Media: URLs only.** Report markdown keeps any image/video/link URLs as
  they appear in the report source; no media files are downloaded or added to
  the repository.
- **Existing-folder policy: skip by default.** A root-level `*-a<aid>` folder
  that already exists (save-time backup or earlier backfill run) is skipped.
  Skipping is what makes the run resumable, keeps re-runs commit-silent, and
  preserves save-time `report.md` files, which can be sidecar-verbatim
  Markdown — the backfill can only produce a bracket→Markdown conversion,
  because the Markdown-source sidecar exists only in the save-time flush. A
  separate **Refresh all** option re-syncs every ascent through the existing
  Update path, for profiles edited on Peakbagger without the extension.
- **The repository is the progress tracker.** Folder leaves end in `-a<aid>`,
  and the GitHub client lists the marked root layout. Work
  list = aids on the list page minus aids present in the tree. Each ascent is
  one atomic commit, so a crash never leaves a partial folder; a failed ascent
  leaves no folder and is retried on the next run. No separate checkpoint
  state exists to drift.

## Where the loop runs (MV3 lifetime)

The long-running loop must not live in the background worker: Chrome MV3
service workers idle out in ~30 s and are only kept alive while actively
processing events, and Firefox's event pages behave similarly. A multi-minute
orchestration loop there is the canonical fragile pattern.

Instead the loop runs in the **content script on the owner's ClimbListC.aspx
tab** — the same place the fetches must happen anyway, since Peakbagger
fetches belong to the page session context (existing architecture boundary:
the worker never fetches from Peakbagger). The content script lives as long
as the tab; the worker is woken per ascent for one short, self-contained
GitHub push, exactly like the existing per-save backup. If the user closes or
navigates the tab, the run stops cleanly and the next run resumes from the
repository diff.

## Flow

```
ClimbListC.aspx (owner's own list; content script, isolated world)
  "Back up all ascents" → parse table rows: aid, pid, date, GPS flag, TR words
  → GITHUB_BACKUP_STATUS + existing-folder listing from the worker
  → work list = rows minus already-backed-up aids (unless Refresh all)
  → for each ascent, ~2 s spacing:
      fetch AscentEdit.aspx?aid= (same-origin) → DOMParser
      → ascentSnapshot.build() on the parsed form
      → report: bracketToMarkdown(JournalText)
      → GPS flag set? fetch GetAscentGPX.aspx?aid=
      → send one GITHUB_BACKUP_ASCENT-shaped message to the worker
  → worker: build payload (github-backup.js), push one commit, reply
  → progress panel advances; per-ascent failures recorded and skipped past;
    a Cloudflare challenge pauses the whole run instead (see below)
```

The edit-page fetch parses into the very form `ascentSnapshot.build`
consumes, so backfilled `ascent.json` is snapshot-grade — same field source
as a save-time backup. Fail closed per ascent: a fetch that lands on a login
page, a form without the expected fields, or a mismatched aid drops that
ascent into the error list rather than committing a guess.

## Cloudflare and transient failures

The initial live check saw no challenges for same-origin, logged-in traffic,
but a sequential sweep of a whole profile is precisely the shape that can
trip Cloudflare mid-run. The runner must expect it and degrade to a pause,
never to a cascade of bogus per-ascent failures or a silently wrong archive.

- **Distinguish three failure classes per response.** (1) *Challenged*:
  Cloudflare interposed — detected by the `cf-mitigated: challenge` response
  header, a 403/429/503 status, or challenge-page markers in the HTML.
  (2) *Transient*: network error or other 5xx. (3) *Wrong content*: a 200
  that is not the expected edit form (login page, missing fields, mismatched
  aid) — the existing fail-closed gate. Only class 3 is recorded as that
  ascent's failure; classes 1–2 are never attributed to the ascent.
- **A challenge pauses the run; the user clears it; the run resumes.** A
  content-script `fetch()` cannot execute a challenge, and automating or
  bypassing one is off the table (AGENTS.md). On detection the runner stops
  the queue immediately — no further requests — and the panel switches to a
  "Peakbagger is asking for a human check" state with a button that opens the
  challenged URL in a new tab. Solving it there mints clearance cookies for
  the whole session. **Resume** re-probes the same URL first and continues
  the queue only on a clean response; the interrupted ascent is retried, not
  skipped. After any challenge the pacing doubles for the rest of the run.
- **Transient errors back off and retry in place.** Two retries with
  exponential backoff (~4 s, ~15 s) before the ascent is recorded as failed
  and the queue moves on. Repeated transient failures across consecutive
  ascents (e.g. connectivity loss) also pause the run rather than marching
  through the whole queue collecting failures.
- **Nothing is lost either way.** Commits are atomic per ascent and the
  repository diff is the work list, so a run abandoned mid-challenge is just
  a shorter run: the next click resumes from where it stopped. The finish
  summary distinguishes "failed" (needs attention) from "not reached"
  (paused/cancelled before their turn).

## Automated coverage

The failure handling is automatically testable because none of it needs a
real Cloudflare in the loop — it needs the *decisions* pinned. Three layers,
all using patterns this repo already has:

- **Response classifier: pure unit tests.** Detection lives in one pure
  function, `classify(status, headers, bodyText)` →
  `ok | challenged | transient | wrong-content`. The primary challenge signal
  is the documented `cf-mitigated: challenge` response header (Cloudflare's
  official contract for detecting challenged fetch/XHR requests), with
  status codes and challenge-page HTML markers as fallbacks. Tests feed
  synthesized responses: the masked edit-form fixture → `ok`; a login page →
  `wrong-content`; 403 + `cf-mitigated` → `challenged`; challenge-page markup
  → `challenged`; 500/network error → `transient`. When a real challenge
  page is next captured in the wild, a masked copy joins the fixtures.
- **Runner state machine: scripted fetch + injected clock.** The runner takes
  injected `fetch` and timer dependencies, exactly like the github-client and
  device-flow tests. Scripted sequences pin the guarantees, not just the
  happy path: a challenge at item k stops the queue (assert *no request
  k+1*), resume re-probes the challenged URL before continuing and retries
  item k; transient failures back off with the expected delays (fake clock,
  no real waiting) and only two retries; consecutive transients pause the
  run; a wrong-content response fails only its own ascent and the queue
  proceeds; already-present folders are skipped. The cascade bug this design
  exists to prevent — one challenge marching on and recording dozens of bogus
  failures — is a one-line assertion here.
- **End to end: fixtures + built-worker integration.** The list-parser test
  reads a masked ClimbListC fixture; the built-worker integration test (the
  github-backup-integration.test.mjs pattern) drives backfill messages
  through the real bundled worker into a scripted GitHub fetch and asserts
  the commit payloads.

What automated tests cannot establish, and stays in the step-6 live check:
that real Cloudflare responses actually carry the markers the classifier
keys on, that clearing a challenge in another tab really mints clearance for
the content script's fetches, and the true post-save GPX-link timing. That
live check stays minimal and rate-limited; no test ever provokes or
automates a challenge (AGENTS.md forbids automating one, and a test that
depends on triggering Cloudflare would be both hostile and flaky).

## Progress UI

An on-page panel on the list page (same visual language as the existing
backup affordance): progress bar with n/total and the current peak name, a
note to keep the tab open, pause/cancel, and a final summary — backed up,
skipped (already present), failed (with per-ascent reasons and links). Errors
never abort the run.

## Snapshot completeness (also improves the per-save backup)

`src/ascent/ascent-snapshot.js` currently captures only a subset of the edit form.
Live inspection of the form shows these gaps, all wanted for both the
per-save snapshot and the backfill:

- **Weather:** `TempDD` is categorical (Pleasant/Hot/Cool/Cold/Frigid), so it
  is captured as a label like `PrecipDD`, not a number; the never-populated
  numeric `weather.temperature` is replaced by label fields. Also capture
  `WindDD`, `VisDD`, and the free-form `WeatherText`.
- **Companions:** added companions are rows of `#OthersTable`, not the
  `OthersText` input (that is only the search box — reading it captures
  nothing once a name is added). Parse the table: rows linking to a climber
  page are `registered` (with cid); plain-text rows are `others`. Needs a
  fixture ascent that actually has companions.
- **Also missing:** `RouteDn` (route down — only `RouteUp` is read today),
  `URLTB` (external trip-report URL), and the trip fields (`TripDD`,
  `TripSeqText`) if we choose to record trip membership.

`src/github/github-backup.js` already serializes registered companions and weather;
the changes concentrate in the snapshot reader plus small payload-builder
extensions (new weather labels, routeDown, externalUrl). Additive keys keep
`schemaVersion: 1`; nothing previously emitted changes meaning, because
`temperature` was always null in practice.

## Execution steps (each one focused commit)

1. **Done.** Snapshot completeness: `TempDD`/`WindDD`/`VisDD`/`WeatherText`,
   `#OthersTable` companions, `RouteDn`, `URLTB`; extend the fixture-based test
   with masked synthetic companion rows; extend `github-backup.js`
   serialization + tests.
2. **Done.** Pure list-page parser (`ClimbListC.aspx` rows → {aid, pid, date, hasGpx,
   trWords}) against a masked list fixture, plus work-list diffing against
   existing folder leaves.
3. **Done.** Backfill runner in the list-page content script: queue, pacing, pause/
   cancel, fail-closed per-ascent gates, and the three-class failure handling
   (challenge → pause/hand-off/resume, transient → backoff, wrong content →
   per-ascent failure), with the classifier unit tests and scripted-fetch/
   injected-clock runner tests from the Automated coverage section; worker
   handler reusing the existing backup path for provenance-stamped commits.
4. **Done.** Progress panel UI with explicit light/dark styling and fixture
   visual inspection. Real-browser extension loading is covered by
   `npm run verify:extension`; final Firefox/manual UX smoke remains part of
   release verification.
5. **Done.** Refresh-all mode with an explicit confirmation before creating an
   update commit for every ascent.
6. **Automated portion done; manual live check pending.** Fixture parsing,
   scripted queue behavior, built content surface, and built-worker Git Data
   integration are covered. Before release, run one minimal, rate-limited live
   backfill against a scratch repository in both browser families; do not try
   to provoke or automate a Cloudflare challenge.
