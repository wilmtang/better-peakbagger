# GitHub ascent backup: design and execution plan

Status: implemented, including full-profile backfill. Steps 1–10 have landed,
and the automated release checks
(`npm test`, `npm run lint:js`, `npm run verify:browsers`, `web-ext lint`)
pass. Step 11's live
verification — a real device-flow authorization and installation against the
registered app, and one rate-limited save on real Peakbagger landing a commit in
a scratch repo, in both browsers — remains a manual pre-release step, because it
needs the user's GitHub and Peakbagger sessions. The execution checklist at the
end records each step; the ascent.aspx selectors in `src/ascent-page.js` are the
main thing that live verification confirms.

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

**Per save.** After the user saves an ascent and lands on the saved ascent
page, a small dismissible affordance appears: **Back up to GitHub**. Clicking
it pushes one commit and replaces the affordance with a success state linking
to the commit. Failures show an actionable message and a retry control.
Backup never blocks or alters the Peakbagger save itself, and no extension
path clicks either Peakbagger Save control.

**Automatic mode.** A separate opt-in setting, "Back up automatically
after save", performs the same push without the click, with the same visible
success/failure state. It requires a fresh, precise save-time snapshot; merely
revisiting an old ascent falls back to the manual button without pushing.

**Full profile.** On the signed-in climber's own **My Ascents** page, **Back
up all ascents** reads the complete all-years index, skips ascent ids already
represented by a root-level `*-a<aid>` backup folder, and commits each missing
ascent.
The page tab owns the paced queue and must remain open; it can be paused or
cancelled, and a later run resumes from the repository diff without local
checkpoint state. A Peakbagger challenge pauses before the next request and
hands the human check to a normal tab. A GitHub write error pauses on the
current ascent before any later ascent is fetched; resuming retries that same
ascent instead of silently accumulating repository-wide failures. **Refresh
all** has an explicit confirmation and re-syncs every ascent through the same
Update path.

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
  → locate the "Download this GPS track" link; fetch same-origin if present
  → show the Back up to GitHub affordance
  → on click: send GITHUB_BACKUP_ASCENT {snapshot key, page fields, gpx text}
    to the background worker

background worker
  → re-validate sender tab + snapshot identity (same discipline as drafts)
  → build folder payload via pure src/github-backup.js
  → push one commit via the GitHub client; return commit URL or typed error

ClimbListC.aspx (isolated world, owner only)
  → parse or fetch the complete all-years ascent index
  → worker lists root backup folder leaves (token never leaves worker)
  → tab fetches each owned AscentEdit.aspx form and stored GPX, sequentially
  → worker receives one GITHUB_BACKUP_PROFILE_ASCENT snapshot at a time
  → same payload builder and atomic Git Data commit path as per-save backup
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
`POST` blobs (`report.md`, `ascent.json`, optional `track.gpx`, and the marker
when first adopting the repository) → `POST` a tree based on the latest commit
(including any owned old-slug paths) → `POST` the commit → `PATCH` the ref. An
empty repository instead creates a parentless commit and `POST`s its first ref.
On a non-fast-forward race, re-read the ref and retry once. The Contents API
alternative (one `PUT` per file) is simpler but produces multiple commits per
ascent and cannot move a renamed folder atomically.

**Error taxonomy.** Authorization revoked or token invalid, app uninstalled or
repository access withdrawn, repo archived, ambiguous repository paths, missing
non-empty branch, branch protection rejection, rate limit, network. Each maps
to one actionable sentence in the affordance; auth and selection problems also
flag the options page.

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
   (archived, no-push, and ambiguous paths fail closed), empty-repository
   initialization, root-layout marker and folder discovery, and owned-file-only
   rename handling in one tree, plus a single non-fast-forward
   retry and `GithubBackupError` taxonomy. Tests run against a scripted fetch
   stub; no network.
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
5. **Setup UI.** **Done.** Options-page "GitHub backup" section
   (`options/github.js`, styled in `options.css`): the enable toggle requests
   both optional host permissions (added to `manifest.json`), **Connect
   GitHub** shows the user code and hands off to `github.com/login/device`,
   offers a prefilled GitHub repository-creation form or GitHub's installation
   access picker, then lists even a sole granted repository for explicit,
   worker-inspected selection. Existing content requires confirmation. A clear
   connected state names the account and repo, and **Disconnect** drops the
   local token (full revocation is uninstalling the app on GitHub). The options
   page never sees the token: it drives the background worker over
   `GITHUB_AUTH_*` messages, gated to extension-page senders;
   `github-auth.js` joins the background bundle. The `enableGithubBackup` gate
   is in `settings-schema.js`.
6. **Save-time snapshot.** **Done.** `src/ascent-snapshot.js` owns the
   ascentedit.aspx field-name mapping and turns the live Form1 fields plus the
   editor's report (mode, submitted bracket, exact Markdown sidecar) into the
   github-backup snapshot, with a `climber|peak|date` match key and normalized
   date. The report editor's Save or implicit-submit flush
   (`src/report-editor.js`) builds it — Preview and other named submitters do
   not — gated on `enableGithubBackup`, best-effort, never blocking the save —
   and sends `GITHUB_BACKUP_SNAPSHOT` to the worker, which stores it in
   storage.session (Peakbagger-sender + feature gated, identity-keyed, bounded,
   30-minute expiry via the existing cleanup alarm).
   `test/ascent-snapshot.test.mjs` pins the mapping against the masked fixture.
7. **Ascent-page surface.** **Done.** `src/ascent-page.js` reads the saved
   ascent (aid, ownership via the edit link — fail closed, peak, GPX link, and a
   DOM→Markdown report fallback); `src/ascent-backup.js` (isolated world on
   ascent.aspx, styled in `src/ascent-backup.css`) shows the dismissible **Back
   up to GitHub** affordance only for the owner when enabled and connected,
   fetches Peakbagger's stored track in the page session, and messages the
   worker with success/error/retry states. The `GITHUB_BACKUP_ASCENT` handler
   in `src/background.js` (Peakbagger-sender gated) matches the pending snapshot,
   merges the saved-page fields over it (page wins on identity and peak
   metadata; the snapshot supplies the entered fields and the report), stamps
   provenance, pushes through `github-client`, drops the used snapshot, and
   returns the commit URL or a typed error. `GITHUB_BACKUP_STATUS` gives the
   surface a token-free enabled/connected check. *Refinement discovered here:
   the bracket→Markdown conversion needs a DOM, which the service worker lacks,
   so it runs in the content script and `github-backup.js` now consumes a
   resolved `report.markdown` — keeping the pure module DOM-free.*
8. **Fixture + integration tests.** **Done.** A masked, representative
   `ascent.aspx` fixture (`test/fixtures/pages/climber-ascent.html`, fake ids)
   drives `test/ascent-page.test.mjs` (parser + ownership) and
   `test/ascent-backup.test.mjs` (the built surface: gates, GPX fetch, message
   shape, success/error). `test/github-backup-integration.test.mjs` runs the
   real built worker end-to-end — snapshot → status → merge → scripted GitHub
   push → commit payload — and pins the fail-closed gates and snapshot
   consumption. The fixture selectors are confirmed on live Peakbagger at
   step 11.
9. **Manifest + docs.** **Done.** `optional_host_permissions` for `github.com`
   and `api.github.com` are in `manifest.json` (added with the setup UI).
   PRIVACY.md gains a "GitHub backup (optional)" section, the third-party list
   gains GitHub, the permissions list gains the optional GitHub host access and
   the local-only token note, and the `locationInfo` disclosure now covers the
   stored track written to the user's repo. README gains a feature section and
   a privacy line. Firefox data-collection review: `locationInfo` already
   declares the only sensitive category the backup transmits (the stored GPS
   track); the remaining payload is the user's own ascent fields and trip
   report sent to the user's own repository on an explicit action, so no
   additional `data_collection_permissions` category is added.
10. **Auto-backup toggle.** **Done.** The `autoGithubBackup` setting (a
    separate opt-in shown in the connected state of the options panel)
    performs the same push automatically on the saved ascent page, with the
    same working/success/error states. It fires only when a matching pending
    snapshot exists (a fresh save), so revisiting an old ascent declines
    quietly (`no-fresh-save`) and falls back to the manual button rather than
    re-pushing. `GITHUB_BACKUP_STATUS` now reports the `auto` preference to the
    surface. Covered by the integration, surface, and options suites.
11. **Release verification.** Automated checks **Done**: `npm test` (full
    suite green, including the backup unit, surface, and built-worker
    integration suites), `npm run verify:browsers` (the worker boots with the
    backup/auth handlers and every content script loads), and `web-ext lint`
    (0 errors). **Pending manual pre-release** (needs the user's sessions): one
    real device-flow authorization + installation against the registered app,
    and a minimal, rate-limited live check on real Peakbagger in both browsers —
    save one test ascent, confirm the redirect/`aid` and GPX-link timing that
    `src/ascent-page.js` assumes, and a real commit landing in a scratch repo.

## Open questions (mostly resolved; confirm the live-behavior ones at step 11)

- Exact post-save behavior on live Peakbagger: redirect target, referrer
  value, and whether `aid` is always present on arrival. Handled defensively —
  `src/ascent-page.js` takes `aid` from the URL and fails closed without it, and
  manual snapshot matching falls back from `aid` to peak+date to
  most-recent-for-peak, so a new ascent (whose snapshot had no `aid`) still
  matches. Automatic mode permits only `aid` or peak+date and therefore cannot
  push a merely similar stale snapshot. Confirm the live redirect on Peakbagger.
- Whether the stored-GPX link is present immediately after a save that used
  GPS Preview, or appears only after a server-side delay. The surface treats the
  track as optional (omits `track.gpx` when the link is absent), so a delayed
  link degrades to a report+JSON backup rather than failing; confirm the timing.
- Whether deleted Peakbagger ascents should ever be reflected (answer: out of
  scope; the repo is an archive, not a mirror).
