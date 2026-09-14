# Browser store releases

Pushing an exact `vMAJOR.MINOR.PATCH` tag starts `.github/workflows/release.yml`.
The workflow verifies separate Firefox and Chrome packages, then submits that
version independently to the Chrome Web Store and Firefox Add-ons (AMO). The
canonical Chrome package opens settings in a full tab; the Firefox package
differs only by keeping settings inline in the Add-ons Manager. Store
review is asynchronous; a successful workflow means both stores accepted the
submissions, not that review has completed.

The workflow deliberately has no manual dispatch. A store version cannot be
reused, so publishing an arbitrary branch or rerunning a successful store job
would create an avoidable partial-release failure.

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

1. In dedicated Chrome Stable and Firefox Stable test profiles, perform one
   minimal owned-provider capture in each browser family:

   - Open an owned Garmin or Strava activity and click Better Peakbagger's
     actual toolbar action. Do not open `popup.html` directly; that bypasses the
     native `activeTab` gesture being checked.
   - Confirm capture reaches summit results, open one draft, and confirm the
     fields, attached GPX, and GPS Preview are present.
   - Confirm Save remains wholly manual. Do not click either Save control.
   - Check the native popup presentation, permission prompts, Firefox inline
     Preferences, and tab-group presentation while the dedicated profile is
     visible.
   - Load the candidate through Mozilla's
     [Firefox for Android extension-testing workflow](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)
     on a Firefox for Android 142+ device. Confirm the add-on enables, an ascent
     analyzer initializes, and Settings opens without an unsupported-manifest
     error. Record the device, Firefox version, and any mobile layout
     limitation; desktop Firefox does not establish this.
   - Discard the extension's capture state, close the draft and provider tabs,
     and close the test profile. Keep the live check minimal and rate-limited.

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
   npm run verify:browsers
   npm run terrain:verify
   npm run terrain:verify:firefox
   npm run package
   npm run build:firefox -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip
   npm run release:verify-archive -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip chrome
   npm run release:verify-archive -- web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip firefox
   npm run verify:packages -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip
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
   `audit:ci` must pass without editing its acceptance during release rehearsal.
   A 2026-08-22 source review found no patched `image-size` release and renewed
   only the two exact high `image-size` advisories through the development-only
   `web-ext`/`addons-linter` lint path, with locked package versions and an
   expiry of 2026-09-21. Every other finding fails. If that
   acceptance expires before an upstream fix exists, publication stays blocked
   until a fresh source review records the advisory ids, exact install path,
   locked versions, and a new expiry. `npm run lint`
   likewise permits only the owner-annotated warnings checked into
   `scripts/check-web-ext-lint.mjs`, at the exact per-file occurrence counts
   recorded there.

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

## Store listing description

`store-assets/description.md` is the single source of truth for the "About this
extension" text on both stores. The Firefox workflow reads the Markdown
automatically via `scripts/create-amo-metadata.mjs`. After editing it, run
`npm run store:description:chrome` to regenerate
`store-assets/description-chrome.txt`. The Chrome Web Store API does not support
updating listing metadata, so paste that generated plain text into the Chrome
Developer Dashboard manually.
