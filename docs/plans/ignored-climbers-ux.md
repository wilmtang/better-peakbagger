# Climber lists and report visibility — UX specification

Status: proposed, 2026-10-01. Companion to the
[implementation plan](ignored-climbers.md); wireframes are design intent, not
screenshots of implemented or visually verified UI.

## Design direction

Keep the report table central. Use the extension's existing type, spacing,
green accent, neutral borders and dark-theme tokens. One compact favorites
control does the filtering; a text-style reveal control handles exceptions.
Avoid a second full Beta filter toolbar above a short Selected Trip Reports table.

A small control must still be readable and operable: 12–13 px text, 32 px minimum
interactive height with padding, visible focus ring, 4.5:1 text contrast, and a
plain-language accessible name. Do not fade it to near invisibility or rely on an
unlabelled eye icon. Green communicates the active favorite filter; ignored
status is neutral, not red or a judgment about the climber.

## Profile: an independent, reversible Ignore action

Place **Ignore** beside the existing favorite star in the profile heading action
group, aligned with the heading. Use a neutral text/outline button with a small
crossed-eye icon if it reads clearly at 14 px. Keep a visible text label.

```text
Alex Example                          ☆   Ignore
```

After a confirmed write the label is **Unignore**, with a restrained **Ignored**
status and polite announcement: “Alex Example's reports are now hidden.” Tooltip:
“Hide this climber's reports on peak and ascent pages.” No modal for this
reversible action. Keep the button's position and width stable while saving.

```text
Alex Example                          ☆   Unignore
                                      Ignored
```

Ignore appears in both Buddy and custom-favorite modes. Changing favorites mode
must never remove it. Keep native Add/Remove Buddy controls independent. Allow a
climber to be both favorite and ignored, without a destructive confirmation or
silent removal from either list. Omit self-ignore when the profile matches the
signed-in climber. A failed write preserves the previous state and displays a
nearby actionable error with Retry, not only a tooltip.

On narrow pages let the action group wrap below the name without shrinking or
clipping the heading. Use textContent for names. No badges are injected into
unrelated Peakbagger tables or profile links.

## Peak: Selected Trip Reports

Preserve Peakbagger's heading and explanatory sentence. Add one short toolbar
immediately above the selected-report table, keeping existing Peak GPS Map links
and My Ascents separate.

```text
Selected Trip Reports
Click on a date for the full report.

[ ☆ Favorites  8 ]                      Show ignored · 3
Date          Climber             Type  GPS  TR Words  Link
… native rows …
                         18 of 21 selected reports shown
```

In Buddy source mode the button reads **Climbing buddies**, not Favorites. This
is one toggle whose label follows the existing source preference, not two
competing modes or a dropdown that changes the user's list source.

- Off: neutral outline and empty star. On: subtle tinted background, active
  border, filled star and `aria-pressed="true"`. No large solid call-to-action.
- The badge is the number of favorite/buddy rows available under the current
  ignored-visibility choice. It is a row count, not unique climbers.
- Preserve the peak's native report ordering. No extra sorting controls here.
- Favorites-only is remembered locally across peak pages and browser restarts,
  independently of the full ascent-list Favorites toggle. Tooltip: “Only show
  reports from your favorites. Remembered on this device.”
- If the source has no entries, keep a saved active preference active and show
  an honest empty state plus **Manage climber lists** and **Show all reports**.
  Do not silently render all rows behind an apparently active toggle.
- While an uncached Buddy List loads, say “Loading climbing buddies…” in the
  report region. With no valid cache on failure, show an unavailable state and
  **Retry** / **Show all reports**. With a valid stale same-owner cache, render
  it and expose the refresh status. Ignore filtering remains independent.

A two-line toolbar at narrow widths is intentional: favorites on the first
line, reveal and status on the second. Fit the containing peak column, which is
about half the viewport on the site's desktop layout. No overlap with Peak GPS
Map links, native table headers or adjoining peak data. Keep original table
columns and wrapping; never impose a page-wide fixed toolbar width.

## Counted reveal and filter composition

Use a text-style button in the toolbar's trailing utility area, outside the
regular filter chips. On individual reports place it where the report would
begin. Use a real button with `aria-pressed`, a label naming ignored content,
and `aria-controls` for the controlled region.

| State | Visible control |
| --- | --- |
| No ignored records loaded | Omit control; no meaningless “0 hidden.” |
| Ignored records concealed | **Show ignored · 3** |
| Some concealed records also fail other filters | **Show ignored · 3**, plus nearby muted **1 matches filters** when it helps explain the click. |
| Ignored records temporarily included | **Hide ignored · 3**; nearby **0 hidden by ignore**. The button's 3 is the number of loaded ignored records governed by it. |
| All ignored records fail other filters | Reveal stays available. Say **None match filters** and provide **View full list**; never claim those rows became visible. |

The button always names ignored reports. The small overall status separately
counts all rows excluded by any filter. Its accessible description distinguishes
“3 reports hidden because you ignored their climbers; 1 matches current filters”
from “3 ignored reports included; 0 hidden by ignore.” No tooltip-only counts.
On full ascent lists use **ascents** for counted rows, because some have no TR.

Let `R` be loaded eligible rows, `I` the rows with confirmed ignored authors,
`P(r)` the ordinary filter predicate (including Favorites), and `reveal` the
page-only reveal flag:

```text
visible(r) = P(r) AND (reveal OR r not in I)
ignoreHidden = reveal ? 0 : |I|
revealWouldAdd = reveal ? 0 : count(r in I where P(r))
otherHidden = count(r in R where not P(r) and (reveal or r not in I))
totalHidden = ignoreHidden + otherHidden
```

Counts are derived from the same records and predicates as rendering; a row is
counted once. With 12 rows, 3 ignored, 4 favorites and 1 favorite also ignored:

| Favorites | Reveal | Shown | Hidden by ignore | Hidden by other filters |
| --- | --- | --- | --- | --- |
| Off | Off | 9 | 3 | 0 |
| On | Off | 3 | 3 | 6 |
| On | On | 4 | 0 | 8 |
| Off | On | 12 | 0 | 0 |

Reveal does not secretly disable Favorites, GPS, word-count or other filters.
For a literal full list, **View full list** performs a temporary page override:
ordinary predicates are bypassed and ignored rows included. Show a small
**Restore filters** action while overridden. Keep saved filter choices intact;
next navigation resumes them. Activating any ordinary filter exits that override
and applies that explicit choice normally. **Hide ignored** also exits the
full-list override and restores ordinary predicates with ignores concealed.

Reveal/full-list override resets on navigation, reload and BFCache restoration.
Unignore changes the list permanently; reveal never does. Changes from another
tab recalculate counts without altering the current page's reveal flag.

## Empty and unavailable states

Keep the table header when supported; put one short message where rows were,
with an obvious recovery action and no tall banner.

| Situation | Copy and recovery |
| --- | --- |
| All selected reports ignored | “All 3 selected reports are from ignored climbers.” **Show ignored · 3** |
| Favorites active, no matching reports | “No selected reports from your favorites.” **Show all reports** |
| Matching favorites all ignored | “Your favorites' reports on this page are hidden.” **Show ignored · 2** |
| No selected reports provided by Peakbagger | Preserve native empty content; do not imply extension filtering removed it. |
| Buddy source unavailable | “Couldn't load your climbing buddies.” **Retry** · **Show all reports** |
| Ignore storage unavailable | “Couldn't load ignored climbers.” **Retry**; leave content readable and avoid claiming it was filtered. |

**Show all reports** turns off and persists the peak favorites preference but
still respects ignores. Use **View full list** when a temporary view including
ignored content is intended. Tooltips and accessible names make that distinction
explicit. The persistent favorite toggle remains the normal way to change mode.

## Full ascent list

Reuse the existing Beta filter toolbar. Add no new full-size chip. Put the
counted reveal button beside the result summary/reset utilities, wrapping into a
second utility row as needed. Rename **Show all** to **Clear filters** so it does
not promise to bypass ignores. Keep filter reorder behavior and stable sorting.

```text
[ Has beta ] [ Favorites ] [ GPS track ] [ Trip report ] [ Link ]
42 of 57 ascents shown          Clear filters   Show ignored · 5
```

Compact views still hide identified ignored authors and show the reveal count;
the existing “no beta data” guidance remains. Counts describe the loaded
page/year range only. Do not rewrite Peakbagger's total number of ascents.

## Individual ascent report

Keep the author/title, ascent date, route, summary and map tools visible. Replace
the report presentation with one restrained inline row; no skeleton, modal or
large warning panel.

```text
Ascent Trip Report
1 report hidden · Ignored climber                  Show ignored · 1
```

After reveal, show the original report body with **Hide ignored · 1** and
**0 hidden by ignore** above it. Report images, captions, videos and report links
follow the same hide/reveal boundary. Maps and GPX tools are independent. A page
with no report gets no hidden-report placeholder. An ambiguous author must never
be assigned to the signed-in account just to make filtering work.

Keyboard activation leaves focus on the utility button. Re-hiding must not leave
focus in a hidden report link. No automatic scrolling or animation of long
report content. Do not reserialize or destroy report markup.

## Settings and list manager

Rename visible **Favorite climbers** navigation to **Climber lists**, retaining
`options.html#favorites` and `favorites.html` for existing links. Settings card:

```text
Climber lists
Follow favorite climbers and manage ignored climbers.
Ignore and don't display TRs of certain climbers.
                                           [ Manage climber lists ]
```

The standalone manager uses two accessible tabs with counts. Default to Favorites;
allow a stable deep link to Ignored for profile/restore guidance. Preserve focus
and each tab's search state during live list updates.

```text
Climber lists
[ Favorites · 128 ] [ Ignored · 7 ]

Ignored climbers
Ignore and don't display TRs of certain climbers.

Climber link or id                         [ Add to ignored ]
[ Search by name or id                    ] [ Newest first ▾ ]

Alex Example              #900002              Unignore
Jordan Example            #900003              Unignore

7 ignored climbers                  GitHub backup & sync →
```

Reuse existing manager components and list density: linked name, secondary ID
and date added, fuzzy name/ID search, name/newest sorting, count and removal Undo.
The Ignored tab is available in both favorite-source modes. Existing source
selection, Buddy refresh, merge/mirror and Buddy-removal preference remain inside
Favorites. Ignore has no Buddy import/mirror action and no new source setting.

Validate pasted links/IDs with the existing guarded profile lookup; reject
ambiguous or failed lookups instead of adding an invented name. Duplicate adds
focus the existing entry and announce “Already ignored.” Capacity, lookup and
storage errors stay near the action. Unignore offers entry-level Undo without
resetting the search, scroll position or unrelated entries. Whole-list restore
previews its impact and uses guarded Undo, matching current favorites safety.

## GitHub controls

Keep GitHub connection setup in Settings → Backup & sync. Rename the visible
favorites subsection to **Climber lists backup & sync**, preserving its anchor.
Show Favorites' existing backup controls as one group and Ignored climbers as a
separate group; never imply that favorites acquired two-way sync in this change.

```text
Ignored climbers
Saved on this device · 7 climbers
[ Back up now ]   [ Restore… ]
☐ Sync ignored climbers with GitHub
```

With sync enabled, **Sync now** is the primary action; fold manual restore into
a secondary action and reconcile it under the sync transaction. Show last
successful time and Pending changes/Offline/Review changes states. Do not stack
an automatic-backup toggle and a sync toggle for the same list.

First enable with an existing remote file presents a concise impact preview.
Default **Merge lists**; also allow **Use GitHub's list** or **Use this device's
list**, with explicit counts of additions/removals. Conflict review shows only
affected climbers and keeps the previous local list usable. Disconnect leaves
the local list and pending local edits intact.

Use the existing connected repository; state that IDs and names are uploaded and
that public repositories and prior Git history may expose the list. Put this
explanation at setup, not in every report toolbar. A GitHub connection is never
required to use Ignore.

## Visual review checklist

Before implementing UI, confirm that the intended browser verifier can load the
real `dist/` extension and relevant masked fixture. Inspect light/dark screenshots
at 1440×1000 and 390×844 for site pages, and 1024×900 and 390×844 for the manager.
Include the narrow desktop peak column, long names, 1,500-entry counts, 200% zoom,
all-hidden, favorite overlap, revealed, loading, failed and empty states.

Check readable utility controls, alignment, wrapping, non-jumping busy state,
keyboard focus, accessible tab and toggle semantics, polite count announcements,
no hidden focusable descendants, and reduced motion. Use native table semantics;
never restyle a table row as a block to hide it. Keep active state readable without
color alone. Screen-reader speech and native window focus require separate proof;
DOM tests and hidden screenshots cannot establish them.

This specification is not visual verification. Record rendered evidence and any
uninspected page states in the implementation plan before calling the UI complete.
