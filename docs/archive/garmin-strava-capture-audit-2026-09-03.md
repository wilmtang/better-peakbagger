# Garmin/Strava capture reliability, performance, and UX audit — 2026-09-03

Status: **archived remediation record, closed 2026-09-07.** All ten findings
received implemented remediation and local verification. Measurement and live
compatibility gaps remain explicitly recorded below. The remediation preserves fail-closed ownership, the raw GPX
privacy boundary, complete summit lookup, generation cancellation, and manual
Peakbagger Save. Live providers and native browser chrome remain explicit proof
gaps in the closure ledger.

Baseline: clean local `main` at `c81eb331`, one commit ahead of `origin/main`.
The completed [2026-08-29 code/performance/UX audit](../archive/codebase-audit-2026-08-29.md)
was reconciled before reopening capture behavior. Its provider-operation
cancellation, cooperative analysis, and split capture-payload findings remain
closed. This plan addresses distinct current paths and the archived live-provider
proof gap.

## Scope and evidence

This is a capture-focused code audit, not a claim that every unrelated product
surface was re-audited. The review traced the toolbar transaction through:

- provider URL recognition, on-demand MAIN-world injection, DOM ownership
  evidence, GPX export, bounded response reads, and GPX parsing;
- Peakbagger helper-tab acquisition, account verification, corridor query
  construction, request retry/concurrency, summit matching, and session-backed
  job publication;
- popup status polling, error taxonomy, recovery actions, and draft opening;
- capture resource limits, privacy documentation, architecture contracts,
  provider/capture/popup tests, scale tests, and the hidden-browser verifier's
  stated coverage.

Audit-time evidence:

- `npm test`: **1,735 passed, 0 failed** after rebuilding all 29 bundles in
  `dist/`.
- `npm run test:scale`: **14 passed, 0 failed**. The 20,000-point full analysis
  took about 1.85 seconds, while the 20,000-point GPX parser case took about
  14.68 seconds and the point-limit-plus-one rejection took about 7.53 seconds
  in jsdom. Those timings are useful risk evidence, not browser performance
  budgets.
- `npm run lint`: passed. `web-ext lint` reported the eight maintained,
  repository-owned warnings documented by the lint wrapper.
- `node --test test/project/documentation.test.mjs`: **3 passed, 0 failed**,
  including resolution of the new plan index link.
- A deterministic built-bundle probe showed that current ownership inspection:
  1. accepted matching Strava athlete paths from `evil.example` as owned;
  2. accepted the first matching identity while a second candidate scope
     contained a contradictory identity; and
  3. threw `URIError: URI malformed` on a malformed Garmin profile escape.
- Static deadline tracing showed that the page adapter defaults its complete
  export operation to 30 seconds, but the worker abandons the encompassing
  `scripting.executeScript()` call after 20 seconds. The inner timeout therefore
  cannot be the terminal timeout on the real worker path.
- No live Garmin, Strava, or Peakbagger account request was made. No browser
  window was launched. Native toolbar `activeTab`, live provider DOM/export
  behavior, popup dismissal on tab creation, and actual anti-bot responses remain
  external proof gaps.

## Successful-capture contract and present failure surface

| Stage | Success requirement | Current failure modes that can block success |
| --- | --- | --- |
| Toolbar admission | active tab is a recognized provider activity and settings are readable | unsupported/broad Strava host match; settings read occurs before unsupported-page rejection |
| Provider ownership | stable viewer identity, matching author identity, owner-only edit affordance | SPA skeleton, changed selectors, localization, signed-out page, challenge page, contradictory or foreign identity links, malformed profile URL |
| Peakbagger session | canonical page helper loads and verifies one signed-in climber | tab load/connect failure, sign-out, Cloudflare challenge, unexpected page, rate limit |
| Provider export | authenticated GPX endpoint returns the requested activity's bounded GPX | 401/403/404/429/5xx, login/challenge redirect, 200 HTML/JSON interstitial, missing Garmin ambient session values, slow body, endpoint drift |
| Local parse | valid bounded GPX yields usable direct-owned trackpoints | malformed/empty GPX, legal large input exhausting the outer deadline, main-thread stall |
| Summit lookup | every corridor box succeeds before matching | up to four requests per capture and unbounded cross-tab fan-out, immediate retry after a limit, timeout, partial failure, challenge |
| Recovery | the primary action removes the actual blocker and the next toolbar click re-evaluates it | generic Retry for non-retryable failures, tab-opening action dismisses popup, cached terminal error returned for up to 30 minutes |

## Anti-bot boundary: detect, stop, and recover; never evade

The safe goal is not to make automation look less automated. It is to detect a
provider or Peakbagger refusal accurately, stop adding traffic, and put the user
on the first-party page that can restore the ordinary browser session.

Cloudflare documents `cf-mitigated: challenge` as the response marker for a
Challenge Page and states that the response content type is `text/html`, even
when the requested resource was not HTML. It also warns that interstitial
Challenge Pages break fetch/XHR flows that expect a non-HTML response. See
[Detect a Challenge Page response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)
and [Interstitial Challenge Pages](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/).
The current provider adapter checks neither marker before treating a response as
GPX.

Strava's documented API returns HTTP 429 when its request limit is exceeded and
recommends throttling rather than continuing the burst. That documentation does
not establish limits or contracts for the private website export endpoint used
here, but it does reinforce that 429 is a stop/cooldown signal, not an immediate
retry signal. See [Strava API rate limits](https://developers.strava.com/docs/rate-limits/).

Garmin's supported Connect Developer Program uses OAuth 2.0 and is restricted to
business use. Replacing the page adapter with an official API is therefore a
separate product/access decision, not a small engineering fix. See the
[Garmin Connect Developer Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/).

Do not add CAPTCHA solving, clearance-cookie copying, user-agent spoofing,
proxy/identity rotation, hidden login automation, or repeated probing. Recovery
must use the user's normal first-party tab and ordinary provider controls.

## Priority summary

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| F1 | P1 | ownership trust | foreign, contradictory, and malformed profile links violate the fail-closed provider-identity contract |
| F2 | P1 | ownership readiness | a single immediate DOM snapshot turns ordinary SPA loading or compatible localized markup into a terminal capture failure |
| F3 | P1 | provider response | auth, challenge, rate-limit, endpoint, and no-GPS outcomes collapse into generic export failure or false no-GPS |
| F4 | P1 | deadline ownership | the worker's 20-second wrapper preempts the provider's 30-second fetch/read/parse deadline and can reject legal inputs |
| F5 | P1 | anti-bot/load control | four-way concurrency is per capture, cross-tab fan-out is unbounded, and every transient response including 429 is retried immediately |
| F6 | P2 | recovery lifecycle | reopening the popup after sign-in, reload, or a human check can return the cached failure without re-evaluating the page |
| F7 | P2 | failure UX/engineering | error policy is duplicated across three layers and gives the same Retry action to waiting, reload, split-track, blocked, and terminal failures |
| F8 | P2 | progress UX | phase labels describe the wrong work and expose no bounded progress during the longest lookup stage |
| F9 | P2 | page performance | accepted GPX is synchronously materialized and walked in the provider MAIN world without a browser responsiveness budget |
| F10 | P3 | speed/compatibility assurance | the critical path has no component timings or live-shaped provider corpus, so optimization and provider drift are detected by users first |

P1 means a capture can be authorized from invalid evidence, blocked despite a
recoverable valid activity, mislabeled in a way that defeats recovery, timed out
by contradictory budgets, or driven into a request pattern that aggravates a
limit. P2 is bounded but material failure UX, responsiveness, or engineering
debt. P3 is measurement-gated optimization debt without evidence that a proposed
optimization is safe or faster.

---

## F1 — Validate the origin and the complete identity evidence set

**Broken invariant.** Ownership must be proven only by consistent profile
identities from the expected provider. Malformed or contradictory evidence must
produce a typed fail-closed verdict, never a thrown page exception or a positive
ownership decision.

**Evidence.** `profileId()` resolves a link against the page but validates only
its path, not its origin, in `src/capture/provider-page.js` (lines 29–39).
`firstScopeWithOneId()` returns the first selector scope containing one ID and
does not examine later candidate scopes for contradiction at lines 41–57.
Garmin's non-numeric profile pattern feeds arbitrary percent escapes directly to
`decodeURIComponent()`. `inspectOwnership()` then accepts the selected viewer
and author pair plus the edit affordance at lines 70–107. The built-bundle probe
reproduced all three counterexamples recorded in the audit evidence above.

`providerFromUrl()` separately accepts any Strava subdomain whose path happens
to match `/activities/<id>` in `src/capture/provider-url.js` (lines 8–26), while
the export endpoint is later constructed as a relative website URL. Recognition
and export hosts therefore do not share one verified allowlist.

**Remediation.** Give each provider one pure, shared host/profile policy. Accept
only explicitly supported activity hosts and same-provider profile origins.
Decode profile IDs inside a non-throwing normalizer. Aggregate evidence from the
relevant selector tier and require exactly one consistent viewer ID and one
consistent author ID; contradictory evidence is `ownership-unverified`. Keep
the owner-only edit control as independent corroboration and continue narrowing
the reply through `publicOwnership()` so profile IDs never reach the worker.

**Regression proof.** Add provider cases for foreign absolute links,
protocol-relative links, unsupported Strava subdomains, contradictory scopes,
duplicate identical links, malformed escapes, mixed case, encoded valid Garmin
IDs, and navigation during inspection. Positive fixtures must still require a
matching owner and exact activity-specific edit affordance.

## F2 — Wait for a stable provider ownership outcome, not one SPA snapshot

**Broken invariant.** Clicking capture on a valid owned activity must tolerate
the provider's bounded client-side render time without weakening ownership.
Loading or challenge UI must not be mislabeled as a permanent inability to prove
ownership.

**Evidence.** After injection, `processCapture()` invokes
`inspectProviderOwnership()` exactly once and treats every incomplete verdict as
terminal in `src/background/background.js` (lines 1376–1404). The page adapter
has no readiness state, observer, retry, or stable-document generation in
`src/capture/provider-page.js` (lines 70–108). An activity URL can be complete
while a React header, author card, edit menu, sign-in redirect, or challenge is
still settling. The maintained architecture already admits that English-only
Garmin edit text and provider markup are compatibility limits in
`docs/architecture.md` (lines 386–395).

**Remediation.** Add a generation-owned `waitForOwnership(expectedActivity,
signal, deadline)` page API. Observe only the bounded provider roots needed for
identity/edit evidence, re-check exact activity identity on every turn, and
finish on one of: consistent owned, definite not-owner, definite signed-out,
recognized human check, activity changed, or readiness deadline. Do not use a
fixed sleep. Treat incomplete DOM as `provider-page-not-ready` only after the
deadline, with reload/wait copy; keep contradictory completed evidence distinct.
Prefer stable href, test ID, role, and activity identity over English text.

**Regression proof.** Build staged fixtures that add viewer, author, and edit
evidence over separate tasks; remove or contradict them mid-wait; navigate the
SPA; cancel; close the tab; and never become ready. Prove that no GPX or
Peakbagger coordinate request starts before the positive ownership result.
Include non-English accessible labels when stable non-text evidence exists, but
do not accept a translated guess by text alone.

## F3 — Classify provider export responses before parsing them as GPX

**Broken invariant.** A failed capture must name the category that determines
the next safe action. “No GPS” must mean the provider successfully established
that no route exists; it must not also mean endpoint drift, auth concealment, or
a blocked request.

**Evidence.** The provider fetch follows redirects but never validates the final
URL or response content type in `src/capture/provider-page.js` (lines 201–221).
HTTP 204 and 404 are both converted to `no-gps-data`; every other non-2xx status
throws before any bounded challenge probe; and a 200 login, JSON error, or HTML
challenge reaches the XML parser at lines 222–249. The catch then reduces every
remaining cause to only no-GPS, too-large, timeout, cancellation, or generic
export failure at lines 250–268. The tests explicitly pin 404 to no-GPS and 503
to copy that hides the status in `test/capture/provider-page.test.mjs` (lines
230–242 and 315–334).

This means anti-bot can currently appear as:

- `ownership-unverified` when the top-level activity itself is a challenge;
- generic `provider-export-failed` for 401, 403, 429, 5xx, login redirect, 200
  challenge HTML, or unexpected JSON;
- `no-gps-data` for a 404 caused by endpoint or authorization behavior; or
- `provider-page-timeout` when a challenge or body stalls past the outer worker
  deadline.

**Remediation.** Introduce a pure provider-response classifier, separate from
raw exception text. Validate final URL, status, `content-type`, documented
challenge headers, and a small bounded/cancelled prefix only when needed.
Return an allowlisted taxonomy such as `provider-signed-out`,
`provider-human-check`, `provider-rate-limited`, `provider-forbidden`,
`provider-unavailable`, `provider-response-changed`, `no-gps-data`, and
`invalid-gpx`. Carry only bounded safe metadata such as provider, status class,
and a validated retry time; never body text, headers wholesale, cookies, or
profile IDs. Confirm each provider's actual 404/no-route behavior before keeping
404 in the no-GPS category.

**Regression proof.** For Garmin and Strava separately, cover 204, 401, 403 with
and without `cf-mitigated: challenge`, 404, 429 with valid/invalid retry hints,
5xx, cross-origin and sign-in redirects, 200 HTML, 200 JSON, empty 200, malformed
GPX, valid trackless GPX, and a valid GPX response. Assert bounded body reads,
socket cancellation, no raw response leakage, and one stable worker/popup code
per case.

## F4 — Give the provider transaction one coherent monotonic deadline

**Broken invariant.** The documented timeout and error category must be owned by
the operation that can actually reach it. A legal input must not lose most of
its network budget to synchronous parsing hidden inside a shorter outer wrapper.

**Evidence.** `PROVIDER_OPERATION_TIMEOUT_MS` is 20 seconds in
`src/background/background.js` (lines 52–55). `captureProvider()` wraps the
entire page call—fetch, body read, DOM identity rechecks, XML parse, metadata
scan, and structured-clone result—in that deadline at lines 1099–1131. It passes
`undefined` as the adapter timeout, selecting the 30-second
`PROVIDER_TIMEOUT_MS` in `src/capture/provider-page.js` (lines 23–27 and
201–220). The page's `provider-export-timeout` therefore loses to the worker's
earlier generic `provider-page-timeout` on the production route.

The scale parser accepted 20,000 points but took about 14.68 seconds in jsdom.
That is not a Chrome/Firefox measurement, but it shows why an outer 20-second
envelope that also includes the network and clone cannot be assumed safe.

**Remediation.** Define one capture-operation budget with explicit sub-budgets
for browser dispatch, provider response, bounded body read, parse/extraction,
and result transfer. Pass the remaining monotonic budget into the page API so
the inner owner settles first with the accurate code; leave a small outer
cleanup margin rather than making the outer limit shorter. Distinguish renderer
unresponsive from provider response timeout. Keep cancellation independent of
the timeout and preserve late-result suppression.

**Regression proof.** With fake monotonic clocks, exercise completion just below
and above each boundary, especially 20–30 seconds; stalled fetch, stalled stream,
slow parse, slow structured result, caller cancellation, and an ignored abort.
Assert exactly one public terminal code, prompt socket abort, no late job
resurrection, and no timer leak. Measure the accepted 20,000-point path in real
hidden Chrome and Firefox before selecting final budgets.

## F5 — Coordinate Peakbagger traffic across captures and respect stop signals

**Broken invariant.** A user-triggered interactive client must not amplify an
outage, rate limit, or human check. Concurrency limits must apply to the origin,
not independently to every activity tab.

**Evidence.** Each `fetchPeaks()` creates its own four-runner pool in
`src/background/background.js` (lines 992–1017). Capture admission and active
process ownership are keyed only by source tab at lines 73–79 and 1536–1604, so
several tabs can each send four simultaneous Peakbagger requests. `fetchBox()`
retries every `transient` result immediately at lines 960–989. The page response
mapping calls both rate limits and ordinary network/server failures transient in
the same file at lines 733–746. A 429 can therefore produce another immediate
request, while other captures continue their own pools.

This is both an anti-bot risk and a speed/reliability problem: one late failure
discards the otherwise complete lookup, and a repeated burst makes the next
attempt less likely to succeed. It conflicts with README's promise to stop or
pause for rate limits and human checks.

**Remediation.** Add one fair, cancellation-aware Peakbagger request scheduler
owned by the worker. Cap aggregate corridor concurrency across all captures.
Stop the origin queue immediately on a human check or 429, cancel sibling work,
and retain a bounded `storage.session` cooldown when a validated retry time is
available so another tab cannot resume the burst. Retry only idempotent network
or selected 5xx failures with bounded exponential delay and jitter inside the
same total deadline; never automatically retry auth, challenge, forbidden,
unexpected-content, or 429. Preserve all-or-nothing summit results.

Measure before changing the four-request single-capture cap. After correctness,
consider safe exact-box de-duplication across simultaneous captures or merging
heavily overlapping boxes only if response-equivalence and maximum queried area
are pinned; never trade completeness or disclose a wider corridor merely to save
a request.

**Regression proof.** Start several captures in different tabs and assert the
aggregate in-flight ceiling, fair progress, per-generation cancellation, and no
cross-account/tab result reuse. Inject 429, challenge, 403, network, and 5xx at
every runner position. A rate limit must make exactly one terminal decision,
cancel queued siblings, publish one cooldown, and perform no automatic retry.
Advance a fake clock through cooldown and prove an explicit later user action can
resume.

## F6 — Re-evaluate recoverable failures on the next toolbar gesture

**Broken invariant.** After the user follows a recovery instruction and clicks
Better Peakbagger again, that new gesture must check whether the blocker is gone.
It must not replay a stale failure and require an unexplained second click.

**Evidence.** `admitCapture()` reuses every fresh terminal job for the same
activity and settings when `force` is false in `src/background/background.js`
(lines 1564–1574). Error, no-GPS, and no-match jobs receive the same 30-minute
TTL as successful data. The popup always starts with `beginCapture(false)` at
`popup/popup.js` (lines 430–443). Its sign-in and human-check actions create a
new tab at lines 83–149; a native browser-action popup ordinarily closes when
that tab receives focus. Reopening the popup can therefore redisplay the cached
error instead of verifying the repaired session. The jsdom popup tests can click
both buttons without modeling native popup dismissal.

**Remediation.** Reuse successful `ready`/opened states, not recoverable error
verdicts. On a new toolbar gesture, re-evaluate signed-out, challenge-completed,
page-not-ready, connection, response-changed, and transient network failures.
Keep rate-limit cooldown authoritative and avoid an automatic request while it
is active. Decide no-GPS/no-match freshness separately: these may be cached
briefly, but the primary **Check again** action must remain explicit and force a
new provider read. Copy for actions that leave the popup must say what happens
next: complete the first-party step, return to the activity, and click Better
Peakbagger again.

If a temporary Peakbagger helper already contains the actionable challenge,
prefer safely transferring/adopting and focusing that exact leased tab over
closing it and opening a duplicate. Never focus or close a user-owned tab based
on an unresolved lease.

**Regression proof.** Seed each terminal class, close/reopen the popup, and
assert which states are reused, re-evaluated, or cooldown-blocked. Add a real
dedicated-profile native popup check for the tab-opening dismissal flow; a
standalone extension page is not proof. Cover adopted helper tabs, source-tab
navigation, worker restart, and 30-minute expiry.

## F7 — Centralize error policy and give each failure one useful primary action

**Broken invariant.** The primary action must address the stated cause. Retrying
immediately is harmful or futile for a rate limit, human check, sign-out,
not-owner result, oversized/fragmented track, or provider-response change.

**Evidence.** Provider-page codes/copy live in
`src/capture/provider-page.js` (lines 23–27 and 250–268), worker translations in
`src/background/background.js` (lines 1387–1403 and 1440–1475), and popup title
and action selection in `popup/popup.js` (lines 88–160). Most codes fall through
to **Capture stopped** plus **Try again**, including `activity-changed`,
`ownership-unverified`, `provider-page-timeout`, `capture-timeout`,
`gpx-too-large`, `track-too-large`, `capture-analysis-too-large`,
`peak-response-too-large`, and rate limiting. Tests cover the Peakbagger human
check and two transport errors, but not an exhaustive code/action contract in
`test/popup/popup.test.mjs` (lines 787–893).

**Remediation.** Create one pure, allowlisted capture error policy shared by the
page adapter, worker, and popup bundle. Each code owns a safe title, explanation,
retry safety, and recovery kind—not a callback or privileged URL. The worker
remains the boundary that discards raw exceptions; the popup turns recovery
kinds into exact first-party actions.

At minimum distinguish:

| Cause | Primary action |
| --- | --- |
| provider page still loading / adapter unavailable | Reload activity, then re-check |
| provider signed out | Open provider sign-in/activity; explain return gesture |
| provider or Peakbagger human check | Open the exact first-party page; no background retry |
| rate limit with/without retry time | Wait until stated time; suppress immediate Retry |
| transient network/server error | Try again |
| response/endpoint changed | Open activity and offer concise issue-report/help path; do not imply repetition will fix it |
| no GPS | Explain manual activities/provider processing and offer Check again |
| too large/fragmented/dense | Explain the exact limit and a manual shorter-GPX route; no blind Retry |
| not owner | No capture action |

Keep one obvious primary action, make secondary choices genuinely different,
and do not display HTTP bodies, browser messaging errors, selector names, or
anti-bot implementation details.

**Regression proof.** Enumerate every public capture code in one test and fail
when any code lacks a title, message, retry policy, and permitted recovery kind.
Render every action family at 390×620 in light/dark and 200% text zoom; assert no
overflow, clipping, or duplicate primary action. Verify keyboard order, visible
focus, `aria-live`/alert semantics, and focus recovery after an in-popup retry.
Actual screen-reader speech remains manual evidence.

## F8 — Report the work actually in progress and bounded lookup progress

**Broken invariant.** Progress copy should let a user distinguish provider
loading, track download, local processing, and Peakbagger lookup. A long but
healthy capture must not look stuck on the wrong service.

**Evidence.** The job remains `checking-peakbagger` after login and throughout
`captureProvider()` in `src/background/background.js` (lines 1406–1478). Only
after the GPX is already fetched and parsed does it switch to `analyzing`. The
popup labels `analyzing` as “Reading the track” in `popup/popup.js` (lines
162–168). Corridor lookup then exposes only the undifferentiated
`finding-peaks` phase even though the box count can range from one to 64.

**Remediation.** Use truthful stable phases: validating activity, waiting for
provider page, verifying ownership, checking Peakbagger, exporting GPX,
processing track, searching summit areas, and preparing results. Expose only
coarse bounded progress such as completed/total corridor areas; throttle session
metadata writes so status UI does not create one storage write per response.
Retain the failed stage with the terminal error so support copy can distinguish
provider, local parse, and Peakbagger failures without telemetry.

**Regression proof.** Hold each async boundary and assert the visible phase,
then release it and assert monotonic transitions. Complete corridor requests out
of order and verify monotonic bounded progress with a stated maximum storage
write count. Cancellation and error must stop progress immediately; a late
response must not move a terminal card backward.

## F9 — Bound provider-page parse responsiveness, not only input size

**Broken invariant.** A GPX that is inside the byte/point contract must not freeze
the provider tab long enough to defeat Cancel, the outer deadline, or normal page
interaction.

**Evidence.** `readBoundedResponseText()` accumulates the complete decoded string
before parsing in `src/net/bounded-text.js` (lines 24–61 and 114–131).
`parseGpxData()` synchronously builds a full XML DOM, scans it for parser errors,
allocates direct-child arrays, and maps all points in
`src/gpx/gpx-parse.js` (lines 18–27 and 94–146). The provider adapter executes
that work in the activity page's MAIN world and then scans broad DOM text for
metadata in `src/capture/provider-page.js` (lines 153–184 and 229–249).

The scale suite proves completeness, but explicitly uses jsdom and has no event
loop, frame-gap, memory, or cancellation budget. Its current 14.68-second legal
parse and 7.53-second reject-after-full-DOM timings are warnings, not estimates
of native browser speed.

**Remediation.** First measure native DOMParser, extraction, peak transfer, peak
memory, and animation-frame gaps for representative and limit inputs in hidden
Chrome/Firefox. Preflight declared bytes and reject certainly excessive
structure before DOM construction. If native budgets fail, replace full-DOM
materialization with a bounded incremental GPX reader or another page-local
parser that preserves namespace handling, direct GPX ownership, segment breaks,
strict numeric/time parsing, waypoint/name allowlists, and cancellation. Do not
move source XML into the worker, an offscreen document, persistent storage, or a
remote service. Narrow Garmin metadata queries instead of reading all
`main.textContent`.

**Regression proof.** Keep exact parser-result parity for the existing corpus,
nested fake geometry, namespaces, malformed XML, partial numeric/time data,
point/segment/waypoint limits, and privacy exclusions. Add real-browser budgets
for representative 1k/5k/20k tracks, limit-plus-one early rejection, maximum
event-loop gap, peak heap where observable, and cancellation latency. Report
browser, version, viewport, hidden state, and hardware; do not promote jsdom
timings to product guarantees.

## F10 — Measure the critical path and maintain live-shaped provider contracts

**Broken invariant.** Capture speed and compatibility work must be guided by the
actual dominant stage and current provider shapes. A synthetically faster code
path is not an improvement if it weakens ownership, widens data access, or merely
moves time into a hidden stage.

**Evidence.** Admission reads capture settings before rejecting an unsupported
URL in `src/background/background.js` (lines 1545–1563). The popup waits for its
own settings read before sending capture start in `popup/popup.js` (lines
430–443), while the worker reads settings again as the authoritative privacy
gate. Provider ownership is scanned once by the worker and three more times
inside the capture call around the body read in
`src/capture/provider-page.js` (lines 201–239). Up to 64 corridor boxes each
cross a separate `scripting.executeScript()` bridge in
`src/background/background.js` (lines 817–869 and 1011–1017). None of these
components has a native-browser timing breakdown.

The provider tests use small hand-authored DOM strings and mocked responses in
`test/capture/provider-page.test.mjs`. The hidden extension verifier exercises
the Peakbagger page bridge and seeded post-capture state, but explicitly leaves
the native toolbar `activeTab` grant and live provider behavior manual in
`scripts/verify-extension.mjs` (lines 5405–5409) and
`docs/development.md` (lines 598–611).

**Remediation.** Add local diagnostic timing hooks—not telemetry—for admission,
settings, injection, ownership readiness, Peakbagger account check, provider
headers/body/parse, box construction, corridor network/bridge time, matching,
reduction, storage, and popup-to-ready time. Record only durations/counts in test
output; never provider identity, coordinates, URLs, GPX, or response bodies.

Use those measurements to evaluate, in order:

1. reject unsupported pages before the authoritative settings read while still
   requiring settings before any injection or capture;
2. begin popup admission as soon as the active tab is known while resolving
   display units before any results render;
3. replace repeated broad ownership scans with a stable document/activity
   generation plus the minimum independent checks needed before and after the
   body read;
4. probe/reuse a versioned provider helper only when it is measurably faster than
   reinjection and cannot retain a stale activity generation;
5. batch a small bounded set of allowlisted Peakbagger box requests per page
   bridge only if aggregate response bytes, cancellation, failure attribution,
   and the origin-wide scheduler remain bounded; and
6. consider overlapping Peakbagger login with provider export only as an
   explicit privacy/product decision. Current architecture intentionally checks
   Peakbagger before asking the provider for coordinates, so this is not an
   audit-authorized shortcut.

Maintain a sanitized, secret-free provider contract corpus: loading skeleton,
owned/non-owned/signed-out activity, SPA navigation, localized variants where
structural evidence is known, Garmin session-mode variants, response status and
redirect shapes, and anti-bot markers. Store no cookies, tokens, real profile
IDs, private GPX, or verbatim personal page dumps. Stamp the last minimal live
read-only verification date separately for Chrome and Firefox.

**Regression proof.** Add deterministic latency composition tests plus hidden
real-browser provider-shaped HTTPS fixtures. Set budgets only after measuring the
current median and slow-path distribution; require a material improvement in
the targeted component and no regression in ownership/privacy/result parity.
Keep a separately authorized, minimal, rate-limited manual live check for each
provider and browser family. A fixture pass does not prove live selectors,
exports, challenges, or native toolbar permission behavior.

## Implementation sequence and commit boundaries

Each numbered item is an independently verified commit unless implementation
reveals an inseparable invariant. Do not bundle unrelated refactors.

1. **Provider trust — F1.** Centralize exact provider/activity/profile host rules,
   non-throwing identity normalization, and complete evidence aggregation.
2. **Provider readiness — F2.** Add the generation-owned readiness observer and
   terminal ownership states without starting coordinate work early.
3. **Provider failure semantics — F3, then F7.** Classify bounded response
   outcomes first; once codes are stable, centralize public copy and recovery
   kinds across page, worker, and popup.
4. **Deadline and page CPU — F4, then F9.** Establish native parse measurements,
   give the provider operation one deadline, and change parser architecture only
   if the measured browser budget requires it.
5. **Origin traffic ownership — F5.** Add the global Peakbagger scheduler,
   cooldown, and retry policy without weakening complete lookup.
6. **Recovery and progress — F6, then F8.** Make new toolbar gestures re-evaluate
   recoverable failures, then expose truthful phase/progress state with bounded
   storage writes.
7. **Measured speed and provider assurance — F10.** Add diagnostic timings and
   the sanitized provider corpus before accepting any bridge batching, helper
   reuse, scan reduction, or critical-path overlap.
8. Update `docs/architecture.md`, `docs/development.md`, `PRIVACY.md`, and README
   only for behavior that actually ships. Complete the closure ledger, move this
   plan to `docs/archive/`, and remove its active index entry in the final
   documentation commit.

## Verification matrix

`npm test` rebuilds `dist/`; directly running bundled provider or popup tests
without a fresh build can exercise stale code.

| Findings | Required proof | Still not proven |
| --- | --- | --- |
| F1–F3 | provider bundle tests against the full identity/readiness/response matrix; no provider network | current live provider DOM, response, or localization |
| F4, F9 | fake-clock deadline permutations, `npm run test:scale`, hidden native Chrome/Firefox parse and event-loop budgets | slower devices outside the measured matrix |
| F5 | cross-tab scheduler interleavings, request counts, cooldown clocks, cancellation, all-or-nothing results | future Peakbagger policy or production load |
| F6–F8 | exhaustive error-policy tests, popup close/reopen behavior, 390×620 light/dark/200% visual inspection | native popup lifecycle unless run visibly in a dedicated profile; screen-reader speech |
| F10 | sanitized HTTPS provider-shaped fixtures, component timing output, exact before/after comparison | live Garmin/Strava, native `activeTab`, real challenge passage |
| bundle/worker/manifest changes | `npm run verify:browsers` in hidden isolated profiles, with exact versions/viewports and teardown inspection | native focus, permission UI, store acceptance |
| all | nearest focused tests, `npm test`, `npm run lint`, `git diff --check` | legal approval or provider endorsement |

Live checks must remain minimal, read-only, rate-limited, and separately
authorized. If a provider presents a CAPTCHA or managed challenge, stop and let
the user complete it normally; do not automate or weaken it. Report whether
verification was hidden or visible and every surface that remained uninspected.

## Investigated and not reopened

- Raw provider XML still stays on the provider page. Only allowlisted parsed
  analysis fields reach the worker, and only a newly serialized reduced GPX can
  reach Peakbagger Preview after the user's selection.
- Settings remain an authoritative fail-closed privacy gate before provider
  injection. F10 may move the unsupported-URL rejection earlier, not move data
  access before settings.
- Provider and Peakbagger browser operations retain generation cancellation,
  explicit bounds, late-result suppression, and helper-tab leases from the
  completed 2026-08-29 audit. F4 concerns contradictory deadline ownership, not
  a return to unbounded calls.
- Capture analysis remains cooperative and spatially indexed, and immutable GPX
  payloads remain separated from mutable job metadata. Current unit and scale
  gates passed.
- Every corridor request must still complete before results appear. Partial
  summit responses are not “no peaks.” F5 changes traffic ownership, not result
  completeness.
- The Peakbagger page helper remains a narrow login/summit-box transport and
  correctly recognizes its current 403 Cloudflare marker. It must not become a
  general fetch bridge.
- No persistent Garmin/Strava host permission, cookie-reading permission,
  official API migration, automatic capture, or server-side activity copy is
  proposed.
- Draft identity checks, exactly-once Preview, selection lock, and user-owned
  final Save remain unchanged.

## Closure ledger

Preserve all three categories during remediation and in the archived handoff. A
green fixture is not proof of current live provider compatibility.

### Fixed and verified

- **F1 — provider identity trust** (`1eb0f66`): exact activity/profile host
  allowlists, non-throwing identity normalization, and complete contradictory
  evidence rejection are covered by provider URL/page bundle tests.
- **F2 — provider readiness** (`27c141f`): a generation-owned eight-second DOM
  observer accepts staged ownership only after all evidence exists and returns
  distinct signed-out, human-check, navigation, cancellation, and timeout
  outcomes. Tests prove no export begins before approval.
- **F3 — provider response semantics** (`af279f7`): final URL, status, content
  type, documented challenge marker, bounded prefix, and validated retry time
  produce allowlisted public codes without response leakage. Garmin and Strava
  response matrices pass.
- **F4 — deadline ownership** (`41bcfa0`): the page owns the 30-second
  fetch/read/parse/result deadline and the worker adds a two-second dispatch
  margin. Fake-clock tests pin timeout and cancellation precedence.
- **F5 — Peakbagger traffic ownership** (`72fac97`): one FIFO scheduler caps
  requests at four across activity tabs, aborts siblings on challenge/rate
  limit, persists a validated cooldown, and retries only network/server failure
  once. Cross-tab, restart, fake-clock, and cancellation tests pass.
- **F6 — recovery lifecycle** (`7be1c18`): new toolbar gestures re-evaluate
  errors, explicit no-GPS/no-match checks can force refresh, cooldown cannot be
  bypassed, and an exact validated helper challenge can be adopted/focused.
- **F7 — shared failure UX** (`c07ffea`): every public code has one shared
  title, message, retry policy, and permitted recovery kind; worker exceptions
  remain bounded and popup action-family tests are exhaustive.
- **F8 — truthful progress** (`a904a8e`): stable phase names, failed-stage
  retention, and decile-throttled completed/total summit-area progress are
  covered across held async boundaries and bounded session writes.
- **F9 — provider parse responsiveness** (`eeef6ce`): structural preflight
  rejects over-limit GPX before DOM construction. Hidden Chrome for Testing
  151.0.7922.34 measured 1k/5k/20k parses at 6.7/15.3/60.4 ms and rejection at
  2.8 ms; hidden Firefox 153.0 measured 5/15/61 ms and rejection at 2 ms, all
  at 1280×720.
- **F10 — measured startup and provider assurance** (`12fe594`): unsupported
  tabs bypass settings I/O; popup admission starts while display units resolve
  but result paint waits for those units. Opt-in diagnostics accept only
  allowlisted local durations/counts and never persist. Sanitized, intercepted
  HTTPS provider contracts pass in hidden Chrome for Testing 151.0.7922.34 and
  Firefox 153.0 at 1280×720, covering ownership, localization, SPA navigation,
  Garmin session mode, redirects, challenge, rate limit, and no-GPS.
- **Failure layout accessibility** (`30b1d56`): all eight recovery families fit
  their policy-owned action (or no action for wait/terminal cases) with no clipping in hidden Chrome for Testing 151.0.7922.34 and
  Firefox 153.0 at a 390×620 physical viewport, light/dark, and a 195×310 CSS
  viewport rendered at 2x scale for 200% zoom. Representative screenshots were
  visually inspected; the primary action remains above the fold.
- Final repository gates passed: `npm test` **1,809/1,809**; `npm run
  test:scale` **14/14**; `npm run lint` with the eight maintained owned
  warnings; documentation/development tests **20/20**; and `git diff --check`.
  `npm run verify:browsers` passed against the real unpacked extension in hidden
  Chrome for Testing 151.0.7922.34 (new headless, 1000×760) and hidden Firefox
  155.0 (1000×760). Verifier-owned processes and disposable artifacts were
  checked after completion.

### Intentionally not changed

- Ownership still rechecks before and after the provider body read. A stable
  document-generation shortcut was not adopted without live drift evidence.
- Provider helper reuse and Peakbagger box batching/merging were not adopted:
  the measured fixture path did not justify stale-generation, attribution,
  response-size, cancellation, wider-corridor, or completeness risk.
- Peakbagger login still completes before provider coordinate export. Overlap
  would change the documented privacy order and needs a separate product choice.
- No persistent provider permission, cookie access, official API migration,
  CAPTCHA automation, clearance-cookie copying, user-agent spoofing, proxy
  rotation, or background login automation was added.
- The committed provider verifiers intercept all network requests. An earlier
  exploratory hidden-page navigation reached a Strava activity URL; it did not
  establish authenticated capture or live compatibility. No account mutation,
  push, tag, store submission, or release was performed.

### Changed but not fully proven

- Current live Garmin/Strava DOM, localization, authenticated export endpoints,
  and real provider/Peakbagger challenge or rate-limit responses remain
  unverified. The secret-free corpus is compatibility regression evidence, not
  live-provider proof; its live-check stamps remain "not performed" for both
  browser families on 2026-09-03.
- The hidden real-extension gates do not prove the native toolbar `activeTab`
  grant, popup dismissal/focus/browser chrome, permission prompts, or a user's
  completion of a human check. The popup content was visually inspected as an
  ordinary hidden page, not as native popup chrome.
- Screen-reader speech, physical devices, slower hardware outside the measured
  parser matrix, production network/load distribution, future provider policy,
  store acceptance, legal review, and provider endorsement remain unproven.
- F9's native gate measures synchronous parse/extraction wall time and early
  rejection. Native animation-frame gaps, peak heap, structured-clone cost, and
  renderer cancellation latency were not separately measured; the synchronous
  parser cannot interrupt itself mid-parse. Those measurements remain follow-up
  evidence before replacing the bounded DOM parser.
- F10's duration hooks and fixture timings do not establish a production median,
  tail distribution, or end-to-end speedup. Admission ordering is proven by
  deferred-settings tests; corridor timing combines queue, bridge, and network
  work. Further optimizations still require comparative measurements.
