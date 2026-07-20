# Cross-browser extension verification: execution plan

Status: investigated 2026-07-19; implementation plan agreed in conversation,
not yet implemented.

Better Peakbagger has broad deterministic coverage in Node and jsdom, plus a
substantial real-extension verifier in Chrome for Testing. The remaining risk
is not a shortage of unit assertions. It is that several product boundaries
belong to the browser itself and are either exercised only in Chromium or
replaced by test stubs: manifest interpretation, extension execution worlds,
background lifecycle, browser namespaces and async APIs, `activeTab`,
`scripting.executeScript`, real storage areas, tab creation/grouping, file
attachment, and extension-page behavior.

This plan adds a small cross-browser layer around those boundaries while
preserving the fast Node suite as the source of exhaustive edge-case coverage.

## 1. Current coverage and confirmed gaps

### `npm test`

- Builds `dist/` and evaluates the shipped bundles in Node/jsdom.
- Covers pure algorithms, parsing, privacy gates, worker state transitions,
  captured Peakbagger DOM, settings, report conversion, release archives, and
  many failure paths.
- Replaces extension APIs with in-memory stubs. The worker harness stubs
  `storage.session`, `scripting.executeScript`, badges, tabs, tab groups, and
  alarms. The page harness stubs storage and messaging.
- Does not let either browser interpret the manifest. It cannot prove
  execution worlds, real injection order, extension origins, service-worker
  or background-script startup, browser chrome, layout, or native file-input
  behavior.

### `npm run verify:extension`

- Loads the real unpacked `dist/` in hidden Chrome for Testing, using a
  disposable profile and a local HTTPS Peakbagger stand-in.
- Proves the Chrome MV3 worker boots and answers, and exercises the actual
  manifest load of the ascent analyzer, cross-world settings bridge, 3D
  integration on ascent/Peak/BigMap pages, and substantial TipTap/CodeMirror
  report-editor interaction.
- Does not exercise the popup-driven capture transaction, provider injection,
  draft-tab registration and filling, ascent filtering, options behavior,
  backup behavior, or any Firefox runtime.

### `npm run terrain:verify`

- Exercises real Chrome GPU/WebGL rendering and MapLibre interaction with
  synthetic basemap, terrain, route, and peak fixtures.
- Uses settings and bridge-protocol stubs and therefore does not replace a
  real-extension run.
- Has no Firefox counterpart.

### Packaging and CI

- Pushes and pull requests targeting `main` run the real Chrome verifier.
- The Firefox archive is derived and statically verified, but no automated
  check launches it in Firefox.
- Release packages are built after the Node tests and are inspected as
  archives, but the minified Chrome and Firefox package contents are not
  executed before publication.
- `.github/workflows/ci.yml` and `.github/workflows/test.yml` duplicate some
  Node/lint work with different Node versions; only the latter runs Chrome.
  The workflows and `docs/development.md` should describe one authoritative
  matrix after the browser work lands.

## 2. What belongs in a real browser

The real-browser layer should use representative end-to-end scenarios, not
duplicate every Node assertion.

| Boundary | Why jsdom is insufficient | Required browser coverage |
| --- | --- | --- |
| Manifest and background startup | Chrome starts `background.service_worker`; Firefox uses the separately declared `background.scripts` path | Chrome and Firefox |
| MAIN and isolated worlds | The analyzer, Peak map, and BigMap enhancers run in MAIN while their settings bridges run isolated | Chrome and Firefox |
| Extension API compatibility | Namespace, callback/promise, API support, and manifest handling vary by browser | Chrome and Firefox |
| Settings and private jobs | Production uses real `storage.sync`, `storage.local`, `storage.session`, and `storage.onChanged` | Chrome and Firefox |
| Capture coordinator | `activeTab`, MAIN-world provider injection, badges, session state, tab creation, and grouping are currently mocked together | Chrome and Firefox; native `activeTab` gesture remains a manual release check |
| Draft filling | Real sender/tab identity, `DataTransfer`, file-input assignment, ASP.NET form events, Preview, and messaging are browser behavior | Chrome and Firefox |
| Report editor | Selection, contenteditable, TipTap, CodeMirror, form submission, layout, and the browser-specific credit URL cross the DOM/runtime boundary | Quick smoke in both; deeper interaction may remain Chrome-first |
| Theme startup | jsdom cannot establish stylesheet-before-first-paint or expose a visible flash | Chrome and Firefox |
| Peak, BigMap, and ascent bridges | Correctness depends on manifest worlds, page-owned globals, iframes, `postMessage`, and extension URLs | Chrome and Firefox |
| Ascent filter | One real filter/sort covers manifest matching, navigation interception, layout, and large-table behavior | Chrome and Firefox |
| Options and popup | Extension origins, real storage, active-tab lookup, popup layout, and Firefox inline Preferences are browser-owned | Chrome and Firefox |
| Terrain/WebGL | Engine, CSP, worker URL, compositing, GPU renderer, and pointer behavior are not represented by jsdom | Chrome automated today; Firefox release/scheduled check |

## 3. What stays in Node/jsdom

Keep the exhaustive cases for these areas in the existing suite:

- GPX validation, scoring, metrics, reduction, timezone math, and serialization.
- Report markup conversion, sanitization, round trips, and malformed input.
- Provider ownership parsing and changed/signed-out DOM cases.
- Settings schema bounds and cross-world allowlists.
- Capture privacy gates, state-machine failures, cancellation, expiry, and
  concurrency.
- GitHub authentication/client error taxonomy and backup serialization.
- Release metadata, build composition, archive contents, and fixture privacy.

The browser suite should prove that one normal and one safety-critical path
reach these algorithms through the shipped extension. Node remains the right
place for the combinatorial cases.

## 4. Target command and CI matrix

Introduce explicit commands:

| Command | Purpose |
| --- | --- |
| `npm run verify:chrome` | Existing deep Chrome for Testing verifier |
| `npm run verify:firefox` | New Firefox real-extension smoke |
| `npm run verify:browsers` | Build once, then run the Chrome and Firefox gates |
| `npm run verify:extension` | Compatibility alias for `verify:chrome` until callers migrate |

Target gates after stabilization:

- **Every push/PR:** `npm test`, JavaScript and extension lint, real Chrome,
  and the quick Firefox smoke. Run the browser jobs independently so failures
  identify the responsible runtime.
- **Release:** run the quick smoke against the extracted minified Chrome ZIP
  and the generated Firefox ZIP/XPI before either store job can publish.
- **Scheduled or release-only:** Firefox Nightly and Firefox GPU/terrain
  interaction, plus any minimum-supported Firefox rehearsal warranted by API
  or manifest changes.
- **Manual release check:** browser-chrome behavior that a hidden page driver
  cannot establish honestly: toolbar `activeTab` grant, popup presentation,
  native permission prompts, inline Firefox Preferences, tab-group
  presentation, and one minimal owned Garmin/Strava capture in each browser
  family.

## 5. Implementation steps

Each step is one focused commit and must leave its checks green before the
next begins.

### Step 1 — Name the verification tiers

- Add `verify:chrome` as the authoritative name for the current
  `scripts/verify-extension.mjs` behavior.
- Keep `verify:extension` as an alias so existing docs and CI do not break
  mid-migration.
- Document the target commands without claiming Firefox coverage yet.

Commit: `test: define browser verification tiers`

### Step 2 — Prove the smallest Firefox vertical slice

Create `scripts/verify-firefox-extension.mjs`:

1. Build `dist/` and call the existing `prepareFirefoxSource()` so the check
   uses the same derived Firefox manifest as development and release.
2. Launch Firefox headless with an isolated disposable profile.
3. Temporarily install the prepared extension with Selenium/geckodriver.
4. Serve a local HTTPS fixture under a manifest-matching Peakbagger hostname.
5. Assert the runtime origin uses `moz-extension://`.
6. Open the extension options page and confirm the Firefox background script
   answers the existing `CAPTURE_STATUS` message.
7. Navigate to an ascent fixture and confirm the isolated theme and MAIN-world
   analyzer both initialize.
8. Close the driver and remove the prepared source, profile, certificates,
   and server in `finally`, including failure paths.

Do not refactor the Chrome driver first. The Firefox install, hostname mapping,
background discovery, and extension-page access are the uncertain parts; prove
them in a narrow script before introducing shared infrastructure.

Commit: `test: verify firefox extension startup`

### Step 3 — Share only fixture infrastructure

After the second runner works, extract the pieces that are genuinely common:

- HTTPS server, certificate setup, routes, and synthetic responses.
- Captured Peakbagger form and page fixtures.
- Synthetic GPX/media data.
- Condition polling, failure aggregation, and cleanup helpers.
- Expected surface selectors and store URLs.

Keep Playwright and Selenium operations visibly separate. A large common
driver facade would obscure which browser failed and make protocol-specific
debugging harder.

Commit: `refactor: share browser verification fixtures`

### Step 4 — Add the quick cross-browser smoke

Use one launch and profile per browser to cover all fixtures.

#### Runtime boot

- The real manifest loads without runtime/page errors.
- The background answers `CAPTURE_STATUS`.
- The runtime origin is `chrome-extension://` or `moz-extension://` as
  appropriate.
- Real sync, local, and session storage can round-trip narrow test values and
  `storage.onChanged` reaches a consumer.

#### Representative manifest surfaces

- **Ascent:** theme initialized; analyzer rendered; settings bridge responds;
  3D toggle mounts and creates the extension frame.
- **Ascent editor:** editor mounts with the native textarea retained inside
  the form.
- **Peak:** planning links and 3D integration mount.
- **BigMap:** enhancer, settings bridge, and 3D integration mount.
- **PeakAscents/ClimbListC:** filter mounts and one filter/sort operation
  succeeds.

#### Report editor

- Enable the optional credit through real extension storage.
- Assert both the rendered anchor and serialized `JournalText` use the Chrome
  Web Store in Chrome and AMO in Firefox.
- Type one bold sentence through the real editor and confirm synchronous form
  serialization.
- Wait for a local draft, reload once, and confirm recovery is offered.

#### Extension pages

- Options initializes from the real extension origin, displays the manifest
  version, and persists one setting.
- A directly opened popup page queries the real active tab and renders the
  worker's status. Native popup sizing remains a visible/manual check.

Commit: `test: add cross-browser extension smoke coverage`

### Step 5 — Verify the real draft-tab handoff

Automate the downstream half of capture without widening the shipping
manifest or weakening `activeTab`:

1. Seed one narrow synthetic, fresh capture job in real `storage.session`.
2. Send the existing selection/open messages to the real worker.
3. Assert real draft tabs are created, grouped when supported, and navigated
   to identity-bound Peakbagger URLs.
4. Let the actual ascent-editor content script request the draft from its
   sender tab.
5. Confirm the worker validates tab, job, peak, and climber identity.
6. Confirm form fields are populated and a real `File` is assigned to the GPX
   input through the production `DataTransfer` path.
7. Confirm GPS Preview fires exactly once and no Save control is clicked.

This does not claim to verify the initial native toolbar gesture or provider
host grant. It verifies the real browser APIs and handshakes after a job exists.

Commit: `test: verify real draft tab handoff`

### Step 6 — Preserve a native capture release check

The production provider transaction deliberately depends on the user clicking
the browser action to grant `activeTab`. Opening the popup URL directly or
adding a test-only provider host permission would bypass the privacy boundary
and create a misleading green test.

Document a short check in dedicated Chrome Stable and Firefox Stable profiles:

1. Open an owned Garmin or Strava activity.
2. Click Better Peakbagger's actual toolbar action.
3. Confirm capture reaches summit results.
4. Open one draft and confirm Preview, populated fields, and attached GPX.
5. Confirm Save remains wholly manual.
6. Discard the captured data and close the test profile.

Keep live provider checks minimal, read-only, and rate-limited. Fixture-backed
browser coverage remains the repeatable gate.

Commit: `docs: add cross-browser capture release check`

### Step 7 — Execute the store packages

After `npm run package` and `build:firefox`:

- Extract the Chrome archive into a disposable directory and run the quick
  Chrome smoke against those minified bytes.
- Temporarily install the generated Firefox archive and run the quick Firefox
  smoke against it.
- Assert the Firefox archive's inline options presentation and each browser's
  store-specific credit.
- Make both successful executions prerequisites for the store publication
  jobs.

Commit: `ci: smoke test packaged browser extensions`

### Step 8 — Make both browser gates authoritative

- Add the Firefox runtime and driver installation to the main test workflow.
- Initially report Firefox separately while measuring harness stability; do
  not hide intermittent infrastructure failures as product failures.
- Promote Firefox to a required gate only after repeated clean runs.
- Consolidate `.github/workflows/ci.yml` and `.github/workflows/test.yml` once
  the final matrix is established.
- Update `docs/development.md` and `docs/releasing.md` to match the actual CI
  and release behavior.

Commit: `ci: require cross-browser extension smoke`

### Step 9 — Add Firefox graphics coverage separately

Do not block the initial Firefox runtime smoke on a full MapLibre visual suite.
Once the core runner is stable, add a scheduled or release check for:

- MapLibre frame and CSP worker startup.
- A non-software WebGL renderer, reported explicitly.
- Synthetic route, terrain, basemap drape, and peak rendering.
- Scroll zoom, right-drag tilt, and the macOS Firefox Ctrl-drag alternative.
- Resize behavior without a blank composited frame or route loss.

If the available CI runner cannot provide representative hardware rendering,
keep this as a hidden local/release check and report that boundary rather than
accepting plausible software-rendered screenshots.

Commit: `test: verify firefox terrain interactions`

## 6. Reliability and safety requirements

- Use hidden/headless isolated profiles for routine checks. Never reuse the
  user's everyday browser or profile.
- Run one browser process per browser suite and batch fixture navigation.
- Poll observable conditions with bounded timeouts; never use a fixed sleep as
  the gate.
- Capture target-page screenshots and current DOM/runtime state only on
  failure. Do not capture the whole display.
- Intercept external map/media/provider traffic. Repeatable browser checks must
  not depend on live Garmin, Strava, GitHub, Peakbagger, or terrain providers.
- Close pages, drivers, debugging servers, fixture servers, and browser
  processes in `finally`. Remove disposable profiles and prepared Firefox
  source trees.
- Report browser name/version, viewport, headless/visible mode, renderer for
  graphics checks, and which native browser-chrome behaviors were not tested.
- A check that passes only on rerun is a harness defect to fix, not noise to
  suppress.

## 7. Completion criteria

The plan is complete when:

- `npm test` remains the fast exhaustive suite.
- Chrome and Firefox each load the real browser-specific manifest and start
  their real background entry.
- Every manifest surface has at least one mount-level assertion in both
  browsers.
- The actual runtime chooses the correct store credit in Chrome and Firefox.
- Real storage, worker messaging, draft tabs, sender identity, file attachment,
  and exactly-once Preview run end to end in both browsers.
- Extracted minified release packages pass the same quick smoke before store
  publication.
- Native `activeTab`, permission prompts, popup/browser chrome, tab-group
  presentation, and live provider export have an explicit manual release
  check.
- Firefox terrain behavior has a truthful GPU-backed release or scheduled
  check, or is explicitly documented as a remaining manual boundary.
- CI and development/release documentation describe one consistent matrix.

## 8. Implementation references

- [`scripts/verify-extension.mjs`](../../scripts/verify-extension.mjs) — real
  Chrome fixture server, isolated profile, manifest load, and assertions.
- [`scripts/run-firefox.mjs`](../../scripts/run-firefox.mjs) — creation and
  cleanup of the derived Firefox source tree.
- [`scripts/build-firefox-package.mjs`](../../scripts/build-firefox-package.mjs)
  — Firefox manifest transformation shared by development and release.
- [`test/helpers/load-page.mjs`](../../test/helpers/load-page.mjs) — current
  jsdom bundle harness and the limits the browser smoke must cover.
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)
  — Playwright's extension loader is Chromium-specific.
- [Selenium Firefox add-on testing](https://www.selenium.dev/documentation/webdriver/browsers/firefox/)
  — temporary installation of unsigned Firefox add-on directories.
- [Mozilla browser compatibility guidance](https://extensionworkshop.com/documentation/develop/browser-compatibility/)
  — namespace, async API, API coverage, manifest, and browser-behavior
  differences.
- [Mozilla `web-ext` command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
  — disposable Firefox profiles and fixture start URLs for development/manual
  checks.
