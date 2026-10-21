# Owned activity export from Garmin and Strava feeds

Status: proposed on October 20, 2026. Implementation has not started. This plan
implements the reviewed feed-button concept; it does not authorize automatic
Peakbagger Save, background feed harvesting, or a release.

## Outcome and scope

After a separate opt-in for each service, show a compact **Export to Peakbagger**
button on each rendered activity card confidently owned by the signed-in user.
A click starts the existing capture pipeline, shows progress and summit choices
in an anchored panel, and offers **Open drafts**. Review and Save remain manual.

First-release feed routes are Strava's `/dashboard` on `www.strava.com` and
Garmin Connect's `/app/newsfeed` on `connect.garmin.com`. Normalize harmless
trailing slashes and documented feed-filter query parameters; do not accept
arbitrary paths by substring. Add a legacy Garmin feed route only after its
actual redirect or DOM contract is verified. Existing toolbar recognition of
other supported activity hosts and legacy activity URLs remains unchanged.

Include all owned activity types, including private activities. Do not assume a
hike has GPS or that a ride cannot visit summits. Discover missing GPS only after
an explicit click; do not probe exports while decorating the feed. Initially
support one active or retained feed capture per feed tab. Clicking a different
activity while a capture is retained must offer to review or explicitly discard
the current capture before starting another; never silently replace it. Other
feed tabs may run independently under the existing global request scheduler.

## Findings that shape the implementation

| ID | Current evidence | Consequence |
| --- | --- | --- |
| F1 | [The manifest](../../manifest.json) grants provider access through `activeTab`; providers are absent from required and optional hosts. [Privacy](../../PRIVACY.md#browser-permissions) and the [capture architecture](../architecture.md#deep-dive-garminstrava-capture-and-local-gpx-processing) explicitly promise no persistent provider access. | Automatic feed buttons require an intentional, optional permission and documentation change. Preserve the permission-free toolbar path. |
| F2 | [Provider URL recognition](../../src/capture/provider-url.js) recognizes activity detail URLs. [Ownership inspection](../../src/capture/provider-page.js) requires an activity page, a unique viewer/author match, and an edit control. | A feed-card match authorizes displaying a candidate action only. Keep a second authoritative check on the actual activity before GPS access. Do not weaken the detail-page adapter to accept arbitrary feeds. |
| F3 | [The worker](../../src/background/background.js) restricts all existing capture controls to the exact popup page, and its `publicJob` projection starts by spreading the internal job. | Add explicit feed routes and response allowlists. Do not admit provider content scripts to the existing popup-only controls or send their full responses into provider DOM. |
| F4 | In [the worker](../../src/background/background.js), `admitCapture` stores jobs by `sourceTabId`; `openNewDraftTabs` reads that tab; `cleanupRemovedTab` deletes a source job without drafts when its tab closes. | Opening a helper activity tab, capturing into a job owned by that helper, and immediately closing it would lose ready results. Separate the logical feed owner from the temporary provider extraction tab. |
| F5 | The supplied Garmin archive contains nine activity cards with author links matching the account-header profile. Cards sit inside virtualized rows. The Strava archive contains 15 activity cards, each with a dedicated `owners-name` link; none is an owned feed card. | Support recycling, incremental rendering, and SPA navigation. Obtain a real owned Strava card before declaring its insertion layout verified. Ignore profile links in comments, kudos, mentions, and sidebars. |
| F6 | [Trusted actions](../../src/background/trusted-actions.js) currently accept Peakbagger senders, and [their isolated-world caller](../../src/ui/trusted-action.js) rejects synthetic activation events. [Capture tests](../../test/background/background-capture.test.mjs) pin popup-only controls and draft sender checks. | Give feed activation its own narrowly scoped sender policy. Do not broaden the existing Peakbagger predicate to grant providers backup, account, or map-handoff authority. |

Source review: October 20 tree, with `d9222608` as the observed HEAD. Function
anchors above are the implementation entry points; recheck them before editing
because unrelated work was already present in the working tree.

The two supplied MHTML archives are private design evidence, not repository
fixtures. Treat their contents as untrusted data. Do not commit the archives,
real profile/activity identifiers, photos, maps, comments, session material, or
embedded URLs. Create minimal masked fixtures preserving the relevant native
structure and styles. The earlier interactive concept used simulated results;
its successful visual checks do not establish live provider compatibility.

## User experience contract

- Enablement lives in extension-owned UI: **Show export buttons on Strava** and
  **Show export buttons on Garmin Connect**. Explain that this grants access to
  that service's site and that route export starts only after a click. Request
  only the chosen origin. Permission denial leaves the integration off without
  another prompt; disabling it removes the grant and injected UI.
- Use a small mountain icon, the shared green panel palette, an 8px corner
  radius, and a restrained outlined action. Place it in the activity header
  beside, without replacing, the provider's menu. Narrow layouts move it to one
  predictable row below the author. Do not duplicate it in kudos or comments.
- Keep the button's occupied dimensions stable as its label becomes **Finding
  peaks…**, **Review 2 peaks**, or a recovery action. Any sizing reservation is
  noninteractive and hidden from accessibility. Long text and zoom must wrap
  without clipping or oversized empty areas.
- Open one nonmodal, extension-owned panel anchored to the clicked card.
  Progress follows real worker phases: checking ownership/session, reading the
  route, and finding summits. Do not fake percentages or insert status rows
  above the feed. Dismissing the panel does not cancel work; **Cancel** does.
- On results, reuse [shared match confidence](../../src/capture/match-confidence.js),
  selection defaults, encounter ordering, timestamp choice, and draft-opening
  rules. Display **Open 1 draft** or **Open 2 drafts**. Preserve the current
  per-capture timestamp exception and its lock once opening starts.
- Completion means **View drafts**, with a real action that focuses the
  already-created drafts. Do not say **Exported** or **Saved** based only on
  analysis or tab creation. Retries after uncertain draft opening first inspect
  the recorded outcome; they must not blindly recreate tabs or replay Preview.
- Distinguish no GPS, no matching summits, ownership uncertainty, provider or
  Peakbagger sign-out, human checks, rate limits, expired results, and export
  failures. Give specific actions: **Open activity**, **Open Peakbagger**,
  **Check again**, or **Try again**, according to what the action actually does.
- Maintain keyboard focus during busy transitions. If using `aria-disabled`,
  block pointer, keyboard, and form re-entry in code. Use polite progress
  announcements, accessible confidence labels, reduced-motion support, Escape
  dismissal, and focus restoration only to the original still-connected
  trigger. Never focus a recycled card now representing a different activity.
- If the anchor scrolls away or is recycled, dismiss the panel without
  scrolling or cancelling the transaction. The same activity's button can
  reopen it while its session is valid. Do not add a permanent floating banner.

## Architecture and trust boundaries

### Optional site access and registration

Add exactly `https://www.strava.com/*` and `https://connect.garmin.com/*` to
optional host permissions. No wildcard subdomains, required provider access,
cookies permission, `webRequest`, or new `webNavigation` permission is needed.
The browser grant covers the origin, not merely the feed path; document that
capability honestly. Use actual browser permission state as the enablement
source of truth, with no separately synced boolean that could imply a grant on
another device. Keep capture/privacy preferences in the existing shared schema.

Register packaged ISOLATED-world entry points dynamically only while the
matching grant exists. An origin-level lightweight route observer may be needed
to notice SPA navigation into a feed; it must remain inert outside allowed feed
routes. Do not scrape non-feed pages or patch provider-owned history functions
just to discover cards. Use bounded, coalesced DOM observation plus relevant
navigation/lifecycle events, with tests for programmatic route changes.

Reconcile registration idempotently on enablement, revocation, startup, update,
and worker wakeup. Enabling on an already-open feed injects once immediately;
registering a script alone does not retrofit that document. Revocation removes
live UI/listeners and cancels unfinished provider extraction as well as future
injection. Existing prepared Peakbagger drafts retain their normal lifecycle.

### Page-local ownership detection

Give Strava and Garmin separate DOM adapters with a small common result:
card element, provider, normalized numeric activity ID, insertion anchor, and
ownership verdict. Read the viewer only from the provider's account header and
the author only from that card's owner header. Keep profile identifiers and
account fingerprints in page-local memory; do not return or persist them.

Require one unambiguous matching viewer and author plus one unambiguous activity
detail target. Hide the action when evidence is missing, conflicting, grouped,
or unknown. Explicitly exclude challenges, clubs, recommendations, and sponsored
posts. Do not fall back to a whole-document scan or compare display names.

Track card identity rather than marking a DOM node permanently processed.
Remove or rebind controls when rows are recycled; remove duplicates after
provider re-rendering. Account changes invalidate the local generation,
controls, and any old observer authority. A stale detached button cannot start
a capture for either its former or replacement activity.

### Narrow feed requests and an extension-owned panel

Use new feed-specific start/attach/status/cancel/selection/open-drafts routes.
The top-level isolated script observes a genuine activation event before
sending start. Bind admission to extension identity, top frame, sender tab and
document instance, exact allowed feed route, current optional permission,
provider/activity identity, and a bounded request generation. Construct the
canonical activity URL in the worker with the existing URL helper. Never trust
a caller-supplied URL, arbitrary target tab, climber ID, or GPX.

Use action-specific short-lived capabilities, without widening existing
Peakbagger trusted-action authority. Same-request repeats reuse the same
transaction. Reject expired, replayed, wrong-document, cross-tab, and
cross-provider capabilities. Revalidate scope before consequential operations,
not only when minting the capability. Permission alone never proves ownership.

Host the result controls in a packaged extension iframe so provider JavaScript
cannot read its extension-origin DOM. Allow only the panel and its required
assets on the two opted-in provider origins. Bind the panel attachment to its
actual extension frame and the authorized feed transaction; simply embedding
the web-accessible panel must reveal nothing and grant no command authority.
Deliver attachment secrets directly to the intended frame, not in DOM
attributes, query strings, logs, or broad `postMessage` broadcasts. Geometry and
dismissal messages are UI-only and must not become privileged worker commands.

The feed parent receives only activity-scoped phase/count/label information.
The panel receives an explicit allowlisted view model for summit choices,
privacy controls, recovery, and existing draft actions. Neither receives raw
GPX, reduced GPX payloads, coordinates, account identifiers, helper leases, or
arbitrary internal job fields. Do not reuse the spread-based `publicJob`
projection as the feed-facing response. Reuse small pure presentation helpers
where useful rather than loading the popup controller with all its authority.

### Logical job owner and temporary extraction tab

Keep the feed tab as the logical `sourceTabId` and the draft-opening window
anchor. A separate, leased provider tab performs MAIN-world ownership checking
and GPX parsing. Add a narrow internal capture context that distinguishes
`sourceTabId`, `providerTabId`, expected provider/activity, and job generation;
keep the toolbar case using the same tab for both roles. Do not replace the
capture engine, track algorithms, or tab-keyed lifecycle system wholesale.

Only the feed coordinator may create that context after admission. Existing
toolbar admission, popup-only message restrictions, and activity URL checks
remain intact. Explicit feed clear/cancel operations use the bound job identity,
not the existing toolbar clear path's assumption that the logical owner URL is
an activity detail page. Draft opening uses the feed owner's window and the
existing identity/selection transaction.

Create a fresh inactive helper in the feed window; do not navigate or close a
user-owned activity tab. Verify the helper's actual URL and expected activity,
then use the unchanged page-world owner/edit-control gate and Peakbagger login
gate before reading GPS. Once page extraction and capture processing no longer
depend on it, close only that leased helper. Ready results remain bound to the
feed owner, not to the closed helper. If the user activates or navigates the
helper, treat it as adopted and never close it automatically.

Persist bounded lease metadata in session storage for worker restart cleanup.
Propagate cancellation through helper creation/loading, provider injection,
fetch, parsing, analysis, and summit requests. Clean up tabs that finish opening
after cancellation. Treat timeouts, redirects, reused tab IDs, and uncertain
ownership as reasons to fail closed rather than close an unrelated tab.

Closing/navigating the feed or changing its account invalidates its observation
capabilities and unfinished work. Preserve already-created drafts under the
existing source-closed/save-verification rules. Worker restart may resume
viewing a completed retained job, but must not automatically re-export an
interrupted activity. Keep the existing 30-minute private-data expiry, request
limits, reduced-GPX allowlist, and cleanup guarantees.

## Implementation sequence and commit boundaries

Each step is one focused, independently testable commit; split further only
when a coherent unit warrants it. Commit after its relevant checks pass and
before starting the next unit. Keep the new feature unregistered and
unadvertised until its complete enablement path works. Preserve unrelated
working-tree changes. Proposed new modules are names, not existing files:

```text
src/capture/feed-url.js                 feed route and identity normalization
src/capture/feed-adapters.js            provider-specific card inspection
src/capture/feed-content.js             isolated button and panel host
src/capture/feed-content.css            isolated control/anchor styling
src/capture/feed-panel.html             extension-owned review surface
src/capture/feed-panel.js               narrow review controller
src/capture/feed-panel.css              panel-specific shared-theme styling
src/background/feed-capture-routes.js   admission, job context, observer binding
src/background/feed-provider-access.js  permissions, registration, helper leases
test/capture/fixtures/feed-*.html        masked feed variants
scripts/verify-feed-capture.mjs          proposed integrated browser verifier
```

### 1. Pin feed contracts and owner-only detection

- Build minimal masked Garmin and Strava fixtures, including a verified owned
  Strava variant. Record which details are observed versus synthetic. Keep the
  original archives private and run the existing fixture privacy guard.
- Implement pure URL helpers and the two read-only DOM adapters. Cover owner,
  other user, unknown owner, duplicate/conflicting IDs, private activities,
  group/challenge posts, comments mentioning the viewer, and malicious links.
- Test virtualization, card reuse, duplicate rendering, sign-out/account change,
  and supported feed filter/SPA transitions. No network calls or live injection.
- Suggested subject: `feat: identify owned provider feed activities`.

### 2. Add bounded worker admission, extraction, and observation

- Implement feed-specific sender/capability checks and explicit response DTOs;
  retain the existing popup-only capture-control tests.
- Separate logical source and provider extraction targets at the smallest
  existing capture seam. Add helper leases, cancellation, restart/expiry
  reconciliation, and explicit feed lifecycle operations.
- Prove the source-tab bug cannot recur: helper closure after successful
  capture must leave ready results able to open drafts in the original window.
  Exercise helper adoption, late creation, feed closure, missing payloads,
  replay, other-tab access, source ID reuse, and existing toolbar capture.
- Keep these internals unreachable without a valid feed grant and activation.
- Suggested subject: `feat: coordinate feed captures with leased activity tabs`.

### 3. Build the inert feed button and protected review surface

- Implement idempotent insertion, scoped styles, anchor collision handling,
  accessible labels, state-stable controls, and detachment/account cleanup.
- Build the extension-owned panel with capability-bound attachment, real phase
  updates, selection/timestamp controls, meaningful errors, and draft reuse.
- Add a permission-backed integration control component for extension-owned UI;
  request permission directly from its native activation handler before an
  awaited preflight can consume browser user activation.
- Wire all new bundles/copied assets through
  [build configuration](../../scripts/build-config.mjs). Keep live registration
  and the advertised enablement controls off until step 4 is complete.
- Suggested subject: `feat: add activity feed export controls and review panel`.

### 4. Enable the complete opt-in integration and update contracts

- Declare the two optional origins, narrowly expose the panel assets, register
  the new packaged entry points on grants, and wire enable/disable controls in
  the popup, with a matching Settings location for later management.
- Provide immediate state feedback without shifting existing popup capture
  controls. Handle first enablement on an existing tab, denied or externally
  revoked permission, re-enable, browser update, and MV3 worker restart.
- Update [manifest tests](../../test/project/manifest-capture.test.mjs), worker
  boot/bundle checks, permission lifecycle tests, popup tests, and panel sender
  tests together. Required provider host access must remain absent.
- Update [Privacy](../../PRIVACY.md), [README](../../README.md),
  [architecture](../architecture.md), [development](../development.md), and
  [repository instructions](../../AGENTS.md), including their mirrored
  [Claude instructions](../../CLAUDE.md), to distinguish default toolbar-only
  access from optional persistent site access. Document helper cleanup,
  page-local ownership inspection, panel scope, expiry, and revocation.
- Suggested subject: `feat: enable optional garmin and strava feed export`.

### 5. Establish browser, packaging, and live proof

- Add the proposed feed verifier to the existing verification dispatcher and
  document its exact coverage. Reject unknown selectors and zero executed
  cases. Reuse fixture/certificate/process lifecycle helpers where appropriate.
- Exercise the real unpacked extension in Chrome and Firefox, including
  permission-backed registration, worker boot, MAIN-world extraction, the
  cross-origin review panel, and draft opening. Stubbing only a content
  script's final message does not prove these boundaries.
- Keep functional and geometry assertions separate. Require the transition
  matrix below and inspect representative intermediate/final screenshots.
- Verify final packages and retain separate native/live/store proof gaps.
  Record results and focused follow-up fix commits in this plan's ledger.
- Suggested subject: `test: verify provider feed export across browsers`.

## Acceptance and verification matrix

| Area | Required evidence before completion |
| --- | --- |
| Default installation | Neither provider grants access or receives injection until enabled; the original toolbar capture still works on activity pages. |
| Permissions | Independent services; denial, revocation, restart, update, and already-open feeds; disabling removes listeners/UI and unfinished provider work. No synchronized setting substitutes for a browser grant. |
| Ownership | Only owner-header identity matches get buttons. Unknown, conflicting, signed-out, group, sponsored, comment/mention-only, recycled, and account-switched cases fail closed. Detail-page ownership and edit checks precede all route reads. |
| Authority and privacy | Synthetic events, unauthorized frames, unbound panel embeds, caller-selected tabs/URLs, expired/replayed capabilities, and cross-tab/provider requests fail. No profile IDs or raw/reduced GPX reach feed messages, DOM, URL parameters, or logs. |
| Pipeline | One request per repeated click; explicit disposition of another retained capture; full summit lookup before results; existing time/waypoint/name preferences, rate limits, suffix ordering, and manual Save remain unchanged. |
| Helper lifecycle | Inactive creation in the correct window; wrong redirects, cancellation at every async stage, late arrival, adopted tabs, worker restart, expiry, and cleanup failures. Closing the extraction helper preserves ready results and draft creation. |
| Recovery | No GPS/no matches; both sign-outs; human check; rate-limit cooldown; slow or failed export; missing/expired payload; failed or uncertain draft opening; reopened panel and existing drafts without duplicate Preview or Save. |
| Layout | Idle → pending → results/error → retry/cancel → drafts, repeated updates, long names/errors, pointer and keyboard activation, light/dark, reduced motion, desktop and 390/320px layouts, enlarged text and 200% browser zoom. |
| Geometry and focus | Compare trigger position/size, owning card/heading, following native content, and document scroll before/during/after. Allow at most 1 CSS px rounding absent an explicitly documented disclosure. Check focused controls through busy transitions in both browsers, including inside the panel. |
| Native/provider behavior | Authenticated existing-profile Strava owned cards and Garmin feed, real export responses, SPA/filter/scroll behavior, browser permission prompts, helper focus/adoption, and manual keyboard/screen-reader behavior. Record these separately from hidden checks. |

Before UI implementation, confirm that the intended Chrome and Firefox surfaces
can load the actual extension and the masked feed fixture. Serve Peakbagger
fixtures over HTTPS on a real Peakbagger hostname with per-run certificates;
serve provider feed/detail fixtures at their actual HTTPS provider hosts and
intercept only the explicit test endpoints. Never contact production providers
from repeatable fixture tests. Keep worker leases and intermediate state updates
faithful to production instead of returning only final results.

Use isolated hidden browsers for automation, the approved Chrome execution path
and repository launch guard on macOS, condition-based waits, and reliable
teardown. Record browser/version, hidden or visible mode, viewport/text scale,
and renderer when graphics are involved. This feature does not need WebGL.
Check process command lines and exact disposable profile paths after teardown.
Live reproduction uses the existing authenticated profile without raising a
test window, stealing focus, mass-scraping, or automating human challenges.

Existing checks to run during implementation, scaled to each affected unit:

```sh
npm run build
node --test test/capture/provider-url.test.mjs test/capture/provider-page.test.mjs test/background/background-capture.test.mjs test/popup/popup.test.mjs test/project/manifest-capture.test.mjs
node --test test/project/documentation.test.mjs test/project/fixtures-privacy.test.mjs
npm test
npm run lint
npm run verify -- capture-flow
npm run verify -- draft-recovery
npm run verify -- browsers
git diff --check
```

Add the new feed suites to the focused checks; the list above names existing
commands only. Run the new integrated feed verifier in both browsers after its
dispatcher target exists. Packaging verification follows the repository's
current release workflow; this plan does not authorize signing or publication.

## Completion ledger and handoff

### Fixed and verified

- No feature implementation is complete. Planning verification is recorded
  below and must not be presented as shipped-feature evidence.

### Intentionally not changed

- Toolbar capture remains available without persistent provider access.
- Existing popup-only routes, Peakbagger sender authority, detail-page ownership
  gates, raw-GPX locality, capture privacy options, selection/order semantics,
  draft identity, exactly-once Preview, manual Save, and retention rules remain.
- No automatic export on scrolling, feed API harvesting, bulk export, provider
  subscription API integration, persistent export history, or cross-service
  duplicate detection is included. A retained session is not proof that an
  ascent was saved, or that a Garmin recording duplicates a Strava recording.
- Unrelated map, settings, and hover-card work in the checkout is outside this
  plan and must not be included in its implementation commits.

### Changed but not fully proven

- Documentation only: this plan and its active-plan index entry. Provider
  permissions, adapters, worker routes, helper context, injected controls,
  review panel, regression suites, and package changes are still unimplemented.
- The supplied Strava snapshot lacks an owned feed card. Its real owned-card
  insertion point, grouped activity variants, supported locale behavior, and
  live helper export readiness remain proof gaps. Garmin's existing English
  edit-control limitation remains; do not claim new locale coverage.
- Earlier hidden concept checks established simulated component appearance
  and geometry only. They did not test native permission prompts, live GPS
  exports, Firefox integration, worker suspension, real helper focus, screen
  readers, or store acceptance.

### Planning verification

- Before authoring: `node --test test/project/documentation.test.mjs` passed all
  3 tests. The working tree contained unrelated changes; none was included here.
- After authoring: `node --test test/project/documentation.test.mjs` passed all
  3 tests, including link/path validation for this plan and its index entry.
  `git diff --check` passed for the two-document unit, including its staged
  additions. Runtime and browser suites are deferred to implementation.

For implementation, replace the pending ledger entries with commit IDs, exact
commands/results, and remaining proof gaps as work finishes. Once implemented
or abandoned, archive the plan, preserve the ledger, and update the active-plan
index and maintained runtime documentation.
