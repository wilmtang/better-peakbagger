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

After the release metadata is merged and main CI passes, run:

```bash
gh workflow run release.yml --ref main
gh run list --workflow release.yml --event workflow_dispatch --limit 1
gh run watch RUN_ID --exit-status
```

Use the returned run ID and confirm **Release scale tests**, **Verify release**, packaged Chrome 128,
and packaged Firefox 152 finish successfully, with both store jobs skipped.
This checks listing metadata before expensive work, then runs the same audit,
tests, lint, production packaging, archive validation, and current/floor browser
checks used for publication. A rehearsal proves package readiness for its commit;
a later tag still reruns the gates for its own commit.

Manual rehearsals require three consecutive successes per browser by default,
using the same archive bytes with fresh disposable profiles. Choose one or five
with `-f repetitions=1` or `-f repetitions=5`. Every requested repetition must
pass, including teardown; the first failure stops the check and stays failed.
Current-browser checks verify archive hashes between runs. The floor jobs use
the same repetition count. Published tag jobs run once after this preflight.
The current-package job allows 25, 45, or 65 minutes for one, three, or five
passes, including setup, tests, and lint. Individual assertion and performance
deadlines stay unchanged.

Ordinary CI's current-browser job and the release job use the same
`.github/actions/setup-verification` action and `npm run release:verify-packages`
command. The action installs Node 24 and locked dependencies, resolves browser
paths, and exports exact expected versions. The command builds the canonical
Chrome ZIP, derives and validates Firefox's ZIP from those bytes, and executes
both archives. Browser capabilities must match the installed versions before
extension assertions begin; an absent expectation is an error in CI. The
additional ordinary Firefox matrix continues to cover Linux separately.

Firefox's temporary extension is owned by its disposable profile. Verification
closes the session, confirms profile-owned processes exited, and removes the
profile; it does not issue a separate add-on uninstall during shutdown. Only
the known lost QUIT-response error can be accepted after confirmed process
exit. Disconnections during other commands, assertion failures, and lingering
processes remain failures. The success message follows completed teardown.

Scale gates run serially on the same explicit Ubuntu 24.04 runner and Node 24
toolchain in CI and release. Full capture analysis keeps all three CPU samples,
including the first; correctness, point budgets, and cooperative yielding must
pass each time. The 15-second limit applies to the median, with a 30-second
individual-sample guard and a 120-second overall test deadline. This tolerates
one moderate measurement outlier while rejecting sustained or severe slowdown.
It is a reference-runner regression gate, not a latency promise for every device.

Verified artifacts contain the exact two ZIPs and `package-identity.json`, which
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
release tags and, if desired, require a reviewer. Configure the following in
that environment.

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
   npm run audit:ci -- --allow-reviewed-development-advisory # exact exception until Oct 17
   npm test
   npm run test:scale
   npm run lint
   npm run verify:browsers
   npm run terrain:verify
   npm run terrain:verify:firefox
   npm run release:verify-packages
   ```

   `package` creates a minified, sourcemap-free `dist/` and the canonical Chrome
   ZIP; the Firefox command derives its ZIP from those exact bytes and changes
   only the options-page presentation. The archive verifier derives required
   runtime files from `scripts/build-config.mjs` and rejects missing bundles,
   assets, or packaged licenses. The package verifier then launches both
   minified archives, including the browser-specific options presentation and
   store credit, before publication. If a new root-level development file is copied
   into `dist/` intentionally, update the build config and archive policy
   together rather than relying on web-ext's old repository-root ignore list.
   `audit:ci` requires zero advisories by default, including development dependencies.
   The owner approved the same exact-path, development-only `node-forge`
   exception for main CI and store releases through October 17, 2026, without
   a version-specific approval. Pass `--allow-reviewed-development-advisory`
   for the local check; the release workflow opts into the same evaluator.
   The exception expires
   at 00:00 October 17, 2026 in Los Angeles (07:00 UTC), and rejects new advisories,
   changed dependency versions or paths, and production resolutions. Raw npm
   audit still reports the three high findings in the `web-ext` chain. This is
   an accepted tooling risk, not a patched dependency or a clean raw audit.
   Every other advisory remains rejected, and the flag cannot accept this
   advisory at or after the expiry.
   The patched `web-ext`/`addons-linter` toolchain no longer needs the former
   `image-size` exception. Rehearsals use the same policy as publication.
   `npm run lint`
   likewise permits only the owner-annotated warnings checked into
   `scripts/check-web-ext-lint.mjs`, up to the reviewed per-file occurrence limits
   recorded there.

   Release scale tests retain the 15-second capture CPU ceiling on the same
   Ubuntu runner class as ordinary scale CI. Package verification waits for
   that required job; its browser checks run separately on hosted macOS.
   Release CI also downloads the verified archives and executes them in hidden
   Chrome for Testing 128 and Firefox 152 before either store job becomes
   eligible. The ordinary package verifier separately covers current Chrome
   for Testing and current Firefox. Record all four exact browser versions;
   these desktop checks do not replace the Firefox Android 142+ device step.

4. Review the four stamped files, commit them, and create only the exact tag
   after every gate above passes:

   ```sh
   git add manifest.json package.json package-lock.json CHANGELOG.md
   git commit -m "chore: release X.Y.Z"
   git tag vX.Y.Z
   npm run release:check -- vX.Y.Z
   git push --atomic origin main refs/tags/vX.Y.Z
   ```

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

`npm run terrain:verify:firefox` fails closed on SwiftShader, llvmpipe, and other
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
   node scripts/release-package-identity.mjs verify tmp/release-X.Y.Z X.Y.Z TAG_COMMIT
   ```

   Use the tag's full commit SHA. A store-job rerun increases the run attempt
   without rebuilding the verified packages, so the artifact can still end in
   an earlier attempt number. Read its actual name; do not derive it from the
   latest run attempt. If it is expired or identity verification fails, stop
   recovery and record the blocker.
3. Reconcile the target store. Chrome can accept a dashboard upload of the
   verified ZIP and submit it for review after the listing is corrected. Confirm
   the draft version and automatic publication choice. If that exact version
   is already submitted, the Chrome publisher's preflight returns before upload
   or publish. If it is already published, retain that evidence and follow the
   publisher's guidance; do not submit it again. Firefox signing can run only
   after the authenticated exact-version check proves the version unused.
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
   inspect the job graph before dispatch. The two store jobs are independent.
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
automatically via `scripts/create-amo-metadata.mjs`. After editing it, run
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
