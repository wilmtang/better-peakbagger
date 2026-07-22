# Settings export/import, GitHub settings backup, and favorites auto backup (completed plan)

Two related gaps, one shared mechanism:

- Extension settings live only in `chrome.storage.sync` (`bpbSettings`), which
  does not cross browser vendors, fresh profiles, or machines without the same
  browser account. This plan adds two ways out, both surfaced in the existing
  **Sync for nerds** options section: **file export/import** (a JSON download
  that imports into a brand-new browser with zero other setup) and **GitHub
  backup/restore** (push the same payload to the already-connected backup
  repository, manual button plus opt-in automatic push on change).
- Favorite climbers live only in `chrome.storage.local`
  (`bpbFavoriteClimbers`) and already have manual GitHub backup/restore
  buttons, but the backup goes stale the moment the list changes on a climber
  page or through buddy sync. This plan adds an opt-in **automatic** favorites
  push whenever the stored list changes.

Both automatic paths are the same worker-side debounced-alarm, signature-gated
push, so they are planned and built together.

## Hard invariants — read before writing any code

1. **Never create a second schema.** Every settings value passes through
   `src/settings/settings-schema.js` `clean()`; every favorites value passes
   through `src/favorites/favorite-climbers.js` `cleanFavorites()`. Do not
   copy a default, a bound, or a validation rule into a new file.
   `test/settings/settings-schema.test.mjs` fails the build if you do.
2. **The GitHub token never leaves the worker.** `bpbGithubAuth` stays in
   `storage.local`, is read only via `GithubAuth.authStore.read()` inside
   `src/background/background.js`, and is never included in any payload,
   message response, or backup file.
3. **All worker event listeners register synchronously at top level.** The MV3
   worker dies and restarts constantly; a listener registered inside an async
   callback misses the event that woke the worker. `storage.onChanged`,
   `Settings.subscribe`, and `alarms.onAlarm` registrations all go in the
   worker's top-level IIFE body, next to the existing `ext.alarms` block.
4. **Debounce with `ext.alarms`, never `setTimeout`.** A timeout dies with the
   worker; `ext.alarms.create(name, ...)` with an existing name *replaces* the
   alarm, which is exactly the trailing-edge debounce we want.
5. **Every GitHub write goes through `enqueueGithubWrite(...)`**
   (`background.js:85`) so automatic, manual, and ascent-batch pushes cannot
   race each other on the mutable branch.
6. **Message endpoints for these features are extension-page-only.** New
   `GITHUB_SETTINGS_*` types must be added to the `extensionOnly` guard in the
   `onMessage` listener (`background.js:1692`), exactly like
   `GITHUB_FAVORITES_BACKUP/RESTORE` already are.
7. **One commit per completed unit** (see the commit sequence at the end), and
   `npm test` plus — because the worker and bundle composition change —
   `npm run verify:extension` must pass before each commit.

## Names used throughout (do not improvise different ones)

| Thing | Name |
| --- | --- |
| Settings schema key (new) | `autoSettingsBackup` (boolean, default `false`) |
| Settings schema key (new) | `autoFavoritesBackup` (boolean, default `false`) |
| Settings backup file (repo root) | `settings.json` |
| Favorites backup file (repo root) | `favorite-climbers.json` (exists: `FAVORITE_CLIMBERS_BACKUP_PATH`, `background.js:33`) |
| Settings debounce alarm | `bpb-settings-backup` |
| Favorites debounce alarm | `bpb-favorites-backup` |
| Settings backup state (`storage.local`) | `bpbSettingsBackupState` = `{ signature, syncedAt, attempts? }` |
| Favorites backup state (`storage.local`) | `bpbFavoritesBackupState` = `{ signature, syncedAt, attempts? }` |
| New message types | `GITHUB_SETTINGS_BACKUP`, `GITHUB_SETTINGS_RESTORE` (no payload either way) |
| Changed message type | `GITHUB_FAVORITES_BACKUP` no longer takes `content` |
| New options element ids | `favorites-auto-backup` (checkbox); settings-backup ids are yours to choose, prefixed `settings-backup-` |
| Debounce / retry timing | 1 minute debounce; on push failure re-arm at 10 minutes, at most 2 retries per change |

## Decisions (already made — do not reopen)

- **Settings file scope: settings only** — the `bpbSettings` schema values.
  Favorites keep their own separate file; the GitHub token/repo
  (`bpbGithubAuth`) must never leave `storage.local`; drafts and terrain
  caches stay device-local.
- **Manual button + separate opt-in auto toggle, per feature.** Restore is
  always a manual button for both features. Restore semantics: replace
  wholesale after an explicit inline confirmation (favorites already has this
  flow; settings copies it). No merging.
- **Favorites auto trigger: every stored change to `bpbFavoriteClimbers`,
  regardless of surface.** The options page, the climber-page star
  (`src/favorites/climber-favorite.js`), and ascent-filter buddy sync all
  write through `storage.local`, so the worker watches that one key instead
  of tagging user intent across three writers.
- **The worker builds and serializes the favorites payload itself** for both
  manual and automatic backups (the auto path needs it anyway; sharing it
  keeps one serialization and one signature-state record).
- **Neither auto toggle is coupled to `enableGithubBackup`** — that gate
  belongs to ascent backup (favorites manual backup already ignores it; there
  is an existing test pinning that independence). Both new booleans sync
  harmlessly: without a device-local token/repo they are inert.
- **PRIVACY.md is part of this change** — it currently promises the favorites
  file reaches GitHub only on an explicit click.
- **Non-goals:** no auto-restore, no conflict resolution between devices
  (last write wins on the fixed root path), no surfacing of auto-push
  failures in the UI (the manual buttons remain the loud path), no backup of
  the buddy cache (`bpbBuddyCache` is owner-scoped and refreshable).

## Code map — where everything lives today

- `src/settings/settings-schema.js` — `DEFAULTS` + `clean()`.
- `src/settings/settings.js` — `S.get()/S.set()/S.subscribe()`; already
  bundled into the options page and the background worker. `subscribe(cb)`
  fires `cb(cleanedSettings)` on any `bpbSettings` change in `sync`.
- `src/favorites/favorite-climbers.js` — pure favorites logic:
  `SCHEMA_VERSION`, `FAVORITES_KEY = 'bpbFavoriteClimbers'`, `LIMIT`,
  `cleanFavorites()`. No DOM, no extension APIs — keep it that way.
- `src/background/background.js` — one IIFE; `ext = globalThis.browser ||
  globalThis.chrome`; constants at the top (`FAVORITE_CLIMBERS_BACKUP_PATH`
  at line 33, `CLEANUP_ALARM` at 37); `enqueueGithubWrite` at 85;
  `favoritesGithubClient()` at 1642 (auth/repo gate returning
  `{ client }` or `{ error }`); `backupFavorites`/`restoreFavorites` at
  1660–1684; the `onMessage` switch with the `extensionOnly` guard at
  1686–1741; the `ext.alarms` block at 1781–1786. There is **no**
  `ext.storage.onChanged` listener in the worker today.
- `options/options.js` — element refs by `getElementById`, a serialized
  `save(patch)` queue that calls `S.set` and flashes, `populate(settings)`
  that pushes values into controls and calls `favorites.populate(settings)` /
  `githubBackup.populate(settings)`, and `S.subscribe(populate)` at the end.
- `options/favorites.js` — `initFavorites({ extensionApi, flash, save })`;
  element refs at the top with a bail-out guard if any is missing;
  `favoritesSignature()` (line 135) = `JSON.stringify(favorites.entries)`;
  `renderGithub()` (line 330) shows/hides `#favorites-github-actions` and the
  "Favorites backed up ✓" state; `backupFavorites()` (line 606) currently
  serializes the payload page-side; `restoreFavorites()` (line 628) validates
  inline then calls `beginReplacement(...)` (undo window);
  `removeWithBuddyEl` (lines 710–712 + populate line 825) is the exact
  save-a-settings-boolean checkbox pattern to copy.
- `options/github.js` — `initGithubBackup`; `el`/`button` DOM builders; the
  ascent auto-backup checkbox pattern (lines 260–265); `hasGithubPermission`.
- `options/options.html` — favorites GitHub block at `#favorites-github`
  (~line 448); the `#github` "Sync for nerds" section with subsections
  `#github-connection` and `#github-backup` (~lines 478–511).
- `scripts/build-config.mjs` — bundle compositions; `background.js` entry at
  line 41 currently: gpx-metrics, capture-core, provider-url, terrain-tiles,
  terrain-cache, settings-schema, settings, github-errors, github-api,
  github-auth, github-client, peakbagger-*, background.
- Tests: `test/options/options.test.mjs` (jsdom drives the real options
  page; `loadOptions(...)` helper; existing favorites-GitHub tests around
  lines 840–960), `test/github/github-backup-integration.test.mjs` (boots the
  real `dist/background.js` in a `vm` context via `createWorker(...)`;
  `gitDataBackend()` scripted GitHub; favorites tests at lines 391–450),
  `test/favorites/favorite-climbers.test.mjs` (pure),
  `test/project/manifest-capture.test.mjs` (pins the exact background source
  list at line 44).

## Implementation

### Step 1 — pure settings transfer module: `src/settings/settings-transfer.js` (new)

Pure (no DOM / extension APIs), same spirit as `settings-schema.js`. Exact
shape:

```js
import { settingsSchema as Schema } from './settings-schema.js';

const KIND = 'better-peakbagger-settings';
const SCHEMA_VERSION = 1;
const BACKUP_PATH = 'settings.json';

// clean() spreads raw over defaults and KEEPS unknown keys, so the pick to
// known keys must happen here, on both build and parse, to keep junk out of
// exports and out of storage. Insertion order follows Object.keys(DEFAULTS),
// which is deterministic — that is what makes signature() stable.
const pick = settings => {
    const cleaned = Schema.clean(settings);
    const picked = {};
    for (const key of Object.keys(Schema.DEFAULTS)) picked[key] = cleaned[key];
    return picked;
};

const buildPayload = (settings, { extensionVersion = '', exportedAt }) => ({
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    extensionVersion,
    settings: pick(settings),
});

const serialize = payload => `${JSON.stringify(payload, null, 2)}\n`;

const parse = text => {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'not-json' }; }
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== KIND) {
        return { ok: false, reason: 'wrong-kind' };
    }
    // Older versions are accepted (clean() fills gaps); newer are rejected.
    if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion > SCHEMA_VERSION) {
        return { ok: false, reason: 'newer-version' };
    }
    if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) {
        return { ok: false, reason: 'no-settings' };
    }
    return { ok: true, settings: pick(parsed.settings) };
};

// Over the settings only — never exportedAt — so the auto-backup skip check
// is not defeated by the timestamp.
const signature = settings => JSON.stringify(pick(settings));

export const settingsTransfer = { KIND, SCHEMA_VERSION, BACKUP_PATH, buildPayload, serialize, parse, signature };
```

### Step 2 — pure favorites backup helpers in `src/favorites/favorite-climbers.js`

Add four functions next to the existing cleaners and export them from the
`favoriteClimbers` object at the bottom. The payload shape and key order must
match what `options/favorites.js` `backupFavorites()` writes today
(`{ schemaVersion, exportedAt, entries }`), so existing backup files parse
and identical entries produce byte-identical files:

```js
const buildBackupPayload = (favorites, { exportedAt }) => ({
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    entries: cleanFavorites(favorites).entries,
});

const serializeBackup = payload => `${JSON.stringify(payload, null, 2)}\n`;

// The exact checks options/favorites.js restoreFavorites() does inline today
// (lines 639–646), moved here so restore validation cannot drift.
const parseBackup = text => {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false }; }
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries)
        || parsed.entries.length > LIMIT
        || cleanFavorites(parsed).entries.length !== parsed.entries.length) {
        return { ok: false };
    }
    return { ok: true, favorites: cleanFavorites(parsed) };
};

// Stable: cleanEntry() builds each entry with fixed key order
// {cid, name, addedAt, source}. Over entries only — never exportedAt — so a
// restore round-trip yields an equal signature and the auto push skips.
// Matches the page's current favoritesSignature() output exactly.
const backupSignature = favorites => JSON.stringify(cleanFavorites(favorites).entries);
```

### Step 3 — schema: `src/settings/settings-schema.js`

Two edits, nothing else:

1. In `DEFAULTS`, after the `autoGithubBackup: false` line, add:

   ```js
   // Automatic GitHub push of the settings / favorites backup files on
   // change. Deliberately independent of enableGithubBackup (that gate
   // belongs to ascent backup); inert without a device-local token/repo.
   autoSettingsBackup: false,
   autoFavoritesBackup: false,
   ```

2. In `clean()`, add `'autoSettingsBackup', 'autoFavoritesBackup'` to the
   boolean-coercion list (the `for (const key of ['enable3dMap', ...])` array).

Do **not** add them to the `if (!s.enableGithubBackup) s.autoGithubBackup =
false;` coupling line — these two stand alone.

### Step 4 — worker: shared debounced auto-push helper

All worker changes are in `src/background/background.js`.

**4a. Imports and constants.** Add to the import block:

```js
import { favoriteClimbers as Favorites } from '../favorites/favorite-climbers.js';
import { settingsTransfer as Transfer } from '../settings/settings-transfer.js';
```

Add constants next to `FAVORITE_CLIMBERS_BACKUP_PATH` (line 33):

```js
const SETTINGS_BACKUP_ALARM = 'bpb-settings-backup';
const SETTINGS_BACKUP_STATE_KEY = 'bpbSettingsBackupState';
const FAVORITES_BACKUP_ALARM = 'bpb-favorites-backup';
const FAVORITES_BACKUP_STATE_KEY = 'bpbFavoritesBackupState';
const AUTO_BACKUP_DELAY_MINUTES = 1;
const AUTO_BACKUP_RETRY_MINUTES = 10;
const AUTO_BACKUP_MAX_RETRIES = 2;
```

**4b. Rename** `favoritesGithubClient` (line 1642) to `optionsGithubClient`
— it now serves favorites, settings, and both auto paths. Update its two
existing call sites.

**4c. The helper.** Place after `optionsGithubClient`:

```js
// Debounced, signature-gated automatic backup shared by the settings and
// favorites auto paths. schedule() may be called as often as callers like:
// ext.alarms.create with an existing name REPLACES the alarm, giving a
// trailing-edge debounce that survives MV3 worker death (a setTimeout would
// not). fire() re-checks everything, so a stale or spurious alarm is safe.
const createAutoBackup = ({ alarmName, stateKey, path, commitMessage, enabled, build }) => {
    const readState = async () => (await ext.storage.local.get(stateKey))[stateKey] || null;
    const markSynced = signature => ext.storage.local.set({
        [stateKey]: { signature, syncedAt: new Date().toISOString() },
    });

    const schedule = () => {
        if (!ext.alarms) return;
        ext.alarms.create(alarmName, { delayInMinutes: AUTO_BACKUP_DELAY_MINUTES });
        // A fresh change grants a fresh retry budget.
        void readState().then(state => {
            if (state && state.attempts) {
                return ext.storage.local.set({ [stateKey]: { ...state, attempts: 0 } });
            }
        });
    };

    const fire = async () => {
        if (!(await enabled())) return;
        const access = await optionsGithubClient();
        if (access.error) return;
        const { text, signature } = await build();
        const state = await readState();
        if (state && state.signature === signature) return;
        try {
            await enqueueGithubWrite(() => access.client.putRootFile(path, text, commitMessage));
            await markSynced(signature);
        } catch {
            // Silent bounded retry; the manual buttons remain the loud path.
            const attempts = ((state && state.attempts) || 0) + 1;
            await ext.storage.local.set({ [stateKey]: { ...(state || {}), attempts } });
            if (attempts <= AUTO_BACKUP_MAX_RETRIES) {
                ext.alarms.create(alarmName, { delayInMinutes: AUTO_BACKUP_RETRY_MINUTES });
            }
        }
    };

    return { schedule, fire, markSynced };
};
```

**4d. Two instances**, right below the helper:

```js
const settingsAutoBackup = createAutoBackup({
    alarmName: SETTINGS_BACKUP_ALARM,
    stateKey: SETTINGS_BACKUP_STATE_KEY,
    path: Transfer.BACKUP_PATH,
    commitMessage: 'Back up settings',
    enabled: async () => (await Settings.get()).autoSettingsBackup,
    build: async () => {
        const settings = await Settings.get();
        const payload = Transfer.buildPayload(settings, {
            extensionVersion: ext.runtime.getManifest ? ext.runtime.getManifest().version : '',
            exportedAt: new Date().toISOString(),
        });
        return { text: Transfer.serialize(payload), signature: Transfer.signature(settings) };
    },
});

const favoritesAutoBackup = createAutoBackup({
    alarmName: FAVORITES_BACKUP_ALARM,
    stateKey: FAVORITES_BACKUP_STATE_KEY,
    path: FAVORITE_CLIMBERS_BACKUP_PATH,
    commitMessage: 'Back up favorite climbers',
    enabled: async () => (await Settings.get()).autoFavoritesBackup,
    build: async () => {
        const stored = await ext.storage.local.get(Favorites.FAVORITES_KEY);
        const favorites = Favorites.cleanFavorites(stored[Favorites.FAVORITES_KEY]);
        const payload = Favorites.buildBackupPayload(favorites, { exportedAt: new Date().toISOString() });
        return { text: Favorites.serializeBackup(payload), signature: Favorites.backupSignature(favorites) };
    },
});
```

**4e. Triggers** — top-level registrations (invariant 3), next to the
existing `ext.alarms` block at the bottom of the IIFE:

```js
// Favorites change on ANY surface (options page, climber-page star, buddy
// sync) lands in storage.local; storage events wake this worker, so a star
// click backs up even with no extension page open. Only the favorites key is
// watched — the backup-state writes above cannot self-trigger.
ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[Favorites.FAVORITES_KEY]) return;
    void Settings.get().then(settings => {
        if (settings.autoFavoritesBackup) favoritesAutoBackup.schedule();
    });
});

// Any settings change schedules the settings backup when its toggle is on.
// It also nudges the favorites path: that makes flipping autoFavoritesBackup
// ON create the first backup immediately, and lets a previously failed push
// self-heal. Spurious nudges are free — fire() skips on equal signature.
Settings.subscribe(settings => {
    if (settings.autoSettingsBackup) settingsAutoBackup.schedule();
    if (settings.autoFavoritesBackup) favoritesAutoBackup.schedule();
});
```

Extend the existing alarms block (lines 1781–1786) — do not create a second
`onAlarm` listener:

```js
if (ext.alarms) {
    ext.alarms.create(CLEANUP_ALARM, { periodInMinutes: 5 });
    ext.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === CLEANUP_ALARM) void cleanup();
        if (alarm.name === SETTINGS_BACKUP_ALARM) void settingsAutoBackup.fire();
        if (alarm.name === FAVORITES_BACKUP_ALARM) void favoritesAutoBackup.fire();
    });
}
```

### Step 5 — worker: settings endpoints and favorites endpoint refactor

**5a. Settings endpoints.** Add handlers next to `backupFavorites`:

```js
const backupSettings = async () => {
    const access = await optionsGithubClient();
    if (access.error) return { ok: false, error: access.error };
    const { text, signature } = /* same build as settingsAutoBackup.build */;
    try {
        const result = await enqueueGithubWrite(() => access.client.putRootFile(
            Transfer.BACKUP_PATH, text, 'Back up settings'));
        await settingsAutoBackup.markSynced(signature);
        return { ok: true, result };
    } catch (error) {
        return { ok: false, error: GithubErrors.publicError(error, 'The settings backup failed.') };
    }
};

const restoreSettings = async () => {
    const access = await optionsGithubClient();
    if (access.error) return { ok: false, error: access.error };
    try {
        return { ok: true, content: await access.client.readRootFile(Transfer.BACKUP_PATH) };
    } catch (error) {
        return { ok: false, error: GithubErrors.publicError(error, 'The settings backup could not be read.') };
    }
};
```

(Extract the settings build into one shared function used by both the
endpoint and the auto instance rather than duplicating it.)

Wire into the message switch **and** the `extensionOnly` guard:

```js
|| type === 'GITHUB_SETTINGS_BACKUP'
|| type === 'GITHUB_SETTINGS_RESTORE'
...
case 'GITHUB_SETTINGS_BACKUP': return backupSettings();
case 'GITHUB_SETTINGS_RESTORE': return restoreSettings();
```

**5b. Favorites manual endpoint refactor.** Replace `backupFavorites`
(lines 1660–1674) wholesale — it no longer reads `message`:

```js
// The worker owns backup serialization for both the manual button and the
// automatic path (one payload builder, one signature state); the options
// page still owns restore validation and the reversible replace flow.
const backupFavorites = async () => {
    const access = await optionsGithubClient();
    if (access.error) return { ok: false, error: access.error };
    const stored = await ext.storage.local.get(Favorites.FAVORITES_KEY);
    const favorites = Favorites.cleanFavorites(stored[Favorites.FAVORITES_KEY]);
    const payload = Favorites.buildBackupPayload(favorites, { exportedAt: new Date().toISOString() });
    try {
        const result = await enqueueGithubWrite(() => access.client.putRootFile(
            FAVORITE_CLIMBERS_BACKUP_PATH, Favorites.serializeBackup(payload), 'Back up favorite climbers'));
        await favoritesAutoBackup.markSynced(Favorites.backupSignature(favorites));
        return { ok: true, result };
    } catch (error) {
        return { ok: false, error: GithubErrors.publicError(error, 'The favorites backup failed.') };
    }
};
```

Update the switch case to `return backupFavorites();` (drop the `message`
argument). The old `{ code: 'no-data' }` empty-content rejection disappears —
an empty list is a valid backup (`entries: []`), which matches what the page
sends today. Also delete/replace the stale comment above the old handler
("Favorites are intentionally manual-only…"). `restoreFavorites` is
**unchanged**.

**5c. Bundle composition.** In `scripts/build-config.mjs` line 41, insert
`'favorites/favorite-climbers.js'` into the `background.js` sources
immediately after `'settings/settings.js'`. Mirror the exact same insertion
in the pinned array in `test/project/manifest-capture.test.mjs` (line 44).
(`settings/settings-transfer.js` rides in via the ES import chain the same
way; add it beside `settings/settings.js` in both places as well, keeping the
two lists identical.)

### Step 6 — options UI: favorites auto checkbox

**6a. `options/options.html`** — inside
`<div class="favorites-github-actions" id="favorites-github-actions" hidden>`
(~line 453), after the restore button:

```html
<label class="check" for="favorites-auto-backup">
    <input type="checkbox" id="favorites-auto-backup">
    <span>Keep favorites backed up automatically</span>
</label>
```

Also update the add-favorites description two rows up (~line 374): change
"Stored only on this device unless you choose Back up favorites below." to
"Stored only on this device unless you back it up to GitHub below." (the
sentence must stay accurate for both the manual and automatic paths).

**6b. `options/favorites.js`** — copy the `removeWithBuddyEl` pattern
exactly:

- Element ref: `const autoBackupEl = document.getElementById('favorites-auto-backup');`
  and add `|| !autoBackupEl` to the bail-out guard.
- Listener (next to the `removeWithBuddyEl` one):

  ```js
  autoBackupEl.addEventListener('change', () => {
      void save({ autoFavoritesBackup: autoBackupEl.checked });
  });
  ```

- In `populate(settings)`:
  `autoBackupEl.checked = settings?.autoFavoritesBackup === true;`
- `favoritesSignature()` (line 135) — replace the body with
  `F.backupSignature(favorites)` (identical output; one source of truth).
- `backupFavorites()` (line 606) — delete the `exported` object and send the
  bare message: `const response = await send({ type: 'GITHUB_FAVORITES_BACKUP' });`
  Everything else (busy state, flash, `githubBackupResult`, commit link)
  stays.
- `restoreFavorites()` (line 628) — replace the inline `JSON.parse` +
  validation block (lines 638–646) with:

  ```js
  const parsed = F.parseBackup(response.content);
  if (!parsed.ok) {
      flash('This favorites backup is not valid or uses a newer format.');
      return;
  }
  const changed = await beginReplacement(parsed.favorites, 'Favorites restored from GitHub');
  ```

No changes to `renderGithub()` are required — the checkbox lives inside
`githubActionsEl`, which already hides when disconnected. Visually inspect
the rendered row (see UX bar): if the checkbox crowds the two buttons, wrap
it onto its own line within the actions container via `options.css`
(`.favorites-github-actions` layout), not by restructuring the HTML ids.

### Step 7 — options UI: settings backup card

New subsection in `options/options.html` between `#github-connection` and
`#github-backup`:

```html
<div class="subsection" id="github-settings-backup" role="group" aria-labelledby="github-settings-backup-heading">
    <h3 class="subsection-title" id="github-settings-backup-heading">Settings backup</h3>
    <div class="card"> ... </div>
</div>
```

(Also add a matching `nav-subitem` link in the sidebar list beside the
existing "Github connection" / "Ascent backup" entries.)

New `options/settings-backup.js` implementing
`initSettingsBackup({ extensionApi, flash, save })` → `{ populate }`, wired
in `options/options.js` exactly like `initFavorites` (construct once, call
`.populate(settings)` from the page's `populate`). Contents of the card:

- **Export settings** button — always available, no GitHub needed:
  `S.get()` → `Transfer.buildPayload(settings, { extensionVersion:
  extensionApi.runtime.getManifest().version, exportedAt: new
  Date().toISOString() })` → `Transfer.serialize` → Blob download:

  ```js
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), {
      href: url, download: `better-peakbagger-settings-${payload.exportedAt.slice(0, 10)}.json`,
  });
  link.click();
  URL.revokeObjectURL(url);
  ```

- **Import from file…** button + hidden `<input type="file"
  accept=".json,application/json">`. Read via `file.text()`, run
  `Transfer.parse`. On failure flash plain language mapped from `reason`:
  `not-json`/`wrong-kind`/`no-settings` → "That is not a Better Peakbagger
  settings file."; `newer-version` → "This settings file was made by a newer
  version of the extension." On success show an **inline confirmation**
  (file name + "Replaces your current settings." + Confirm/Cancel buttons,
  built with the `el`/`button` helpers from `options/github.js` — no
  `window.confirm`), then `save(parsed.settings)` (the payload covers every
  known key, so this is a full replace through the existing save queue) and
  flash "Settings imported".
- **GitHub row**, rendered from connection status: when connected — "Back up
  settings" → `GITHUB_SETTINGS_BACKUP`; "Restore from GitHub" →
  `GITHUB_SETTINGS_RESTORE` then `Transfer.parse(response.content)` and the
  **same inline confirmation** before `save(...)`; a "Keep settings backed up
  automatically" checkbox bound to `autoSettingsBackup` via `save(...)` and
  populated from `populate(settings)`. When not connected — hint text
  "Connect GitHub above to back up settings." For status, send
  `GITHUB_AUTH_STATUS` itself (do not reach into `github.js` internals) and
  refresh on `window` focus, as `options/favorites.js` does; also handle
  `response.content == null` ("No settings backup found in <repo>.").

`options/settings-backup.js` is pulled into the options bundle by ES import
from `options/options.js` (no `scripts/build-config.mjs` entry — same as
`options/github.js`); confirm `test/project/manifest-capture.test.mjs` stays
green on the options bundle.

### Step 8 — docs and changelog

- **`PRIVACY.md`** — a data-handling contract change. Update every statement
  that promises explicit-click-only favorites transfer; search for these
  fragments and rewrite each to cover "an explicit click, or automatically
  after changes while the user-enabled auto-backup toggle is on":
  - "favorite-climber list reaches GitHub only when the user explicitly backs it up"
  - "An explicit **Back up favorites** action separately sends `favorite-climbers.json`"
  - "Favorite backup and restore occur only when the user clicks"
  - "It receives the custom favorite-climber list only on an explicit **Back up favorites** click"
  Add the settings backup file (`settings.json`, schema values only — never
  the token) to the same GitHub sections, and state that only these fixed
  root files are written.
- **`docs/github-ascent-backup.md`** — add `GITHUB_SETTINGS_BACKUP` /
  `GITHUB_SETTINGS_RESTORE` rows to the message-endpoint table; update the
  `GITHUB_FAVORITES_BACKUP` row (constraints no longer include "nonempty
  serialized content" — the worker builds the file); revise "The custom
  favorite-climber list is a separate, manual root-file operation" and the
  `options/favorites.js` responsibility row ("Validate/serialize explicit
  favorites backup…" → serialization moved to the worker); add a short
  section documenting the shared debounced auto-push: alarm names, state
  keys, 1-minute debounce, signature skip, bounded retry.
- **`CHANGELOG.md`** — Unreleased entries: settings export/import, GitHub
  settings backup with optional auto push, automatic favorites backup.

## Tests

### Harness changes first — `test/github/github-backup-integration.test.mjs`

`createWorker` currently stubs `storage.onChanged` as
`{ addListener: () => {} }` and `alarms` as `{ create: () => {}, onAlarm:
event() }`, which swallow everything. Upgrade the stub (reusing the local
`event()` helper) and return the new handles:

```js
const storageChanged = event();
const alarms = {
    created: [],
    create(name, info) { this.created.push({ name, info: info || null }); },
    onAlarm: event(),
};
// browser.storage.onChanged = storageChanged; browser.alarms = alarms;
...
return {
    send, session, local, sync, alarms,
    fireStorageChange: (changes, area) => storageChanged.listeners.forEach(l => l(changes, area)),
    fireAlarm: name => alarms.onAlarm.listeners.forEach(l => l({ name })),
};
```

Notes for the implementer: the `area(...)` storage stub does **not** fire
`onChanged` on `set` — tests fire `fireStorageChange` explicitly.
`Settings.subscribe` inside the bundle registers on this same
`storage.onChanged` with area `'sync'`. Scheduling goes through async
`Settings.get()`, so after `fireStorageChange` poll for the expected
`alarms.created` entry (small `waitFor`-style loop) instead of asserting
synchronously. Worker boot itself records the `bpb-capture-cleanup` alarm —
filter `alarms.created` by name in assertions.

### `test/github/github-backup-integration.test.mjs` — new/updated cases

- **Update** "favorites backup and restore stay extension-only…" (line 391):
  seed `local` with a favorites value, send bare
  `{ type: 'GITHUB_FAVORITES_BACKUP' }`, assert the committed
  `favorite-climbers.json` content equals the worker-built serialization of
  the seeded entries, and that `local.bpbFavoritesBackupState.signature ===
  JSON.stringify(entries)`. Extension-only and token-never-leaves assertions
  stay as they are.
- **Favorites change schedules the debounce alarm**: worker with
  `settings = { autoFavoritesBackup: true }` + connected auth;
  `fireStorageChange({ [favoriteKey]: { newValue } }, 'local')`; poll until
  `alarms.created` contains `{ name: 'bpb-favorites-backup', info: {
  delayInMinutes: 1 } }`.
- **Alarm commits once, then skips**: after the above, `fireAlarm(
  'bpb-favorites-backup')` and await the commit (backend records it); parse
  the committed JSON — `schemaVersion`, `entries` match the store; state key
  written. Fire the alarm again with nothing changed: commit count must not
  grow (signature skip).
- **Restore round-trip produces no push**: take the committed content, write
  its parsed cleaned value back into `local` (what the options page does on
  restore), `fireStorageChange`, `fireAlarm` — no new commit.
- **Manual backup marks synced**: bare manual backup, then `fireAlarm` — no
  second commit.
- **Toggle off means no alarm**: `autoFavoritesBackup: false`,
  `fireStorageChange` — poll briefly, assert no `bpb-favorites-backup` in
  `alarms.created`.
- **Failure retries bounded**: backend scripted to fail the commit; fire the
  alarm — assert state `attempts: 1` and a re-created
  `bpb-favorites-backup` alarm with `delayInMinutes: 10`; fire twice more —
  after attempts exceeds 2, no further alarm is created.
- **Settings mirror set**: a `bpbSettings` change (via
  `fireStorageChange({ bpbSettings: { newValue } }, 'sync')`) with
  `autoSettingsBackup: true` schedules `bpb-settings-backup`; the alarm
  commits `settings.json` whose `settings` are picked+cleaned; equal
  signature skips; `GITHUB_SETTINGS_BACKUP`/`RESTORE` work from an extension
  sender, are forbidden for a content-script sender, and ignore
  `enableGithubBackup`; not-connected/no-repo return the typed errors.

### `test/options/options.test.mjs`

- **Update** the existing manual-backup test (~line 873): the sent
  `GITHUB_FAVORITES_BACKUP` message must have **no** `content` property.
- Auto checkbox: `loadOptions({})` → `#favorites-auto-backup` unchecked;
  click it → stored `bpbSettings.autoFavoritesBackup === true`;
  `loadOptions({ autoFavoritesBackup: true })` → checked. (Copy the
  `favorites-remove-with-buddy` test shape.)
- Settings card: export produces a parseable payload (kind, picked keys);
  import applies only after the inline confirmation and replaces values; an
  invalid file flashes the error and changes nothing; a newer-version file
  flashes the newer-version message; GitHub buttons send
  `GITHUB_SETTINGS_BACKUP`/`GITHUB_SETTINGS_RESTORE`; the settings auto
  checkbox saves `autoSettingsBackup`; restore confirmation precedes apply.

### Pure tests

- **`test/settings/settings-transfer.test.mjs`** (new): round-trip
  build→serialize→parse; unknown keys stripped in both directions;
  out-of-range values clamped via `clean()`; rejects newer `schemaVersion`,
  wrong `kind`, garbage text; `signature` identical across different
  `exportedAt` and raw key orders.
- **`test/favorites/favorite-climbers.test.mjs`** (extend): payload
  round-trip; `parseBackup` rejects wrong `schemaVersion`, over-`LIMIT`
  arrays, and entry lists that do not survive `cleanFavorites` unchanged —
  and accepts the exact file `serializeBackup` produces; `backupSignature`
  identical across `exportedAt` values and after a
  serialize→parse round-trip; differs when an entry is added, removed, or
  renamed.
- The schema additions are covered by the existing `settings-schema` guard
  test automatically — which is also why no `src/` file other than the
  schema may mention the defaults.

## Verification

1. `npm test` — full suite (builds `dist/`, runs the jsdom suites).
2. `npm run verify:extension` — **required**: the worker, its bundle
   composition, and the options bundle change.
3. Manual, per the real-browser rules (hidden Chrome for Testing profile,
   `npm run start:chromium`):
   - Settings: export a file; flip several settings; import the file —
     confirm the inline confirmation appears and values revert. Connect
     GitHub; "Back up settings" → `settings.json` lands in the repository;
     enable settings auto; change a setting → exactly one debounced commit.
   - Favorites: enable the auto checkbox → first backup commit appears
     within ~1 minute; add a favorite → exactly one further debounced
     commit; "Restore from backup" → no follow-up commit; with **no
     extension page open**, star a climber on a fixture page (masked
     fixtures per the fixtures workflow — never drive the live
     Cloudflare-protected site for repeatable checks) → the star alone
     produces a commit.
   - Visually inspect the favorites GitHub row and the new settings card at
     normal and narrow options-page widths, light and dark.
4. End-goal check in a fresh profile: new browser profile → load `dist/` →
   import the exported settings file with no GitHub setup → settings match.
   Separately connect GitHub → "Restore from GitHub" (settings) and "Restore
   from backup" (favorites) → both match the first profile.

## Commit sequence (straight to `main`, one unit each)

Each commit: implementation + its tests together; `npm test` green before
committing; `npm run verify:extension` before the worker-touching commits
(3 and 5). Conventional, lowercase, explanatory bodies per `AGENTS.md`.

1. `feat: pure settings transfer payload` — Step 1 + its pure test.
2. `feat: settings file export and import in sync for nerds` — Step 7's
   export/import half (no GitHub row yet) + options tests.
3. `feat: back up settings to the connected github repo` —
   `autoSettingsBackup` schema key, Steps 4 (helper + settings instance +
   triggers + alarm wiring) and 5a, Step 7's GitHub row, harness upgrade +
   settings integration tests.
4. `feat: pure favorites backup payload and signature` — Step 2, plus
   `options/favorites.js` switched onto `backupSignature`/`parseBackup`
   (page still sends `content` at this point), pure + options tests.
5. `feat: auto back up favorite climbers on change` — `autoFavoritesBackup`
   schema key, Steps 4d/4e favorites instance + watcher, 5b endpoint
   refactor, 5c bundle pin, Step 6 UI, favorites integration + options
   tests.
6. `docs: record backup endpoints, privacy contract, and changelog` — Step 8.

Commits 4–5 depend on the helper from commit 3 but not on commits 1–2; if
favorites must ship first, land the helper and harness upgrade inside commit
5 instead and have commit 3 reuse them.
