# Favorite climbers

> **Status:** Implemented on `codex/favorite-climbers` on 2026-07-21. This is the
> completed execution record; maintained behavior lives in
> [`docs/architecture.md`](../architecture.md),
> [`docs/github-ascent-backup.md`](../github-ascent-backup.md), and
> [`PRIVACY.md`](../../PRIVACY.md).
>
> A later follow-up added live totals, fuzzy search, automatic cache refresh
> after native Buddy actions, automatic custom-list additions, and an opt-in
> removal policy. Those additions are intentionally documented only in the
> maintained guides above; the decisions below remain historical.

## Why

Peakbagger's Buddy List (`report/report.aspx?r=b&cid=<your id>`) is a dead end:
the only thing you can do with it is open that one page and eyeball your
buddies' latest climbs. This feature turns buddies into **favorite climbers**
you can actually use — most importantly, filtering any peak's ascent list down
to "people I care about" — and lets you outgrow the Buddy List's 100-climber
cap with a curated list of your own.

## Decisions already made

- **Scope: everything above ships in this round** (filter + cache, source
  modes, settings manager, climber-page button, GitHub backup/restore).
- **Storage: `storage.local` is the source of truth.** Matches the repo's
  "gate/mode in sync, data in local" discipline (drafts, GitHub auth). A
  100-buddy merge with names would sit right at `storage.sync`'s 8 KB per-item
  cap and could fail mid-merge; sync also wouldn't bridge Firefox↔Chrome.
  Cross-device: in Buddy List mode Peakbagger itself is the sync; custom lists
  travel via the GitHub backup.

## Data model

Synced setting (inside the existing `bpbSettings` item, `src/settings/settings-schema.js`):

- `favoritesSource: 'buddies' | 'custom'`, default `'buddies'`, cleaned like
  `chartDefaultSeries`. No on/off gate — the Favorites button is part of the
  always-on Beta filter bar like every other button there.

`storage.local` (keys owned by the new pure module `src/favorites/favorite-climbers.js`):

- `bpbFavoriteClimbers` → `{ schemaVersion: 1, entries: [{ cid, name, addedAt,
  source: 'buddy'|'manual' }] }` — deduped by cid, names trimmed ≤ 200 chars,
  capped ~500 entries.
- `bpbBuddyCache` → `{ ownerCid, entries: [{ cid, name }], fetchedAt }` —
  `BUDDY_TTL_MS = 7 days`. A cache whose `ownerCid` differs from the currently
  detected login is treated as absent (account switch invalidates it).

GitHub backup file: `favorite-climbers.json` at the backup-repo root:
`{ schemaVersion: 1, exportedAt, entries }`. Safe by construction:
`inspectRootTree` (`src/github/github-client.js:157-194`) considers only the marker
blob and `type === 'tree'` folders, so ascent commits neither prune nor trip
over a root file (verified against current source).

## Verification record

The original execution record marked the feature implemented, but its test and
commit checklists did not record executed counts or browser results. Planned
coverage included pure cleaning/parsing, filter composition and cache refresh,
climber/Settings actions, and fixed-root GitHub backup/restore. Live Buddy-page,
Cloudflare, GitHub, and native UI behavior cannot be inferred from that checklist.

## Risks and notes

- Buddy-page markup drift: the parser keys on the stable cell-0
  `climber.aspx?cid` anchor; an unparseable page fails soft (keeps the old
  cache).
- A Cloudflare challenge on an options-page fetch classifies as
  `'challenged'` → actionable copy, never auto-retried.
- Name formats differ by source ("Surname, First" on the Buddy List,
  "First Last" on climber pages) — cosmetic only; dedupe is by cid.
- GitHub favorites backup is manual-only; `autoGithubBackup` does not include
  it.
