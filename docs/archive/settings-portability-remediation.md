# Settings portability remediation

Approved follow-up to [the storage audit](../settings-storage-and-sync.md).
Completed locally on 2026-10-23. Each independent implementation unit was
committed after its focused checks; live-service and native proof gaps remain.

1. Protect settings and favorites root backups from unreviewed remote replacement.
2. Separate portable preferences from device settings and local transfer consent;
   migrate existing local weather, overlay and photo-tool preferences safely.
3. Add independent JSON file export/import for favorites and ignored climbers.
4. Correct the settings transfer guide and privacy disclosure, and update the
   audit to describe the resulting policy.

## Closure ledger

- **Fixed and verified:** root-backup regression reproduced on the previous
  worker; guarded writes and snapshot-bound replacement confirmation added.
  Focused unit and browser results are recorded with the implementation commit.
  The settings policy now has 67 portable preferences and nine device-local
  values (dimensions, cache budget and GitHub transfer choices). Schema v5
  excludes device values even when importing older files. Weather, overlay and
  photo-tool preferences migrate only when no synced choice exists. Fresh
  installs publish no default-filled sync item. Existing local connections
  preserve legacy transfer choices; new connections and ignored sync start off.
  Verification: 3,392 full-suite tests passed, plus the added fresh-install
  regression in the 11-test settings-store suite. ESLint passed. Hidden Chrome
  156 and Firefox 157 Settings checks passed at 390×900 and 1280×900 in both
  themes, including enlarged controls, pending/error/retry and focus retention;
  narrow and desktop screenshots were inspected.
  Favorites and ignored climbers now have independent JSON export/import with
  bounded validation, replacement preview, stale-state guards and existing
  membership rules. All 349 favorites/options tests and ESLint passed. Hidden
  Chrome 156 and Firefox 157 list-file checks passed at 390×900 and 1280×900 in
  both themes, with normal/doubled control text, native JSON downloads,
  pending/error/conflict/stale/retry/success states, stable geometry and keyboard
  focus. Screenshots were inspected; the final list contents were asserted.
  Maintained documentation now matches schema v5, the unified credential opt-in
  including Garmin, and the local consent policy. Final verification: all 3,398
  tests, full `npm run lint`, documentation links and script inventory passed.
  Report keys matched the schema programmatically. Final process/profile
  inspection found no remaining test browsers or disposable profiles.
- **Intentionally not changed:** GitHub settings/favorites remain push plus
  explicit restore. Credentials remain local and excluded from GitHub; manual
  credential export remains explicit. Peakbagger Buddy List is not replaced by
  custom-list import. Browser sync remains whole-item conflict resolution, not
  a per-field cross-device merge. Page filters, device layouts and caches remain
  local by design. No remote publishing or writes are part of verification.
- **Changed but not fully proven:** live GitHub concurrency and real browser
  account sync across physical devices need release verification. Hidden
  fixture checks do not establish native window/focus behavior or native file
  chooser appearance. No live multi-device merge or remote write is claimed.

## Implementation commits

| Unit | Commit | Result |
| --- | --- | --- |
| Shared root-file overwrite protection | `9b57cbeb` | Known-baseline or snapshot-bound approval; invalid remote files preserved; retry revalidation |
| Portable/device settings policy | `9007ed67` | 67 portable keys, nine local keys, schema v5, safe preference migration and device consent |
| Independent climber-list files | `3a3224c5` | Bounded JSON, replacement previews, concurrency guards and membership checks |
| Maintained report and privacy corrections | Documentation commit containing this ledger | Current inventory, credential policy, local consent and script inventory |

## Validation record

- Root backup: 192 focused tests passed; the old worker failed the fresh-profile
  overwrite assertion. New tests exercise first-seen remote data, changed remote
  data, invalid files, stale review and branch-ref retry.
- Settings migration: 3,392 full-suite tests passed, followed by the new
  fresh-install case in the 11-test settings-store suite.
- List files: all 349 favorites/options tests passed, including actual worker
  stale-state and conflicting-membership rejection.
- Hidden Settings and list-file fixtures passed in Chrome 156 and Firefox 157
  at 390×900 and 1280×900, both themes, normal/doubled control text. Checks cover
  keyboard duplicate prevention and focus, pending/error/retry, snapshot review,
  action/panel/following-content geometry and reading position. List files also
  exercise native downloads and assert the final rendered list. Screenshots
  were inspected. API/storage/network work is stubbed in those fixtures.
- Real unpacked `dist/` passed hidden Chrome verification after the worker and
  settings changes, including local map-size persistence and BFCache.
- The final full-suite run initially passed 3,397/3,398: the sole failure was
  the new browser helper missing from the script inventory. The inventory was
  corrected in the documentation unit. The final `npm test` rerun passed all
  **3,398 tests**, with no failures, skips or cancellations. Full `npm run lint`
  passed (ESLint, rebuild and packaged extension lint). The five documentation
  and verifier-inventory checks passed, including the repaired historical link
  to the current schema heading.
- The maintained report's portable inventory was compared programmatically
  with all 67 schema keys. Schema v5 excluded all nine device keys and
  credentials by default; all transfer defaults were false.

The checks use no real credentials, browser sync accounts, GitHub writes or
Peakbagger modifications. Enlarged fixture text is not native browser zoom.
Headless screenshots and DOM focus do not prove native window placement, file
chooser appearance, screen-reader output or physical-device sync.
