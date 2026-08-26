# Development guide

Better Peakbagger is a Manifest V3 extension whose `src/` is written as **ES
modules** and bundled with **esbuild** into `dist/`. `dist/` is the extension:
it is what you load in a browser, what the release packagers zip, and what the
real-extension checks exercise. You never load the repo root directly.

If you worked on this project before the build step existed: the old model was
"build-free"—the browser loaded raw files from `src/` and extension modules
found each other through `globalThis.BPB*`. That is gone. Modules now use ES
imports. Third-party browser builds still expose their documented globals, and
the provider adapter has one deliberate cross-world API described below; no
Better Peakbagger module uses a global as an internal dependency.

## Prerequisites

- Node.js 22 or newer (CI uses Node.js 24) and npm.
- `npm ci` to install the exact dependency graph in `package-lock.json`
  (esbuild, runtime vendor packages, jsdom, Playwright, Selenium, and web-ext).
  Its `prepare` step also points this clone's `core.hooksPath` at `.githooks`,
  which is what makes `.githooks/pre-commit` run the staged privacy scan in
  `scripts/privacy-guard.mjs`. That scan refuses to commit any file containing
  the account holder's identifiers, so it is the one check whose absence is
  invisible until something has already been committed. If you already set
  `core.hooksPath` yourself the install leaves it alone and says so; enable the
  scan by hand with `git config core.hooksPath .githooks`.
- For Chrome verification: `npx playwright install chromium` (Chrome for
  Testing — stable Chrome refuses `--load-extension`).
- For Firefox verification: Firefox Stable and `geckodriver` on `PATH`.
  `npx playwright install firefox` additionally installs the isolated Firefox
  build used by the GPU terrain check.
- OpenSSL. Every browser fixture server — both extension verifiers, both
  terrain verifiers, and `showcase:render` — creates a one-day self-signed
  certificate in a disposable directory and deletes it in teardown, so the local
  fixture is served over HTTPS on a real Peakbagger hostname. That is required
  by the product, not a formality: `src/peakbagger/peakbagger-request.js`
  refuses any other origin.

## Source and test layout

Runtime modules are grouped by the behavior they own. The directory is an
ownership boundary for maintainers; esbuild bundles may still import modules
from several directories when a shipped surface crosses those boundaries.

| Directory | Ownership |
| --- | --- |
| `src/ascent/` | Ascent form filling, filtering, snapshots, upload, and saved-ascent backup |
| `src/background/` | Extension service-worker coordination |
| `src/capture/` | Provider adapters, ownership checks, and pure capture analysis |
| `src/favorites/` | Favorite-climber data and climber-page controls |
| `src/github/` | GitHub authentication, API transport, repository writes, and backup payloads |
| `src/gpx/` | Shared GPX parsing, metrics, and ascent-page analysis |
| `src/maps/` | BigMap and Peak map coordinators, bridges, links, and peak markers |
| `src/peakbagger/` | Authenticated Peakbagger request and response policy |
| `src/profile/` | Full-profile backup parsing, pipeline, and UI |
| `src/reports/` | Trip-report conversion, editing, and local drafts |
| `src/settings/` | Settings schema, storage, and the page-world bridge |
| `src/terrain/` | 3D lifecycle, renderer, camera, cache, tiles, and styling |
| `src/theme/` | Theme startup and the packaged dark stylesheet |

Tests mirror those names under `test/<domain>/`. Cross-cutting build, manifest,
release, and repository-policy tests live in `test/project/`; extension-page
tests live in `test/options/` and `test/popup/`; shared fixtures and helpers
remain under `test/fixtures/` and `test/helpers/`. Scale tests add one more
level, `test/scale/<domain>/`, so no executable test is loose in `test/`.

Put a new module in the directory that owns its behavior and place focused
coverage in the matching test directory. Do not add loose files directly under
`src/` or `test/`. A generic `shared/` directory is intentionally avoided:
reusable code still needs one domain owner, and cross-domain imports make that
dependency visible.

## Everyday workflow

For test-driven work, edit source and run `npm test`; the command creates a
fresh development build before the suite.

For interactive browser work, use one of the managed development commands:

```bash
npm run start -- firefox
npm run start -- chromium --chromium-binary "/path/to/chrome-for-testing"
```

Without additional profile flags, each command makes the initial `dist/` build,
launches web-ext with a temporary browser profile, keeps esbuild watching the
source tree, and reloads the extension after every successful rebuild. Stop the
command with Ctrl+C; the watchers, browser process, and Firefox temporary source
are then cleaned up.

To keep site logins and browser settings across development sessions, give each
browser a dedicated persistent development profile:

```bash
npm run start -- firefox \
  --firefox-profile "$HOME/.better-peakbagger-firefox-profile" \
  --profile-create-if-missing \
  --keep-profile-changes

npm run start -- chromium \
  --chromium-binary "/path/to/chrome-for-testing" \
  --chromium-profile "$HOME/.better-peakbagger-chromium-profile" \
  --profile-create-if-missing \
  --keep-profile-changes
```

Log into Peakbagger once in each profile; subsequent runs reuse its cookies.
Keep these profiles outside the repository because they contain login state.
Do not point either command at an everyday profile: web-ext changes Firefox
security-related preferences when keeping profile changes, and Chromium can
lock or damage a profile opened concurrently by another browser process. See
the [web-ext profile options](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#firefox-profile)
for the upstream behavior and Firefox warning.

The reload is transactional. Each generation builds every browser bundle,
notice, and runtime asset into its own staging tree, validates the complete
inventory there, then publishes the tree with a directory swap. The previous
`dist/` remains available until publication succeeds; a bundle, copy, notice,
or swap failure therefore leaves both the on-disk runtime and web-ext reload
token at the last complete generation. Startup and teardown remove only
identified abandoned staging trees. Fix the error and save again to retry.

Extension reload is not page reload. Content scripts already injected into an
open Peakbagger, Garmin, or Strava tab keep their old page instance, so refresh
that tab after the extension reloads. Reopening the popup or Preferences is
enough for those extension pages. The commands deliberately do not refresh
activity or ascent-editor tabs automatically, because that could discard page
state or interrupt a capture.

Do not run `watch`, `start`, or another build command concurrently in the
same worktree at the same time. The managed browser commands already own the
watcher, while one-off builds deliberately replace `dist/`; concurrent writers
can produce a transient mixed tree.

For a manually managed browser instead, run `npm run watch`, load `dist/` as an
unpacked extension, and reload it yourself after a rebuild:

- **Chrome/Edge/Brave:** open the browser's extensions page → enable Developer mode → *Load
  unpacked* → pick the `dist/` folder. Click the reload ↻ on the card after each
  rebuild.
- **Firefox:** load `dist/manifest.json` via
  `about:debugging` → *This Firefox* → *Load Temporary Add-on*.

Standalone `npm run watch` still writes the completed-build signal, but a
manually loaded browser does not subscribe to it; use the browser's extension
reload control, then refresh the target page. Restart any watcher after changing
`scripts/build-config.mjs`, the build scripts, or installed dependencies—the
running Node process has already loaded those inputs.

Do **not** load the repo root — `manifest.json` there names bundle files that
only exist under `dist/` after a build.

## Commands

`package.json` is strict JSON and cannot carry comments. This table is the
complete command reference; `test/project/development.test.mjs` fails when a
script is added or removed without updating it.

| Command | What it does |
| --- | --- |
| `npm run prepare` | Installs this clone's privacy-preserving Git hooks after `npm install`/`npm ci`; leaves an existing custom `core.hooksPath` unchanged. |
| `npm run build` | One-off development build (unminified, source maps) into `dist/`. |
| `npm run build:release` | Minified production build (no source maps). |
| `npm run watch` | Transactionally rebuild on change and re-copy static assets; does not launch or control a browser. |
| `npm run start -- BROWSER [web-ext options]` | With `BROWSER` set to `chromium` or `firefox`, builds, watches, launches an isolated web-ext development browser, and reloads after complete builds. Firefox mirrors each build into an inline-Preferences source first. |
| `npm test` | Builds `dist/`, then runs the normal pure/jsdom/project suite in `test/**/*.test.mjs`. |
| `npm run test:scale` | Exercises the 4,145-row ascent fixture, a synthetic 20,000-point provider track, and the full 1,500-entry favorite manager/search/backup path; CI and release checks run these separately from the fast default suite. |
| `npm run lint` | Runs ESLint over source, page-local surfaces, scripts, and tests; then builds and runs `web-ext lint` against `dist/`, accepting only the owner-reviewed warning baseline. |
| `npm run audit:ci` | Applies the repository's exact, expiring npm-advisory policy. A 2026-08-22 source review found no patched release and renewed only two exact high `image-size` advisories through the development-only `web-ext`/`addons-linter` path, with locked versions and a 2026-09-21 expiry; every other or expired finding fails. |
| `npm run verify:chrome` | Builds and loads the real unpacked `dist/` in hidden Chrome for Testing, including trusted GPX selection, draft handoff, 1,500-row favorite management, long settings navigation, and native Buddy synchronization. |
| `npm run verify:firefox` | Builds the derived Firefox source, temporarily installs it in hidden Firefox, and runs the same manifest-surface and feature smoke. |
| `npm run verify:browsers` | Builds once, then runs the Chrome and Firefox extension gates. |
| `npm run verify:packages -- CHROME.zip FIREFOX.zip` | Executes the extracted minified Chrome package and the exact generated Firefox archive through the browser gates. |
| `npm run terrain:verify` | Renders the real MapLibre terrain frame on Chrome's GPU with synthetic route, basemap, peak, and CORS-enabled DEM fixtures. Serves the showcase over HTTPS on `www.peakbagger.com`; needs `openssl`. |
| `npm run terrain:verify:firefox` | Runs the focused Firefox GPU terrain/interaction check and refuses software WebGL. Same HTTPS showcase host. |
| `npm run terrain:lod` | Measures the 3D tilt detail collapse against the acceptance criteria in `docs/archive/3d-tilt-detail-blink.md`: which elevation level every visible pixel is drawn from across a cold-cache pitch sweep, plus the elevation and drape traffic it costs. Same HTTPS showcase host and GPU rules as `terrain:verify`. |
| `npm run showcase:render` | Builds and renders the local UI showcase fixtures into `store-assets/`. Same HTTPS showcase host. |
| `npm run package` | Release build + `web-ext build` from `dist/`; writes the canonical Chrome ZIP under `web-ext-artifacts/`. |
| `npm run build:firefox -- CHROME.zip FIREFOX.zip` | Derives the Firefox store ZIP from the verified Chrome ZIP, changing only Firefox-specific manifest presentation. |
| `npm run release:bump X.Y.Z` | From a clean synchronized `main`, validates and stamps release metadata and the UTC changelog date; deliberately creates no commit or tag before verification. |
| `npm run release:check -- vX.Y.Z` | Validates an exact release tag, synchronized versions, stable Gecko identity, store description, and changelog heading. |
| `npm run release:check-history` | Fails when already-released changelog sections or tags have been rewritten; CI runs it with full Git history. |
| `npm run release:metadata:firefox` | Converts the canonical store description into the AMO metadata JSON used for submission. |
| `npm run release:sign:firefox` | Submits the prepared Firefox source to AMO with the release environment's credentials and metadata. |
| `npm run release:verify-archive -- ARCHIVE.zip BROWSER` | Checks a Chrome or Firefox archive for required runtime files, licenses, browser-specific manifest policy, and forbidden development artifacts. |
| `npm run store:description:chrome` | Regenerates Chrome's checked-in plain-text listing from the canonical Markdown description. |

Pushes and pull requests use one least-privilege workflow with independent
jobs for Node tests/lint, the scale suite, current Chrome for Testing, Chrome
128, and Firefox 152 plus latest. The desktop manifest promises those exact
floors (`minimum_chrome_version: 128` and Firefox `strict_min_version: 152.0`),
and release CI repeats both floor smokes against the minified store archives
before either submission job can start. Firefox Android 142+ remains a separate
physical-device release check. Each job installs its own runtime and reports
failures separately. The Node job runs both lint stages through `npm run lint`:
ESLint reads source, while web-ext reads the built package, and neither
substitutes for the other. It also runs
`audit:ci`, so any new advisory fails CI. Release CI runs the same two linters, adds the
scale test, and executes both generated store archives before either
publication job can start.

The source manifest declares the verified Firefox desktop floor 152.0 and the
Firefox Android floor 142.0 independently. Android 142 is the first mobile
release that supports
[`gecko.data_collection_permissions`](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
and remains separately declared even though the working desktop floor is newer.
Desktop browser automation cannot prove the Android declaration or mobile
layout; use the physical-device release check in [Browser store releases](releasing.md).

The browser smokes select a fixture GPX through the native file input and
confirm that a fresh ascent form receives its local date and replaces Preview
with the extension's Process action. They also exercise the 1,500-entry favorite
total and fuzzy search, the distance-aware jump over that list, and native Buddy
add/remove convergence under both removal policies. Exhaustive parsing, summit
selection, and failure cases remain in `npm test`; the browser gates continue
through the shared draft path to prove real file attachment and exactly-once
Preview.

Chrome stable 137+ rejects command-line `--load-extension`, so
`npm run start -- chromium` needs a compatible Chromium/Chrome for Testing binary (pass
web-ext's `--chromium-binary` after the `chromium` argument) or it will fail. Manual **Load
unpacked** from `dist/` remains the simplest Chrome-family loop.

The reload marker (`dist/.better-peakbagger-reload`) exists only in watch mode.
It is an internal development coordination file, not extension runtime state;
one-off and release builds replace `dist/` and do not package it.

## How the build works

`scripts/build-config.mjs` is the **single source of truth** for how the
extension is assembled—which source roots belong to each bundle and which
assets/vendor distributions are copied. `scripts/build.mjs` turns that config
into esbuild calls. The manifest names only generated bundle paths; tests
cross-check those references against the config.

Every classic browser entry point (the service worker, each content script, and
the options and popup pages) is bundled into one self-contained **IIFE** file.
Browsers cannot load an ES module as a classic content script, so those entries
must be bundled down to classic scripts. The extension-owned terrain frame is a
deliberate native-ESM exception: its module entry imports the local MapLibre ESM
distribution directly.

ES imports determine dependency evaluation order. The source order in an
`ENTRIES` record matters only where independent side-effect roots intentionally
run in sequence; tests pin those compositions. Separately loaded third-party
browser globals remain ordered by `manifest.json`.

`dist/` layout:

```
dist/
  ACKNOWLEDGEMENTS.md, LICENSE, README.md
  manifest.json            # copied from the repo-root manifest.json
  background.js            # the MV3 service worker (one bundle, both browsers)
  provider-page.js         # injected on demand into provider pages
  peakbagger-page.js        # narrow account evidence and capture transport in a Peakbagger tab
  content/*.js             # one bundle per content-script entry
  terrain/terrain.html + terrain-frame.js
  options/ popup/          # page html + bundled js + css
  css/                     # shared stylesheets
  icons/
  vendor/                  # browser builds copied/derived from node_modules
```

`dist/` is ignored generated output. Never patch a file there: the next build
removes it. Make the change in `src/`, the page/asset source directory, or the
build config.

## Adding or changing a source module

1. Write `src/<domain>/foo.js` as an ES module: `export` what other modules
   need, and `import` your own dependencies. Do **not** publish a `globalThis`
   global.
   - Modules that only run for side effects and need an early `return` (e.g. "no
     matching DOM, do nothing") may keep a small `(() => { … })()` IIFE for
     control flow. That is fine as long as they publish no globals.
2. Add the module to the relevant bundle(s) in `scripts/build-config.mjs`
   `ENTRIES` as an explicit root. A module can appear in several bundles;
   esbuild follows and deduplicates imports within each bundle.
3. If it's a brand-new entry point (a new content script, page, or worker), add
   an `ENTRIES` record **and** wire it into `manifest.json` (or the page HTML).
4. Add focused coverage and run `npm test`.
   `test/project/manifest-capture.test.mjs` cross-checks that every manifest bundle
   reference is a declared build output and pins security-sensitive bundle
   composition.

For a new copied HTML, CSS, or root file, add a `[source, destination]` pair to
`COPY_FILES`. Add an asset directory to `COPY_DIRS` only when the whole tree is
runtime material. A file that exists in the repository but is absent from the
build config does not ship.

### Testing a module

- **Pure logic** (no DOM/chrome/vendor globals): `import` it directly in a
  `test/<domain>/*.test.mjs` and call it. Set any ambient browser global the
  module reads (`DOMParser`, `location`, …) from a throwaway jsdom.
- **Content-script behaviour**: evaluate the *built bundle* into a jsdom page
  with `evalBundle` from `test/helpers/load-page.mjs`. This runs exactly what
  ships and needs no Better Peakbagger module globals. Feed settings through a
  `chrome.storage` stub (`makeChromeStub`), not a `globalThis.BPBSettings` stub
  — modules import settings now.

Keep degradation tests for genuinely absent third-party globals where the
runtime supports that fallback. Do not recreate removed `BPB*` module globals
as test seams.

## Vendor libraries

Vendor libraries are dev dependencies declared in `package.json` and resolved
exactly by `package-lock.json`. The build sources them from `node_modules` into
`dist/vendor`—nothing is hand-copied.

- **marked and Chart.js** ship browser builds that are copied verbatim.
- **MapLibre 6** ships ESM only. The build copies its main module, module worker,
  shared module, stylesheet, and license verbatim. The native terrain-frame entry
  imports the main module directly; the frame sets the local worker URL before
  constructing a map.
- **tz-lookup** ships only CommonJS, so esbuild bundles it directly into the GPX
  analyzer and ascent-editor bundles that import it.

Chart and marked stay **separately-loaded browser globals** because the manifest
orders their browser artifacts. MapLibre is a local native ESM dependency, and
tz-lookup is an ordinary bundled dependency: manifest content scripts cannot be
module entry points, and bundling avoids exposing its resolver through the page
namespace.
"Zero globals" means no Better Peakbagger module uses a global as an internal
dependency; it does not refer to third-party UMD APIs or the provider boundary
below.

To add or update a runtime dependency:

1. Run `npm install --save-dev <pkg>@<version>` and commit both package files.
2. Import an ordinary bundled dependency from the consuming module. For a
   separately loaded browser build, add its npm path, destination, and license
   to `VENDOR_COPY`; generate a wrapper only when an entry must stay a separate
   global.
3. Update `ACKNOWLEDGEMENTS.md` and Firefox review metadata when distributed
   third-party code or its version changes. Authored source roots in the AMO
   instructions are derived from `scripts/build-config.mjs`; do not maintain a
   second directory list when adding a page-local bundle root.
4. Run `npm test`, the relevant real-browser check, and `npm run package` when
   packaging paths or vendor outputs changed.

Dependency updates arrive automatically; see
[Dependency updates](#dependency-updates) for what merges on its own.

### The intentional page APIs

`src/capture/provider-page.js` publishes `globalThis.BPBProviderPage`. That is a narrow,
deliberate boundary rather than a module dependency: `background.js` injects
the built adapter into a provider page, then injects inline functions that call
the API across the worker→page boundary, where an ES import cannot reach.
`src/peakbagger/peakbagger-page.js` uses the same mechanism for capture requests
that Cloudflare can reject from the worker while accepting from the signed-in
site. Its request API accepts only the canonical login page and bounded
summit-box endpoint. Its account-evidence API exposes only allowlisted global
navigation links from a freshly loaded canonical page; it never exposes cookie
values or arbitrary page text. The worker revalidates both result shapes.
Neither API is a general fetch, DOM, or module seam. Do not generalize these
exceptions.

## Dependency updates

Dependabot opens weekly grouped pull requests. npm updates merge without a
human once their checks pass, majors included; GitHub Actions updates wait for
review because they change CI and release machinery rather than extension code.
Four pieces carry that:

| Piece | Where |
| --- | --- |
| Schedule, grouping, cooldown | `.github/dependabot.yml` |
| npm auto-merge trigger and provenance gate | `.github/workflows/dependabot-auto-merge.yml` |
| Checks that must pass first | `.github/workflows/test.yml` |
| Enforcement of those checks | the `main` ruleset, in repository settings |

### Why the groups exist

Grouping is a correctness constraint, not tidiness. `@tiptap/*`,
`@codemirror/*`, and `@lezer/*` are released in lockstep and carry peer
relationships, so each family moves as a single pull request. A lone bump of one
member against an unchanged sibling is exactly the breakage grouping prevents.
The npm updater also uses `versioning-strategy: increase`: Dependabot raises the
minimum in every matching manifest range even when an older caret already
admits the release. That makes already-satisfied TipTap siblings visible to the
group instead of producing a partial family update that `npm ci` rejects on its
exact peer requirements.

Within npm, group membership no longer decides whether an update waits, since
none of those groups do. It decides how much of `dist/` one merge can move,
which is what you need when a release rehearsal fails and the cause has to be
attributed:

| Group | Reaches `dist/` via | Ships? |
| --- | --- | --- |
| `bundled-runtime` | bundled by esbuild | yes |
| `copied-runtime` | copied by `scripts/build-config.mjs` | yes |
| `tooling` | nothing; build and test only | no |
| `remaining-npm` | depends on the owning dependency path | inspect |
| `security-fixes` | depends on the vulnerable dependency path | inspect |

Both runtime groups are third-party code vendored with the extension in the
broad sense. Their names describe the packaging path: `bundled-runtime` modules
are imported into Better Peakbagger bundles, while `copied-runtime` packages
remain separately loaded browser builds under `dist/vendor/`.

Exact dependency versions have one owner: `package-lock.json`. Build and
release tooling derives `THIRD_PARTY_NOTICES.txt`, AMO approval notes, and
web-ext warning-owner labels from that lockfile. Maintained acknowledgements and
editor documentation intentionally name projects without copying their current
versions; the metadata test rejects reintroducing those redundant pins. The
web-ext gate still fails closed on warning code, output file, and occurrence
count, so version automation does not turn an added or disappeared warning into
an accepted one.

Every package is declared under `devDependencies`, so that field says nothing
about whether a package ships. The three named release-path groups do; updates
in either catch-all require tracing the package through its parent dependency.

Dependabot assigns a version update to the first matching group. The
`remaining-npm` wildcard therefore stays after the three release-path groups
and combines only otherwise unmatched direct and transitive updates. This
prevents separate incomplete lockfile repairs from deadlocking the global
zero-advisory check. `security-fixes` applies the same all-npm grouping to
security updates, which GitHub does not combine with ordinary version updates.

### What gates a release after an npm update

Nothing here publishes. A merge only updates `main`. The store release runs
solely from a manually pushed `vX.Y.Z` tag, and that tag sits behind the manual
rehearsal in [releasing.md](releasing.md)—real Chrome and Firefox profiles, a
live owned capture through the native toolbar action, native popup
presentation, Firefox for Android.

Copied-runtime changes now run both hardware-GPU terrain verifiers before the
stable Chrome and Firefox required checks can pass. The comparison reads the
resolved Chart.js, Marked, and MapLibre versions from the base and proposed
lockfiles; additions and removals count as changes, and an unreadable base fails
closed. The browser jobs refuse software WebGL and exercise the real copied
MapLibre modules in hidden Chrome and Firefox.

The release rehearsal remains a gate because those focused GPU checks do not
visually inspect the report editor, charts, native browser UI, or live provider
surfaces. A dependency that breaks layout outside the terrain fixture can still
pass automation—see
[What each check can and cannot see](#what-each-check-can-and-cannot-see). Such
an update should not reach a store, and skipping the rehearsal removes the last
human check in the chain.

GitHub Actions bumps are the exception the rehearsal does not cover at all. They
change what CI itself runs, including the release workflow holding the Chrome
workload-identity and AMO credentials, and the rehearsal exercises the
extension rather than the workflow that publishes it. They stay grouped and
carry a longer cooldown, but they do **not** auto-merge; inspect the action's
upstream change and the workflows it reaches before merging one.

### How the merge happens

1. Dependabot opens a pull request against `main`.
2. `dependabot-auto-merge.yml` runs on `pull_request_target`, so the privileged
   job comes from trusted `main`, not from the proposed merge commit. It never
   checks out, downloads, or executes the pull-request branch.
3. On every opened, reopened, or changed head, the job first clears any existing
   auto-merge request. It then asks GitHub for up to two commits and requires
   exactly one: the event's current head, authored by `dependabot[bot]`, with a
   verified signature. A hand-pushed commit therefore leaves the PR manual.
4. `dependabot/fetch-metadata` parses that verified Dependabot commit. Only an
   `npm` ecosystem result reaches `gh pr merge --auto --merge`, and the command
   uses `--match-head-commit` so the head cannot change between verification and
   queueing. GitHub Actions updates stop here for human review.
5. Queueing sets a flag and nothing more. GitHub merges once the `main` ruleset
   is satisfied, which means the pull request is current with `main` and the
   four stable required checks in `test.yml` have passed against that base. The
   Chrome check conditionally includes its copied-runtime GPU run; the stable
   Firefox check aggregates both matrix versions and its conditional GPU run.
   Dependabot cannot skip
   that: the ruleset's only bypass is the repository-admin role, which it does
   not hold.

The ruleset does not require a pull request, so ordinary work still commits
straight to `main`. Dependabot goes through a pull request because that is the
only way it proposes changes, and the required checks apply to its merge either
way. Merge commits are enforced in repository settings rather than by the
ruleset—squash and rebase merges are disabled.

### What still stops a bad merge

For npm updates, three automated controls remain:

- **The four required checks.** A bump that breaks the build, the tests, or
  either browser smoke never merges. A copied-runtime version change also has
  to pass hidden hardware-GPU terrain checks in both browsers before the Chrome
  and Firefox statuses succeed.
- **Cooldown.** npm version updates wait 3, 7, or 21 days by semver level, which
  lets an ecosystem find a bad release first. Security updates ignore cooldown
  by design and arrive immediately.
- **Complete branch provenance.** The trusted workflow resets stale auto-merge,
  requires a single verified Dependabot commit at the exact event head, and
  binds queueing to that SHA. `fetch-metadata` is retained for ecosystem parsing
  and a redundant first-commit check; it is not treated as an all-commit
  verifier because its implementation only checks the first commit.

GitHub Actions updates add a fourth control—a person—because the extension tests
cannot establish that a new action implementation handles release credentials
safely.

### Why the action pins are annotated the way they are

Every `uses:` line pins a full commit SHA and carries its version as a **trailing
comment on the same line**:

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

That position is load-bearing, not style. Dependabot rewrites the SHA and the
trailing comment together, but it will not touch a comment on the line above—so
annotations written above the pin silently claim a version the SHA no longer is.
This repository learned that on the first automatic Actions merge, which left
seven pins reading `v7.0.0` above a v7.0.1 SHA. Keep new pins in the trailing
form.

`browser-actions/setup-firefox` and `setup-geckodriver` are the exception.
Dependabot tracks them SHA-to-SHA and reports no version, so nothing it does can
maintain an annotation for them. Their comments stay above the pin and say so.
In every case the SHA is the truth and the comment is a hint.

### Turning it off

Delete `.github/workflows/dependabot-auto-merge.yml`. Every update then waits
for a human, and the checks are unaffected. To hold back one npm group instead,
add it to the merge-step condition, for example
`if: steps.metadata.outputs.dependency-group != 'bundled-runtime'`.

## What each check can and cannot see

- `npm test` builds `dist/` first and runs in jsdom. It evaluates
  the shipped bundles, but it does not exercise the real manifest — execution
  worlds, injection order, and the live service-worker lifecycle are invisible
  to it.
- `npm run test:scale` keeps the expensive 4,145-row ascent fixture,
  20,000-point GPX completeness case, and 1,500-entry favorite
  render/search/backup path out of the fast local loop. It still uses jsdom
  rather than a browser and does not impose a cross-machine timing threshold.
- `npm run lint` first checks undeclared names, unused bindings, and unsafe
  equality in source without rewriting it, then checks the built extension
  package. Neither lint stage establishes browser behavior.
- `npm run terrain:verify` and `npm run terrain:verify:firefox` render the true MapLibre
  frame on a reported hardware GPU, but their
  showcase pages provide their own settings/chrome stubs and their Mapterhorn
  requests are intercepted with a synthetic CORS-enabled DEM, so it does not run
  the real settings or bridge code or exercise the live terrain service.
- `npm run terrain:lod` measures which elevation level each visible pixel is
  actually drawn from, on the same real GPU frame, so the tilt detail behaviour is
  a number rather than an impression. It generates its own continuous DEM tiles
  and serves them at a fixed 140 ms delay, so it says nothing about live
  Mapterhorn latency or tile sizes — a decode-bound residual it reports may be
  smaller against Mapterhorn's WebP than against the fixture's PNG.
- `BPB_LOD_DRAPE` picks which of the two shipped drape LOD settings that run
  exercises: `L_OS` (the default, full `(4, 3)`) or `L_OT` (thrifty `(6, 1.5)`,
  what OpenTopoMap and every live Leaflet layer get). Run both when touching
  either constant pair — the gap between them is the reason there are two. Its
  per-pitch census counts are stable; the sweep traffic total is not, so compare
  levels-against-ceiling rather than totals.
- Every fixture server — the terrain verifiers, `terrain:lod`, and `showcase:render` — serves
  over **HTTPS on `www.peakbagger.com`**, with a self-signed certificate minted
  per run and deleted in teardown. This is a product constraint, not a
  preference: `src/peakbagger/peakbagger-request.js` refuses any URL that is not
  `https:` on a Peakbagger host, and the GPX Analyzer fetches its track through
  that guard. See *A plain-HTTP fixture breaks these checks* below.
- `npm run verify:browsers` loads the real Chrome and derived Firefox manifests.
  The isolated HTTPS fixtures exercise extension origins, execution worlds,
  worker/background startup, real storage, every manifest surface, store credit,
  report editing, filtering, the owner-only profile-backup entry point, tab
  grouping when supported, sender-bound draft handoff, native file assignment,
  exactly-once Preview, the no-Save boundary, a 1,500-entry favorite total and
  fuzzy search, a long settings-navigation jump, and native Buddy add/remove
  convergence under both removal policies. The profile-backup mount uses a
  fixture-only local credential and makes no GitHub request.
  Run it after touching `manifest.json`, bundle composition, execution worlds,
  the worker, or anything a content script relies on at load.
- `npm run verify:packages -- CHROME.zip FIREFOX.zip` runs those same gates against minified store bytes
  and additionally pins Chrome's full-tab versus Firefox's inline Preferences
  manifest presentation.
- CI additionally supplies exact `CHROME_BIN` and `FIREFOX_BIN` paths to run
  the same hidden verifier against Chrome for Testing 128 and Firefox 152.
  Current-browser success does not substitute for either declared desktop
  floor, and neither desktop run establishes Firefox Android behavior.

The real-extension and terrain checks are hidden/headless and use an isolated
test profile. They establish browser loading, DOM behavior, and (for terrain)
the reported WebGL renderer; they do not establish browser-chrome focus,
window placement, permission-prompt appearance, or live Garmin/Strava DOM and
export behavior. The full-profile suites script list/edit/GPX responses and
GitHub commits; they cannot prove live Peakbagger challenge markers or GitHub
session behavior. Live provider and profile-backup verification therefore
remains a minimal, rate-limited manual release check in both browser families.
The Buddy scenarios also use validated synthetic Peakbagger pages; they do not
prove current live control labels, authenticated cookies, or report markup.

The runners open ordinary extension pages in hidden tabs; they do not establish
native popup size, browser-chrome focus, permission-prompt presentation, or the
toolbar click that grants `activeTab`. Those remain explicit release checks.

### A plain-HTTP fixture breaks these checks

`src/peakbagger/peakbagger-request.js` refuses any URL whose protocol is not
`https:` or whose host is not `peakbagger.com`/`www.peakbagger.com`, before it
fetches anything. That guard is a security property and must not be relaxed to
suit a test. The GPX Analyzer fetches its track through it, so a fixture served
over `http://localhost` makes the extension refuse *its own fixture*:

- the analyzer panel renders **"Better Peakbagger refused an invalid Peakbagger
  request."** instead of the chart,
- the route never loads, so the 3D toggle stays disabled with its
  "Available after the GPX route loads" title,
- `terrain:verify` then times out on
  `Timed out waiting for page state: {"ready":false,"disclosureExists":false}`,
  `terrain:verify:firefox` on `Timed out waiting for Firefox terrain readiness`,
- and `showcase:render` succeeds while writing that refusal into the
  store-listing screenshots.

The failure looks like a broken renderer or a hung frame, and is neither. All
three scripts therefore mint a disposable self-signed certificate for
`www.peakbagger.com` with `openssl`, serve over `node:https`, map the hostname
to the local server (`--host-resolver-rules` in Chrome,
`network.dns.localDomains` in Firefox), accept the certificate for that launch
only, and delete the key and certificate in teardown.
`test/project/showcase.test.mjs` fails if any of them regresses to HTTP, and
also asserts the product-side refusal is still in force — the fixtures follow
the product, not the reverse.

`openssl` must be on `PATH`; the scripts fail with
`Could not create the isolated HTTPS fixture certificate` if it is not.

## Packaging and release rehearsal

`npm run package` first replaces `dist/` with a minified, sourcemap-free build,
then asks web-ext to create the canonical Chrome archive. Derive the Firefox
archive from that exact ZIP so only `options_ui.open_in_tab` differs:

```bash
npm run package
npm run build:firefox -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip
npm run release:verify-archive -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip chrome
npm run release:verify-archive -- web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip firefox
npm run verify:packages -- web-ext-artifacts/better_peakbagger-X.Y.Z.zip web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip
```

The archive verifier derives required runtime files from
`scripts/build-config.mjs`; it rejects stale raw-source layouts and missing
bundles/vendor licenses. See [Browser store releases](releasing.md) for version,
tag, credential, and live-verification requirements.
