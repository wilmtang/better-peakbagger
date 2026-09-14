# Imgur uploads and media-host selection

Status: proposed; implementation has not started. Researched 2026-09-13.

## Recommendation

Add an **Upload to** dropdown with **ImgBB** and **Imgur**, preserving ImgBB as
the existing default. Support both hosts for flattened photos; add MP4 uploads
through Imgur in a dedicated video path. Reuse the report editor's existing
direct-video node and serializers. Do not send videos through Photo Topos'
image decoder, canvas export, or pasted-photo message transport.

Each user registers their own Imgur application and supplies its **Client ID**.
Settings guides registration, supplies the exact callback to copy, and then
handles account authorization through **Connect Imgur**. This is the default
setup, not an advanced fallback. Do not bundle a maintainer-owned Client ID or
route uploads through a shared application or relay.

User-owned applications keep unrelated users from depending on one application
quota. Files still travel directly from each user's browser to Imgur. Postman
must not be a prerequisite. A cURL example can validate an existing Client ID,
upload a file, or refresh an account token; it cannot replace registration.

Before enabling Imgur for release, resolve registration availability and the
provider's external-hosting restriction, then verify real photo/video uploads.
These are outstanding evidence requirements, not findings that the feature is
impossible. The provider-neutral work remains useful independently.

### Application quota decision

Imgur documents approximately **1,250 uploads per day per application**, with
additional user/IP limits. It also documents an application block for the rest
of the month after reaching its daily limit five times. Read actual allowances
and reset information from response headers or `/3/credits`; the published
figures are not a guarantee of live capacity. See
[the official API rate-limit documentation](https://apidocs.imgur.com/).

Separate user logins under one Client ID still consume that application's
shared quota. With this plan, each user's uploads consume the quota of the
application they registered. Their other tools using that same Client ID also
share it, and user/IP limits continue to apply. The extension must not rotate
Client IDs or fall back to a maintainer application when a limit is reached.

The tradeoff is a one-time application-registration step for every user. Accept
that setup cost to avoid a shared quota and application-wide outage affecting
all extension users. Successful registration is therefore a release prerequisite
for the standard setup, not merely an advanced configuration check.

## Findings in the current repository

| Boundary | Current behavior | Required change |
| --- | --- | --- |
| [Report markup](../../src/reports/report-markup.js), [Rich editor](../../src/reports/report-rich-editor.js), [editor UI](../../src/reports/report-editor.js) | Direct HTTPS MP4 URLs already become native video controls and Peakbagger bracket markup. The video popover currently accepts URLs. | Add file-upload entry and typed return handling; preserve existing video semantics. |
| [ImgBB client](../../src/photos/imgbb-client.js) | Accepts image blobs, posts to a fixed endpoint, validates ImgBB-specific response fields, distinguishes refusals from unknown outcomes. | Add a separate Imgur adapter; share only provider-independent contracts. |
| [Photo catalog](../../src/photos/photo-library.js) | Schema version 1 accepts only image metadata and `provider: 'imgbb'`. Transitions rewrite the provider to ImgBB. | Preserve the selected provider across every transition and introduce an explicit image/video discriminator. |
| [Photo store](../../src/photos/photo-store.js) | IndexedDB version 4; upload commit requires a valid ImgBB-style delete URL. | Version deletion capabilities and journals; an Imgur delete hash is not a browser delete URL. |
| [Standalone uploader](../../photos/photos.js) | Owns image decoding, source/export formats, annotation projects, local recovery, direct upload, and report return. | Add host selection; branch video preparation before image-only work. Keep existing photo-format choices. |
| [Local report photos](../../src/reports/report-local-photos.js), [worker service](../../src/background/report-photo-service.js) | Pasted photos are re-encoded, bounded to 16 MiB, stored locally, then uploaded sequentially after a trusted Save Ascent action. | Select and persist a host for pending photos; keep the existing image-only size/privacy boundary. |
| [Photo routes](../../src/background/photo-routes.js) | Exact packaged photo page can obtain an ImgBB key; report content scripts cannot. Return authority is bound to source/editor contexts. | Provider-aware status and narrowly scoped upload credentials; typed, revalidated media returns. |
| [Settings](../../options/imgbb.js), [transfer](../../src/settings/settings-transfer.js) | ImgBB credential is device-local. Explicit credential export can include it; ordinary backup cannot. | Separate Imgur connection from ImgBB credentials and make Imgur export behavior explicit. |

This is more than an endpoint substitution. Merely accepting `.mp4` would fail
the image decoder, catalog validation, mandatory delete-URL commit, and report
image insertion even if Imgur accepted the bytes.

## What the provider documentation establishes

Use [Imgur's current API documentation](https://apidocs.imgur.com/) and its
[published collection](https://apidocs.imgur.com/api/collections/1688173/6YsWHMa?segregateAuth=true&versionTag=latest)
as primary API evidence. The collection was read directly because the document
page is client-rendered; do not copy its example credentials or run its scripts.

- The current upload request is `POST /3/image`, multipart field `image`, with
  `type=file`; its accepted MIME types include `video/mp4`.
- Registration supplies `client_id` and `client_secret`. Client-ID authorization
  supports anonymous images; Bearer authorization associates uploads with an account.
- The current OAuth section recommends `response_type=token` and deprecates
  `code` and `pin`. Older tutorials proposing a PIN exchange are unsuitable.
- Token refresh requires `client_id`, `client_secret`, and `refresh_token`.
  Read expiry from the response; do not hard-code a month.
- The collection's upload example has competing authorization configuration.
  Verify anonymous **video** authorization and response shape live rather than
  assuming the anonymous-image statement settles it.

[Imgur's upload help](https://help.imgur.com/hc/en-us/articles/26511665959579-What-files-can-I-upload-Is-there-a-size-limit)
currently lists 200 MB and 180 seconds for video. These are website guidance,
not a verified API contract. Do not copy the deprecated API's image limit or
older 60-second video claims into a new validator. Initially propose local
ceilings of **200,000,000 bytes and 180 seconds**, explicitly identified as our
limits and subject to the API probe and browser-memory checks below. Lower them if the
verified API or supported browsers require it; use one shared definition.

The [documented registration page](https://api.imgur.com/oauth2/addclient)
redirected to the homepage in this unauthenticated research session, while
[account application settings](https://imgur.com/account/settings/apps)
redirected to sign-in. Therefore, the docs describe web-issued credentials, but
successful registration and retrieval in today's signed-in UI remain unverified.
No documented programmatic client-registration route was found. Do not invent a
POST endpoint or promise that cURL fixes an unavailable registration page.

[Imgur's terms](https://imgur.com/tos) restrict external image libraries and use
as a content delivery network. This product's reusable report-media library may
intersect that restriction; that is an inference requiring clarification before
release, not a claim that every individual report embed is prohibited. Document
the permitted use or applicable agreement before advertising Imgur as a durable
hosting option. Do not infer perpetual retention from a successful upload.

## User experience

### Settings and host selection

In Settings → Activity creation, evolve **Trip report photos** to **Trip report
media**. Show a default-host select and the selected provider's setup:

```text
Trip report media
Default upload host   [ ImgBB ▾ ]

ImgBB                 API key       [ Save key ]
```

Selecting Imgur reveals **Register application**, the exact callback with a
**Copy** action, a **Client ID** field, and **Connect Imgur**. The primary setup
uses the user's own application and account. Keep detailed form instructions in
the guide behind **How to connect**. A small **Anonymous uploads** disclosure
offers Client-ID-only setup as an explicit alternative; it uses the same
user-owned application. Connection status identifies the account or explicitly
says **Anonymous uploads**. Saving a Client ID alone must not say **Connected**.

Every upload surface shows **Upload to [host ▾]** before bytes leave the device:

- Photo Topos: both hosts support the existing flattened image export.
- Report photo paste: snapshot the report's selected host into each pending
  item and display its destination with the existing local status. Changing the
  dropdown affects new items. Allow changing an existing pending item's host
  explicitly before upload; do not silently reroute a saved draft.
- Video upload: list **Imgur — photos and MP4**; leave **ImgBB — photos only**
  visible but unavailable for an MP4. If ImgBB is the default, require an
  explicit Imgur selection instead of switching services automatically.
- Library reuse: insert the existing hosted URL without another upload.

Persist `defaultMediaHost: 'imgbb' | 'imgur'` through the existing shared
settings schema. Unknown/missing values default to ImgBB. Credentials stay
device-local; a synced host preference does not imply that another device is
connected. Never fall back to another host after an error or permission denial.

Once an upload starts, freeze provider, Client ID, account/credential generation,
file snapshot, and destination report. A host/client/account change elsewhere
cannot retarget an in-flight operation. Existing uploaded items retain their
provider and URL.

### MP4 entry

Add **Upload video…** beside the existing video URL control. It opens a dedicated
video mode in the packaged uploader, with file selection, native preview,
duration/size, host dropdown, and **Upload and insert**. Reuse the existing helper
tab and return-authority design; keep Photo Topos' drawing UI for images.

For the first version, MP4 uploads finish in that helper before insertion into
the report. Do not introduce pending local-video placeholders, video clipboard
paste, drag/drop upload, trimming, transcoding, or video annotations. This avoids
expanding the photo-only 16 MiB messages and native Save gate to large videos.
The resulting remote video can still round-trip through all three editor modes.

Show separate **Uploading…** and **Processing video…** states when needed. Only
show a percentage if the transport measures sent bytes. Keep cancellation
available; canceling a request does not establish that Imgur deleted its copy.

The original MP4 is uploaded, including audio and any embedded metadata. State
that briefly at file review; do not reuse the photo flow's metadata-stripping
promise. Do not claim that Imgur will preserve audio until tested.

## Credential setup without Postman

### Default: register your application, then connect in Settings

1. Settings supplies a **Register application** link and the exact callback for
   this installed extension, with **Copy**. The user signs in to Imgur, registers
   their application, and copies the returned Client ID. Verify and document the
   current form choices. The extension cannot issue a Client ID or register on
   the user's behalf. If registration is unavailable, explain that limitation
   and preserve ImgBB and existing direct-URL insertion.
2. The user pastes the Client ID and selects **Connect Imgur**. Obtain necessary
   permission and start browser authorization with that user's Client ID,
   `response_type=token`, a cryptographically random one-use `state`, and the
   registered callback. No Client Secret field is required for this flow.
3. Use `identity.getRedirectURL()` and `identity.launchWebAuthFlow()` where
   supported. Add the identity permission only with this flow. Register the exact
   callback for each supported browser/distribution; a user may need separate
   applications for different callbacks. Verify Chrome, Firefox, installed
   builds, and development extension IDs separately; callback support is not
   established by a mocked response. See
   [the browser identity API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity/launchWebAuthFlow).
4. Check exact callback origin/path, matching state, expiry, denial, replay, and
   the Client ID and connection generation captured when authorization started.
   Parse tokens only in extension-owned code. Drop the full callback URL
   immediately; never log, sync, or display it.
5. Validate account identity with a read-only request, then atomically store the
   Client ID, access token, account identity, and expiry locally. Show **Connected
   as …**. Stage a replacement Client ID separately until its authorization
   succeeds; never pair it with the old token. Keep the previous connection if
   replacement fails, and let disconnect invalidate late callbacks.
6. Reconnect on expiry in v1. The documented refresh exchange requires a secret;
   collecting client secrets and implementing unattended refresh are outside
   this version. Discard any unused refresh token returned by authorization.
   Never switch to anonymous uploads or another application on expiry.

The extension assists registration and handles tokens after browser consent;
users need neither Postman nor manual access-token copying. It does not remove
the requirement for their own registered application.

### Optional: anonymous uploads with your own Client ID

1. After registering their application, the user opens **Anonymous uploads**,
   enters its Client ID, and chooses **Save and use anonymous uploads**. No client
   secret or access token is needed for the documented anonymous-image flow.
   A read-only credential check proves only that check, not upload permission.
2. Explain that anonymous uploads are not added to the user's account. Preserve
   deletion capability locally; after a response-lost upload, account-gallery
   inspection may not recover it. This is why account connection is preferred.
3. If live probes show anonymous MP4 is unavailable, require account connection
   for MP4 and say so in the dropdown's setup state. Moving between anonymous
   and account uploads is an explicit connection change, never an error fallback.

Postman's collection is an optional API testing workspace. It still requires
registered client credentials; importing it is not a way to obtain one's own
Client ID. Never reuse the ID embedded in its demonstration script.

### cURL examples for the guide

These are proposed examples, not commands executed during this planning task.
They require existing credentials. Placeholder values are intentionally not real
keys; for actual use, load credentials without saving them into shell history.

Read-only Client ID check:

```sh
curl --fail-with-body --silent --show-error \
  --header "Authorization: Client-ID ${IMGUR_CLIENT_ID}" \
  https://api.imgur.com/3/credits
```

After explicit account authorization, an MP4 upload following the current
collection's multipart contract:

```sh
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${IMGUR_ACCESS_TOKEN}" \
  --form 'image=@/absolute/path/summit.mp4;type=video/mp4' \
  --form-string 'type=file' \
  https://api.imgur.com/3/image
```

For advanced manual use outside the extension, a user-owned registered client
with an existing refresh token can run the following. This does not imply that
the v1 extension retains refresh tokens or offers automatic refresh:

```sh
curl --fail-with-body --silent --show-error \
  --request POST https://api.imgur.com/oauth2/token \
  --data-urlencode "client_id=${IMGUR_CLIENT_ID}" \
  --data-urlencode "client_secret=${IMGUR_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${IMGUR_REFRESH_TOKEN}" \
  --data-urlencode 'grant_type=refresh_token'
```

The last command obtains a new **access token**, not a new API application key.
Its response contains credentials. Do not use deprecated PIN/code recipes to
bootstrap it; initial authorization remains a browser interaction. Do not add
automatic POST retries to either example.

## Implementation design

### Provider contracts and data migration

Add a small provider registry under the proposed **src/media/** directory and a
separate Imgur client.
Keep provider-specific endpoint, authorization, capability, response validation,
and error mapping in each adapter. Callers select a fixed provider identifier;
messages cannot supply arbitrary upload URLs or authentication headers.

A normalized result needs `provider`, `providerId`, `kind`, a direct `url` when
ready, a viewer URL, optional thumbnail/poster, MIME type and dimensions, plus
video duration where known. Preserve submitted-file metadata separately from
provider output metadata because a host can transform a file. Optional Imgur
thumbnails must not be invented to satisfy ImgBB's mandatory thumbnail fields.
Keep private deletion capabilities outside this public result.

Version the existing catalog and local journal; do not rename the entire photo
subsystem. Read version-1 entries as `kind: 'image', provider: 'imgbb'`, preserving
IDs, URLs, captions, references, project/source format, hashes, tombstones, and
secrets. Add discriminated validation for video: no annotation project or fake
JPEG export. Migrate metadata on controlled writes and change the IndexedDB
version only where its stores/indexes require it. Handle old open tabs and
unsupported future schemas without discarding records.

Represent deletion capability as a provider-tagged secret: existing ImgBB delete
URL versus Imgur delete hash or account-owned deletion identity. Catalog commit
must not reject a known successful upload solely because no delete capability
was returned. Record that limitation and preserve the URL. Local removal never
issues remote deletion. A future explicit remote-delete action must construct a
fixed API request and validate provider/account identity; do not turn a hash
into an invented browser link.

Extend catalog backup/import and format versions alongside validation, so Imgur
and videos cannot disappear on restore. Keep credentials, deletion capabilities,
upload journals, pixels, and MP4 bytes out of GitHub catalog backups. Preserve
existing photo project archives. In v1, videos offer original-file download and
metadata recovery, not a misleading Photo Topos project archive.

### Upload lifetime and recovery

Use the packaged uploader for long video transfers. Chrome documents worker
termination when a fetch response takes more than 30 seconds; increasing our
JavaScript timeout is insufficient. See
[service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
The existing small pasted-photo worker path stays bounded and gains provider
dispatch; verify its interruption behavior separately.

Keep blobs in extension IndexedDB and send identifiers/metadata between contexts.
Never base64 a 200 MB video into runtime messages or report drafts. Before POST,
validate nonzero file size, MP4 type/container, finite duration, dimensions, and
native preview support. Treat malformed/undecodable files as actionable failures.
Use a single active video upload, bounded metadata reads, and bounded hashing
that avoids loading multiple full file copies. Release object URLs, media
elements, buffers, and upload listeners on replacement, cancel, or page close.

Preserve the durable ordering:

```text
local snapshot + provider/account selection
  → durable request-started journal
  → one POST
  → durable response with remote identity and private deletion capability
  → processing check if required
  → committed playable media in library
  → one-use report insertion
  → journal cleanup
```

If Imgur returns an ID before a playable result, preserve that known acceptance
and add a processing state. Use bounded, rate-aware GET polling only for that
known ID. Persist enough to resume a status check after restart. Do not invent a
processing endpoint or assume it always occurs; lock the actual state/response
contract from the probe. Processing timeout means **Uploaded; still processing**,
with **Check status**, not permission to upload again.

Distinguish refusal, unknown remote outcome, accepted/processing, and committed
but not inserted. Transport abort, unexpected proxy HTML, unreadable success, or
lost response must not trigger another POST. A report closing after commit
leaves a reusable library item. Respect rate-limit/reset headers; reconcile
known IDs with GET, and never automatically switch host/account or retry POST.
An account list with similar names/times is not proof of duplicate identity.

Validate returned direct URLs against Imgur's observed HTTPS media origins;
reject credentials, unsupported schemes, arbitrary endpoints, and unexpected
redirects. A viewer page or `.gifv` wrapper is not a playable video URL. Use the
returned direct MP4 field/URL; do not guess by changing a file extension.

### Permissions, secrets, and report insertion

Add only optional `https://api.imgur.com/*` API host access, requested from a
user action. Avoid wildcard Imgur content scripts. Request any additional
origin only if a verified extension fetch requires it; ordinary report playback
does not justify broad API permissions. Fixed API requests omit browser cookies
and referrers and do not forward tokens across redirects.

Store the user-owned Client ID and account credentials together in a separate
device-local connection record. The worker owns connection management. Only the
exact packaged uploader may obtain the Client ID or access token needed for the
chosen upload mode, bound to the operation and current connection. V1 neither
collects client secrets nor retains refresh tokens. Neither Peakbagger world,
general status replies, URLs, logs, nor GitHub backups receive credentials.
Removing credentials prevents subsequent uploads without erasing library items.

For v1, settings export continues its existing ImgBB/GitHub credential behavior
but excludes the Imgur account session, even under **Include saved credentials**.
Update that label/help to name exactly what is included and require reconnecting
Imgur after restore. A user-owned public Client ID may be exported only with an
explicit versioned field; exclude client secrets and tokens. This avoids quietly
expanding an existing credential-export consent.

Return only public `{ localId, kind, url, width, height }` and supported text
metadata through the existing bound helper handshake. Validate kind and URL on
both sides; look up the committed record rather than trusting a claimed result.
Images retain their current caption/alt behavior. Videos use the existing video
node, controls, no autoplay, and existing width rules. Video captions and new
embed providers are outside this change.

Keep `JournalText` as submission authority. Preserve Rich/Markdown/Plain round
trips, draft restore, dirty-state guards, trusted native Save behavior, and
one-use source tab/frame/document/report checks. Do not add gallery publication,
account-wide media import, or automatic remote deletion.

## Execution sequence and acceptance

Each numbered implementation unit gets a focused commit after its checks pass.

1. **Provider feasibility.** Verify a new user's signed-in application
   registration/retrieval, exact callback behavior, permitted hosting use, and
   one user-authorized image/MP4 upload per required auth mode. Read that
   application's quota/reset data without deliberately exhausting its limits.
   Capture sanitized response fixtures, final MIME/playback/audio behavior,
   limits, and processing behavior. Prove the intended hidden fixture can load
   the real extension before UI implementation.
2. **Provider-neutral image upload.** Introduce adapters, pinned host selection,
   versioned catalog/journal/secrets, and migrations while preserving all current
   ImgBB behavior. Cover source/export formats, captions, archives, backups,
   interrupted requests, multiple tabs, and return-after-commit behavior.
3. **Imgur connection and photo upload.** Add the adapter, optional permission,
   Settings setup, dropdown, and both standalone/pasted-photo routing. Implement
   user-owned Client ID setup and in-extension account authorization as the
   standard flow. Test expired/revoked tokens, denied permission, state/replay,
   Client ID replacement, disconnect/reconnect races, and secret exclusion.
   Verify that requests use the selected user's application, quota failure never
   changes it, and the build contains no default or fallback Imgur Client ID.
4. **MP4 uploader and library.** Add video metadata, preview, blob retention,
   streaming/bounded preparation, processing recovery, and typed insertion.
   Cover over-limit/empty/corrupt files, unsupported decoding, cancellation,
   slow uploads, worker restart, helper close, quota failure, revoked permission,
   processing failure, rate limits, and provider changes during a transaction.
5. **End-to-end and documentation.** Update the photo guide, report-editor guide,
   architecture/privacy docs, settings transfer copy, and build composition.
   Add intercepted Imgur image/video/processing routes to the real packaged
   HTTPS Peakbagger fixtures. Verify all editor modes, library reuse, draft
   restore, and both native Save controls without duplicate uploads.

Run focused tests beside `test/photos`, `test/reports`, `test/options`, and
`test/settings`, plus appropriate manifest/build/privacy guards. Before closure,
run `npm test`, `npm run lint`, and `npm run verify:browsers`; extend
`scripts/verify-report-photos.mjs` or add a small media-focused verifier as needed.

Visually inspect Settings, the photo uploader, video uploader, and report
playback at 1280×900 and 720×900 in light/dark contexts, in hidden dedicated
profiles. Check keyboard access, permission-denied copy, wrapping, clipping,
progress, and return focus within the page. Record browser/version/viewport;
native video decoding/rendering and permissions require their own evidence.
No full-display screenshots or use of the user's normal browser for routine QA.

Mocks cannot prove Imgur account enrollment, upload permission, real processing,
audio retention, or Peakbagger server acceptance. Before claiming live support,
have a user-authorized report saved/reopened and viewed without the extension.
Verify owned browser/process/profile teardown and retain only deliberate evidence.

## Evidence ledger

| Category | Current state |
| --- | --- |
| Fixed and verified | No runtime changes. Current code boundaries inspected; current official collection read; this plan and examples reviewed statically. |
| Intentionally not changed | Existing default and credentials; image format/export behavior; photo metadata stripping; native Save authority; arbitrary embeds; video editing/transcoding; video paste; automatic gallery publication/deletion; existing caption plan. Shared maintainer application, quota fallback, client-secret collection, and unattended token refresh are outside scope. |
| Changed but not fully proven | No implementation yet. New-user application registration, hosting suitability, anonymous MP4 behavior, live quotas/limits/response/processing/audio, OAuth browser callbacks, and server save/reopen remain open. |

Keep this plan active until implementation evidence and remaining limitations are
recorded. Archive it only with this ledger preserved and maintained guides updated.
