# Climber lists and report visibility

Open **Settings → Ascent beta filter → Climber lists → Manage climber lists**.
Climber lists is the first subsection. Favorites and Ignored
have separate tabs, searches and counts. The existing `favorites.html` page and
Settings `#favorites` link remain valid; `favorites.html#ignored` opens Ignored.

## Favorite and ignored membership

Favorites follows either your Peakbagger climbing buddies or your custom list,
as selected in Settings. These sources are never combined. A Buddy cache is used
on site pages only when its owner matches the signed-in account; a stale matching
cache stays usable if refresh fails. Missing or failed data is distinct from a
valid empty list.

**Ignore** appears on another climber's public profile in either source mode.
After a confirmed save it becomes **Unignore**. Ignored climbers cannot be newly
added to custom favorites or through the profile's native **Add to My Buddy
List** control. Those actions are dimmed, with guidance to Unignore first.
Favorites and known climbing buddies cannot be newly ignored; remove them from
the indicated list first. The rule applies in either source mode, including
custom favorites that are not the currently selected source. Your own profile
omits Ignore.

Unignore, Remove favorite, and Remove buddy remain available to resolve existing
overlaps. Nothing is silently deleted or moved between lists. Ignore still takes
precedence for visibility when an old overlap exists. Conflicting actions wait
while a profile save or native Buddy addition is pending. If a Buddy change
cannot be confirmed, refresh the profile before ignoring.

Imports, replacements, GitHub restores, sync merges, and Undo enforce the same
rule. A conflicting bulk operation leaves the lists unchanged and identifies
the climber and required removal. Concurrent extension list edits share one
worker transaction lane; pending ignored-sync results reserve their IDs against
favorite additions until reconciliation or review.

Peakbagger owns the Buddy List. Protection uses the native profile controls and
the last saved Buddy cache, even when the custom favorite source is selected.
Refresh your Buddy List after changing it elsewhere. Changes through other
Peakbagger surfaces, another browser, or another device can still introduce an
overlap; the extension does not silently edit the server or provide a global
transaction across Peakbagger and local storage.

Ignored climbers are saved on this device, across browser restarts and Peakbagger
account changes. Each entry contains a climber ID, displayed name and date added.
The list holds up to 1,500 entries. In the Ignored tab, add a verified profile link
or ID, search by name or ID, sort by name or newest, and remove entries with
**Unignore**. Entry Undo preserves unrelated edits. Errors stay beside the action;
a failed write does not display saved success.

## Reports and ascents

| Surface | What ignoring conceals | What stays available |
| --- | --- | --- |
| Peak → Selected Trip Reports | Rows from ignored authors | Other peak information, maps and Peakbagger totals |
| PeakAscents, full or compact view | Ignored authors' loaded ascent rows, including rows without report text | Native table headers, ordering, year navigation and unaffected rows |
| Individual ascent | The author's dedicated report body, links, images, captions and embedded media | Author/title, date, route, summary, GPX and map tools |

Personal ascent lists, Buddy reports, editors and peak-list sorters keep their
existing behavior. Ambiguous author markup is left readable. Empty individual
reports receive no hidden-report placeholder.

**Show ignored · N** temporarily includes ignored content on the current page.
It never removes anyone from the list. **Hide ignored · N** conceals it again.
The count describes loaded rows, not unique climbers or all ascents on Peakbagger.
Reveal resets on navigation, reload and BFCache restoration. Another tab's list
edit updates membership and counts without changing this page's reveal choice.

On peak pages, **Favorites** or **Climbing buddies** is one independent toggle,
remembered on this device across peak visits. It preserves Peakbagger's ordering.
On full ascent lists, the existing beta, report, GPS, link and favorites filters
combine. Reveal continues to respect those filters. **Clear filters** clears
ordinary filters and keeps ignores concealed. If nothing matches, **View full
list** temporarily bypasses ordinary filters and includes ignored rows; **Restore
filters**, **Hide ignored**, or changing an ordinary filter ends that override.
Saved filter choices remain intact.

For a legacy overlap, with 12 loaded rows, 3 ignored, 4 favorites and 1 favorite
also ignored:

| Favorites | Reveal | Shown | Hidden by ignore | Hidden by other filters |
| --- | --- | --- | --- | --- |
| Off | Off | 9 | 3 | 0 |
| On | Off | 3 | 3 | 6 |
| On | On | 4 | 0 | 8 |
| Off | On | 12 | 0 | 0 |

A saved active favorites filter stays active when its list is empty. The table
shows an honest empty state and recovery actions. Failed Buddy or ignore reads
show actionable status and Retry; failed ignores do not conceal arbitrary rows.

Report nodes stay in place. Concealment removes the report from layout and
keyboard navigation, recovers focus to the reveal button, and pauses playing
media. Embedded iframe sources, including `srcdoc`, are suspended and restored
on the same outer nodes; their players can restart on reveal. This is a display
preference, not a network blocker: native pages and media may load before hiding.

## Optional GitHub backup and two-way sync

Use **Settings → Backup & sync → Climber lists backup & sync**. Connect your
existing backup repository once. Favorites retains its existing one-way backup
controls. Ignored climbers uses a separate root file, `ignored-climbers.json`.
A GitHub connection is not required for local ignoring.

**Back up now** conditionally writes the current list. A changed or first-seen
existing remote file requires an impact preview. **Restore…** previews replacement
and offers guarded whole-list Undo. A missing file means no backup exists; a valid
empty file can intentionally clear the list after review. Concurrent local or
remote changes invalidate the preview instead of overwriting them.

Both climber-list sync checkboxes default to checked and remain disabled until
GitHub is connected with its required permission. Saved opt-outs remain intact.
First ignored-sync setup previews **Merge lists**, **Use GitHub's list**, or
**Use this device's list**.
Merge keeps currently ignored IDs from both sides. Conflicting versions require
an explicit device/GitHub choice; names, added dates and removals are shown.

After setup, sync compares both sides against their last confirmed common list.
Independent additions and removals converge. Conflicting edits to the same
climber pause for review; timestamps never choose a winner. A disappeared remote
file also requires review. **Sync now** checks immediately. Browser startup,
manager opening (rate limited), a 30-second trailing change alarm and a 15-minute
periodic alarm provide later checks while the browser runs. Delivery is not
instantaneous and can be delayed while offline or the browser is closed.

Status distinguishes **Pending changes**, **Syncing…**, **Synced**, **Offline —
changes saved on this device**, and **Review changes**. Manual upload is labelled
**Backed up**. Disabling sync or changing/disconnecting the repository cancels
network work and preserves local membership. A new repository requires setup.
Interrupted transactions retain a journal; confirmed uploads are reconciled with
later local edits, and uncertain outcomes require review.

Only IDs, names and added dates enter this file. Local revisions, filters, Buddy
cache, credentials, report contents, reasons and browsing history are excluded.
Public repositories can expose the list. Removing an entry updates the current
file after successful sync; prior Git history can retain it. See
[Privacy](../PRIVACY.md) and the [GitHub failure model](github-ascent-backup.md).

Implementation and verification evidence, including remaining live-service and
native accessibility gaps, is recorded in the
[archived delivery ledger](archive/ignored-climbers.md).
The mutual-exclusion change and its verification boundaries are recorded in the
[membership delivery ledger](archive/climber-membership-2026-10-04.md).
