# GitHub ascent backup: design and execution plan

Status: in progress. See the execution checklist at the end for what has
landed; steps are marked **Done** as each focused commit lands.

When the user saves an ascent on Peakbagger, Better Peakbagger can back that
ascent up into a GitHub repository the user has explicitly granted access to.
Each ascent becomes one folder containing the trip report as real Markdown,
every structured field the user entered as JSON, and the GPX track Peakbagger
stores for the ascent. The backup is an explicit, opt-in feature; an automatic
after-save mode is a later, separately opted-in refinement.

## Why this is cheap in this codebase

Three existing mechanisms carry most of the weight:

1. **The GPX is already reachable.** The saved ascent page carries a
   "Download this GPS track" link, and `src/gpx-analyzer.js` already locates
   and fetches it same-origin. The backup exports *Peakbagger's stored copy*
   of the track — the reduced, user-approved serialization the user already
   published — so the capture privacy invariant ("raw provider GPX never
   leaves the activity page") is untouched.
2. **The trip report has a Markdown representation.** The trip-report editor
   (see `docs/trip-report-editor.md`) keeps an exact Markdown-source sidecar
   when the user writes Markdown, and `src/report-markup.js` can convert
   bracket markup to Markdown when they don't. The repo therefore holds a
   `report.md` that renders natively on GitHub, not Peakbagger's
   `[b]bold[/b]` dialect.
3. **There is already a pre-Save flush hook.** The editor flushes its active
   view synchronously before Save, Preview, ASP.NET postbacks, and page exit.
   The same hook can snapshot the full ascent form, so the backup records
   exactly what the user submitted rather than a scrape of the rendered page.

## User experience

**Setup (once).** In the extension options, the user enables "GitHub backup",
which requests the optional GitHub host permissions, then clicks **Connect
GitHub**. The extension shows an eight-character code; the user enters it at
`github.com/login/device` and approves. The extension then opens the app's
installation page, where GitHub's own UI asks which repositories to grant —
the user picks **Only select repositories** and chooses their one backup
repo. Back in options, the extension discovers the granted repository through
the API and shows it as connected. No tokens are typed or copied anywhere.
If more than one repository was granted, the options page asks which one to
use; if none, it links back to the install page.

**Per save.** After the user saves an ascent and lands on the saved ascent
page, a small dismissible affordance appears: **Back up to GitHub**. Clicking
it pushes one commit and replaces the affordance with a success state linking
to the commit. Failures show an actionable message and a retry control.
Backup never blocks or alters the Peakbagger save itself, and no extension
path clicks either Peakbagger Save control.

**Automatic mode (later).** A separate opt-in setting, "Back up automatically
after save", performs the same push without the click, with the same visible
success/failure state. It ships only after the manual path is verified.

## Repository layout

```
ascents/
  2026-07-12-mount-rainier-a1234567/
    report.md     # trip report as Markdown
    ascent.json   # all structured fields + peak metadata + provenance
    track.gpx     # Peakbagger's stored track (omitted when none exists)
```

- The folder slug is `YYYY-MM-DD-<peak-slug>-a<ascentId>`. Date first for
  human sorting; the `a<ascentId>` suffix is the stable identity. Partial
  Peakbagger dates degrade gracefully (`2026-07-00…` → `2026-07`, undated →
  `undated`).
- **Idempotency and renames:** re-saving an ascent re-syncs the same folder.
  Before writing, the sync lists the `ascents/` tree and looks for an
  existing folder ending in `-a<ascentId>`; if the slug changed (date or
  peak edited), the old folder is removed and the new one written in the
  same commit, so history stays clean and no stale duplicate survives.
- One ascent = one atomic commit: `Add ascent: Mount Rainier, 2026-07-12`
  (or `Update ascent: …` on re-sync).

### `ascent.json` schema (v1)

Once users accumulate folders this is a public-ish contract, so it is
versioned from the start:

```jsonc
{
  "schemaVersion": 1,
  "ascent": {
    "id": 1234567,
    "url": "https://peakbagger.com/climber/ascent.aspx?aid=1234567",
    "date": "2026-07-12",
    "suffix": "",             // Peakbagger's same-day alphabetical suffix
    "type": "successful-summit",
    "route": "Disappointment Cleaver",
    "gainFt": 9000, "lossFt": 9000,
    "distanceUpMi": 8.0, "distanceDnMi": 8.0,
    "extraGainFt": 300, "extraLossFt": 300,
    "timeUp": "7:30", "timeDn": "4:15", "nightsOut": 1,
    "startFt": 5400, "endFt": 5400, "pointFt": 14411,
    "gear": ["Ice Axe", "Crampons"],
    "companions": { "registered": [], "others": "" },
    "quality": 9,
    "weather": { "precip": "None", "temperature": null }
  },
  "peak": {
    "id": 2296,
    "url": "https://peakbagger.com/peak.aspx?pid=2296",
    "name": "Mount Rainier",
    "elevationFt": 14411,
    "location": "Washington, USA"
  },
  "backup": {
    "syncedAt": "2026-07-12T21:04:05Z",
    "extensionVersion": "2.2.0"
  }
}
```

Field values come from the save-time form snapshot (names as in the
`ascentedit.aspx` form: `DateText`, `GainFt`, `UpMi`/`DnMi`, `GearCheckBoxList`,
`BuddyList`, `OthersText`, `AscentQuality`, `PrecipDD`, …), normalized into the
units-explicit keys above. Fields left blank are omitted or `null`, never
invented.

### `report.md`

- If the user authored in Markdown mode, the exact Markdown-source sidecar is
  written verbatim — their spelling, not a round-trip.
- Otherwise the submitted `JournalText` bracket markup is converted through
  the existing allowlisted report AST to Markdown.
- A short YAML frontmatter block (peak, date, Peakbagger URL) makes the file
  self-describing outside the folder context.

## Trigger and data flow

```
ascentedit.aspx (isolated world, existing editor content script)
  Save clicked → existing flush hook fires
  → serialize Form1 fields + Markdown sidecar
  → PENDING_BACKUP snapshot into storage.session
     keyed by climber + peak + date, 30-minute expiry (reuse draft TTL rules)

ascent.aspx (isolated world)
  → verify the logged-in climber owns this ascent (fail closed)
  → match a PENDING_BACKUP snapshot; freshness heuristics: referrer from
    ascentedit + matching identity
  → locate the "Download this GPS track" link; fetch same-origin if present
  → show the Back up to GitHub affordance
  → on click: send GITHUB_BACKUP_ASCENT {snapshot key, page fields, gpx text}
    to the background worker

background worker
  → re-validate sender tab + snapshot identity (same discipline as drafts)
  → build folder payload via pure src/github-backup.js
  → push one commit via the GitHub client; return commit URL or typed error
```

Notes:

- The saved-page fields cross-check the snapshot; where they disagree (the
  user edited between snapshot and save in another tab), the saved page wins
  and the mismatch is logged to the affordance, not silently merged.
- If no snapshot matches (user edited an old ascent without the extension's
  flush path, or the snapshot expired), the ascent-page surface can still
  offer a backup built from the saved page alone; `report.md` then comes from
  the bracket-markup conversion.
- The GPX fetch happens in the page's session context where the analyzer
  already fetches it; the background worker never fetches from Peakbagger
  for this feature.

## GitHub integration

**Auth — GitHub App device flow (the shipped path).** A registered GitHub
App (device flow enabled, no webhook, repository permission *Contents: read
and write*, installable on any account, opted out of user-token expiration)
is the mechanism behind "OAuth to one repo". Only the app's public
`client_id` ships in the extension. Both device-flow endpoints take only the
`client_id` — unlike the web application flow, whose token exchange requires
a client secret — so no secret is ever generated for the app and none exists
to leak. The flow:

1. `POST https://github.com/login/device/code` with the `client_id`; show
   the returned `user_code` and point the user at `github.com/login/device`.
2. Poll `POST https://github.com/login/oauth/access_token` with the
   `device_code` grant, honoring the returned `interval` and any
   `slow_down`/`authorization_pending` responses, until the user access
   token arrives.
3. Send the user to `github.com/apps/<slug>/installations/new`, where they
   grant **Only select repositories** → their backup repo. Repo scoping
   happens here, at installation: the token can reach only the intersection
   of the app's permissions and the installed repositories.
4. Discover the granted repository with `GET /user/installations` and
   `GET /user/installations/{id}/repositories`, and store the choice.
   Exactly one granted repo means zero-typing setup.

Because the app opts out of user-token expiration, the token is long-lived
and no refresh-token machinery (which would require a client secret) is
needed. The token lives in `chrome.storage.local`, *never* `storage.sync`:
secrets must not ride browser-account sync, and this also keeps them outside
`src/settings.js`'s sync-schema ownership. A dedicated accessor
(`src/github-auth.js`) owns that storage; the feature's on/off gate is an
ordinary boolean in the settings schema like other feature gates. The token
is held only by the background worker; content scripts never receive it.
Plaintext `storage.local` is the honest ceiling for an extension without a
native helper — the mitigation is the token's blast radius: one repo,
Contents only, revocable by uninstalling the app on GitHub.

**Auth — fine-grained PAT (documented alternative, not scheduled).** A
fine-grained personal access token scoped to one repository with *Contents:
read and write* reaches the same API with the same blast radius. It needs no
registered app, so it suits forks of the extension that lack the app's
`client_id`; the cost is a manual chore (mint the token in GitHub's
developer settings, paste it plus `owner/repo` into options) and a mandatory
expiry the user must renew. The storage and background-only handling rules
above apply unchanged. The execution plan below implements only the
device-flow path; a PAT fallback field could be added later without
structural change.

A classic OAuth app via `launchWebAuthFlow` remains ruled out: it needs an
embedded client secret and its `repo` scope grants every repo.

**Commit strategy — Git Data API, one atomic commit.** `GET` the branch ref →
`POST` blobs (report.md, ascent.json, track.gpx as base64) → `POST` a tree
based on the latest commit (including any old-slug folder removal) → `POST`
the commit → `PATCH` the ref. On a non-fast-forward race, re-read the ref and
retry once. The Contents API alternative (one `PUT` per file) is simpler but
produces three commits per ascent and cannot move a renamed folder
atomically.

**Error taxonomy.** Authorization revoked or token invalid, app uninstalled
or repository access withdrawn, repo archived, branch protection rejection,
rate limit, network. Each maps to one actionable sentence in the affordance;
auth problems also flag the options page.

## Manifest and privacy changes

- `optional_host_permissions`: `https://api.github.com/*` plus
  `https://github.com/*` — the device-flow endpoints live on `github.com`
  and do not reliably send CORS headers, so the background worker needs the
  host grant. Both are requested only when the user enables the feature
  (Firefox MV3 already treats host permissions as optional; verify the
  request flow on both browsers).
- **PRIVACY.md** gains a "GitHub backup (optional)" section: what leaves the
  browser (ascent fields, trip report, Peakbagger's stored GPX), that it goes
  only to the user-chosen repository over the GitHub API, only on explicit
  action or explicit auto-backup opt-in, and that the token stays in local
  extension storage. GitHub joins the third-party services list.
- Review the Firefox `data_collection_permissions` declaration; the README
  gains a short feature section.

## Boundaries this must preserve

- Raw provider GPX still never leaves the activity page; the backup uses only
  Peakbagger's stored track fetched on the ascent page.
- No extension path clicks either Peakbagger Save control; backup is strictly
  read-only toward Peakbagger and runs after the user's own save.
- Ownership and identity gates fail closed: no affordance, and no push, when
  the logged-in climber does not own the ascent or the snapshot identity
  does not verify.
- Pure logic (payload building, slugging, JSON/Markdown serialization, tree
  construction) stays in browser-API-free modules; the background worker owns
  tokens, messaging validation, and network.
- The settings-schema single-source rule: the feature gate joins
  `src/settings-schema.js`; token and repo name are deliberately *not*
  settings-schema values because they must not sync.

## Execution steps

Each step is one focused commit (or a small series), tested before the next
begins, per the repository commit discipline.

1. **Design doc** — this file. **Done.**
2. **Pure payload module + tests.** **Done.** `src/github-backup.js`: folder
   slug rules (dates, partial dates, peak-name slugging, `a<aid>` suffix),
   `ascent.json` v1 serialization from a form-snapshot object, `report.md`
   assembly (sidecar-verbatim vs bracket→Markdown via `src/report-markup.js`),
   commit-message text. `test/github-backup.test.mjs` covers slug edge cases,
   unit normalization, blank-field omission, and Markdown selection. The
   snapshot contract this module consumes is documented in its header; the
   content script and background worker own the Peakbagger-DOM field mapping
   that produces it.
3. **Pure GitHub client + tests.** **Done.** `src/github-client.js`: Git Data
   commit builder with an injected `fetch` and token — repo/branch pre-flight
   (archived and no-push fail closed), ref read, blob/tree/commit creation,
   rename-move *and* stale-file removal in one tree, single non-fast-forward
   retry, and a `GithubBackupError` typed by `ERROR_CODES`. Existing folders
   are listed one directory level at a time so a large archive never trips the
   recursive-tree truncation limit. Tests run against a scripted fetch stub; no
   network.
4. **App registration + device-flow client.** **Done.** The GitHub App is
   registered (device flow on, no webhook, *Contents: read and write*,
   installable on any account, user-token expiration opted out, no client
   secret generated); its public `client_id` (`Iv23liZpTdD1iZfT3eL1`) is in
   `src/github-auth.js`. That module holds the device-flow client with an
   injected `fetch` and clock (code request, polling with `interval`/`slow_down`
   handling, abortable, `GithubAuthError`-typed) plus the `storage.local`-only
   token/repo accessor (`authStore`), tested against a scripted fetch stub and a
   fake storage area. *The app's public slug is still needed for the step-5
   install handoff URL (`github.com/apps/<slug>/installations/new`).*
5. **Setup UI.** Options-page section: enable toggle (requests both optional
   host permissions), **Connect GitHub** with user-code display,
   install-page handoff, granted-repo discovery via `GET /user/installations`
   (a picker when several repos are granted, an install link when none), a
   clear connected state, and **Disconnect** (drops the local token; full
   revocation is uninstalling the app on GitHub). Feature gate added to
   `settings-schema.js`.
6. **Save-time snapshot.** Extend the editor's existing pre-Save flush in the
   ascent-editor content script to serialize the form + Markdown sidecar into
   a `storage.session` snapshot with the drafts' identity binding and
   30-minute expiry; background cleanup alarm covers it.
7. **Ascent-page surface.** Content-script piece on `ascent.aspx` (isolated
   world): ownership check, snapshot match, GPX link fetch, the Back up
   affordance with success/error/retry states, message to background. New
   `GITHUB_BACKUP_ASCENT` handler in `src/background.js` with sender/identity
   validation mirroring the draft handlers.
8. **Fixture + integration tests.** Capture a PII-masked saved-ascent
   (`ascent.aspx`) fixture (none exists yet; follow the fixtures workflow),
   then test the end-to-end path in jsdom with stubbed GitHub fetch:
   snapshot → surface → background → commit payload.
9. **Manifest + docs.** Both `optional_host_permissions`, PRIVACY.md section,
   README feature blurb, Firefox data-collection review. Run
   `npm run verify:extension` (manifest changed).
10. **Auto-backup toggle.** Separate opt-in setting performing the same push
    after save-detection, same visible result states.
11. **Release verification.** `npm test`, `npm run verify:extension`, one
    real device-flow authorization + installation against the registered
    app, and a minimal, rate-limited live check on real Peakbagger in both
    browsers: save one test ascent, confirm redirect behavior, GPX-link
    timing, and a real commit landing in a scratch repo.

## Open questions (resolve during steps 6–8)

- Exact post-save behavior on live Peakbagger: redirect target, referrer
  value, and whether `aid` is always present on arrival — the fixtures only
  cover the edit page today.
- Whether the stored-GPX link is present immediately after a save that used
  GPS Preview, or appears only after a server-side delay.
- Whether deleted Peakbagger ascents should ever be reflected (current
  answer: out of scope; the repo is an archive, not a mirror).
