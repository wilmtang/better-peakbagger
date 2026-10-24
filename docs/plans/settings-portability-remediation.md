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
- **Intentionally not changed:** GitHub settings/favorites remain push plus
  explicit restore. Credentials remain local and excluded from GitHub; manual
  credential export remains explicit. Peakbagger Buddy List is not replaced by
  custom-list import. No remote publishing or writes are part of verification.
- **Changed but not fully proven:** live GitHub concurrency and real browser
  account sync across physical devices need release verification. Hidden
  fixture checks do not establish native window/focus behavior. Units 2–4 are
  pending.
