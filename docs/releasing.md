# Browser store releases

Pushing an exact `vMAJOR.MINOR.PATCH` tag starts `.github/workflows/release.yml`.
Manually dispatching that workflow runs a read-only rehearsal. Both store jobs
require a tag push and are skipped on every manual dispatch, even one on a tag.
The workflow verifies separate Firefox and Chrome packages, then submits that
version independently to the Chrome Web Store and Firefox Add-ons (AMO). The
canonical Chrome package opens settings in a full tab; the Firefox package
differs only by keeping settings inline in the Add-ons Manager. Store
review is asynchronous; a successful workflow means both stores accepted the
submissions, not that review has completed.

A store version cannot be reused. Manual dispatches therefore stop at
verification; publishing an arbitrary branch or replaying a successful store
mutation would create an avoidable partial-release failure.

## Rehearse before tagging

Before starting the expensive checks, run:

```sh
npm run release:readiness -- --previous-tag vPREVIOUS.VERSION.HERE
# Once per candidate, when public-service connectivity can be checked:
npm run release:readiness -- --previous-tag vPREVIOUS.VERSION.HERE --online
```

Use the actual previous store release tag. The maintained copy in
`store-assets/release-readiness.json` must cover every manifest permission.
The report flags new permissions and prepares their justifications; it cannot
check saved Chrome fields or authenticate a dashboard session. Sign in to both
developer dashboards before the long rehearsal. After the verified package is
uploaded, explicitly check its version and Google's missing-requirements panel
before publication; new permission fields can appear only after upload.

The optional online check makes three bounded public-link requests and one
synthetic tile request each for public lands and slope. It checks PNG structure
and response CORS headers, never a user's coordinates or activity. It does not
establish browser CORS enforcement, map rendering, dashboard login or Google's
URL acceptance. A local HTTP 200 did not establish Google's acceptance during
the 4.1.0 release. Do not repeat live probes in every browser repetition.

After the release metadata is merged and main CI passes, run:

```bash
gh workflow run release.yml --ref main -f ci_run=CI_RUN_ID
gh run list --workflow release.yml --event workflow_dispatch --limit 1
gh run watch RUN_ID --exit-status
```

Use the new rehearsal run ID and confirm **Prepare release candidate**, **Verify
release**, and all four **Packaged** browser jobs succeed, with both store jobs
skipped. The explicit CI run must be a terminal full `Test` push on canonical
main for the exact commit. Its required checks and actual successful job
coverage must be within 24 hours. Partial reruns that carry jobs from an earlier
attempt do not refresh that evidence; rerun the complete CI workflow.

CI builds the production Chrome ZIP once, derives Firefox, validates both
archives and executes them. Its shared package gate also exercises popup,
pending-resource capture, three independent toolbar-to-draft profiles (six
provider successes, alternating first provider), and multi-summit flows against
those same minified bundles. CI retains the exact ZIPs and their version/source
hash identity in `ci-packages-SHA-ATTEMPT` for seven days. Its other required
jobs supply Node, scale, lint, layout and cross-platform coverage.

Rehearsal acquires that artifact by immutable ID, hard-checks GitHub's archive
SHA-256 and inner package hashes, then fans out current Chrome/current Firefox
on separate Intel macOS runners and Chrome 128/Firefox 152 on separate Ubuntu
runners. Every browser requires three consecutive passes with fresh profiles
and teardown by default. `-f repetitions=1` is diagnostic only; five is also
supported. Each Chrome pass extracts a new copy; both canonical ZIP hashes are
checked around every pass. Every job checks the independently pinned expected
identity, not just the downloaded identity file. There are no automatic retries
of failed passes. The first failure remains a failed rehearsal.

Keep the candidate fixed. Any source, metadata, test or workflow change requires
new CI and rehearsal evidence. Use a fresh rehearsal after failure; a rerun
cannot become publication evidence. The latest exact-commit main rehearsal must
itself succeed on attempt one with three or five passes in every browser; an
older green run cannot hide a newer failed or in-progress run.

A tag promotes the same ZIP bytes without another build or repeated full suite.
Promotion reconstructs the trusted CI/rehearsal run, attempt, job/log and
artifact proof, compares rehearsal ZIP hashes with the original CI artifact,
and rechecks identities and latest attempts after download. Required coverage
and artifacts must remain within 24 hours, with no future/missing timestamps.
Metadata, immutable history, the complete adoption policy, fresh dependency
audit, protected-main ancestry and remote publication protections remain gates.
The operator preflight uses this same acquisition validator. Every downstream
browser, join and store job checks the independently pinned identity.

Shared setup still installs Node 24, locked dependencies and exact expected
browser versions. Browser capabilities must match before assertions begin.
The additional ordinary Firefox matrix continues to cover Linux separately.
Individual assertion/performance deadlines remain unchanged. Rehearsal browser
jobs have separate 40-minute budgets; they do not serialize current browser
pairs or wait for another package rebuild.

Ordinary CI runs the complete interaction layout matrix in separate Chrome and
Firefox jobs, with the same runner and assertion deadlines. Each browser keeps
all themes, viewports, and surfaces. The stable required Chrome check waits for
package verification and both layout jobs; no gate can be skipped or consume
another browser's setup and cleanup budget.

Firefox's temporary extension is owned by its disposable profile. Verification
closes the session, confirms profile-owned processes exited, and removes the
profile; it does not issue a separate add-on uninstall during shutdown. Only
the known lost QUIT-response error can be accepted after confirmed process
exit. Disconnections during other commands, assertion failures, and lingering
processes remain failures. The success message follows completed teardown.

Scale gates run serially on the explicit Ubuntu 24.04 runner and Node 24
toolchain in CI; exact-commit release evidence inherits this required coverage. Full capture analysis keeps all three CPU samples,
including the first; correctness, point budgets, and cooperative yielding must
pass each time. The 15-second limit applies to the median, with a 30-second
individual-sample guard and a 120-second overall test deadline. This tolerates
one moderate measurement outlier while rejecting sustained or severe slowdown.
It is a reference-runner regression gate, not a latency promise for every device.

Verified rehearsal artifacts contain the exact two ZIPs, `candidate-evidence.json`
linking the source CI run/attempt/artifact/digest, and `package-identity.json`, which
records their version, source commit, and SHA-256 hashes. Each downstream job
checks that identity before using the downloads. Artifact names include the
release version and run attempt; failed-job reruns consume the successful verify
job's output instead of guessing a new artifact name. Do not rebuild an archive
between verification and submission. Browser failures retain bounded diagnostics
and logs for seven days; verified packages are retained for thirty days.

Firefox submission also checks the authenticated AMO version immediately before
signing and stops if it is already used. An ambiguous store response still
requires reconciliation; do not rerun a mutation to see whether it works.

## One-time setup

Create a protected GitHub environment named `browser-stores`. Restrict it to
release tags and require a reviewer. Configure the following in
that environment.

### Chrome metadata checkpoint

Create `chrome-metadata-review` **before** enabling the workflow reference. Require
an owner reviewer, forbid admin bypass, and allow only `v*` tags. It has no store
secrets or variables and no OIDC permission; `browser-stores` retains the existing
publisher credentials, WIF subject and reviewer protection. The shared preflight
checks both environments. The configured checkpoint was read back after creation
with one owner reviewer, only the `v*` tag policy, no bypass, zero secrets and zero
variables; this configuration check is not a live publication test.

The tag transaction uploads Chrome first, writes a pinned receipt and pauses at
this environment. Before approval, inspect the **latest draft version** and clear
Google's missing requirements in the Developer Dashboard, including permission
justifications and URL validation. The upload job's summary links the dashboard
and maintained copy. No store credentials are exposed to the review job. After
approval, publication uses the receipt and **never uploads again**. Firefox can
finish independently. Each primary tag-release store job revalidates the same fresh CI and
rehearsal evidence, independent package pin and dependency audit after approval
waits. All tag/recovery workflows share the publication lock; do not concurrently
upload or edit drafts outside that transaction. The separate Firefox recovery
workflow retains its legacy preserved-artifact and unused-version contract; it
shares the lock but does not claim the new primary pipeline's freshness proof.

The [v2 status API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus)
exposes submitted/published revision versions, not an unsubmitted draft digest or
revision precondition. The receipt records expected bytes/source/version, a
successful upload outcome and an optional API-reported version; it cannot prove
the current remote draft still matches. An asynchronous upload may omit its
version, and a synchronous upload may leave no asynchronous status. Human review
of the latest draft is therefore required. An already-submitted receipt claims
only exact submission reconciliation, not a new upload. Publication must still
prove the exact submitted version and fails on contradictory state. The receipt
expires after 24 hours; neither it nor the manual gate replaces fresh test proof.
The original evidence expiry also propagates to the store job and is checked
again immediately before a mutation, so audit/authentication work cannot silently
extend its validity.

### Chrome Web Store

The [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
can upload only a new version of an existing item. It cannot perform this
project's first dashboard upload. For the initial Chrome release:

1. Enable two-step verification on the publisher account.
2. Run the build and verification commands in the release checklist locally.
3. Upload `web-ext-artifacts/better_peakbagger-X.Y.Z.zip` in the Developer
   Dashboard. Complete
   the Listing, Privacy, Distribution, and reviewer-instructions fields, then
   publish that first version manually.
4. Do not tag that same version for automated Chrome submission. The first
   automated release must have a higher manifest version.

For subsequent automated releases, follow Google's
[service-account setup](https://developer.chrome.com/docs/webstore/service-accounts):

1. Enable the Chrome Web Store API in a Google Cloud project and create a
   service account. No long-lived JSON key is needed.
2. Add the service-account email to the Chrome Web Store publisher account.
   Chrome currently permits one service account per publisher.
3. Configure GitHub-to-Google
   [Workload Identity Federation](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account).
   Restrict the provider to this repository and release-tag refs, and grant that
   identity `roles/iam.workloadIdentityUser` on the service account.
4. Add these GitHub environment variables:

   - `GCP_WORKLOAD_IDENTITY_PROVIDER`: full provider resource name
   - `GCP_SERVICE_ACCOUNT`: linked service-account email
   - `CHROME_PUBLISHER_ID`: Publisher ID from the Developer Dashboard
   - `CHROME_EXTENSION_ID`: existing Chrome Web Store item ID

The workflow requests a short-lived token scoped only to
`https://www.googleapis.com/auth/chromewebstore`, uploads the verified ZIP,
waits for package processing, and submits it with automatic publication after
approval. Store warnings fail the job instead of being accepted silently. Each
API request has its own deadline and bounded response. After submission, the
publisher requires `fetchStatus` to show the manifest version in the submitted
revision with an accepted submitted state; it never reports the local package
version as a substitute for that remote evidence. If an upload or publish
response becomes ambiguous after dispatch, the script reconciles status and
stops with Developer Dashboard guidance instead of replaying the mutation. A
rerun that already observes the exact submitted revision completes without a
duplicate upload.

If listing visibility is changed in the Developer Dashboard, Chrome requires
one manual publication with that visibility before the API can publish again.

### Firefox Add-ons

Create an AMO developer account and generate API credentials. Add them as
GitHub environment secrets:

- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

`web-ext sign --channel=listed` can create the first AMO listing as well as
submit updates. The checked-in Gecko ID is the stable AMO identity and must not
change. Listing metadata is generated from `LICENSE` for every submission. A
custom license is intentional: AMO's predefined choice is
`AGPL-3.0-only`, while this project grants `AGPL-3.0-or-later`.

The Firefox command disables waiting for approval. AMO may take longer than a
CI job to review a listed version; timing out after a successful submission
would make a rerun attempt to reuse the same version. Review status remains
visible in the AMO Developer Hub.

## Release checklist

1. Prefer the existing signed-in Chrome Stable and Firefox Stable profiles for
   one minimal owned-provider capture in each browser family. Keep test windows
   in the background or on a separate display without taking focus; use
   isolated hidden profiles for the automated fixtures below.

   Use a signed-in Chrome session for the Chrome Developer Dashboard. Firefox
   is needed for its own toolbar grant, popup, worker, and inline Preferences
   checks. Choose the browser for the behavior being verified; ordinary store
   page inspection does not require Firefox debugging.

   - Open an owned Garmin or Strava activity and click Better Peakbagger's
     actual toolbar action. Do not open `popup.html` directly; that bypasses the
     native `activeTab` gesture being checked.
   - Confirm capture reaches summit results, open one draft, and confirm the
     fields, attached GPX, and GPS Preview are present.
   - Confirm Save remains wholly manual. Do not click either Save control.
   - Check the native popup presentation, permission prompts, Firefox inline
     Preferences, and tab-group presentation in a visible test window under the
     same non-interruption rule.
   - Load the candidate through Mozilla's
     [Firefox for Android extension-testing workflow](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)
     on a Firefox for Android 142+ device. Confirm the add-on enables, an ascent
     analyzer initializes, and Settings opens without an unsupported-manifest
     error. Record the device, Firefox version, and any mobile layout
     limitation; desktop Firefox does not establish this.
   - Discard only the test capture state and close only test-owned tabs. Close
     disposable profiles, preserving the user's existing browser and tabs.
     Keep the live check minimal and rate-limited.

   If Peakbagger presents a Cloudflare challenge, leave that tab for the user
   to validate and record the live check as pending. Fixture success cannot
   fill that evidence gap. Any restart of the user's browser or temporary
   privileged browser-UI debugging needs explicit permission. Preserve the
   profile and tabs, keep debugging local, and restore the original launch
   options afterward. Inspect the remaining process command lines: disconnecting
   a driver alone does not remove the browser's debugging flags.

   Automated fixtures cover the repeatable paths but cannot establish the live
   provider DOM/export, browser chrome, or native toolbar grant.
2. From a clean local `main` that exactly matches a freshly fetched
   `origin/main`, stamp the version and changelog:

   ```sh
   npm run release:bump X.Y.Z
   ```

   This updates `manifest.json`, `package.json`, `package-lock.json`, and
   stamps the `## Unreleased` heading in `CHANGELOG.md` with the version and
   current UTC date. Use `--date YYYY-MM-DD` only when the project owner has
   intentionally chosen a different release date. Before writing, the script
   fails on a dirty worktree or index, a detached or non-`main` branch, a
   diverged `origin/main`, or an existing local/remote tag. It creates neither
   a commit nor a tag, so all verification remains possible before the
   publication trigger exists.

3. Run the verification suite:

   ```sh
   npm ci
   npm run audit:ci
   npm test
   npm run test:scale
   npm run lint
   npm run verify -- browsers
   npm run verify -- terrain
   npm run verify -- terrain firefox
   npm run release:verify-packages
   ```

   `package` creates a minified, sourcemap-free `dist/` and the canonical Chrome
   ZIP; the Firefox command derives its ZIP from those exact bytes and changes
   only the options-page presentation. The archive verifier derives required
   runtime files from `scripts/build-config.mts` and rejects missing bundles,
   assets, or packaged licenses. The package verifier then launches both
   minified archives, including the browser-specific options presentation and
   store credit, before publication. If a new root-level development file is copied
   into `dist/` intentionally, update the build config and archive policy
   together rather than relying on web-ext's old repository-root ignore list.
   `audit:ci` requires zero advisories in shipped code. Advisories confined to the
   build and test tools named by `DEVELOPMENT_TOOLS` are reported and accepted at any severity.
   The minimatch 10 paths used by ESLint and TypeScript ESLint resolve the scoped
   upstream 11.0.1 override for
   [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
   The CommonJS matcher APIs and typed-file discovery are checked on Node 24;
   the legacy minimatch 3 / brace-expansion override remains separate. Remove
   this override when upstream owners adopt a patched range, after revalidation.
   Forge now resolves patched 1.4.2. The low-severity deepmerge advisory has no
   upstream patch and stays in tooling only (deepmerge 4.3.1 → addons-linter →
   web-ext), so raw `npm audit` still reports those three packages.
   The patched `web-ext`/`addons-linter` toolchain no longer needs the former
   `image-size` exception. Rehearsals use the same policy as publication.
   `npm run lint`
   likewise permits only the owner-annotated warnings checked into
   `scripts/check-web-ext-lint.mts`, up to the reviewed per-file occurrence limits
   recorded there.

   Main CI retains the 15-second capture CPU ceiling on Ubuntu. The rehearsal
   consumes its exact verified archives and executes all four current/floor
   browsers in parallel before either store becomes eligible. Record all four exact browser versions;
   these desktop checks do not replace the Firefox Android 142+ device step.

4. Review the four stamped files and commit them. Push main, wait for its Test
   workflow, and run the read-only rehearsal above on that exact commit. Include
   any coordinated changes before starting this verification; changing the
   candidate afterward invalidates both runs.

   ```sh
   git add manifest.json package.json package-lock.json CHANGELOG.md
   git commit -m "chore: release X.Y.Z"
   git push origin main
   # Wait for main CI, then dispatch and wait for the three-pass rehearsal.
   npm run release:preflight -- vX.Y.Z --ci-run CI_RUN_ID --rehearsal-run REHEARSAL_RUN_ID --output /private/tmp/bpb-vX.Y.Z-preflight.json
   git tag vX.Y.Z COMMIT_SHA_FROM_RECEIPT
   npm run release:check -- vX.Y.Z
   git push --atomic origin main refs/tags/vX.Y.Z
   ```

   `release:preflight` is read-only: it creates no commit, tag, deployment, or
   store submission. It requires clean local main, its tracking ref, and the
   live remote main to agree; the candidate tag must be unused. It checks
   metadata and changelog history, then pins the exact successful main CI and
   first-attempt rehearsal. All required jobs must succeed, both store jobs
   (including Chrome upload and metadata review) must be skipped, and all
   current/floor browser passes must include teardown.
   A one-pass rehearsal cannot authorize tagging. It downloads the rehearsal's
   exact artifact, checks both archive hashes against its commit identity, and
   removes the temporary download even on failure. The receipt records the
   run, attempt, artifact, hashes, and active protection IDs. Keep it outside
   the checkout; an existing output file is never overwritten.

   It also reruns the dependency audit with the release workflow's exact policy,
   so a green run cannot cover an advisory disclosed since.

   The command also requires active strict main checks, deletion/non-fast-forward
   protections for main and v* tags, no tag-rule bypass, and a required reviewer
   on the tag-only `browser-stores` environment. It inspects settings without
   changing them or reading store credentials. It rechecks the candidate and
   remote main before completing. Run it immediately before tagging and use
   the receipt's full commit SHA, not a moving branch name. This receipt is
   preparation evidence; the tag's own checks and store review remain required.

   The atomic push prevents the branch and release tag from reaching the
   remote independently and does not include unrelated local tags. Release CI
   fetches the protected `origin/main` tip and rejects any tag whose commit is
   not integrated into it. Keep the remote `v*` tag ruleset and
   `browser-stores` required-reviewer policy enabled; those GitHub settings are
   owner-controlled and must be inspected immediately before publication.

The verification job must finish before either store job starts. The store jobs
then run independently because the stores have no shared transaction. A failed
HTTP client or workflow result after an upload began does not prove submission
failed. Before using GitHub's **Re-run failed jobs** action, inspect the exact
`X.Y.Z` version in both the Chrome Developer Dashboard (including upload and
submitted revision state) and the AMO Developer Hub (including pending review
versions), and record what each store accepted. The Chrome publisher also
completes without another mutation when `fetchStatus` proves that exact version
is already submitted. It fails closed when the version is already published, a
different submission is active, or a recent upload remains ambiguous. Do not
retry a store mutation until its version is confirmed unused, and do not rerun
all jobs after either store consumed it.

`npm run verify -- terrain firefox` fails closed on SwiftShader, llvmpipe, and other
software renderers. Run it hidden on representative GPU hardware and record the
reported Firefox version, renderer, and viewport in the release notes. Hosted
CI does not run this command until its renderer can satisfy that condition.

## Recover a partial store release

Inspect the failed job's logs and both stores before choosing a recovery action.
Record the exact version, tag commit, original package artifact, and each
store's upload/submission state. A previous rejected Chrome revision can block
the next upload before any package bytes are sent; inspect the quoted rejection
in the Developer Dashboard rather than assuming the extension code failed.

1. If the rejection concerns listing text, correct
   `store-assets/description.md`, regenerate the Chrome text, and save it in the
   dashboard. Confirm the saved listing before uploading a package. See
   [Store listing description](#store-listing-description).
2. List the original release run's artifacts and download the name actually
   retained by its successful verification job:

   ```sh
   gh api repos/wilmtang/better-peakbagger/actions/runs/RUN_ID/artifacts --paginate \
     --jq '.artifacts[] | {name, expired}'
   gh run download RUN_ID --name ARTIFACT_NAME --dir tmp/release-X.Y.Z
   node scripts/release-package-identity.mts verify tmp/release-X.Y.Z X.Y.Z TAG_COMMIT
   ```

   Use the tag's full commit SHA. A store-job rerun increases the run attempt
   without rebuilding the verified packages, so the artifact can still end in
   an earlier attempt number. Read its actual name; do not derive it from the
   latest run attempt. If it is expired or identity verification fails, stop
   recovery and record the blocker.
3. Reconcile the target store. For a new pipeline run, preserve its
   `chrome-upload-receipt-ATTEMPT` artifact and independently pinned receipt hash.
   If upload succeeded and Google rejected metadata, correct the dashboard fields,
   inspect the latest draft/version, approve `chrome-metadata-review`, and run only
   **Submit Chrome Web Store**. That job calls the receipt-based publish-only API;
   it cannot replay upload. Never rerun **Upload Chrome Web Store** as a metadata
   recovery action. If receipt/proof expired, is missing, or upload outcome is
   ambiguous, stop and reconcile the dashboard/API read-only before a reviewed
   recovery decision; do not bypass the receipt's freshness or invent an upload
   receipt. A submitted exact version can be reconciled without another mutation.
   A receipt for an existing submission cannot publish if that submission vanished.
   Old runs from before this split need their original dashboard recovery path;
   do not assume the new receipt exists. Firefox signing still requires the
   authenticated exact-version check to prove its version unused.
4. Rerun only the affected store job after reconciliation, through the normal
   `browser-stores` reviewer gate:

   ```sh
   gh run view RUN_ID --json jobs --jq '.jobs[] | {name, databaseId, conclusion}'
   gh run rerun RUN_ID --job JOB_DATABASE_ID
   gh run watch RUN_ID --exit-status
   ```

   Obtain `databaseId` from the command output, as described in the
   [GitHub CLI manual](https://cli.github.com/manual/gh_run_rerun). GitHub also
   reruns [dependent jobs](https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run);
   inspect the job graph before dispatch. Chrome has separate upload, metadata
   review and publish jobs; rerun only publish after successful upload and review.
   Leave an accepted Firefox submission intact during Chrome recovery. Record
   terminal results, the original failed attempt, and whether recovery performed
   a new submission or only reconciled an existing one.

The separate [Firefox recovery workflow](../.github/workflows/retry-firefox-release.yml)
searches every artifact page for the latest unexpired verified package from
the target release run, including earlier attempts retained after store-only
reruns. It checks the exact tag and rejects ambiguous names before downloading;
version, commit, and archive hashes are still verified after download. Releases
predating package identity retain the explicit legacy-name fallback. Never rerun
all release jobs merely to recreate an artifact; that also replays store mutations.

Recovery still validates metadata and archive contents against current main.
If main has advanced to another version or changed its package file contract,
older-tag recovery requires a reviewed tooling correction before dispatch.

## Confirm public availability

Keep three outcomes separate in the release record:

| Outcome | Evidence |
| --- | --- |
| Packages verified | Terminal verification jobs and matching package identity. |
| Submitted for review | Exact version accepted in the store's developer dashboard/API. |
| Publicly available | Exact version shown on the public store listing/API. |

Check each store independently. For Firefox, the public AMO API exposes the
currently available version without developer credentials:

```sh
curl --fail --silent --show-error \
  https://addons.mozilla.org/api/v5/addons/addon/better-peakbagger/ \
  | jq '{version: .current_version.version, version_id: .current_version.id}'
```

For Chrome, check the Version field on the
[public listing](https://chromewebstore.google.com/detail/better-peakbagger/kndjohodnpdoejmjkiiakejfehoodedn)
and the submitted version's status in the Developer Dashboard. Pending review
with automatic publication enabled is still a submission. Record the check
date and any disagreement between the dashboard and public listing; do not
report both stores live from a green release workflow alone.

## Store listing description

`store-assets/description.md` is the single source of truth for the "About this
extension" text on both stores. The Firefox workflow reads the Markdown
automatically via `scripts/create-amo-metadata.mts`. After editing it, run
`npm run store:description:chrome` to regenerate
`store-assets/description-chrome.txt`. The Chrome Web Store API does not support
updating listing metadata, so paste that generated plain text into the Chrome
Developer Dashboard manually.

Review the generated text as listing metadata before tagging. Keep brand and
supported-site references relevant and concise, including in independence
disclaimers. Google's
[keyword-spam guidance](https://developer.chrome.com/docs/webstore/program-policies/spam-faq#keyword-spam)
limits lists of supported sites or brands to five. The 3.8 recovery removed a
long service-name disclaimer after Chrome rejected it for excessive keywords.
Use the canonical short independence statement instead of recreating that list.
Generator tests prove the text is current; store review determines acceptance.

The [3.8 hardening ledger](archive/release-hardening-2026-09-30.md) records the
original failures, preserved package identities, and Chrome-only recovery.
