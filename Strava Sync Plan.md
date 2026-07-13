# Better Peakbagger: Strava Sync and Automatic Ascent Logging Plan

## 1. Objective

Extend `wilmtang/better-peakbagger` with:

* Manual **Sync from Strava**
* Bring-your-own-Strava-app operation: every user supplies credentials for a separate Strava application they own
* Optional self-hosted backend operation
* Shared summit detection for Strava activities and local GPX files
* Peakbagger ascent drafts by default
* Optional fully automatic Peakbagger submission when a compatible backend is configured
* Chrome and Firefox Manifest V3 support
* No default hosted backend

The extension publisher never supplies a shared Strava client ID, receives user tokens, or proxies standalone requests. Strava integration is conditional on M0 confirming that this per-user application model, summit analysis, Peakbagger transfer, and the proposed retention model comply with Strava's current API Agreement and Policy.

The existing GPX Analyzer and Ascent Beta Filter must continue working unchanged from the user’s perspective.

## 2. Current-state assessment

`better-peakbagger` is a Manifest V3 extension with page content scripts, an options page, and `storage`-backed settings. It has no toolbar popup, background process, Strava credential import, activity database, or extension-level synchronization state.

The existing GPX Analyzer contains useful reusable logic for:

* GPS jump filtering
* Movement confirmation
* Elevation smoothing
* Hysteresis-based elevation gain
* Grade calculation
* Time and distance metrics

That logic is currently embedded inside a page-specific immediately invoked function and should be extracted into testable shared modules rather than rewritten.

The repository currently uses `web-ext` for packaging and linting and Node's built-in test runner with `jsdom`. It has no JavaScript bundling or TypeScript compilation.

## 3. Milestone delivery plan

Each milestone is releasable on its own. Do not start a later milestone until the exit criteria for the current one are met; this keeps the existing GPX Analyzer and Ascent Beta Filter shippable throughout.

| Milestone | Outcome | Exit criteria | Explicitly deferred |
| --- | --- | --- | --- |
| M0 — Scope, terms, and safety decisions | Lock the product boundaries and compatibility baseline. | Current extension tests and `web-ext lint` pass; manual GPX Analyzer and Ascent Beta Filter smoke checks are recorded; per-user, activity-scoped token import works in packaged Chrome and Firefox without sending credentials off-device; Strava confirms the intended application, analysis, transfer, and retention model is permitted; the standalone-secret warning and automatic-submission hard gates are approved. | All production Strava integration, new architecture, in-extension OAuth, backend code. |
| M1 — Extension and track core | Add the smallest extension foundation needed for sync and extract the pure GPX calculations without changing the existing UI. | Chrome and Firefox builds load; extracted calculations have regression tests against representative GPX fixtures; existing analyzer behavior is unchanged. | Strava requests, peak discovery, database, backend. |
| M2 — Local summit drafts | Prove shared summit detection and Peakbagger draft creation using a local GPX file. | A fixture GPX finds, scores, and displays candidates; a selected candidate opens a prefilled ascent draft, uploads reduced GPX, and stops at Preview; no final submission is possible. | Strava credential import and sync scheduling. |
| M3 — Standalone Strava sync | Let a user paste their own Strava credentials and manually sync activities into the local review flow. | An imported access token is validated for activity access; expired/invalid tokens fail clearly; optional refresh credentials rotate correctly; a manual sync is resumable and idempotent; streams reach the same M2 review and draft flow. | In-extension OAuth, hosted service, stored Peakbagger credentials, automatic submission. |
| M4 — Review, history, and retention | Make local results understandable and safely repeatable. | Activity list, candidate evidence, selection, skip/reanalyze, and retention deletion work in IndexedDB; reanalysis never changes an existing ascent. | Backend. |
| M5 — Optional self-hosted backend | Add a secure backend only for users who opt in. | Docker deployment works; encrypted credentials, authenticated health/capabilities checks, deletion endpoints, and idempotency records are verified; standalone mode remains fully usable without it. | Automatic submission. |
| M6 — Guarded automatic submission | Enable server-side submission only when every safety gate passes. | A high-confidence fixture with altitude data submits once with an idempotency key; medium/low candidates stay in review; failed submission is recoverable without duplicates. | Webhooks, background sync, bulk automation. |
| M7 — Release readiness | Publish supported Chrome and Firefox packages and operating documentation. | Browser-specific manifests are linted and package-tested; setup, self-hosting, privacy, recovery, and troubleshooting docs are complete. | A default hosted backend. |

### Milestone rules

* Keep the current single-extension layout through M1. Introduce a workspace, TypeScript, or a backend only in the milestone that demonstrably needs it; do not create empty packages up front.
* M0 is a hard go/no-go gate. Technical success does not override Strava's API Agreement or Policy.
* M2 is the functional proof point. If local GPX candidate detection and safe draft creation are not useful, stop before Strava and backend work.
* Start M3 with access-token import. Do not add an in-extension OAuth callback flow unless token import proves too burdensome for real users.
* Treat every imported access token, refresh token, and client secret as a user-owned secret, never sync it, and never claim extension storage is a secure credential vault.
* Automatic submission is backend-only and requires all existing hard gates: explicit opt-in, altitude data, high confidence, valid encryption, configured credentials, and a healthy Peakbagger adapter.

## 4. Product behavior

### Standalone mode (conditional on M0 approval)

Every user is the developer and operator of their own registered Strava application. They supply that application's credentials to their local extension installation. Better Peakbagger does not ship a shared client ID or client secret, and the publisher has no access to the credentials or API responses.

The user configures:

* Strava access token with `activity:read` or `activity:read_all`
* Optional access-token expiration
* Optional client ID, client secret, and refresh token for automatic refresh
* Optional private-activity access when the token has `activity:read_all`
* Initial synchronization date
* Enabled activity types
* Summit-detection preferences

The extension:

1. Validates the imported token against Strava before saving it.
2. Stores the user’s credentials only in extension-local storage.
3. Refreshes the access token only when the user supplied the matching client ID, client secret, and refresh token.
4. Fetches activities and detailed streams directly from Strava.
5. Performs all track analysis locally.
6. Detects candidate summits.
7. Creates Peakbagger drafts using the user’s existing browser login.

An access token by itself expires after approximately six hours and must then be replaced manually. Automatic final Peakbagger submission is unavailable in standalone mode.

### Backend mode

The user configures:

* Self-hosted server URL
* Server API key

The backend stores:

* Strava OAuth tokens
* Encrypted Peakbagger email and password
* Submission idempotency records

The extension still performs track analysis and summit detection locally.

Backend mode enables:

* Draft creation
* Fully automatic submission for high-confidence summits
* Server-side duplicate protection
* Secure token refresh without exposing Strava refresh tokens to extension storage

There is no default server URL and no first-party hosted service.

## 5. Possible repository structure after M1

Do not convert the repository before M1 proves a shared track core is needed. If M5 adds a backend, this is the target structure:

```text
better-peakbagger/
├── extension/
│   ├── manifest.base.json
│   ├── manifest.chrome.json
│   ├── manifest.firefox.json
│   ├── src/
│   │   ├── background/
│   │   │   ├── index.ts
│   │   │   ├── sync-controller.ts
│   │   │   └── message-router.ts
│   │   ├── content/
│   │   │   ├── gpx-analyzer-main.ts
│   │   │   ├── ascent-filter.ts
│   │   │   └── ascent-editor.ts
│   │   ├── pages/
│   │   │   ├── popup/
│   │   │   ├── options/
│   │   │   └── review/
│   │   ├── providers/
│   │   │   ├── strava-standalone.ts
│   │   │   ├── strava-backend.ts
│   │   │   ├── backend-client.ts
│   │   │   └── peakbagger-browser.ts
│   │   ├── storage/
│   │   │   ├── settings.ts
│   │   │   ├── database.ts
│   │   │   └── migrations.ts
│   │   └── browser-api.ts
│   └── tests/
├── packages/
│   ├── track-core/
│   │   ├── src/
│   │   │   ├── track-model.ts
│   │   │   ├── gpx-parser.ts
│   │   │   ├── strava-converter.ts
│   │   │   ├── metrics.ts
│   │   │   ├── summit-detection.ts
│   │   │   ├── gpx-simplifier.ts
│   │   │   └── gpx-serializer.ts
│   │   └── tests/
│   └── api-contract/
│       └── src/
├── server/
│   ├── src/
│   │   ├── app.ts
│   │   ├── config.ts
│   │   ├── database/
│   │   ├── crypto/
│   │   ├── middleware/
│   │   ├── routes/
│   │   ├── strava/
│   │   └── peakbagger/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── tests/
├── docs/
│   ├── standalone-strava-setup.md
│   ├── self-hosting.md
│   ├── backend-api.md
│   ├── privacy.md
│   └── troubleshooting.md
├── package.json
└── tsconfig.json
```

If this structure is adopted, use:

* TypeScript
* npm workspaces only once the backend is added
* esbuild for extension bundles
* the existing Node test runner for JavaScript tests; add Vitest only if the TypeScript toolchain needs it
* Fastify for the backend
* SQLite for backend persistence
* IndexedDB for extension activity history and review data

The two existing scripts should be migrated incrementally. Do not rewrite both before adding functionality.

## 6. Browser-extension foundation (M1)

### Manifest changes

Add:

```json
{
  "permissions": [
    "storage"
  ],
  "host_permissions": [
    "https://www.strava.com/*",
    "https://peakbagger.com/*",
    "https://www.peakbagger.com/*"
  ],
  "optional_host_permissions": [
    "https://*/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ],
  "action": {
    "default_popup": "pages/popup/index.html"
  },
  "options_ui": {
    "page": "pages/options/index.html",
    "open_in_tab": true
  }
}
```

Token import does not require the `identity` permission or a browser OAuth callback. Add `identity` only if a later milestone introduces in-extension OAuth.

The extension must request permission only for the exact custom backend origin supplied by the user, rather than permanently requesting access to all HTTPS sites.

Chrome and Firefox require different background declarations. Generate browser-specific manifests from one source:

```json
// Chrome
"background": {
  "service_worker": "background.js"
}

// Firefox
"background": {
  "scripts": ["background.js"]
}
```

Firefox does not currently support `background.service_worker`; official Mozilla guidance recommends generating or supplying the appropriate background configuration for each browser.

### Browser API compatibility

Create a small compatibility wrapper instead of scattering `chrome` and `browser` checks:

```ts
export const browserApi =
    globalThis.browser ?? globalThis.chrome;
```

Wrap callback-versus-Promise differences where necessary.

## 7. Shared track-processing core (M1)

Define one normalized representation:

```ts
interface TrackPoint {
    lat: number;
    lon: number;
    elevationM: number | null;
    timeMs: number | null;
    moving: boolean | null;
}

interface NormalizedTrack {
    source: "gpx" | "strava";
    sourceId: string;
    name: string;
    startTimeMs: number | null;
    activityType: string | null;
    points: TrackPoint[];
}
```

Both inputs feed the same pipeline:

```text
Local GPX ────────┐
                  ├─→ NormalizedTrack
Strava streams ───┘
                         ↓
                 metrics and smoothing
                         ↓
                  summit detection
                         ↓
                review or submission
```

### Extract existing calculations

Move the pure portions of `gpx-analyzer.js` into `packages/track-core`:

* `calcDistanceMeters`
* elevation median smoothing
* confirmed movement distance
* confirmed elevation gain
* grade calculation
* cumulative distance calculation
* summit-time calculation

Keep the existing page UI in `gpx-analyzer-main.ts`, calling the extracted functions.

### GPX support

Port and adapt the useful portions of `peakbagger_gpx_ascent_logger`:

* GPX parsing
* closest-point-to-peak calculation
* ascent/descent splitting
* Ramer–Douglas–Peucker simplification
* 3,000-point Peakbagger limit handling
* GPX serialization

That extension currently processes GPX files locally, finds peaks within 500 feet of the route, and opens prefilled Peakbagger ascent pages.

Preserve its MIT attribution in files containing derived code.

## 8. Summit-detection design (M2)

Do not use only a fixed horizontal-distance threshold.

### Candidate discovery

1. Divide the track into overlapping route sections.
2. Build padded bounding boxes around those sections.
3. Query Peakbagger’s bounding-box endpoint.
4. Merge and deduplicate peaks by Peakbagger peak ID.
5. Calculate the actual closest route segment to each summit.

Use one bounding box for ordinary short activities. Split long or geographically broad activities so a large rectangular box does not retrieve many unrelated peaks.

### Evidence calculated for every peak

For each candidate:

* Minimum horizontal distance from route
* Track elevation at closest approach
* Difference from Peakbagger summit elevation
* Whether closest approach is near a local elevation maximum
* Observed climb before the summit
* Observed descent after the summit
* Whether the activity starts or ends at the summit
* Whether altitude and timestamps are available
* Whether the route passes below or around the summit
* Whether the peak has already been processed or logged
* Whether multiple route passes represent repeated visits

### Confidence model

Initial weighting:

```text
Horizontal proximity            45%
Vertical agreement              25%
Local-high-point evidence       20%
Approach/departure evidence     10%
```

Suggested defaults:

| Evidence                     | High confidence | Medium confidence |              Reject or low |
| ---------------------------- | --------------: | ----------------: | -------------------------: |
| Horizontal distance          |          ≤100 m |         100–200 m |                     >250 m |
| Vertical difference          |           ≤50 m |          50–100 m |                     >150 m |
| Near local elevation maximum |     within 20 m |       within 50 m |              clearly below |
| Track altitude present       |        required |          optional | missing reduces confidence |

These values should be constants with advanced overrides, not prominent settings presented to ordinary users.

### Classification

* **High confidence:** score at least 0.85 and all hard gates pass
* **Medium confidence:** score from 0.60 to 0.85, or important data is missing
* **Low confidence:** nearby but insufficient summit evidence
* **Rejected:** contradictory elevation or excessive distance

Automatic mode behavior:

* High confidence: submit automatically
* Medium confidence: create selected drafts for review
* Low confidence: show as unselected suggestions
* Rejected: omit from normal results, but retain in diagnostics

Automatic submission must require altitude data. Horizontal proximity alone must never trigger automatic submission.

## 9. Strava standalone mode (M3)

This is a per-installation bring-your-own-app mode. Each user registers a separate Strava application for their own use and imports only that application's credentials. Standalone requests go directly from the user's browser to Strava; no credential or Strava response passes through infrastructure operated by the Better Peakbagger publisher.

### Configuration

Options page fields:

* Access token
* Optional expiration timestamp
* Optional granted-scope string copied from the OAuth response
* **Test token** button
* Optional **Enable automatic refresh** section containing client ID, client secret, and refresh token
* Connection status: valid, expired, invalid, or insufficient activity scope
* Activity access: standard, private, or unknown
* Replace token button
* Disconnect button

An access token is enough to call Strava directly with an `Authorization: Bearer` header, but Strava access tokens expire after approximately six hours. The token must have `activity:read`; private activities require `activity:read_all`. Do not assume the starter token shown on Strava's API settings page has activity scope—verify it with an activity-list request before saving it.

### Token import flow

1. The user obtains an activity-scoped token for their own registered Strava application and pastes it into the options page.
2. Keep the token only in memory until validation succeeds.
3. Call the authenticated-athlete endpoint to reject invalid or expired tokens.
4. Call the activity-list endpoint to verify `activity:read` access; explain that missing private activities require `activity:read_all`.
5. Store locally:

   * access token
   * athlete ID
   * optional expiration
   * optional granted scopes
6. On `401 Unauthorized`, mark the connection expired and prompt the user to replace the token. Do not loop retries.

This is the minimum standalone implementation. It avoids an OAuth callback flow, but the user may need to replace the access token every six hours.

A bearer token does not expose its scopes. A successful activity-list request proves ordinary activity access, but it does not prove `activity:read_all`. Treat private-activity access as unknown unless the imported OAuth result includes that scope or the extension successfully reads a known “Only You” activity.

### Optional automatic refresh

For a durable standalone connection, the user may additionally provide the client ID, client secret, and current refresh token for the same user-owned Strava application.

Before each Strava request:

1. Use the current access token while it has more than one hour remaining.
2. Otherwise call Strava's token endpoint with the client ID, client secret, and current refresh token.
3. Atomically store the returned access token, expiration, and newest refresh token before continuing.
4. If refresh fails, preserve the old credentials for diagnosis, stop the sync, and require user action.

In-extension OAuth is not part of M3. Add it later only if manually obtaining an activity-scoped token is a demonstrated adoption problem.

### Strava constraints

The implementation and setup guide must reflect these current Strava requirements:

* [Access tokens expire after six hours](https://developers.strava.com/docs/authentication/); an access token alone is therefore a temporary connection.
* Refreshing requires the matching client ID, client secret, and refresh token, and the newest returned refresh token must replace the previous one.
* [Listing activities and fetching activity streams require `activity:read`](https://developers.strava.com/docs/reference/); `activity:read_all` is required for activities visible only to the athlete.
* [The API settings page provides user-owned application credentials and tokens](https://developers.strava.com/docs/getting-started/), but every imported token must still be tested for the required activity access.
* [Strava's API Agreement](https://www.strava.com/legal/api) says API tokens are confidential, cannot be shared with another developer or third party, and cannot be used for more than one application or service. The proposed design keeps each token inside the local installation operated by its owner and never reuses it for another user or service, but M0 must still confirm Strava accepts this interpretation before public release.
* [Strava's API Policy](https://www.strava.com/legal/api_policy) requires express user authorization and consent, limits caching to seven days, and restricts credential reuse and third-party interfaces. M0 must obtain a clear answer on whether summit analysis and transfer to Peakbagger fit the registered application's permitted purpose.

### Local secret warning

Clearly explain that:

* This mode is intended for users operating their own Strava application.
* Access tokens, refresh tokens, and client secrets are confidential; users must never paste credentials belonging to somebody else's Strava application.
* Any supplied client secret and refresh token are stored in extension-local storage.
* No credential, API response, or derived track data is sent to the extension publisher or telemetry service.
* Browser extension storage is not equivalent to an operating-system password manager.
* Secrets must never use synchronized browser storage.
* Disconnect deletes all locally stored Strava credentials. Revocation at Strava remains the authoritative way to invalidate them.

### Strava provider interface

Both standalone and backend providers implement:

```ts
interface StravaProvider {
    getConnectionStatus(): Promise<ConnectionStatus>;
    connect(options: ConnectOptions): Promise<void>;
    disconnect(): Promise<void>;

    listActivities(query: ActivityQuery): Promise<ActivitySummary[]>;
    getActivityStreams(activityId: number): Promise<ActivityStreams>;
}
```

Request these streams:

* `latlng`
* `altitude`
* `time`
* `distance`
* `moving`

Strava exposes activity lists with `before`, `after`, page, and page-size filters, and detailed activity streams require `activity:read`; activities set to “Only You” require `activity:read_all`.

## 10. Manual synchronization flow (M3)

The popup contains:

* Strava connection state
* Current operation mode
* Last successful sync
* **Sync new activities**
* **Choose activities**
* Pending review count
* Last sync summary

### Sync algorithm

1. Acquire a local synchronization lock.
2. Determine the activity date range:

   * First sync defaults to the previous 30 days.
   * Later syncs use the last successful cursor with a small overlap.
3. Page through Strava activities.
4. Filter by enabled activity type.
5. Skip activities already marked complete.
6. Download streams for remaining activities.
7. Convert each activity into `NormalizedTrack`.
8. Run metric calculation.
9. Discover Peakbagger candidate peaks.
10. Score candidates.
11. Save results to the review database.
12. Depending on mode:

    * Draft mode: wait for review.
    * Automatic mode: submit high-confidence results and retain the rest for review.
13. Advance the sync cursor only after the complete batch has been safely recorded.
14. Release the lock.

Use bounded concurrency, such as two stream requests at a time, and respect Strava rate-limit headers. Default Strava applications have separate 15-minute and daily limits, including a default non-upload allowance of 100 requests per 15 minutes and 1,000 per day.

## 11. Review and history interface (M4)

Create a full extension page with:

### Activity list

Each activity shows:

* Name
* Date
* Activity type
* Distance and gain
* Processing state
* Number of detected peaks
* Drafted or submitted count
* Error indicator

### Activity detail

Each candidate peak shows:

* Peak name and elevation
* Horizontal route distance
* Vertical difference
* Confidence score and classification
* Evidence breakdown
* Summit timestamp
* Ascent/descent metrics
* Checkbox for draft creation
* Manual add/remove controls

### History states

```text
discovered
analyzed
needs_review
draft_created
submitted
skipped
failed
```

A user may reanalyze an activity manually. Reanalysis must never automatically edit or delete an existing Peakbagger ascent.

Use IndexedDB only for temporary review data. Delete track points and all Strava-derived activity and candidate data no later than seven days after retrieval unless Strava gives written approval for a different retention model. Keep a Peakbagger ascent reference only if M0 confirms it is not prohibited Strava-derived data; otherwise rely on Peakbagger's own peak/date duplicate check.

## 12. Peakbagger draft creation (M2)

Add a content script for:

```text
https://peakbagger.com/climber/ascentedit.aspx*
https://www.peakbagger.com/climber/ascentedit.aspx*
```

The background process:

1. Determines the logged-in Peakbagger climber ID.
2. Opens one ascent-edit tab per selected peak.
3. Waits for the content script to initialize.
4. Sends the calculated ascent payload and generated GPX.
5. Limits concurrent tab creation to avoid opening a large number at once.

The content script:

* Fills date and summit time
* Fills starting and ending elevations
* Fills route distance up and down
* Fills duration up and down
* Fills extra gain fields
* Attaches the reduced GPX file
* Clicks Preview
* Stops before final submission
* Shows a visible “Review and submit” notice

This retains the safer behavior of the existing GPX ascent logger, which currently fills fields, uploads the GPX, and triggers Preview without clicking the final submit control.

## 13. Self-hosted backend (M5)

### Technology

Use:

* Node.js
* TypeScript
* Fastify
* SQLite
* AES-256-GCM envelope encryption
* Docker
* Docker Compose

### Required environment variables

```env
PUBLIC_BASE_URL=https://peakbagger-sync.example.com
API_KEY=<long-random-value>
ENCRYPTION_KEY=<base64-encoded-32-byte-key>

STRAVA_CLIENT_ID=<id>
STRAVA_CLIENT_SECRET=<secret>

DATABASE_PATH=/data/better-peakbagger.sqlite
PORT=8080
LOG_LEVEL=info
```

Optional:

```env
ALLOW_AUTOMATIC_SUBMISSION=true
ALLOWED_EXTENSION_ORIGINS=
```

Automatic submission remains unavailable unless:

* `ALLOW_AUTOMATIC_SUBMISSION=true`
* The encryption key is valid
* Peakbagger credentials are configured
* The Peakbagger adapter health check passes

### Security rules

* Refuse non-HTTPS remote requests; allow plain HTTP only for localhost.
* Accept the API key through `Authorization: Bearer`, never a query string.
* Compare API keys in constant time.
* Encrypt all Strava tokens and Peakbagger credentials with a fresh random nonce.
* Never derive encryption keys from user IDs.
* Never log OAuth codes, access tokens, refresh tokens, API keys, or Peakbagger passwords.
* Run the container as a non-root user.
* Persist only `/data`.
* Include a credential-deletion endpoint.
* Validate request sizes, including generated GPX uploads.
* Apply request-rate limits even though the deployment is single-user.

## 14. Backend API contract (M5–M6)

All protected requests use:

```http
Authorization: Bearer <configured-api-key>
```

### Health and capabilities

```http
GET /v1/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "apiVersion": "1"
}
```

```http
GET /v1/capabilities
```

```json
{
  "stravaOAuth": true,
  "automaticSubmission": true,
  "gpxUpload": true,
  "peakbaggerCredentialsConfigured": false
}
```

The extension’s **Test connection** button must call both endpoints and display:

* Reachability
* Authentication success
* API compatibility
* Server version
* Available capabilities

### Strava OAuth

```http
POST /v1/strava/oauth/start
```

Response:

```json
{
  "authorizationUrl": "https://www.strava.com/oauth/authorize?...",
  "expiresAt": "2026-07-10T03:00:00Z"
}
```

The extension opens the returned URL. Strava redirects to:

```http
GET /v1/strava/oauth/callback
```

The backend validates state, exchanges the code, stores encrypted tokens, and renders a simple success page.

```http
GET /v1/strava/status
DELETE /v1/strava/connection
```

### Strava data

```http
GET /v1/strava/activities?after=<epoch>&before=<epoch>&page=1&perPage=50
GET /v1/strava/activities/{activityId}/streams
```

The backend should expose normalized Strava responses rather than leaking stored tokens to the extension.

### Peakbagger credentials

```http
PUT /v1/peakbagger/credentials
```

```json
{
  "email": "user@example.com",
  "password": "..."
}
```

```http
POST /v1/peakbagger/test
GET /v1/peakbagger/status
DELETE /v1/peakbagger/credentials
```

The password must never be returned after storage.

### Automatic ascent submission

```http
POST /v1/peakbagger/ascents
Idempotency-Key: strava:<activity-id>:peak:<peak-id>
```

Request:

```json
{
  "source": {
    "type": "strava",
    "activityId": 123456789
  },
  "peak": {
    "id": 9876,
    "name": "Example Peak"
  },
  "confidence": {
    "score": 0.94,
    "classification": "high",
    "algorithmVersion": "1"
  },
  "ascent": {
    "date": "2026-07-08",
    "summitTime": "14:35",
    "startElevationFt": 1200,
    "endElevationFt": 1200,
    "distanceUpMiles": 4.2,
    "distanceDownMiles": 4.1,
    "extraGainUpFt": 350,
    "extraGainDownFt": 190,
    "durationUpMinutes": 210,
    "durationDownMinutes": 160,
    "visibility": "private"
  },
  "gpx": {
    "filename": "strava-123456789.gpx",
    "contentBase64": "..."
  }
}
```

Response:

```json
{
  "status": "submitted",
  "peakbaggerAscentId": 123456,
  "duplicate": false
}
```

Repeated requests with the same idempotency key return the original result without creating another ascent.

## 15. Peakbagger automatic-submission adapter (M5–M6)

This is the highest-risk area and begins with a dedicated feasibility spike.

### Preferred implementation

Use a direct HTTP client with:

* Cookie jar
* Peakbagger login flow
* Ascent-edit form fetch
* Hidden ASP.NET field parsing
* Multipart GPX upload
* Preview submission
* Final form submission
* Returned ascent-ID extraction

Do not initially use PeakLogger’s minimal mobile submission endpoint because it does not preserve the detailed ascent fields and GPX workflow required here.

### Adapter interface

```ts
interface PeakbaggerSubmissionAdapter {
    testCredentials(): Promise<PeakbaggerAccount>;
    findDuplicate(peakId: number, date: string): Promise<ExistingAscent | null>;
    submitAscent(request: SubmitAscentRequest): Promise<SubmissionResult>;
}
```

### Fallback

If direct HTTP form submission proves too fragile, implement the same interface using Playwright and headless Chromium inside the Docker image.

The rest of the backend must not depend on which adapter is selected.

### Failure handling

If Peakbagger changes its forms:

* Disable the automatic-submission capability.
* Continue allowing Strava sync and draft generation.
* Return a structured compatibility error.
* Do not retry final submissions blindly.
* Preserve the pending ascent for manual draft creation.

## 16. Duplicate and idempotency rules (M6)

Before submitting automatically, check:

1. Local submission table by idempotency key, only within the approved retention window.
2. Existing Peakbagger ascents for the same peak and date.
3. Existing review-history association.

Default duplicate behavior:

* Existing matching ascent: mark as already logged.
* Same peak and date but uncertain identity: require review.
* Failed request with unknown final state: query Peakbagger before retrying.
* Never automatically delete an ascent.
* Never automatically change an existing ascent after Strava editing or cropping.
* Do not retain a Strava activity ID, its hash, or any other Strava-derived idempotency material beyond the approved retention window.

## 17. Extension settings (M1, M3, M4, and M6)

### General

* Mode: standalone or backend
* Unit system
* Initial sync date
* Track-data retention, capped at seven days unless M0 records written approval for longer
* Default ascent visibility

### Activity types

Default enabled:

* Hike
* Trail Run
* Walk
* Snowshoe
* Backcountry Ski

Other Strava activity types remain selectable.

### Summit detection

Ordinary users see:

* Conservative
* Balanced
* Permissive

Advanced settings expose individual thresholds.

Automatic submission always uses at least the conservative high-confidence requirements, even when the review detector is configured as permissive.

### Submission mode

* Create drafts
* Automatic high-confidence submission

The automatic option is disabled with an explanation unless a tested backend reports support.

## 18. Testing strategy

### Track-core unit tests

Use recorded and synthetic tracks covering:

* Exact summit
* Trail passing below a summit
* Ridge passing horizontally near a higher summit
* Out-and-back
* One-way route ending at summit
* Multiple summits
* Repeated summit visit
* No altitude
* No timestamps
* GPS jump
* Long pause with GPS drift
* Multi-day activity
* GPX with more than 3,000 points

### Detection regression fixtures

Create a fixture format containing:

```json
{
  "track": "...",
  "peaks": [],
  "expected": {
    "high": [],
    "medium": [],
    "low": [],
    "rejected": []
  }
}
```

Version the detection algorithm and store the algorithm version with every result.

### Extension tests

* Settings migration
* Access-token validation and local-only storage
* Credential-leak regression: no token in sync storage, logs, query strings, analytics, or non-Strava requests
* Expired token and insufficient-scope handling
* Token refresh rotation
* Backend-origin permission request
* Manual sync pagination
* Sync lock
* Activity filtering
* Review edits
* Draft tab creation
* Peakbagger form filling
* Existing GPX Analyzer regression
* Existing Ascent Beta Filter regression

### Backend tests

* API-key rejection
* Encryption round trip
* OAuth state expiration and mismatch
* Strava refresh-token rotation
* Secret-redaction logging
* Peakbagger credential test
* Duplicate detection
* Idempotent submission
* Interrupted submission recovery
* Database migration
* Docker health check

Use recorded Peakbagger HTML as normal test fixtures. Live Peakbagger tests must be explicit, opt-in, and use a dedicated test account.

## 19. Milestone work breakdown

### M0 — Scope, terms, and safety decisions

* Record current test and lint results and smoke-test the GPX Analyzer and Ascent Beta Filter.
* Verify that a different user-owned `activity:read` token in each installation can list activities and fetch streams directly from packaged Chrome and Firefox builds without any publisher-operated service.
* Record how users obtain an activity-scoped token; reject the plan if the only practical instructions are unsafe or unreasonably complex.
* Ask Strava to confirm that a publicly distributed extension may act as local client software for separately registered, user-owned applications whose credentials never leave the user's device.
* Reproduce Peakbagger draft filling and, separately, investigate automatic submission with a dedicated test account.
* Capture sanitized request sequences and stable HTML fixtures; decide direct HTTP versus Playwright before M6.

### M1 — Extension and track core

* Add only the build tooling required to share pure code; keep the current layout unless M5 requires a separate server package.
* Generate browser-specific manifests and add the browser API compatibility wrapper.
* Move existing metric calculations into pure modules, update the GPX Analyzer to consume them, and add regression fixtures proving equivalent displayed metrics.

### M2 — Local summit drafts

* Add local GPX import, normalization, peak matching, GPX reduction, and candidate fixtures.
* Add the review surface and the ascent-edit content script.
* Create selected drafts with reduced GPX and Preview only; do not include a final-submit path.

### M3 — Standalone Strava sync

* Add access-token import, validation, replacement, local-only storage, and disconnect.
* Add optional client ID/secret/refresh-token configuration and refresh-token rotation; keep in-extension OAuth deferred.
* Add activity listing, stream fetching, activity-type filtering, cursor overlap, sync locking, bounded concurrency, and rate-limit handling.
* Send every normalized Strava activity through the M2 review and draft flow.

### M4 — Review, history, and retention

* Add the popup, activity picker, pending-review count, result history, retries, and private-activity scope status with token-replacement instructions.
* Store activity and submission state in IndexedDB and apply configured track-data retention.
* Preserve existing ascents on all manual reanalysis paths.

### M5 — Optional self-hosted backend

* Add the Fastify service, API-key middleware, SQLite migrations, authenticated health/capabilities endpoints, encryption, Docker, and Compose.
* Add backend OAuth/data-provider parity, exact-origin permission requests, connection testing, credential deletion, and documentation.

### M6 — Guarded automatic submission

* Add encrypted Peakbagger credentials, a credential test, duplicate lookup, direct-HTTP or Playwright adapter, and idempotency.
* Gate automatic mode on backend capabilities and submit only high-confidence candidates with altitude data.
* Preserve failed or uncertain candidates for review and never retry an unknown final state blindly.

### M7 — Release readiness

* Complete privacy, standalone setup, self-hosting, API, troubleshooting, upgrade, and backup documentation.
* Package and validate Chrome and Firefox releases; run the existing-feature regression suite and complete store disclosure review.

## 20. Suggested change-set sequence

1. M0 baseline and feasibility notes
2. M1 manifest/build support and track-core extraction
3. M2 GPX parsing, detection fixtures, review, and draft creation
4. M3 token import, standalone provider, and manual sync
5. M4 popup, history, and retention
6. M5 backend foundation and backend provider
7. M6 credential vault, submission adapter, and idempotency
8. M7 documentation, hardening, and release packaging

Each change set must leave the extension loadable and preserve both existing features.

## 21. Definition of done

### Without a backend

* Every user supplies credentials for a separate Strava application they own; the extension contains no publisher-owned shared Strava credentials.
* User can import and replace their own activity-scoped Strava access token.
* User can optionally provide refresh credentials for a durable connection.
* User can connect and disconnect Strava, with disconnect deleting all locally stored Strava credentials.
* Standalone credentials and API responses never pass through publisher-operated infrastructure.
* User can sync private activities only when the imported token has `activity:read_all`.
* User can manually sync new activities.
* User can inspect confidence evidence.
* User can correct detected peaks.
* User can create detailed Peakbagger drafts with attached GPX.
* Automatic submission cannot be enabled.

### With a backend

* User can enter a custom server URL and API key.
* Test connection reports version and capabilities.
* Backend handles Strava OAuth and token refresh.
* Backend securely stores encrypted Peakbagger credentials.
* Manual sync uses the backend Strava provider.
* High-confidence ascents can be submitted automatically.
* Medium-confidence ascents become drafts.
* Duplicate synchronization does not create duplicate ascents.
* Backend or Peakbagger failure safely falls back to review.
* No default server is embedded in the extension.

### Compatibility

* Existing GPX chart remains functional.
* Existing ascent filtering remains functional.
* Chrome package passes extension validation.
* Firefox package passes `web-ext lint`.
* Docker deployment starts with one Compose command.
* All documented APIs use versioned `/v1` paths.
