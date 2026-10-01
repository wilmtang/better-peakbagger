# Ignored climbers and report filtering

Status: proposed, 2026-10-01. Documentation only; no runtime implementation yet.

## Outcome and scope

Add a local ignored-climber list, a reversible Ignore action on public climber
profiles, and optional GitHub backup and two-way sync. Manage favorites and
ignored climbers together under **Climber lists**. The settings description for
the ignore feature is **“Ignore and don't display TRs of certain climbers.”**

The user explicitly confirmed both ascent lists and individual report pages.
The three required surfaces are:

1. `peak.aspx`: remove ignored authors' rows from Selected Trip Reports; add a
   compact Favorites or Climbing buddies filter that persists across peak visits.
2. `climber/PeakAscents.aspx`: remove ignored authors' ascent rows, including
   rows with GPS/link data but no report text; compose with the existing filters.
3. `climber/ascent.aspx`: conceal the ignored author's report body, including
   embedded media and report links; leave ascent metadata and map tools usable.

Every surface offers a quiet, counted reveal action. Revealing is temporary,
never an unignore operation. See the companion [UX specification](ignored-climbers-ux.md)
for controls, copy, count arithmetic, empty states, and layout acceptance.

## Findings before implementation

| Existing boundary | Evidence and consequence |
| --- | --- |
| Local favorites | [Pure favorites model](../../src/favorites/favorite-climbers.js) validates IDs, names, schema and a 1,500-entry limit. [Worker store](../../src/background/favorites-store.js) serializes operation mutations and signature-checks replacements. Use the same discipline for ignores; content scripts must not read-modify-write the list. |
| Profile controls | [Profile favorite script](../../src/favorites/climber-favorite.js) mounts a star only in custom mode, suppresses it on one's own profile, and observes native Buddy changes. Ignore must mount in either favorites mode, independently of star mount/unmount and Buddy mutation handling. |
| Existing filters | [Ascent filter](../../src/ascent/ascent-filter.js) recognizes PeakAscents, personal ascents, Buddy reports and peak lists; it does not handle Selected Trip Reports on peak pages. Its filter state is page localStorage, with one render loop owning row visibility. Extend that loop for ignores rather than adding a competing row hider. |
| Favorite source | The same script resolves custom favorites or an owner-scoped Buddy cache and refreshes stale buddies through the guarded Peakbagger request path. Reuse this policy for peak pages; never use another account's cache. |
| Manager and settings | [Standalone manager](../../options/favorites.html) and [controller](../../options/favorites.js) manage the list; [settings](../../options/options.html) links to it and owns GitHub transfer controls through [favorites backup controller](../../options/favorites-backup.js). Preserve existing URLs and anchors when renaming their visible labels. |
| Existing GitHub transfer | [Worker routes](../../src/background/github-routes.js) upload a favorite snapshot, optionally automatically, and return remote text for explicit restore. That is not two-way synchronization. |
| GitHub concurrency | [Write queue](../../src/github/github-write-queue.js) coalesces root-file snapshots with newest content winning. [Client](../../src/github/github-client.js) retries root writes using the previously supplied content. Neither behavior merges concurrent list membership changes across devices. A sync operation needs a fresh read/merge on every ref conflict. |
| Peak structure | [Rainier](../../test/fixtures/pages/peak-rainier.html) and [Garibaldi](../../test/fixtures/pages/peak-garibaldi.html) contain nested Selected Trip Reports tables alongside totals, My Ascents and map links. Match the section plus its header/row structure, not the first gray table or every climber link. |
| Individual author identity | [Saved ascent fixture](../../test/fixtures/pages/climber-ascent.html) has a report body but no independently identified report-author link. Its navigation account ID is insufficient. Add evidence-backed masked fixtures before defining the production author selector. |

A read-only attempt to inspect the user's [example peak](https://www.peakbagger.com/peak.aspx?pid=1596)
returned HTTP 403 on 2026-10-01. No live layout or author-selector claim is made.
Use the existing authenticated browser for one minimal read-only validation when
implementing; stop for user validation if bot detection blocks it. Do not fetch
all ascents to fill gaps in a selected list.

## Product invariants

- Membership is keyed by a positive safe-integer climber ID, never a display
  name. Validate Peakbagger origin and climber pathname before reading an ID.
- Ignore is a browser-local display preference. It does not block an account,
  contact the climber, alter Peakbagger friendships, or edit a saved ascent.
- Favorite and ignored membership are independent. Ignore wins by default even
  for a favorite/buddy. Unignore restores the existing favorite relationship.
- The effective favorite set is custom favorites OR the signed-in user's Buddy
  List, according to the existing source setting; never silently union them.
- Unknown author identity remains visible. Storage/network errors must not be
  interpreted as a valid empty list and then uploaded to GitHub.
- Personal ascent lists, Buddy reports, summit totals, map overlays, editor
  forms and capture/draft workflows are outside the new hiding scope.
- Counts describe records actually loaded on this page, not all server records.
  Preserve native order, sorting, links and non-report content.
- Hiding is presentation only, not a guarantee that media requests have been
  blocked. Never promise network blocking or deletion.

## Data and ownership

Introduce a small pure ignored-climber model beside the existing favorites
model; share only suitable identity helpers, not a broad favorites rewrite.
Suggested new module basenames are `ignored-climbers.js`, `ignored-store.js`,
`climber-list-sync.js`, `peak-report-filter.js`, and `ascent-report-visibility.js`.
These are proposed files, not existing modules.

`chrome.storage.local` owns:

| Key | Proposed value and rules |
| --- | --- |
| `bpbIgnoredClimbers` | `{schemaVersion: 1, revision, entries: [{cid, name, addedAt}]}`; at most 1,500 unique IDs, trimmed nonempty names at most 200 characters, finite nonnegative timestamps, monotonically incremented local revision. No free-text reasons. |
| `bpbPeakReportFilter` | `{schemaVersion: 1, favoritesOnly: false}` by default. Boolean validation; device-local across peaks and www/bare-host aliases. Independent of existing ascent-list filter state. Excluded from settings export and GitHub list files. |
| `bpbIgnoredSyncState` | Connection scope, confirmed merge base, local revision, remote file/head identity, last-success time, pending transaction and error state. Worker-owned, never sent to Peakbagger. |

The ignored list is extension-profile-wide, like custom favorites, not partitioned
by Peakbagger login. Buddy cache ownership remains account-specific. Profile
controls omit self-ignore when the signed-in identity matches; imported entries
are not silently removed on account changes. Document that the same saved ignore
list applies after signing into another account.

The worker is the sole list writer. Add/remove are idempotent operations applied
against current storage. Replace, restore, and whole-list Undo require the exact
reviewed revision/signature. Entry-level Undo checks that entry's current state
so it preserves unrelated additions. Route gates follow existing favorites
sender checks; GitHub operations accept only exact packaged Settings/manager
pages, not ordinary Peakbagger content-script senders.

Subscribe to local changes to refresh open profiles, lists and managers. Resolve
initial async reads against a revision/generation so late reads cannot replace a
newer storage notification. Keep last valid state on a later read failure;
initial failure shows an actionable unavailable state without hiding arbitrary
content. Writes must confirm before displaying saved success.

The peak filter preference uses a worker-owned, validated single-key operation;
it is not added to the page-world settings bridge or `storage.sync`. A failed
preference save leaves the current view usable but says it could not be
remembered. Temporary reveal lives only in the page controller; reset it on
navigation/reload and BFCache restoration. Favorite preference changes propagate
to open peak pages; separate tabs' reveal states do not.

## Report adapters and rendering

### Peak Selected Trip Reports

Identify exactly one supported selected-report table using section text, expected
headers and ascent/climber links within the same row. Bound the search to the
Ascent Info region. Reject ambiguous structures without mutating unrelated DOM.
Keep each row's original display state so cleanup restores it; never re-create
report HTML or lose native listeners. No results are fetched beyond that table.

Start the ignore/preference read at document_start. Conceal only the positively
identified target report region until initial local state resolves, with bounded
recovery on failure; never conceal the whole page. If favorites needs a network
refresh, show a loading/unavailable state rather than an indefinite blank table.
Use a shared narrow favorite-source resolver, extracted from the existing ascent
filter only as needed, with account checks, stale-cache behavior, cancellation
and response-generation guards preserved.

### Full ascent lists

Add ignored membership and the temporary reveal bit to the existing render
predicate in `src/ascent/ascent-filter.js`. Compute group-header visibility,
shown totals and filter badges from the same row records. Do not let sorting
resurrect hidden rows or lose their original order. Apply ignore even in compact
views when a reliable author column is present; preserve the current notice that
beta filtering needs the full view. Unknown IDs remain visible in All mode.

Rename the existing reset action to **Clear filters** on this surface: it clears
the ordinary beta/favorites predicates but keeps ignored authors concealed. The
explicit reveal action controls ignores. A companion **View full list** action
in an empty state may clear ordinary filters and turn reveal on for this page;
it must not silently persist a different favorites preference.

### Individual ascent report

Build a dedicated isolated-world adapter after validating real author markup.
Require one unambiguous page-author ID associated with the displayed ascent.
Do not infer it from My Home Page, an edit link alone, arbitrary page links,
report text, or the current login. Map the entire report presentation region,
including report-specific heading, external-report link and embedded media;
place the reveal control outside that region. Metadata, GPX/map tools, owner
controls and neighboring summaries stay outside the hidden boundary.

Use scoped hiding that removes descendants from both layout and keyboard/accessibility
navigation; do not rely on opacity or aria-hidden alone. Keep report nodes in
place so reveal restores the original content. Empty reports get no “1 hidden”
control. Move focus to the reveal control before hiding a region containing it;
pause playing report media when re-hiding. Validate compatibility with the
existing report-photo enhancement and GPX/map layout code.

## GitHub backup and synchronization

### Format and compatibility

Use a separate fixed root file, `ignored-climbers.json`, in the already connected
backup repository. Leave `favorite-climbers.json` and its v1 semantics intact.
Do not migrate favorite membership or enable ignored-list uploads because
`autoFavoritesBackup` happens to be on.

```json
{
  "kind": "better-peakbagger-ignored-climbers",
  "schemaVersion": 1,
  "exportedAt": "2026-10-01T12:00:00.000Z",
  "entries": [
    { "cid": 900002, "name": "Example Climber", "addedAt": 1790856000000 }
  ]
}
```

Strictly reject unknown schema/kind, duplicate or invalid IDs, invalid fields,
over-limit entries and payloads exceeding 2 MiB of UTF-8 before any replacement.
Use bounded raw-blob reads through the existing client. Serialize only allowlisted
fields. Local revision, tokens, Buddy cache, login identity, favorite filter and
reveal state never enter this file. Reject oversized outbound content too.

### Explicit backup and restore

Offer **Back up now** and **Restore…** with connection and last-success status.
Restore previews additions/removals, confirms replacement, then offers guarded
Undo. A missing file means “No ignored-climber backup yet,” not an empty restore.
A valid empty file is distinct and can intentionally clear the list after review.

Back up uses a conditional remote write: if the file changed since this device's
last confirmed baseline, first offer reconciliation instead of overwriting it.
On first connection to an existing file, show the same preview used for sync
setup. Users may explicitly choose **Use this device's list** after seeing the
replacement impact. There is no unconditional background overwrite path.

### Actual two-way sync

Offer a separate device-local opt-in **Sync ignored climbers with GitHub**.
It uses the same connection, shared GitHub write queue, auth-epoch checks,
deadlines, retry policy and disconnect cancellation as existing transfers.
A new device never starts pushing because another device enabled a setting.

- First enable: fetch and validate the remote file; preview **Merge lists**
  (default), **Use GitHub's list**, or **Use this device's list**. Explain merge
  keeps all currently ignored IDs. Establish a baseline only after the chosen
  result is confirmed remotely and reconciled locally. Missing remote file can
  be initialized from local data. Missing local baseline is setup, not “empty.”
- Subsequent sync: compare local and remote entries against the last confirmed
  common snapshot, by ID. Unchanged side yields to the changed side; identical
  changes converge; independent IDs merge. Deletions propagate because absence
  is compared with that baseline, not merged by union on every sync.
- If both sides change the same entry differently (including deletion versus
  metadata change), stop before any upload or remote-derived local replacement.
  Show a scoped conflict preview with device/GitHub choices; preserve offline
  edits. Do not choose a winner from wall-clock timestamps.
- If a previously confirmed remote file disappears, pause with **Review changes**;
  do not interpret missing as an empty list or silently recreate it. A valid
  empty file participates in the ordinary three-way merge as explicit removals.
- Persist the baseline while offline; losing/resetting it requires setup again.
  Do not automatically compact it or infer it from the latest remote snapshot.
  This design synchronizes final membership, not the history of intermediate
  remove/re-add actions that cancel out between syncs.
- Run the read/merge/conditional-commit as an exclusive `writeQueue.run`
  operation. Add a narrow client operation that reads the file from one branch
  head and commits against that same head. On ref conflict, re-read, re-merge
  and revalidate the local revision within the existing bounded retry budget.
  Never feed a premerged snapshot to the coalescing last-writer-wins path.
- Persist an in-flight record before network commit. If the worker stops after
  GitHub accepted a commit, resume by reading remote state and reconciling the
  transaction. Do not declare success or discard pending edits on uncertainty.
- If local membership changes during the upload, apply the confirmed remote
  result plus operations made since the captured revision, or re-merge using
  that captured local snapshot. Keep those new edits pending for another sync;
  never replace newer local data wholesale. Commit local list, baseline and
  transaction state together under the serialized worker boundary.
- Scope baseline and pending work to auth epoch plus owner/repository/branch.
  Disconnect or repository change invalidates in-flight writes and requires
  setup for the new target; it must not erase local ignored membership.
- With opt-in active, use durable alarms for a 30-second trailing debounce after
  local changes, a check on browser startup, a rate-limited check on manager
  opening, and a 15-minute periodic check while the browser is running. Manual
  **Sync now** checks immediately. Reuse existing backoff and Retry-After
  handling; coalesce duplicate triggers. No network request on each peak visit.
- Status is **Pending changes**, **Syncing…**, **Synced <time>**, **Offline —
  changes saved on this device**, or **Review changes**. Upload-only backup is
  labelled **Backed up**, never **Synced**. No promises of real-time delivery
  while a browser is closed or a background alarm is delayed.

Deleting an entry updates the current GitHub file on the next successful sync;
prior Git commits can retain previous names/IDs. Restore and Undo are new local
changes when sync is enabled; serialize them with pending sync and require a
fresh preview if the reviewed revision changed. Disabling sync cancels pending
network work without removing local edits or deleting the remote file.

State the Git-history behavior beside GitHub setup
and in the privacy documentation, especially for public repositories. No reasons
or browsing history are exported. Local ignoring works without a GitHub account.

## Delivery sequence and focused commits

Each numbered step is a separately reviewable, complete unit. Run its focused
checks before committing; record results rather than predicting them.

1. **Validate fixtures and pure contracts.** Confirm author/section selectors in
   minimal live read-only inspection; add masked full/compact/list/detail/media
   fixtures. Implement model, strict backup parser, visibility/count functions
   and three-way merge tests. Do not make report hiding depend on a guessed ID.
2. **Implement local mutation boundary.** Add worker operations, concurrent-tab
   guards, preference persistence and storage subscriptions. Test invalid sender,
   replacement races, failed writes, stale initial reads and capacity limits.
3. **Implement profile and manager UX.** Add reversible Ignore/Unignore in both
   favorite modes; rename visible navigation to Climber lists; add the Ignored
   tab with add/search/sort/remove/Undo. Preserve existing anchors and Buddy
   semantics. Verify actual light/dark rendering before completing this step.
4. **Implement peak selected-report UX.** Add isolated content bundle and scoped
   CSS; integrate shared favorite-source loading and persistent local preference.
   Cover counts, empty states, reveal composition, account/cache errors and
   narrow column layouts. Confirm the target verifier loads this surface before
   beginning implementation; add a masked fixture route if needed.
5. **Implement ascent list and detail UX.** Integrate one visibility predicate
   into the existing list renderer, including compact mode; add the dedicated
   detail adapter. Verify sorting, group headings, focus, media, report-photo
   enhancement, map layout and no changes to editors/personal lists.
6. **Implement guarded manual GitHub transfer.** Add fixed-path backup/restore,
   exact sender gates, strict parsing, previews and guarded Undo. Prove unrelated
   root files/ascent folders survive and old favorites files still round-trip.
7. **Implement opt-in two-way sync.** Add conditional client merge transaction,
   per-device baseline/journal, durable scheduling and conflict UI. Exercise two
   independent clients, worker restarts and connection changes. Do not ship an
   upload-only switch under a Sync label.
8. **Finish documentation and release evidence.** Update maintained guides only
   to reflect implemented behavior, run integration checks, preserve proof gaps,
   and archive this plan and the UX specification when complete.

Wire every new bundle through `scripts/build-config.mjs` and `manifest.json` in
the isolated world, supporting current www/bare-host and path-case variants.
Keep the single bundled worker and stylesheet-before-theme startup unchanged.
Any shared default/bound belongs in its pure owner; synchronized settings, if
needed, belong in `src/settings/settings-schema.js`, with its structural tests.

## Verification and acceptance

| Layer | Required evidence |
| --- | --- |
| Pure models | Duplicate/invalid IDs, Unicode and hostile names rendered as text, 1,500 entries, stable serialization, byte limits, empty/missing/unknown schema, membership overlap, all visibility/count combinations, three-way deletion/conflict cases. |
| Worker | Parallel add/remove without lost updates, stale replace/Undo rejection, sender rejection, read/write failure with no empty upload, initial-read race, disconnect/auth-epoch invalidation, bounded retries, restart recovery before/after remote commit. |
| Page fixtures | Ignore all three surfaces; no false author match from navigation or report text; nested peak tables; unknown IDs; compact list; all rows ignored; favorite-and-ignored overlap; stable sort/group counts; reveal/re-hide; local persistence on a different peak and restart; no preference leakage into GitHub export. |
| Favorites compatibility | Buddy/custom switching, matching/stale/wrong-owner cache, sign-out/account changes during request, empty favorites versus unavailable favorites, native Buddy actions, mirror/restore races. |
| GitHub integration | Two devices add different IDs; one deletes while the other adds; conflicting same-ID edits; absent baseline, missing/deleted remote file, valid empty remote file, malformed/oversize file, unrelated commits between read/write, auth/repo changes, offline edits and crash recovery. Stubbed integration is distinct from actual GitHub proof. |
| Visual/accessibility | Hidden full Chrome for Testing with real unpacked `dist/`, plus Firefox: peak/ascent pages at 1440×1000 and 390×844; settings/manager at 1024×900 and 390×844; light/dark, 200% zoom, long names, counts, loading/error/empty states, visible keyboard focus and reduced motion. Inspect screenshots, not only DOM assertions. |
| Release | `npm test`, `npm run lint`, `npm run verify:browsers`; add focused cases to existing verifiers. Run `npm run test:scale` when changing favorites/list hot paths. Before release, verify backup/sync against an owner-authorized disposable GitHub repository and minimal authenticated Peakbagger pages. Never use production backup contents as test scratch space. |

Existing regression homes: `test/favorites/`, `test/ascent/ascent-filter.test.mjs`,
`test/options/options-favorites.test.mjs`, `test/github/github-route-access.test.mjs`,
`test/github/github-client.test.mjs`, `test/github/github-write-queue.test.mjs`,
`test/project/manifest-capture.test.mjs` and `test/project/documentation.test.mjs`.
Add focused tests beside their owning boundaries; build before bundle fixtures.

Serve page fixtures over HTTPS on a real Peakbagger hostname. Use hidden full
Chromium, never headless-shell for extension loading. Keep user's windows and
focus undisturbed; clean up only owned processes, profiles and certificates.
If WebGL is rendered, assert hardware renderer and reject software fallback.
Record browser version, renderer, viewport and hidden/visible mode. Hidden
screenshots do not establish native focus, browser chrome or screen-reader speech.

## Related documentation and completion record

At implementation time update:

- `README.md`: Climber lists entry point, hiding/reveal and local persistence.
- `docs/architecture.md`: pure model, isolated adapters, worker mutation owner,
  per-device sync state and shared favorite-source boundary.
- `docs/github-ascent-backup.md`: fixed file/schema, transfer versus sync,
  connection scope, sender table, conflicts, retry and crash recovery.
- `PRIVACY.md`: stored IDs/names, local-only default, optional GitHub transfer,
  public-repository visibility and retained Git history; no network-block claim.
- `docs/development.md`: fixture routes, focused tests and visual verification.
- A maintained climber-lists guide promoted from the proposed UX specification.

Planning checks and implementation proof must remain separate. At each delivery
step record the commit, checks actually run and remaining gaps. Current record:

| Category | Status |
| --- | --- |
| Fixed and verified | None; this is a proposed feature plan. |
| Intentionally not changed | Runtime code, existing favorite file/schema, native Buddy membership, personal lists, editors, GPX/map data and server totals. |
| Changed but not fully proven | Planning documents only. No runtime, visual, live Peakbagger author-selector or live GitHub sync evidence yet. |

The final feature is not complete while any of the three surfaces, local
persistence, counted reveal, manager editing, manual backup, or genuine two-way
sync is missing. Preserve this record and unresolved verification gaps on archive.

Planning validation on 2026-10-01: `node --test test/project/documentation.test.mjs`
passed all 3 tests; `git diff --check` passed. These checks validate documentation
structure and whitespace, not the proposed runtime or UI.
