# Settings portability remediation

Approved follow-up to [the storage audit](../settings-storage-and-sync.md).
Each independent unit is committed after its focused checks.

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
- **Intentionally not changed:** GitHub settings/favorites remain push plus
  explicit restore. Credentials remain local and excluded from GitHub; manual
  credential export remains explicit. Peakbagger Buddy List is not replaced by
  custom-list import. No remote publishing or writes are part of verification.
- **Changed but not fully proven:** live GitHub concurrency and real browser
  account sync across physical devices need release verification. Hidden
  fixture checks do not establish native window/focus behavior or native file
  chooser appearance. Documentation corrections in unit 4 are pending.
