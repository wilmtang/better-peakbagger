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
  On macOS, run browser checks outside Codex's Seatbelt sandbox through its
  approved execution path. Headless Chrome still registers with macOS and can
  abort during a sandboxed launch, causing a visible system crash dialog.
  Repository verifiers use `scripts/chrome-launch-guard.mjs` to stop that
  launch before Chrome starts. Keep test profiles isolated and Chrome hidden;
  do not disable the system's crash reporting.
- For Firefox verification: Firefox Stable and `geckodriver` on `PATH`.
  `npx playwright install firefox` additionally installs the isolated Firefox
  build used by the GPU terrain check. On macOS this check selects ANGLE Metal
  and verifies the unsanitized hardware renderer before loading terrain; native
  OpenGL on hosted virtual Macs can stall past the production startup deadline.
- OpenSSL. Every browser fixture server — both extension verifiers, both
  terrain verifiers, and `showcase:render` — creates a one-day self-signed
  certificate in a disposable directory and deletes it in teardown, so the local
  fixture is served over HTTPS on a real Peakbagger hostname. That is required
  by the product, not a formality: `src/peakbagger/peakbagger-request.js`
  refuses any other origin.

## Shared UI/UX skill

The repository includes [UI UX Pro Max](../.agents/skills/ui-ux-pro-max/SKILL.md)
for interface design, accessibility, interaction, and layout reviews. Codex and
Gemini CLI discover it in `.agents/skills/ui-ux-pro-max/`; Claude Code discovers
the same copy through `.claude/skills/ui-ux-pro-max`, a relative symlink. The
skill defers to the project rules in `AGENTS.md`.

It is available to Codex on the next turn. Start a fresh Claude Code or Gemini
CLI session if an existing session has not discovered it. Ask any agent to
"use ui-ux-pro-max to review the popup UX"; in Claude Code you can also invoke
`/ui-ux-pro-max`.

Its local search helper requires Python 3 and no third-party Python packages.
For example, from the repository root:

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "keyboard focus modal" --domain ux
```

The upstream revision, license, and local adaptations are recorded in
[UPSTREAM.md](../.agents/skills/ui-ux-pro-max/UPSTREAM.md). Update the canonical
copy and preserve its Claude Code symlink rather than maintaining separate
versions for each agent.

## Source and test layout

Runtime modules are grouped by the behavior they own. The directory is an
ownership boundary for maintainers; esbuild bundles may still import modules
from several directories when a shipped surface crosses those boundaries.

| Directory | Ownership |
| --- | --- |
| `src/ascent/` | Ascent form filling, filtering, snapshots, upload, and backup of saved ascents and TRs |
| `src/background/` | Extension service-worker coordination |
| `src/capture/` | Provider adapters, ownership checks, and pure capture analysis |
| `src/favorites/` | Climber-list schemas, shared favorite source, profile controls and conservative report adapters |
| `src/github/` | GitHub authentication, API transport, repository writes, and backup payloads |
| `src/gaia/` | Gaia's visible import adapter and optional-access fallback page |
| `src/onx/` | onX Backcountry import adapter and optional-access fallback page |
| `src/caltopo/` | CalTopo file-import adapter and optional-access fallback page |
| `src/alltrails/` | AllTrails custom-route upload adapter and optional-access fallback page |
| `src/gpx/` | Shared GPX parsing, saved-track validation, metrics, and ascent-page analysis |
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

## Browser failure evidence

CI retains browser logs and available terrain screenshots for seven days when
one of the browser jobs fails. The full Chrome verifier also records up to three
fixture-page screenshots with form fields masked, bounded pending/failed fixture
requests, and structural page state. Firefox records its current fixture's
structural state without changing the failed document to mask a screenshot.
Queries, fragments, credentials, form values, storage, and request bodies are
excluded. These diagnostics run before teardown and cannot make a failed check
pass. For local diagnosis, set `BPB_VERIFY_ARTIFACTS` to an output directory;
use this only with the isolated fixture verifiers.

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
| `npm run test:scale` | Exercises the 4,145-row ascent fixture, a complete 100,000-point/5,000-peak cooperative capture analysis, 100,000-point provider parsing, and the full 1,500-entry favorite manager/search/backup path; CI and release checks run these separately from the fast default suite. |
| `npm run verify -- TARGET [arguments]` | Runs a named verification target; see the target reference below. Builds once first, except when checking supplied package archives. Use `npm run verify -- --help` to list targets. |
| `npm run lint` | Runs ESLint over source, page-local surfaces, scripts, and tests; then builds and runs `web-ext lint` against `dist/`, accepting only the owner-reviewed warning baseline. |
| `npm run audit:ci` | Requires zero advisories by default, including development dependencies. Ordinary Test CI and store releases explicitly opt into one owner-reviewed, exact-path node-forge exception through October 30, 2026; all other advisories remain rejected. See [releasing](releasing.md) for the policy and the [integration ledger](archive/mainline-dependency-integration-2026-10-03.md) for the original review. |
| `node scripts/verify-layout-stability.mjs --surface=timestamps` | After a build, checks local-file timestamp removal, per-file keyboard exceptions, busy/failure recovery, capture exceptions and Options presentation in hidden Chrome/Firefox at 390×900 and 1280×900, light/dark, 100% and simulated 150% zoom using a scaled CSS viewport and device pixel ratio. APIs and summit lookup are stubbed; no live Save or account sync. `BPB_JITTER_ARTIFACTS` retains screenshots. To prove pre-feature failure without changing the worktree, set `BPB_TIMESTAMP_BASELINE` to a full earlier commit SHA; the expected failure is timestamps still attached to the native upload. |
| `node scripts/verify-layout-stability.mjs --surface=ascent-columns` | After a build, checks a native summary table containing the route map, with a saved 900px map preference, against the shipped layout/analyzer/weather bundles. Hidden Chrome/Firefox cover 390×900 and 1280×900, light/dark, and simulated 150% zoom at 260×600 and 853×600. Asserts aligned table/GPS/weather edges, no horizontal overflow, keyboard divider extremes, and stable geometry/scroll during held weather refresh and retry; error details may deliberately expand. Storage, Leaflet and provider responses are stubbed; no manifest/worker or native window-focus proof. `BPB_JITTER_ARTIFACTS` retains screenshots. The assertion failed on the original auto-layout table before the summary-only fixed-layout rule. |
| `node scripts/verify-report-draft-ownership.mjs` | After a build, exercises two editors against one real worker in hidden Chrome: untouched exits and conflicting edits preserve the newest draft. `BPB_DRAFT_OUTPUT` retains desktop/light and narrow/dark conflict screenshots. |
| `node scripts/verify-report-photos.mjs` | After a build, checks paste, local editing, fixture-owned ImgBB upload, native form resumption, and the acknowledged In report library badge in hidden Chrome. No live upload or server Save proof. |
| `node scripts/verify-layout-stability.mjs --surface=captions` | After a build, checks caption entry, typing, acknowledged autosave, repeated clicks, clearing and keyboard entry against the shipped editor bundles and masked native form in hidden Chrome/Firefox at 390×900 and 1280×900, light/dark, with normal and 150% editor text. Samples viewport, editor scroll, photo, caption, surrounding panel and native form geometry through each transition (1px rounding tolerance), including compact reports and a final image. Storage, worker write acknowledgements, and image bytes are stubbed; no live Save or native window-focus proof. `BPB_JITTER_ARTIFACTS` retains screenshots. |
| `node scripts/verify.mjs map-layers` | Compact collapse/row geometry in hidden Chrome at 736/320 pixels, light/dark; then the real extension and pinned Leaflet on ascent, peak, Full Screen and standalone maps. Checks independent rasters, overlap pixels at 0/50/100% with a failing naive-alpha negative control, one-use Full Screen state/pass handoff, SNOTEL, and hardware MapLibre capture selection/suspend/resume. The component verifier also checks native basemap dark/light updates, keyboard focus and stable geometry at 1280/375 × 800 and desktop 200% CSS zoom; `node scripts/verify-map-layer-control.mjs --firefox` runs it in Firefox. Its storage and native map are stubbed; OS dropdown rendering is not proven. `BPB_LAYER_SCREENSHOT_DIR` retains component renders and `BPB_VERIFY_LAYERS_SCREENSHOT_DIR` retains integration renders. |
| `npm run showcase:render` | Builds and renders the local UI showcase fixtures into `store-assets/`. Same HTTPS showcase host. |
| `npm run package` | Release build + `web-ext build` from `dist/`; writes the canonical Chrome ZIP under `web-ext-artifacts/`. |
| `npm run build:firefox -- CHROME.zip FIREFOX.zip` | Derives the Firefox store ZIP from the verified Chrome ZIP, changing only Firefox-specific manifest presentation. |
| `npm run release:bump X.Y.Z` | From a clean synchronized `main`, validates and stamps release metadata and the UTC changelog date; deliberately creates no commit or tag before verification. |
| `npm run release:check -- vX.Y.Z` | Validates an exact release tag, synchronized versions, stable Gecko identity, store description, and changelog heading. |
| `npm run release:preflight -- vX.Y.Z --ci-run ID --rehearsal-run ID` | Read-only pre-tag gate: pins successful CI, fresh consecutive rehearsal passes, archive hashes and publication safeguards to clean synchronized main. Emits a receipt; creates no tag or submission. |
| `npm run release:check-history` | Fails when already-released changelog sections or tags have been rewritten; CI runs it with full Git history. |
| `npm run release:check:firefox-version -- X.Y.Z --require-unused` | Authenticates to AMO for a read-only exact-version lookup and fails unless the Firefox version is unused; both release and guarded Firefox-only recovery workflows run it before submission. |
| `npm run release:metadata:firefox` | Converts the canonical store description into the AMO metadata JSON used for submission. |
| `npm run release:sign:firefox` | Submits the prepared Firefox source to AMO with the release environment's credentials and metadata. |
| `npm run release:verify-archive -- ARCHIVE.zip BROWSER` | Checks a Chrome or Firefox archive for required runtime files, licenses, browser-specific manifest policy, and forbidden development artifacts. |
| `npm run release:verify-packages` | Builds, derives, validates, and executes both exact store archives. The shared CI/release action additionally checks popup and capture flows against that minified build. |
| `npm run store:description:chrome` | Regenerates Chrome's checked-in plain-text listing from the canonical Markdown description. |

### Verification targets

Pass one target after `npm run verify --`. Arguments after the target go to each
selected verifier; there is no second npm `--` separator. For example:

```sh
npm run verify -- browsers
npm run verify -- layout-stability --surface=maps --firefox-only
npm run verify -- capture-readiness firefox
npm run verify -- terrain firefox
npm run verify -- terrain chrome /private/tmp/bpb-terrain-evidence
npm run verify -- packages CHROME.zip FIREFOX.zip
```

`terrain` alone selects Chrome; use `terrain chrome` when supplying an output
directory. Weather and inline-buddy targets run Chrome and Firefox sequentially.
The `packages` target checks existing archives without rebuilding `dist/`;
`release:verify-packages` creates and checks fresh store packages. Missing or
unknown targets fail before any build or browser launch. Gaia and onX coverage
is part of `map-handoffs`.
The [script inventory](../scripts/README.md) groups executable drivers and shared
case/fixture modules; imported diagnostics are retained when a current runner
uses them.

| Target | What it checks |
| --- | --- |
| `garmin` | Builds and checks Garmin connection, inbox and popup in hidden Chrome and Firefox. Covers rejected keys, range descriptions, dismissal Undo, refreshed matches, draft-opening recovery and stable pending/error controls at 1180/390px, both themes and 200% CSS zoom. Uses shipped UI with stubbed permissions and provider/session replies; native permission prompts and live sessions remain separate checks. |
| `capture-popup` | Builds and opens the real Chrome toolbar popup without a viewport override; asserts 390px sizing in light/dark over tabs at 100% and 200% zoom. Also renders every recovery family in hidden Chrome and Firefox at 390×600 CSS pixels, including 2x pixel density, asserting one action and no clipping. Runs in CI; does not prove visible chrome or focus. |
| `layout-stability` | Builds and checks state-dependent action geometry across eighteen surface groups in hidden Chrome and Firefox at 390×900 and 1280×900, light/dark. Uses controlled pending/error/retry/completion responses, repeated progress and enlarged-text cases; movement tolerance is one CSS pixel. Set `BPB_JITTER_ARTIFACTS` to retain screenshots or pass `--surface=maps` after the target for one group. The `settings-actions` and `photo-backup` groups run shipped page code with held replies, checking keyboard focus, duplicate activation, deliberate focus changes, restore confirmation and doubled control text. Text scaling does not establish native zoom. These HTTPS fixtures load shipped assets and selected component layouts; run `verify -- browsers` separately for real manifest/worker proof. |
| `gpx-header` | Builds and checks the real extension's compact GPX header in hidden Chrome at 1600×900, 800×900 and 390×900, light/dark, including doubled panel text and segment review controls. Samples series-toggle geometry through keyboard and pointer activation (1px tolerance). GPX and map APIs use HTTPS fixtures; no live provider or native focus proof. Set `BPB_VERIFY_GPX_HEADER_ARTIFACTS` to retain screenshots. The shared header checks also run in `browsers`, including Firefox. |
| `multi-summit` | Verifies sequential Preview and simulated manual Save for multiple summit drafts in hidden Chrome, with isolated HTTPS Peakbagger fixtures. Checks complete GPX retention, shared trip identity, and session payload cleanup. |
| `draft-recovery` | Checks slow preparation, rollback, repeated errors, keyboard reload and Preview recovery in hidden Chrome and Firefox at 390 and 1000 by 760, light/dark and 100%/200% CSS zoom. Compares Save, heading, following content, scroll and recovery-action geometry. Uses the native HTTPS form fixture and shipped bundle; worker replies and the native Preview postback are stubbed. `BPB_DRAFT_RECOVERY_ARTIFACTS` retains screenshots. |
| `inline-buddies` | Builds and runs the real extension in hidden Chrome for Testing and Firefox against the masked HTTPS Buddy form. Each browser verifies six inline/native Add/Remove POSTs, cross-tab Buddy/Ignore protection, custom-favorite reconciliation, and card containment at 1000×760 light and 320×760 dark. Set `BPB_BUDDY_SCREENSHOTS` to retain screenshots; add `--firefox` to `node scripts/verify-inline-buddies.mjs` for Firefox alone. No live account is changed. |
| `signed-out` | Builds and checks peak/full-list Buddy recovery and transient retry in hidden Chrome/Firefox at 375/1000×900, light/dark, CSS zoom 1/2. Covers held reads, repeated errors, success, duplicate Enter/Space, focus and action/heading/scroll geometry. Uses native HTTPS fixtures and shipped bundles with explicit storage/network stubs; `browsers` separately checks real-manifest signed-out Buddy recovery and local Favorite persistence through the actual worker. Add `--browser=chrome` or `--browser=firefox` for one renderer; `BPB_SIGNED_OUT_SCREENSHOTS` retains screenshots. CSS zoom does not prove native browser zoom. |
| `capture-flow` | Exercises the unmodified extension in current hidden Chrome through its actual toolbar action: temporary provider access, Garmin/Strava exports, summit lookup, results, draft Preview, privacy gates, outage retry, cancellation/restart, popup reopening, and track deletion. All sites are isolated HTTPS fixtures; no live provider compatibility or native focus is established. |
| `capture-readiness` | Builds and runs the real capture worker and Peakbagger helper in hidden Chrome and Firefox with a permanently pending page image and delayed helper navigation. Verifies that login can complete and that signed-out sessions still block GPS export. Uses a fixture provider adapter and isolated HTTPS origins; pass `chrome` or `firefox` after the target for one browser. |
| `provider-contracts` | Builds and runs the sanitized provider ownership, SPA navigation, Garmin session-mode, export, redirect, rate-limit, and challenge corpus in hidden Chrome for Testing and Firefox at intercepted Garmin/Strava HTTPS origins. No provider request leaves the browser. |
| `provider-performance` | Builds and measures 1,000-, 5,000-, 20,000-, and 100,000-point provider GPX parsing, a 100,000-point Garmin-shaped export with extensions, and over-limit rejection in hidden Chrome for Testing and Firefox at 1280×720. It blocks all network traffic and reports the exact browser versions and timings. |
| `map-handoffs` | Loads the real unpacked extension in hidden Chrome for Testing against masked Peakbagger, Gaia, onX, AllTrails, and CalTopo HTTPS fixtures; verifies exact saved-GPX handoffs, shared placement, manual Save/Import/Upload, membership and uncertain states, storage exclusion, and light/dark rendering. The disposable manifest grants the four map hosts because hidden automation cannot inspect native permission prompts. |
| `api-rate-limits` | Hidden Chrome with the real extension and refused fixture responses: GitHub device authorization, ignored-climber lookup and hover-card Ignore. Checks readable errors at 375/1000 pixels in light/dark; no live provider write. |
| `ascent-backup-lifecycle` | Hidden Chrome against an HTTPS ascent fixture and stubbed GitHub. Requires the exact BFCache document to restore its pending check, one backup control and zero writes; 1000×760 and 390×760. |
| `peak-map-layout` | Hidden Chrome, external requests blocked: Sun & Moon geometry through dates/times at 1280/780/640/390/320 pixels in light/dark, plus keyboard/drag resize, continuous viewport sizing, persistence and reset. |
| `weather-intervals` | Hidden Chrome with intercepted weather responses at 1440×1000. Nepal's 45-minute civil-day boundaries must produce 25 displayed intervals summing to exactly 24 mm, with truthful boundary labels and keyboard reading. `BPB_WEATHER_INTERVALS_OUTPUT` retains the render. Other weather cases stay in `weather`/`peak-weather`. |
| `weather` | Builds and checks the real weather bundle in hidden Chrome and Firefox at 375, 681, 768 and 1440 pixels, with HTTPS ascent fixtures, saved column and within-column placement, pointer/keyboard moves and move menus, preview geometry, GPX/no-GPX/no-map, long reports, divider resizing, light/dark, loading, model selection, partial data and errors. Set `BPB_VERIFY_WEATHER_SCREENSHOT_DIR` to retain card and page screenshots. For one optional public-summit live CORS probe, run `node scripts/verify-ascent-weather.mjs --live` (add `--firefox` for Firefox). |
| `peak-weather` | Builds and checks the real peak weather bundle in hidden Chrome and Firefox at 375, 768 and 1440 pixels: right-column placement, forecast/past period switching from one response, full-day forecasts, responsive hourly graphs, data tabs, keyboard disclosure/sampling, click cursor, conditions timeline, no map, light/dark, loading, partial/empty data and failed refresh. The native fixture retains its existing minimum page width; the 375-pixel check verifies the card and charts fit without widening that layout. Set `BPB_VERIFY_WEATHER_SCREENSHOT_DIR` to retain screenshots. One optional public-summit live CORS probe: `node scripts/verify-ascent-weather.mjs --peak --live`. |
| `snow` | Real unpacked extension in hidden Chrome and Firefox, HTTPS Peakbagger fixtures and intercepted NRCS responses. Checks initial/pending/error/retry geometry, keyboard station selection and Refresh, missing data, rate limits, mapless/long-name layout, settings and 200% browser zoom at 375/681/1440 pixels in light/dark. Set `BPB_VERIFY_SNOW_SCREENSHOT_DIR` for screenshots. See [nearby-snow.md](nearby-snow.md) for proof limits. |
| `snow-map` | Real unpacked extension in hidden Chrome and Firefox with pinned Leaflet, intercepted NRCS JSON and synthetic non-flat DEM. Checks compact toggle stability at 375/1440 pixels, light/dark, 200% zoom, pending/cancel/retry, keyboard popups, frame reload, 2D/3D switching, parked-frame reuse and settings. Requires hardware WebGL. Set `BPB_VERIFY_SNOW_MAP_SCREENSHOT_DIR` for screenshots. See [nearby-snow.md](nearby-snow.md). |
| `peak-cards` | Real unpacked extension in hidden Chrome and Firefox at 375/1440 pixels, both themes and 200% zoom. Requires the BPB map links after column initialization and navigation; checks wrapping and stable keyboard focus. Exercises automatic weather/snow units, card collapse, column resizing, cross-column and within-column keyboard/pointer movement, move menus, Escape, drag preview stability, edge autoscroll, saved order/disclosures on navigation, closed pending/error states and feature off/on. Provider responses are intercepted. Set `BPB_VERIFY_PEAK_CARDS_SCREENSHOT_DIR` for screenshots. |
| `peak-card-placement` | Real unpacked extension in hidden Chrome and Firefox at 375/1440 pixels, both themes and 200% zoom. Checks moving above/below native peak details by keyboard, move menu and pointer; retained focus, cancellation, stable previews, expanded cards and restored placement. Runs separately from `peak-cards` to stay within browser sync-write quotas. Uses the same intercepted providers and screenshot variable. |
| `weather-interactions` | Real unpacked extension in hidden Chrome and Firefox at 375/1440 pixels, both themes, 100/200% tab zoom. Holds Refresh and individual model metadata responses, checks Enter/Space and immediate pointer activation, request counts, focus through failure/retry/success and model cooldown, deliberate focus changes, delayed/unavailable metadata, action/panel/following-card geometry and reading position (1 CSS px rounding tolerance). Providers are intercepted. `BPB_VERIFY_WEATHER_LOCALE=de-DE` checks German Intl formatting (Firefox uses its isolated test locale service; browser chrome translation is not tested). Set `BPB_VERIFY_WEATHER_INTERACTIONS_SCREENSHOT_DIR` for screenshots. |
| `map-controls` | Hidden Chrome and Firefox on HTTPS showcase fixtures with shipped map bundles and hardware MapLibre rendering. Checks mode-button bounds and surrounding map/scroll through loading, cancel, active, return, renderer failure and retry on Peak, Ascent and both route/peak Big Maps at 1280/375 × 1000, light/dark. Storage, activation and provider data are stubbed; this does not prove native browser focus or window placement. The Ascent panel's existing error detail may deliberately expand once; the button and map must stay fixed and retry restores the panel. Set `BPB_VERIFY_MAP_CONTROLS_ARTIFACTS` for screenshots; use `node scripts/verify-map-controls.mjs --firefox` for Firefox alone. |
| `chrome` | Builds and loads the real unpacked `dist/` in hidden Chrome for Testing, including trusted GPX selection, draft handoff, 1,500-row favorite management, long settings navigation, and native Buddy synchronization. |
| `firefox` | Builds the derived Firefox source, temporarily installs it in hidden Firefox, and runs the same manifest-surface and feature smoke. |
| `browsers` | Builds once, then runs the Chrome and Firefox extension gates. |
| `packages CHROME.zip FIREFOX.zip` | Executes the extracted minified Chrome package and the exact generated Firefox archive through the browser gates. |
| `terrain` | Renders the real MapLibre terrain frame on Chrome's GPU with synthetic route, basemap, peak, and CORS-enabled DEM fixtures. Serves the showcase over HTTPS on `www.peakbagger.com`; needs `openssl`. |
| `terrain firefox` | Runs the focused Firefox GPU terrain/interaction check and refuses software WebGL. Includes inherited/explicit Sentinel capture resume, loaded source identity and desktop/narrow light/dark warning geometry. Uses instrumented fixture authorization/storage, distinct from the real-manifest check. Same HTTPS showcase host. |
| `terrain cache-owners` | Uses two same-origin frames in hidden Chrome for Testing and Firefox to verify that distinct and identical DEM writes share one CacheStorage budget and one exact index. This is a non-rendered Web Locks/storage check. |
| `terrain lod` | Measures painted elevation provenance across a cold-cache tilt sweep and 20 fixed-angle Rainier zoom cases, with local delayed DEM tiles and elevation/drape traffic counts. Same HTTPS showcase host and GPU rules as `verify -- terrain`. |

For a focused provider-feedback check, run
`npm run verify -- terrain chrome --provider-ui` or
`npm run verify -- terrain firefox --provider-ui`. Each uses
real hidden GPU rendering with eight credit layouts and eight held-tile → HTTP
403 → keyboard retry → rendered-map paths: 800/320px maps, both themes and
normal/enlarged text. It checks focus, feedback visibility, control overlap,
and action/map/following-content geometry within one CSS pixel. A held vector
style checks pending selection and neutral loading feedback. Provider responses
and extension activation/storage are fixtures; native windows, browser menus
and live provider enforcement remain separate proof. Unknown selections fail.

When diagnosing OSM warning-image tiles, leave DevTools **Disable cache**
unchecked during an ordinary-use capture. Cache bypass reproduced the reported
block, and disabling that option restored the user's 3D map. The raster path
leaves HTTP caching and request identity with the browser; changing the tile
transport or spoofing headers is not an established fix. See the
[policy/recovery closure ledger](plans/2026-10-24-osm-terrain-policy.md).

Ordinary Test CI runs `snow`, `peak-cards`, `peak-card-placement` and `weather-interactions` per browser after the generic
layout matrix, reusing its completed `dist/` build. A separate always-run
`snow-map` matrix uses hardware GPU runners. Both feed the required Chrome
aggregate, so a failure or skipped matrix cannot appear successful. These
surface verifiers check the launched browser against setup's exact version and
retain bounded fixture-only failure state before teardown when
`BPB_VERIFY_ARTIFACTS` is set; provider requests remain intercepted.

Set `BPB_VERIFY_REPETITIONS=3` for consecutive exact-package verification with
fresh profiles and the same archive bytes. All repetitions must pass, including
teardown; a failed assertion stops the run rather than being retried. The manual
release rehearsal defaults to three for current and floor browsers. CPU scale
sampling is separate and always retains all three measured samples.

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

The managed Firefox loop derives its Firefox-specific source in a sibling
candidate directory, validates that complete generation, and publishes it with
the same rollback-capable directory swap as `dist/`. A failed copy, manifest
transformation, validation, or publication leaves the prior tree and reload
token unchanged.

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

### Peak planning link order

The **Better Peakbagger links** panel on `Peak.aspx` is rendered by
`src/maps/peak-links.js`; `src/maps/peak-link-order.js` owns grip dragging,
keyboard movement, cancellation, and persistence. The saved `peakLinkOrder`
contains link IDs only, with its allowed IDs and default order defined by
`PEAK_LINK_ORDER` in `src/settings/settings-schema.js`.

The order is an extension setting in `chrome.storage.sync`, so it can follow
the browser profile across devices when browser sync is enabled. It is also
included in **Settings → Backup & sync → Settings backup → Export settings**
and in the GitHub `settings.json` backup. Importing or restoring either file
restores the order. GitHub writes require a connected repository and either
**Back up settings** or **Keep settings backed up automatically**; storing an
order in browser sync does not by itself establish a GitHub backup.

When adding or changing a planning link:

1. Give the link a unique, stable key in the `addLink(key, label, description,
   href)` call in `src/maps/peak-links.js`, and register that same key in
   `PEAK_LINK_ORDER`. Adding markup alone does not make its order persist.
2. Keep existing keys unchanged when editing labels or destinations. A renamed
   key is treated as a removed link followed by a new link, losing its saved
   position. Set the default position for the new key in `PEAK_LINK_ORDER`.
3. Preserve the schema's order normalization: keep recognized saved IDs in
   their existing sequence, remove duplicates and unknown IDs, then append
   recognized IDs missing from the saved array. Existing users therefore get
   new links at the end of their saved order, even if the new default places
   them elsewhere. Users without a saved order get the current default.
4. Keep temporarily unavailable services registered in the schema. The
   controller replaces only visible slots when saving, retaining positions
   for links hidden by country. The first forecast uses the `avalanche` slot
   across countries; additional border-peak sources use `avalanche-2` through
   `avalanche-8`. These are forecast positions rather than provider identities.
   Remove a key from the schema only when the link is permanently retired.

Older files containing `peakLinkOrder` receive newly registered IDs at the end
when imported by the newer extension. Files predating that setting use the
current default. This supports upgrades, but mixed-version browser sync is not
lossless: an older extension can discard IDs it does not recognize when writing
settings, so newer links can lose their custom positions.

After changes, build and run the planning-link, settings-schema, and
settings-transfer tests. For interaction or styling changes, also run
`node scripts/verify-peak-link-order.mjs` and its `--firefox` variant after the
build. These use hidden HTTPS fixtures; Chrome loads the real extension, while
Firefox checks shipped assets with controlled settings. Use
`npm run verify -- browsers` separately for both browsers' real manifest and worker
coverage. Follow the browser launch and teardown rules below.

## Vendor libraries

Vendor libraries are dev dependencies declared in `package.json` and resolved
exactly by `package-lock.json`. The build sources them from `node_modules` into
`dist/vendor`—nothing is hand-copied.

- **marked and Chart.js** ship browser builds that are copied verbatim.
- **MapLibre 6** ships ESM only. The build copies its main module, module worker,
  shared module, stylesheet, and license from npm. The main module receives the
  guarded 6.13.0 terrain LOD correction in
  `scripts/maplibre-terrain-lod-patch.mjs`; worker/shared code stays verbatim.
  Dependency upgrades must review or remove that patch. The native terrain-frame
  entry imports the main module directly and sets the packaged worker URL.
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

For Garmin's current-session flow, `waitForOwnership` also waits for the
same-page CSRF token within its existing readiness deadline. The token stays
in the provider page. Missing session state and failed downloads have distinct
capture error codes; their **Reopen activity** action opens the canonical
activity in a new tab and preserves the source tab. Export still requires a
new toolbar gesture, with account and ownership checks repeated.

`BPB_CAPTURE_DIAGNOSTICS` is a local developer/test switch, not telemetry. When
set to the boolean `true` in the worker or popup realm, the capture path emits
one allowlisted duration/count object to that realm's console. The worker asks
the provider adapter for its timings through an explicit capture argument; a
page global alone does not enable them. The hook is inert by default, persists nothing, and has no string or
payload channel for URLs, account identity, coordinates, GPX, or response text.

## Dependency updates

Dependabot checks for routine npm and GitHub Actions updates every other Monday
at 09:00 UTC
(`0 9 * * mon%2`, using the [Fugit modulo extension supported by Dependabot](https://github.com/dependabot/dependabot-core/issues/12246#issuecomment-2875021010)).
The cadence continues across month and year boundaries. Grouped npm updates
merge without a human once their checks pass, majors included; security updates
still arrive immediately. GitHub Actions updates wait for review because they
change CI and release machinery rather than extension code.
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
group. This alone did not prevent PR #19 from mixing 3.30.6 with 3.31.3 during
lockfile resolution. Direct TipTap requirements therefore use one exact version,
and the policy check requires every top-level and nested TipTap installation to
match it. Keep the family grouped and update its exact pins together; do not use
`--legacy-peer-deps` to accept an inconsistent update.

Existing Dependabot PRs can retain an older updater job definition: the
2026-09-06 recreation of #19 still used the former `editor`/`vendored` groups and
`requirements-update-strategy: null`, despite the current default-branch config.
When diagnosing recurrence, inspect the **Dependabot Updates** job definition as
well as the PR test logs. Recreating an old PR is not evidence that the new
configuration ran; verify a fresh scheduled update uses the current groups and
strategy after integrating the old branches.

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
web-ext gate rejects unreviewed warning codes/files and occurrence counts above
the reviewed per-file limits. Fewer warnings pass and the report shows actual
counts. Counts cannot detect a replacement warning of the same type in the same
file, so dependency source review remains necessary.

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
Browser-tooling changes (Playwright and its core), source or script changes,
manifest changes, and changes to the test workflow also require these GPU checks.
That keeps a fixture or graphics-backend regression from waiting unnoticed until
the next copied-library update.

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
  100,000-point GPX completeness case, 100,000-point/5,000-peak analysis, and
  1,500-entry favorite render/search/backup path out of the fast local loop.
  Scale files run sequentially so their timing gates do not compete with other
  CPU-heavy fixtures in the same runner.
  The capture case checks summit identities and protected reduction anchors,
  internal cancellation checkpoints, and three complete CPU samples. Every
  sample must satisfy correctness and yielding checks. The median must stay
  below 15 seconds, and any sample at or above 30 seconds fails; a 120-second
  test deadline bounds hangs. CPU timing covers detection, reduction, and draft
  calculation rather than assertion overhead. Logs retain all samples, phase
  CPU, wall time, yields, and range. CI and release use Node 24 on Ubuntu 24.04.
  Cooperative timer waits and runner descheduling are not CPU consumption. It still
  cannot prove native renderer responsiveness or the live MV3 message scheduler.
- `npm run verify -- provider-performance` measures native `DOMParser` and
  extraction for synthetic 1,000-, 5,000-, 20,000-, and 100,000-point GPX,
  including a Garmin-shaped export with extensions, plus early
  over-limit rejection in hidden Chrome and Firefox. It blocks network and does
  not estimate provider latency or slower hardware. The parser remains
  synchronous; this gate does not measure peak memory or cancellation latency.
- `npm run verify -- provider-contracts` routes sanitized provider-shaped pages to
  the exact Garmin and Strava HTTPS origins, intercepts every request, and
  exercises ownership, loading, sign-out, localization, navigation, Garmin
  session mode, response redirects, rate limits, and challenge markers in
  native browser DOM/fetch implementations. It proves the checked fixture
  contract only—not current live markup, endpoints, sessions, or challenges.
- `npm run verify -- capture-popup` opens the real unpacked Chrome action popup
  without a viewport override and asserts its 390px width in light/dark over
  tabs at 100% and 200% zoom. This catches viewport-dependent CSS that collapses
  browser autosizing. It also runs every recovery family using the shipped
  bundle and styles in hidden Chrome and Firefox at 390×600 CSS pixels,
  including 2x pixel density (which is not browser zoom). CI runs both gates.
  These checks prove sizing, action mapping, and content containment, not visible
  popup chrome, dismissal, browser focus, or screen-reader speech. Firefox's
  native toolbar autosizing is not exercised by this verifier.
- `npm run verify -- capture-flow` invokes Chrome's real toolbar action with the
  unmodified extension, so the provider adapter receives the same temporary
  `activeTab` grant as a user click. Garmin and Strava fixtures go through
  ownership, export, summit lookup, results, and one draft Preview without Save.
  Failure cases cover the privacy gates and recovery actions; held exports
  exercise cancellation, restart, and popup reopening without duplicate work.
  This proves the fixture flow, not current live provider compatibility.
- `npm run verify -- capture-readiness` exercises the real worker and Peakbagger
  page helper with a parsed, signed-in page whose image never finishes loading.
  It also delays the first response in an automatically created helper tab to
  exercise its uncommitted URL state. Both paths must progress past session
  verification, clean up completed helpers, and block GPS export when signed out,
  including a live response that disagrees with stale signed-in page links. The provider adapter
  and its host permission exist only in a disposable test extension; no live
  provider compatibility, native popup behavior, or browser focus is established.
- `npm run lint` first checks undeclared names, unused bindings, and unsafe
  equality in source without rewriting it, then checks the built extension
  package. Neither lint stage establishes browser behavior.
- `npm run verify -- terrain` and `npm run verify -- terrain firefox` render the true MapLibre
  frame on a reported hardware GPU, but their
  analyzer showcases load the production settings bridge over stubbed extension
  storage and runtime APIs. Mapterhorn requests are intercepted with a synthetic
  CORS-enabled DEM. These checks exercise the real bridge protocol but not the
  actual extension manifest, worker lifecycle, settings storage, or live terrain
  service.
- `npm run verify -- terrain lod` measures which elevation level each visible pixel is
  actually drawn from, on the same real GPU frame, so the tilt detail behaviour is
  a number rather than an impression. It generates continuous 512-pixel DEM
  tiles as lossless WebP through the locked Playwright toolchain, preserving
  every Terrarium elevation channel and satisfying the production cache's MIME
  and byte validation. It adds a 140 ms delivery delay after fixture generation;
  encoding cost, tile sizes and provider latency do not model live Mapterhorn.
- The LOD probe uses MapLibre 6.13's custom terrain rendering hook to paint
  desired/actual DEM levels onto the mesh and count the resulting pixels.
  It replaces the removed private coordinate framebuffer. Samples contain the
  tile census and pixel read from the same painted frame; movement cannot be
  reported settled. This diagnostic replaces the imagery's appearance and
  therefore does not measure imagery quality, frame rate, or live Rainier
  elevation. Passing terrain/snow-map smoke alone does not prove LOD criteria.
- `BPB_LOD_DRAPE` picks which of the two shipped drape LOD settings that run
  exercises: `L_OS` (the default, full `(4, 3)`) or `L_OT` (thrifty `(6, 1.5)`,
  what OpenTopoMap and every live Leaflet layer get). Run both when touching
  either constant pair — the gap between them is the reason there are two. Its
  per-pitch census counts are stable; the sweep traffic total is not, so compare
  levels-against-ceiling rather than totals.
- Every fixture server — the terrain verifiers, `verify -- terrain lod`, and `showcase:render` — serves
  over **HTTPS on `www.peakbagger.com`**, with a self-signed certificate minted
  per run and deleted in teardown. This is a product constraint, not a
  preference: `src/peakbagger/peakbagger-request.js` refuses any URL that is not
  `https:` on a Peakbagger host, and the GPX Analyzer fetches its track through
  that guard. See *A plain-HTTP fixture breaks these checks* below.
- `npm run verify -- browsers` loads the real Chrome and derived Firefox manifests.
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
- `npm run verify -- packages CHROME.zip FIREFOX.zip` runs those same gates against minified store bytes
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

### Climber-list verification

The [climber lists guide](climber-lists.md) describes behavior; the
[archived ledger](archive/ignored-climbers.md) records proof and release gaps.
Focused tests live in `test/favorites/`, `test/ascent/ascent-filter.test.mjs`,
`test/ascent/ascent-report-visibility.test.mjs`,
`test/background/climber-list-sync.test.mjs` and
`test/options/options-ignored-backup.test.mjs`. They cover exact author evidence,
visibility/count composition, unknown/empty/error states, mutation races, bounded
files, reviewed replacements, three-way deletions/conflicts, ref retry, journal
recovery, cancellation and durable scheduling. Scale coverage includes native
4,145-row groups separately from the added empty-state row.

Both real-extension verifiers load the ignored profile/manager, peak report,
full/compact ascent list and individual-report fixtures. The detail fixture's
synthetic identities/media preserve the live validated Climber heading and report
cell boundary. HTTPS fixture routes add `peak.aspx?ignored=1`,
`climber/PeakAscents.aspx?compact=1` and `climber/ascent.aspx?ignored=1`.
Chrome also exercises the real packaged worker/client against a fully synthetic
GitHub Git Data endpoint, including an external ref race and unrelated root files.
No real backup repository is test scratch space.

Set `BPB_VERIFY_IGNORED_SCREENSHOT_DIR` to an existing output directory for light/
dark site and manager screenshots. `node scripts/verify-climber-list-ui.mjs`
checks the real Settings bundle with synthetic worker replies, long names,
1,500-entry counts and a 200% equivalent reduced CSS viewport at DPR 2. It proves
layout, not live GitHub. Firefox logs measured CSS viewport dimensions; native
headless window limits may require test-tab zoom. Inspect those dimensions and
screenshots rather than treating requested outer window sizes as viewport proof.
Run build-owning npm commands sequentially in one worktree: concurrent build
publication can collide. All runners close only their disposable browser/profile.

After building, `node scripts/verify-climber-transitions.mjs --checks=card-links`
checks the compact name card in hidden Chrome and Firefox at 390, 768 and 1280
pixels, both themes and normal/enlarged text, plus 320-pixel wrapping. It verifies
all-year ascent URLs, social links from existing profile evidence without new
requests, and anchored pending/error/details/check/recovery transitions. Worker
and profile replies are synthetic; use the real-extension verifiers for manifest
and worker integration. Set `BPB_JITTER_ARTIFACTS` to retain rendered screenshots.

Live read-only Peakbagger inspection confirmed the author/section adapters on
2026-10-01. Before release, validate two-device sync and interrupted operations
against an owner-authorized disposable GitHub repository. Browser-store builds,
minimum browser versions, Firefox Android, native focus/permission presentation
and screen-reader speech remain separate checks.

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
- `verify -- terrain` then times out on
  `Timed out waiting for page state: {"ready":false,"disclosureExists":false}`,
  `verify -- terrain firefox` on `Timed out waiting for Firefox terrain readiness`,
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
npm run verify -- packages web-ext-artifacts/better_peakbagger-X.Y.Z.zip web-ext-artifacts/better_peakbagger-X.Y.Z-firefox.zip
```

The archive verifier derives required runtime files from
`scripts/build-config.mjs`; it rejects stale raw-source layouts and missing
bundles/vendor licenses. See [Browser store releases](releasing.md) for version,
tag, credential, and live-verification requirements.
