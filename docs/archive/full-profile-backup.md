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
the extension — have no folder. The implementation added a backfill: one explicit action
that walks the signed-in climber's own ascent list and brings the repository to
complete coverage, in the exact same per-ascent folder format.

Peakbagger's own CSV export is not sufficient: it carries most structured
fields and the trip report as rendered HTML, but no ascent or peak ids, no GPX
tracks, no companions, and no report source markup. It is useful only as an
offline cross-check.

## Historical source facts (live-verified 2026-07-19, logged-in session)

- **The owner's ascent list page is a complete work index.** With `j=-1` and
  `y=9999`, `climber/ClimbListC.aspx` renders every ascent in one page. Each
  row carries: `ascent.aspx?aid=` link (the date cell), `peak.aspx?pid=` link,
  an `AscentEdit.aspx?aid=` link (owner only — doubles as the ownership gate),
  ascent type icon, a **GPS** cell (`GPS.gif`, title "Ascent has GPS track")
  when a stored track exists, and a **TR-Words** cell (`TR-<n>`) when a trip
  report exists. One fetch yields the full aid/pid list plus exactly which
  ascents need a track download.
- **The then-observed stored track URL was deterministic:** `/climber/GetAscentGPX.aspx?aid=<aid>`
  (confirmed against the ascent-page fixture's "Download this GPS track" link).
  That endpoint was later corrected; see the
  [endpoint incident record](profile-backup-gpx-endpoint.md).
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
