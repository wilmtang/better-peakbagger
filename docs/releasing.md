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
approval. Store warnings fail the job instead of being accepted silently.

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

1. Manually verify current Garmin, Strava, and Peakbagger behavior in both
   browser families. Automated fixtures cannot establish that live provider
   DOM and export flows still work.
2. Bump the version, stamp the changelog, and create the tag:

   ```sh
   npm run release:bump X.Y.Z
   ```

   This updates `manifest.json`, `package.json`, `package-lock.json`, and
   stamps the `## Unreleased` heading in `CHANGELOG.md` with the version and
   today's date. It runs `release:check` internally before writing, so version
   mismatches or a missing changelog heading fail before any file is touched.
   The script commits all four files and creates a lightweight `vX.Y.Z` tag.

3. Run the verification suite:

   ```sh
   npm ci
   npm test
   npm run lint
   npm run verify:extension
   npm run terrain:verify
   npm run package
   npm run build:firefox -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip
   npm run release:verify-archive -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip chrome
   npm run release:verify-archive -- web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip firefox
   ```

   `package` creates a minified, sourcemap-free `dist/` and the canonical Chrome
   ZIP; the Firefox command derives its ZIP from those exact bytes and changes
   only the options-page presentation. The archive verifier derives required
   runtime files from `scripts/build-config.mjs` and rejects missing bundles,
   assets, or packaged licenses. If a new root-level development file is copied
   into `dist/` intentionally, update the build config and archive policy
   together rather than relying on web-ext's old repository-root ignore list.

4. Push the release:

   ```sh
   git push origin main --tags
   ```

The verification job must finish before either store job starts. The store jobs
then run independently because the stores have no shared transaction. If one
store job fails after the other succeeds, use GitHub's **Re-run failed jobs**
action. Do not rerun all jobs: the successful store may reject the duplicate
version.

## Store listing description

`store-assets/description.txt` is the single source of truth for the "About
this extension" text on both stores. The Firefox workflow reads it automatically
via `scripts/create-amo-metadata.mjs`. The Chrome Web Store API does not
support updating listing metadata, so after editing `description.txt`, paste
the new text into the Chrome Developer Dashboard manually.
