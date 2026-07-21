# GitHub ascent backup

This is the maintained design for the shipped per-save and full-profile backup
features. The completed implementation checklist is archived in
[archive/github-ascent-backup-plan.md](archive/github-ascent-backup-plan.md).
Real device-flow authorization, a rate-limited live Peakbagger save, stored-GPX
timing, and a scratch-repository commit remain manual pre-release checks because
they require the user's signed-in GitHub and Peakbagger sessions.

When the user saves an ascent on Peakbagger, Better Peakbagger can back that
ascent up into a GitHub repository the user has explicitly granted access to.
Each ascent becomes one folder containing the trip report as real Markdown,
every structured field the user entered as JSON, and the GPX track Peakbagger
stores for the ascent. The backup is an explicit, opt-in feature; automatic
after-save backup is a second, separately disabled-by-default choice.

## Why this is cheap in this codebase

Three existing mechanisms carry most of the weight:

1. **The GPX is already reachable.** The saved ascent page carries a
   "Download this GPS track" link, and `src/gpx-analyzer.js` already locates
   and fetches it same-origin. The backup exports *Peakbagger's stored copy*
   of the track — the reduced, user-approved serialization the user already
   published — so the capture privacy invariant ("raw provider GPX never
   leaves the activity page") is untouched.
2. **The trip report has a Markdown representation.** The trip-report editor
   (see [trip-report-editor.md](trip-report-editor.md)) keeps an exact
   Markdown-source sidecar
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
`github.com/login/device` and approves. The options page then offers a
**Create repository on GitHub** button whose GitHub-owned form is prefilled
with a private `better-peakbagger-backup` repository, or the user can grant the
app access to an existing repository through GitHub's installation page. Back
in options, the extension discovers every granted repository and asks the user
to choose one explicitly. Empty and recognized backup repositories connect
immediately; a populated repository is inspected and requires confirmation.
Ambiguous root backup paths, archived repositories, and repositories without
write access fail closed. No tokens are typed or copied anywhere.
Once connected, Settings offers **Open My Ascents** for older entries. The
worker resolves the signed-in climber from Peakbagger's own account controls
and opens that climber's all-years list; it does not guess or persist a climber
id. A signed-out state names the problem and links directly to Peakbagger's
sign-in page.

**Per save.** Peakbagger leaves both Add and Edit saves on an
`ascentedit.aspx` success view. Better Peakbagger adds **View the Saved Ascent**
there, resolving an edit from its URL `aid` and a new ascent from Peakbagger's
photo link. The saved ascent page places a compact **Back up to GitHub** button
beside Peakbagger's owner actions. Clicking it pushes one commit and replaces
the control with a success state linking to the commit. Failures show an
actionable message and a retry control. Backup never blocks or alters the
Peakbagger save itself, and no extension path clicks either Peakbagger Save
control.

**Automatic mode.** A separate opt-in setting, "Back up automatically
after save", follows the saved-ascent route from a confirmed Add or Edit
success and performs the same push without another click, with the same visible
success/failure state. It requires a fresh, precise save-time snapshot; merely
revisiting an old ascent falls back to the manual button without pushing.

**Full profile.** On the signed-in climber's own **My Ascents** page, **Back
up all ascents** reads the complete all-years index, skips ascent ids already
represented by a root-level `*-a<aid>` backup folder, and commits missing
ascents in atomic groups of up to ten. A paced Peakbagger producer reads ahead
while a single GitHub consumer writes; the in-tab buffer applies backpressure
at 30 ascents or 32 MiB instead of growing without limit. The page tab must
remain open, and a later run resumes from the repository diff without local
checkpoint state. A Peakbagger challenge pauses on the interrupted ascent. A
GitHub error retains the rejected batch so Resume retries it without refetching
those ascents. **Refresh all** has an explicit confirmation and re-syncs every
ascent through the same Update path. See
[profile-backup-pipeline.md](profile-backup-pipeline.md) for the batching,
backpressure, conflict, and lifecycle rationale.

## Repository layout

```
.better-peakbagger.json                  # repository ownership/layout marker
2026-07-12-mount-rainier-a1234567/
  report.md                              # trip report as Markdown
  ascent.json                            # fields + peak metadata + provenance
  track.gpx                              # stored track; omitted when none exists
```

- The folder slug is `YYYY-MM-DD-<peak-slug>-a<ascentId>`. Date first for
  human sorting; the `a<ascentId>` suffix is the stable identity. Partial
  Peakbagger dates degrade gracefully (`2026-07-00…` → `2026-07`, undated →
  `undated`).
- **Repository ownership:** a populated repository gets the marker in the same
  atomic commit as its first mountain folder. An empty repository first gets a
  marker-only initialization commit because GitHub does not allow the Git
  References API to create its initial branch. Before selection and every
  write, an unmarked repository with ambiguous root backup folders fails
  closed. Other populated repositories require explicit confirmation; their
  existing paths remain part of the base Git tree and are not modified.
- **Idempotency and renames:** re-saving an ascent re-syncs the folder ending in
  the same `-a<ascentId>`. If the slug changed, the extension writes the new
  root folder and removes only its own `report.md`, `ascent.json`, and
  `track.gpx` paths from the old folder in the same commit. User-added files are
  preserved.
- **Empty repositories:** the first backup initializes the marker and default
  branch through GitHub's Contents API; users do not need to initialize a
  README. The ascent itself still lands as one atomic Git Data commit.
- A manual or automatic save is one atomic commit: `Add ascent: Mount Rainier,
  2026-07-12` (or `Update ascent: …` on re-sync). Full-profile backup combines
  up to ten ascent folders into one atomic `Back up 10 ascents` / `Refresh 10
  ascents` commit.

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
    "routeDown": "Emmons Glacier",
    "externalUrl": "https://example.com/trip-report",
    "gainFt": 9000, "lossFt": 9000,
    "distanceUpMi": 8.0, "distanceDnMi": 8.0,
    "extraGainFt": 300, "extraLossFt": 300,
    "timeUp": "7:30", "timeDn": "4:15", "nightsOut": 1,
    "startFt": 5400, "endFt": 5400, "pointFt": 14411,
    "gear": ["Ice Axe", "Crampons"],
    "companions": {
      "registered": [{ "id": 42, "name": "Ada" }],
      "others": "Sample Hiking Club"
    },
    "quality": 9,
    "weather": {
      "precip": "No Precipitation",
      "temperature": "Cold",
      "wind": "Breezy",
      "visibility": "Clear",
      "description": "Clouds lifted at noon"
    }
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
`OthersTable`, `AscentQuality`, `PrecipDD`, …), normalized into the
units-explicit keys above. `OthersText` is deliberately ignored because it is
only the companion autocomplete input; committed companions come from
`OthersTable`. Fields left blank and zero-valued dropdown placeholders are
omitted, never invented.

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
  → fetch and validate the owner-only ascentedit form; serialize its complete
    persisted fields so an expired/missing snapshot never produces a sparse update
  → locate the "Download this GPS track" link; fetch same-origin if present
  → show the Back up to GitHub affordance
  → on click: send GITHUB_BACKUP_ASCENT {complete form snapshot, gpx text}
    to the background worker

background worker
  → re-validate sender tab + snapshot identity (same discipline as drafts)
  → build folder payload via pure src/github-backup.js
  → push one commit via the GitHub client; return commit URL or typed error

ClimbListC.aspx (isolated world, owner only)
  → parse or fetch the complete all-years ascent index
  → worker lists root backup folder leaves (token never leaves worker)
  → paced producer fetches each AscentEdit.aspx form and stored GPX sequentially
  → verified list metadata supplies the peak name and any omitted full date
  → bounded in-tab buffer groups at most 10 ascents / 4 MiB per commit
  → worker receives GITHUB_BACKUP_PROFILE_BATCH and serializes all repo writers
  → one tree + one commit + one non-forced ref update makes the batch visible
```

Notes:

- The persisted edit-form fields cross-check the pending snapshot; where they
  disagree, the saved form wins. The pending snapshot still supplies the exact
  Markdown sidecar captured during Save when one exists.
- If no pending snapshot matches (user edited an old ascent without the
  extension's flush path, or the snapshot expired), the ascent-page surface
  builds a complete replacement from the persisted edit form. An incomplete
  form response fails without changing GitHub. If a displayed GPX link cannot
  be read and validated, backup likewise fails rather than deleting a previously
  stored `track.gpx`.
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
   `GET /user/installations/{id}/repositories`. The user explicitly selects a
   repository; the worker inspects it before storing the choice. Populated
   non-backup repositories require a second confirmation.

The background worker persists the pending device code, expiry, interval, and
next-poll time in `storage.session`. The options page advances one poll attempt
per status tick; the worker skips network access before `nextPollAt`, honors
`slow_down`, and clears the pending record on success, denial, expiry, or
disconnect. A service-worker restart therefore cannot silently lose a code the
user is entering. Installation and repository discovery follow GitHub's
validated pagination links rather than assuming the first page is complete.

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

**Auth — fine-grained PAT (documented alternative, not shipped).** A
fine-grained personal access token scoped to one repository with *Contents:
read and write* reaches the same API with the same blast radius. It needs no
registered app, so it suits forks of the extension that lack the app's
`client_id`; the cost is a manual chore (mint the token in GitHub's
developer settings, paste it plus `owner/repo` into options) and a mandatory
expiry the user must renew. The storage and background-only handling rules
above apply unchanged. The shipped extension implements only the device-flow
path; a PAT fallback would be a separate product and security decision.

A classic OAuth app via `launchWebAuthFlow` remains ruled out: it needs an
embedded client secret and its `repo` scope grants every repo.

**Commit strategy — Git Data API, one atomic commit.** `GET` the branch ref →
`POST` one tree based on the latest commit, with ordinary file contents inline
and any owned old-slug removals included → `POST` the commit → `PATCH` the ref.
An unusually large individual file uses the blob endpoint before tree creation.
An empty repository is first initialized with the marker through the Contents
API because GitHub refuses to create the first ref in an empty repository. On a
retryable 409/non-fast-forward race, the client waits, rereads the ref, rebuilds
the whole commit, and retries on the 0.5/2/5-second bounded schedule. The
Contents API alternative for ascent files would produce multiple commits and
cannot move renamed folders or whole batches atomically.

**Error taxonomy.** Authorization revoked or token invalid, app uninstalled or
repository access withdrawn, repo archived, ambiguous repository paths, missing
non-empty branch, branch protection rejection, rate limit, network. Each maps
to one actionable sentence in the affordance; auth and selection problems also
flag the options page.

## Manifest and privacy boundary

- `optional_host_permissions`: `https://api.github.com/*` plus
  `https://github.com/*` — the device-flow endpoints live on `github.com`
  and do not reliably send CORS headers, so the background worker needs the
  host grant. Both are requested only when the user enables the feature.
- [PRIVACY.md](../PRIVACY.md) is canonical for what leaves the browser: ascent
  fields, trip report, and Peakbagger's stored GPX go only to the selected
  repository over the GitHub API, on explicit action or the separate automatic
  opt-in. The token stays in local extension storage.
- Firefox's `locationInfo` declaration covers the stored GPS track. The
  remaining payload is user-authored ascent data sent to the user's own
  repository, so the manifest declares no broader data category.

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
