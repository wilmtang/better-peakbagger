# Codebase audit — 2026-09-25

Status: **audit complete; F7 resolved locally, F1–F6 open.** Seven findings have local
reproductions. This document changes no runtime behavior.

Baseline: `3f7c6bb5df69a4e4f0c668e01e17a9c32b48b9c0`, version 3.7.2,
plus the pre-existing, uncommitted AllTrails integration. That working tree
included changes to the manifest, build configuration, ascent handoff UI,
background wiring, trusted actions, and their tests, plus new AllTrails files.
Those edits were preserved. The findings below concern committed code; none
depends on the unfinished AllTrails changes. Line references describe this
audited tree.

## Findings first

| ID | Priority | Finding | Reproduced outcome |
| --- | --- | --- | --- |
| F1 | P1 | Malformed ImgBB success responses erase upload uncertainty | Two Save attempts issue two POSTs; the photo returns to draft and its journal is empty |
| F2 | P1 | A rejected Save can supply unsaved report text to automatic GitHub backup | No form submission occurs, yet preflight reports a fresh save and the backup contains the attempted text |
| F3 | P2 | An older backup completion removes a newer Save snapshot | A replacement snapshot exists before completion and is absent afterward |
| F4 | P1 | Queued settings/favorites backups can switch repositories | A settings action accepted for repository A writes to repository B after connection replacement |
| F5 | P2 | Automatic backup success signatures are not repository-scoped | An unchanged settings payload is skipped in a newly selected repository |
| F6 | P2 | Cached Back navigation strands the ascent backup control | A completed check leaves “Checking GitHub…” with no button |
| F7 | P2 | The dependency acceptance has expired | `npm run audit:ci` exits 1 with “Audit acceptance expired on 2026-09-21” |

P1 findings can publish incorrect/private content or repeat an external upload.
P2 findings affect backup reliability, recoverability, or a required release
gate. No P0 finding was established. This is a risk-based audit, not a claim
that every possible bug has been found.

## Scope and evidence

The deeper review covered GitHub backup orchestration, queueing, repository
selection, save snapshots, report drafts and local photos, ImgBB response
classification and upload journals, and saved-GPX handoffs. Capture validation,
GPX parsing/metrics, worker lifecycle paths, terrain cache coordination,
settings/bridge/import boundaries, favorites mutation, photo storage, build
configuration, and packaging checks received targeted inspection. Large UI
modules and every branch of capture/terrain orchestration were not exhaustively
reviewed line by line.

The prior [September audit](../archive/codebase-audit-2026-09-13.md) was checked
before reopening issues. Its fixes are not relisted merely because their
subsystems are complex.

| Check | Actual result | Limit |
| --- | --- | --- |
| `npm test` | **1,943 passed; 0 failed** | Rebuilt shipped bundles; Node/jsdom coverage |
| `npm run lint` | Passed, with eight owned web-ext warnings | One manifest, five MapLibre, one ProseMirror, one TipTap warning |
| `npm run test:scale` | **14 passed; 0 failed** | Node/jsdom scale checks; not a browser interaction-latency measurement |
| `node scripts/verify-extension.mjs` | Passed against the freshly built unpacked extension | Hidden Chrome for Testing 153.0.8010.12, new headless; base viewport 1000×760, with the verifier's additional narrow states |
| `npm run audit:ci` | **Failed: expired acceptance** | F7; passing functional tests do not make this gate green |
| `node --test test/project/documentation.test.mjs` | **3 passed; 0 failed** after writing this plan | Documentation links and repository paths |
| `git diff --check` | Passed | Whitespace validation |
| F1 probe | Real upload client plus report-photo service over fake-indexeddb | Simulated provider responses, no live image upload |
| F2–F5 probes | Built editor/worker with existing fixture harnesses and a scripted Git Data backend | F2's editor and worker portions were exercised separately; no real Peakbagger Save or GitHub write |
| F6 probe | Built ascent backup bundle in jsdom with persisted lifecycle events | Proves the handler/state defect, not actual browser BFCache eligibility for that exact state |

No Firefox run, dedicated hardware terrain render, live provider test, live
Peakbagger Save, real GitHub/ImgBB mutation, screen-reader test, or remote CI run
was performed. The Chrome verifier did not record a GPU renderer for this
audit; it is not terrain-render evidence. No new visual-polish claim is made.
After the Chrome run, process command lines and its disposable-profile prefix
were checked: no verifier browser/helper process or matching profile remained.

## F1 — Preserve uncertainty for every malformed upload success

**Source.** `src/photos/imgbb-client.js` (lines 126–155, 174–183) treats
unparseable JSON as ambiguous, but sends parseable `null`, `{}`, and
`{"success":true}` through `providerFailure()`, whose default is
`ambiguous: false`. `src/background/report-photo-service.js` (lines 118–123)
then calls `resetUploadOperation()`. The photo-page caller has the same policy
in `photos/photos.js` (lines 2037–2050).

**Reproduction.** Return HTTP 200 with body `null` from the injected fetch in
`Client.upload()`. The public result is `code: rejected`, `ambiguous: false`.
Use that client in `createReportPhotoService()`, create a local image, and call
`uploadOne()` twice. Observed: **two POSTs**, photo state **draft**, and **zero
journal entries**. `{}` and `{"success":true}` also report a definite refusal.
The provider's actual outcome is unknown in these cases; the probe does not
claim that the simulated endpoint stored an image.

**Fix.** Require a recognized explicit provider refusal before returning a
definite failure after dispatch. Every malformed nominal success must retain
the request journal and enter the existing outcome-unknown recovery path.
Normalize response-validation exceptions too, including out-of-range provider
timestamps, so a raw exception cannot become a retryable generic failure.
Keep pre-dispatch validation failures and established provider refusals
retryable. Do not add automatic POST retries.

**Acceptance.** Extend `test/photos/imgbb-client.test.mjs` and
`test/photos/report-photo-service.test.mjs` with null/empty/wrong-shape JSON,
missing success metadata, invalid timestamps, and explicit refusal controls.
A second Save and a new service lifetime must not issue another POST after an
unknown outcome. Add equivalent recovery coverage for the photo-page caller;
verify the visible recovery copy without making a live upload.

## F2 — Prove that an exact Markdown snapshot belongs to the saved report

**Source.** `src/reports/report-editor.js` (lines 928–969) captures the backup
snapshot from Save's click listener, before successful form submission is
known. `src/background/github-routes.js` (lines 869–871, 881–923) matches a
snapshot by identity and always prefers its nonempty Markdown over the complete
persisted edit-form report. A matching attempted Save is treated as a fresh
Save without checking report equivalence.

**Reproduction.** In the built editor, edit an existing ascent's report to
`UNSAVED attempted report`, make Date required and blank, and click Save.
Observed: `form.checkValidity() === false`, **zero submit events**, but a
`GITHUB_BACKUP_SNAPSHOT` containing that text. In the built worker, supply that
existing-ascent snapshot and a complete persisted form whose report is
`Saved server report`. Preflight returns `{ok:true,fresh:true}`; automatic backup
commits **UNSAVED attempted report** into `report.md`. Returning to the saved
ascent while the snapshot is fresh exposes this path even though the attempted
edit never reached Peakbagger.

**Fix.** Distinguish a Save attempt from a confirmed saved representation.
Retain the exact Markdown sidecar only when its submitted bracket representation
can be shown to match the authoritative persisted report. Otherwise use the
persisted report and retain the unsuccessful attempt as local recovery data;
do not call it a fresh successful Save. Include a submission identity and a
stable content fingerprint/representation in the handoff. Define the allowed
Peakbagger normalization explicitly rather than comparing arbitrary Markdown
strings or always discarding exact Markdown formatting. Client validity alone
is insufficient because server validation and cancelled postbacks also exist.

**Acceptance.** Extend `test/reports/report-editor-mount.test.mjs`,
`test/ascent/ascent-backup.test.mjs`, and
`test/github/github-backup-integration.test.mjs`. Cover rejected/cancelled Save,
server rejection followed by navigation, a subsequently changed or cleared
report, both Save controls, and a successful Save that preserves an equivalent
exact Markdown sidecar. No automatic write may publish an unconfirmed report.
Keep Peakbagger's final Save under user control.

## F3 — Consume only the snapshot revision actually backed up

**Source.** `src/background/github-routes.js` stores a replacement at the same
identity/tab key (lines 479–498). After awaiting a queued GitHub write, it
unconditionally deletes that key (line 979). Reconciliation also looks up and
deletes a matching snapshot after its remote comparison (lines 999–1005), so
the comparison need not describe the snapshot being consumed.

**Reproduction.** Start a backup and hold the backend's ref-update response.
Write a newer snapshot with the same key and report `NEWER SAVE`. Confirm that
it exists, then release the old response. The old backup reports success and
the newer snapshot is **deleted**. Its automatic-save marker and exact Markdown
sidecar are lost, even though that newer version was never included in the
completed commit. This does not prove the independent local report draft was
deleted.

**Fix.** Give each snapshot a unique generation and compare that generation
inside `mutateMap()` before deletion. For reconciliation, capture the candidate
before the remote read and verify the complete intended payload for that
candidate; never consume whichever candidate happens to be newest afterward.
Do not use timestamp equality as the only generation check.

**Acceptance.** Add deferred-network regressions to
`test/github/github-backup-integration.test.mjs`: same-key replacement during
write and reconciliation, unchanged successful consumption, failed/ambiguous
write retention, and two saves in the same clock tick. Preserve the existing
same-tab/new-ascent and unique-ID matching rules.

## F4 — Bind root-file writes to the accepted GitHub connection

**Source.** `src/background/github-routes.js` (lines 788–807) checks authorization
epochs for queued ascent operations, but root-file batches resolve an arbitrary
current connection at commit time. Settings/favorites callers read access before
queueing without passing that identity into `putFile()` (lines 1187–1233).
`src/github/github-write-queue.js` batches by path/content, with no destination
identity.

**Reproduction.** Hold an ascent operation at the front of the queue. Request
settings backup while repository A is selected, then replace the repository
and advance the stored authorization epoch before releasing the blocker.
The settings call returns success and its tree/commit POSTs target repository
B. The corresponding ascent regression already refuses this change; the
root-file path does not.

**Fix.** Carry the expected authorization generation and destination through
root-file queue entries. Coalesce only compatible destinations and validate
again before starting the mutation. Return a superseded result when selection,
account, branch, or authorization changes; a later explicit action can use the
new destination. Do not silently rebind the older request or persist a success
stamp for the wrong connection.

**Acceptance.** Extend `test/github/github-write-queue.test.mjs` and
`test/github/github-backup-integration.test.mjs` for queued manual and automatic
settings/favorites writes, account/repository/branch replacement, disconnect,
and a deliberate retry. Compatible settings/favorites writes should still
coalesce. No obsolete batch may write to the replacement repository.

## F5 — Scope automatic backup stamps to their destination

**Source.** `src/background/github-routes.js` (lines 1086–1126) persists only
`signature` and `syncedAt`, and skips unchanged content without comparing the
repository. Repository selection (lines 388–445) neither scopes those stamps
nor schedules a fresh settings/favorites synchronization. Photo-library backup
has separate repository-aware state; preserve that distinction.

**Reproduction.** Successfully back up settings to A with automatic settings
backup enabled. Replace the selected repository with B and advance its epoch,
then explicitly fire the settings-backup alarm. Observed: **zero network calls**
and the old success signature remains. Thus even a later alarm cannot populate
B while settings are unchanged. Favorites uses the same helper; its parallel
scenario should receive its own regression during remediation.

**Fix.** Store and compare destination identity with each success stamp. Schedule
enabled root-file backups after a successful connection/destination change.
Treat legacy unscoped stamps as unverified. A completion from an earlier
connection must not mark the current one synchronized. Keep retry/error state
scoped consistently. Implement after F4 so scheduling cannot revive obsolete
queued writes.

**Acceptance.** Cover repository, branch, and account changes; existing unscoped
records; in-flight old completions; worker restart; and unchanged-content skips
within the same destination. Verify both settings and favorites in
`test/github/github-backup-integration.test.mjs`, including displayed status
where it consumes these stamps.

## F6 — Resume the ascent backup surface after cached navigation

**Source.** `src/ascent/ascent-backup.js` (lines 286–289) treats every pagehide
as terminal, increments `operationGeneration`, clears the slow timer, and
installs no pageshow/resume handler. Its pending replies are subsequently
discarded by the generation guard. The listener is also one-shot.

**Reproduction.** Hold the initial `GITHUB_CHECK_ASCENT_BACKUP` response. Dispatch
pagehide and pageshow with `persisted: true`, then resolve the response as
current. Observed: **Checking GitHub…**, **zero buttons**, and only one check.
No remaining continuation can resolve that displayed state.

**Fix.** Use the established `src/ui/page-lifecycle.js` ownership model.
Differentiate suspension from disposal, and reconcile/re-render on resume.
An in-flight write can outlive the document; resume must check its result or
current remote state without automatically repeating the mutation. Ensure
repeated Back/Forward cycles do not duplicate controls or subscriptions.

**Acceptance.** Add persisted lifecycle tests to
`test/ascent/ascent-backup.test.mjs` for checking, writing, timeout/reconciliation,
and repeated navigation. Add an actual hidden-browser history traversal with
BFCache eligibility observed for this exact surface; a synthetic event test
alone does not establish that browser behavior. Inspect the restored status at
wide/narrow sizes. Run the real-extension verifier after the load dependency
changes.

## F7 — Restore the dependency gate without weakening its policy

**Source.** `scripts/check-npm-audit.mjs` (lines 18–33, 61–62) accepts two exact
development-tool advisories only through **2026-09-21**. The actual current
`npm run audit:ci` run exited 1 on that expiry. The guard is behaving as designed;
the unresolved maintenance item is the expired acceptance, not an incorrect
comparison or a newly established runtime vulnerability.

**Fix.** Refresh the advisory records, dependency paths, locked versions, and
available compatible patches. Upgrade the affected tooling when a suitable
patch exists. If none does, document a fresh, narrow risk review before any
time-limited renewal. Do not merely move the date, broaden the acceptance,
disable the check, or run a forced dependency update. This audit makes no claim
about the current availability of a patched version.

**Acceptance.** Run `npm run audit:ci`,
`node --test test/project/dependency-audit.test.mjs`, and the build/lint/package
checks affected by any tooling update. Record whether the result is a clean
graph or an explicitly accepted development-only exception. Remote CI remains
unproven until an authorized push and completed workflow.

## Execution order and completion contract

1. **F7:** resolve the already-failing dependency gate in an independent unit;
   an unavailable patch must not delay preparing the runtime fixes below.
2. **F1:** preserve upload uncertainty and its durable recovery journal.
3. **F2:** tie exact report source and automatic backup to saved content.
4. **F3:** add snapshot generations and conditional consumption.
5. **F4:** bind queued root writes to their accepted connection.
6. **F5:** scope automatic stamps and schedule destination changes.
7. **F6:** restore cached-navigation state and verify the actual browser path.

Commit each completed independent unit after focused tests and relevant lint.
Do not absorb the pre-existing AllTrails work into audit fixes. At integration,
run the full suite, scale checks, lint, dependency gate, and Chrome/Firefox
extension checks. Use focused hidden-browser renders for changed UI and record
browser, viewport, and renderer if graphics are exercised. Retain separate
evidence limits for live providers, remote writes, native focus, screen-reader
speech, packaging, and remote CI.

## Existing limitations and proof gaps

- The documented same-target report draft policy remains last-writer-wins
  across tabs; see `docs/trip-report-editor.md` (lines 572–594). This is an
  existing product limitation, distinct from F3's unconditional consumption of
  a newer backup snapshot. A multi-draft design requires a separate decision.
- The [report caption plan](report-image-captions.md) still requires live
  Peakbagger save/reopen proof. Passing local conversion tests does not close it.
- The [Imgur plan](imgur-media-hosting.md) remains proposed feature work.
- The uncommitted AllTrails adapter and the Gaia/onX adapters depend on provider
  UI contracts. This audit inspected their failure/identity boundaries and ran
  the repository baseline; it did not establish current authenticated provider
  markup, locale, membership, or permission-prompt behavior.
- No new measured performance defect was established. Scale-test success is not
  proof of interaction latency or of every GPU/driver combination.

## Closure ledger

### Fixed and verified

F7: `web-ext` 10.7.0 resolves patched `addons-linter` 10.13.0 and `image-size`
2.0.4, so the expired acceptance was removed and the gate now requires zero
advisories. `npm run audit:ci`, the focused dependency-audit tests, `npm run lint`,
and `npm run package` passed locally. The full suite's initial run found a stale
`fast-uri` 3.1.7 test expectation after the lockfile advanced to 3.1.8; the
expectation was corrected and its focused test passed.

### Intentionally not changed

F1–F6, the documented draft-sharing policy, and the independent caption/Imgur
plans were not changed by the F7 dependency repair. The AllTrails feature is a
separate unit of work.

### Changed but not fully proven

No runtime audit fixes have been made. F1–F6 remain open. Remote CI is unproven
until an authorized push and a completed workflow. Future remediation must put
each remaining item here or in “Fixed and verified” with its commit and actual
evidence.
Archive this plan only after every finding has an explicit disposition, keeping
the verification gaps and owner decisions intact.
