# Development guide

Better Peakbagger is a Manifest V3 extension whose `src/` is written as **ES
modules** and bundled with **esbuild** into `dist/`. `dist/` is the extension:
it is what you load in a browser, what the release packagers zip, and what the
real-extension checks exercise. You never load the repo root directly.

If you worked on this project before the build step existed: the old model was
"build-free"—the browser loaded raw `src/*.js` IIFEs and extension modules
found each other through `globalThis.BPB*`. That is gone. Modules now use ES
imports. Third-party browser builds still expose their documented globals, and
the provider adapter has one deliberate cross-world API described below; no
Better Peakbagger module uses a global as an internal dependency.

## Prerequisites

- Node.js 22 or newer (CI uses Node.js 24) and npm.
- `npm ci` to install the exact dependency graph in `package-lock.json`
  (esbuild, runtime vendor packages, jsdom, Playwright, Selenium, and web-ext).
- For Chrome verification: `npx playwright install chromium` (Chrome for
  Testing — stable Chrome refuses `--load-extension`).
- For Firefox verification: Firefox Stable and `geckodriver` on `PATH`.
  `npx playwright install firefox` additionally installs the isolated Firefox
  build used by the GPU terrain check.
- OpenSSL. Each extension verifier creates a one-day self-signed certificate
  inside its disposable profile so the local fixture exercises the production
  HTTPS-only manifest.

## Everyday workflow

For test-driven work, edit source and run `npm test`; its `pretest` hook creates
a fresh development build before the suite.

For interactive browser work, use one of the managed development commands:

```bash
npm run start:firefox
npm run start:chromium -- --chromium-binary "/path/to/chrome-for-testing"
```

Without additional profile flags, each command makes the initial `dist/` build,
launches web-ext with a temporary browser profile, keeps esbuild watching the
source tree, and reloads the extension after every successful rebuild. Stop the
command with Ctrl+C; the watchers, browser process, and Firefox temporary source
are then cleaned up.

To keep site logins and browser settings across development sessions, give each
browser a dedicated persistent development profile:

```bash
npm run start:firefox -- \
  --firefox-profile "$HOME/.better-peakbagger-firefox-profile" \
  --profile-create-if-missing \
  --keep-profile-changes

npm run start:chromium -- \
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

The reload is transactional. A change rebuilds all browser bundles and copies
all runtime assets; only after every operation succeeds does the build change
the single file watched by web-ext. A syntax or copy error is printed but does
not reload the browser into a partly updated extension. Fix the error and save
again to retry.

Extension reload is not page reload. Content scripts already injected into an
open Peakbagger, Garmin, or Strava tab keep their old page instance, so refresh
that tab after the extension reloads. Reopening the popup or Preferences is
enough for those extension pages. The commands deliberately do not refresh
activity or ascent-editor tabs automatically, because that could discard page
state or interrupt a capture.

Do not run `watch`, either `start:*` command, and another build command in the
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

| Command | What it does |
| --- | --- |
| `npm run build` | One-off development build (unminified, source maps) into `dist/`. |
| `npm run build:release` | Minified production build (no source maps). |
| `npm run watch` | Transactionally rebuild on change and re-copy static assets; does not launch or control a browser. |
| `npm test` | `pretest` builds `dist/`, then runs `test/**/*.test.mjs`. |
| `npm run verify:chrome` | Builds and loads the real unpacked `dist/` in hidden Chrome for Testing. |
| `npm run verify:firefox` | Builds the derived Firefox source, temporarily installs it in hidden Firefox, and runs the same manifest-surface and draft-handoff smoke. |
| `npm run verify:browsers` | Builds once, then runs the Chrome and Firefox extension gates. |
| `npm run verify:extension` | Compatibility alias for `verify:chrome`; existing callers can migrate without losing coverage. |
| `npm run verify:packages -- CHROME.zip FIREFOX.zip` | Executes the extracted minified Chrome package and the exact generated Firefox archive through the browser gates. |
| `npm run terrain:verify` | Renders the real MapLibre terrain frame on Chrome's GPU with synthetic route, basemap, peak, and CORS-enabled DEM fixtures. |
| `npm run terrain:verify:firefox` | Runs the focused Firefox GPU terrain/interaction check and refuses software WebGL. |
| `npm run showcase:render` | Builds and renders the local UI showcase fixtures. |
| `npm run lint:js` | Runs errors-only ESLint over source, extension surfaces, scripts, and tests. |
| `npm run lint` | Builds, then runs `web-ext lint --source-dir dist`. |
| `npm run package` | Release build + `web-ext build` from `dist/`; writes the canonical Chrome ZIP under `web-ext-artifacts/`. |
| `npm run start:chromium` / `start:firefox` | Build, watch, launch a web-ext development browser, and auto-reload the extension after successful rebuilds. Firefox mirrors each complete build into its inline-Preferences source first. |

Pushes and pull requests use one least-privilege workflow with three independent
jobs: Node tests/lint, the real Chrome extension smoke, and the real Firefox
extension smoke. Each browser job installs its own runtime and reports failures
separately. Release CI additionally executes both generated store archives
before either publication job can start.

Chrome stable 137+ rejects command-line `--load-extension`, so
`start:chromium` needs a compatible Chromium/Chrome for Testing binary (pass
web-ext's `--chromium-binary` after `--`) or it will fail. Manual **Load
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

Every manifest entry point (the service worker, each content script, the
options and popup pages, the terrain frame) is bundled into one self-contained
**IIFE** file. Browsers cannot load an ES module as a classic content script, so
the ESM source is bundled down to a classic script per entry.

ES imports determine dependency evaluation order. The source order in an
`ENTRIES` record matters only where independent side-effect roots intentionally
run in sequence; tests pin those compositions. Separately loaded third-party
UMD scripts remain ordered by `manifest.json` or `terrain/terrain.html`.

`dist/` layout:

```
dist/
  ACKNOWLEDGEMENTS.md, LICENSE, README.md
  manifest.json            # copied from the repo-root manifest.json
  background.js            # the MV3 service worker (one bundle, both browsers)
  provider-page.js         # injected on demand into provider pages
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

1. Write `src/foo.js` as an ES module: `export` what other modules need, and
   `import` your own dependencies. Do **not** publish a `globalThis` global.
   - Modules that only run for side effects and need an early `return` (e.g. "no
     matching DOM, do nothing") may keep a small `(() => { … })()` IIFE for
     control flow. That is fine as long as they publish no globals.
2. Add the module to the relevant bundle(s) in `scripts/build-config.mjs`
   `ENTRIES` as an explicit root. A module can appear in several bundles;
   esbuild follows and deduplicates imports within each bundle.
3. If it's a brand-new entry point (a new content script, page, or worker), add
   an `ENTRIES` record **and** wire it into `manifest.json` (or the page HTML).
4. Add focused coverage and run `npm test`.
   `test/manifest-capture.test.mjs` cross-checks that every manifest bundle
   reference is a declared build output and pins security-sensitive bundle
   composition.

For a new copied HTML, CSS, or root file, add a `[source, destination]` pair to
`COPY_FILES`. Add an asset directory to `COPY_DIRS` only when the whole tree is
runtime material. A file that exists in the repository but is absent from the
build config does not ship.

### Testing a module

- **Pure logic** (no DOM/chrome/vendor globals): `import` it directly in a
  `test/*.test.mjs` and call it. Set any ambient browser global the module reads
  (`DOMParser`, `location`, …) from a throwaway jsdom.
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

- **marked, Chart.js, MapLibre** ship browser builds that are copied verbatim
  (with their LICENSEs).
- **tz-lookup** ships only CommonJS, so the build esbuild-wraps it into a
  `tzlookup` browser global.

These stay **separately-loaded browser globals** (`Chart`, `tzlookup`,
`maplibregl`, `marked`) rather than being bundled into the modules that use
them, because the manifest loads them as their own scripts and some code paths
degrade gracefully when a vendor global is absent. "Zero globals" means no
Better Peakbagger module uses a global as an internal dependency; it does not
refer to third-party UMD APIs or the provider boundary below.

To add or update a runtime dependency:

1. Run `npm install --save-dev <pkg>@<version>` and commit both package files.
2. Import an ordinary bundled dependency from the consuming module. For a
   separately loaded browser build, add its npm path, destination, and license
   to `VENDOR_COPY`; use an esbuild wrapper like `VENDOR_TZ` only when an entry
   must stay a separate global.
3. Update `ACKNOWLEDGEMENTS.md` and Firefox review metadata when distributed
   third-party code or its version changes.
4. Run `npm test`, the relevant real-browser check, and `npm run package` when
   packaging paths or vendor outputs changed.

### The intentional provider API

`src/provider-page.js` publishes `globalThis.BPBProviderPage`. That is a narrow,
deliberate boundary rather than a module dependency: `background.js` injects
the built adapter into a provider page, then injects inline functions that call
the API across the worker→page boundary, where an ES import cannot reach. Do not
generalize this exception.

## What each check can and cannot see

- `npm test` runs in jsdom. It builds `dist/` first (`pretest`) and evaluates
  the shipped bundles, but it does not exercise the real manifest — execution
  worlds, injection order, and the live service-worker lifecycle are invisible
  to it.
- `npm run lint:js` checks undeclared names, unused bindings, and unsafe equality
  without rewriting source. `npm run lint` checks the built extension package;
  neither establishes browser behavior.
- `npm run terrain:verify` and `npm run terrain:verify:firefox` render the true MapLibre
  frame on a reported hardware GPU, but their
  showcase pages provide their own settings/chrome stubs and their Mapterhorn
  requests are intercepted with a synthetic CORS-enabled DEM, so it does not run
  the real settings or bridge code or exercise the live terrain service.
- `npm run verify:browsers` loads the real Chrome and derived Firefox manifests.
  The isolated HTTPS fixtures exercise extension origins, execution worlds,
  worker/background startup, real storage, every manifest surface, store credit,
  report editing, filtering, tab grouping when supported, sender-bound draft
  handoff, native file assignment, exactly-once Preview, and the no-Save boundary.
  Run it after touching `manifest.json`, bundle composition, execution worlds,
  the worker, or anything a content script relies on at load.
- `npm run verify:packages -- CHROME.zip FIREFOX.zip` runs those same gates against minified store bytes
  and additionally pins Chrome's full-tab versus Firefox's inline Preferences
  manifest presentation.

The real-extension and terrain checks are hidden/headless and use an isolated
test profile. They establish browser loading, DOM behavior, and (for terrain)
the reported WebGL renderer; they do not establish browser-chrome focus,
window placement, permission-prompt appearance, or live Garmin/Strava DOM and
export behavior. Live provider verification remains a minimal manual release
check in both browser families.

The runners open ordinary extension pages in hidden tabs; they do not establish
native popup size, browser-chrome focus, permission-prompt presentation, or the
toolbar click that grants `activeTab`. Those remain explicit release checks.

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
