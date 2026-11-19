# Modern stack adoption with legacy compatibility

Last updated November 13, 2026 against `0444ff28`. This update audited the plan
against the tree: counts, statuses and stale references were corrected, M4 was
re-aimed at the route the pilot really uses, and the owner settled three
choices the same day, recorded under [Owner decisions](#owner-decisions).

## Goal

Write new and changed extension code in checked TypeScript and, where a UI owner
benefits, Svelte. Preserve behavior, storage and wire formats, permissions and
packaging through the compiler cutover.

- **Production adoption is done at M6:** one real settings panel ships through
  checked TS/Svelte beside unchanged legacy code and passes the browser and
  package gates.
- **The end state is no authored JavaScript (M7):** jsdom's retirement is a
  separate result (M7.5) and does not hold M7 open. All remaining runtime code,
  scripts and tests move to TypeScript in small batches. Generated output and
  upstream third-party code keep their required formats. Svelte conversion stays
  per surface and is not required for every UI.
- **WXT/Vite is the chosen production compiler (M8).** The owner accepted its
  measured time cost and requested the cutover after the full evaluation.

Out of scope: rewriting working features in Svelte for uniformity, adding a demonstration
feature to exercise the stack, and replacing messaging, storage or chart libraries.
The supplied
`ts_svelte_vite_migration_and_stack_report.md` proposes WXT/Vite for a greenfield
extension; treat that as a candidate, and measure its size estimates and chart
replacement before they become acceptance criteria.

## Milestones

Ordered from least to most effort, counting implementation **plus verification**.
This is not a calendar. Follow M1–M6 for production adoption. Cheap work in a later
milestone may be prepared early, but its prerequisites and exit gates still apply.
Advisory fixes and native/browser availability can delay verification regardless
of effort.

| Milestone | Effort / scope | Prerequisite | Concrete result |
| --- | --- | --- | --- |
| M0 — Existing foundation | Complete; retain evidence limits | None | Checked mixed JS/TS, enforced adoption policy, shared source guards and bounded runtime TS. |
| M1 — Repair baseline bookkeeping | Small; two focused repairs plus baseline recording | M0 | Fixture and script inventories agree with the tree; current gate failures have owners. |
| M2 — Convert small UI lifetime helpers | Small; one owner per commit | M0; existing `src/ui/` watch coverage | Typed latest-read and page-lifecycle contracts with unchanged behavior. |
| M3 — Complete build/watch support | Medium; build-script conversion, then watcher repair | M1 for affected test gates | Any authored source edit triggers a complete successful generation; failed generations keep the last usable build. |
| M4 — Type the pilot's boundaries | Medium; narrow adapters and serialization tests | M2; M3 before adding a new domain | Typed settings/UI and runtime contracts without changing wire/storage formats. |
| M4.5 — Choose the DOM test environment | Small typing step, then a medium browser harness | M3 | Typed jsdom for legacy tests and a `verify` browser tier for new DOM-behavior tests; jsdom's retirement is assigned to M7.5. |
| M5 — Enable and prove Svelte compilation | Medium–large; dependency, build and fixture work | M3, M4 and M4.5 | Checked components and runes compile, mount, update, dispose and recover in watch mode. No production UI conversion yet. |
| M6 — Ship one bounded Svelte island | Large; UI integration plus release/browser evidence | M1–M5 and dependency-audit gate | The existing Units settings panel works through checked TS/Svelte beside unchanged legacy sections. |
| M7 — Convert all remaining JavaScript in batches | Very large in aggregate; small modules first | M3; M4.5 before DOM test batches; M6 before more production Svelte | No authored JavaScript remains, from pure TS domains through owned pages, high-risk coordinators, scripts and tests. |
| M7.5 — Retire jsdom | Large; a test-environment migration, owner by owner | M4.5's browser tier; independent of finishing M7 | No test or script depends on jsdom; the package, its types and its checking project are removed. |
| M8 — Cut over production to WXT/Vite | Largest cross-cutting risk; separate project | M6 baseline; independent of finishing M7 | One compiler for development and release with manifest, runtime, reload and package parity. |

M4.5 was inserted after M0–M3 shipped, and M7.5 was split from M7 on
November 13, so other milestone numbers stay stable in existing commits and
evidence.

## Current progress

**M7 and M7.5 remain open.** The Units settings panel and Summit Cloud controls ship
through checked TypeScript and Svelte. The production runtime and root Node
tooling have moved to TypeScript. Test and evidence tooling conversion and
jsdom retirement remain open.

| Milestone | Status | Where it stands |
| --- | --- | --- |
| M0 | Done | Strict browser and Node checking, TS lint scopes, adoption policy in hooks/CI/release, and shared discovery for all seven source guards. |
| M1 | Done | `c1ba9599` (JSON privacy scan), `6e4a3041` (`.mts` script inventory), `01616f47` (`minimatch` removal), `a9de7d7b` (`npm run audit:ci` dev classification). Upstream removed `deepmerge`, leaving zero production advisories; only the unpatched dev-only `picomatch` chain remains in the [follow-up ledger](follow-ups.md). |
| M2 | Done | `src/ui/latest-read.ts` (`730c7039`) and `src/ui/page-lifecycle.ts` (`7d916b3d`) are converted with focused and real-browser verification. |
| M3 | Done | `scripts/build-config.mts` (`bc5fa3b3`) and `scripts/build.mts` (`8d4590ef`) are converted; `watchAll` (`17606ac8`) watches all `AUTHORED_SOURCE_ROOTS` and copied asset roots/files with deduplicated recursive watches and disposable-fixture regression coverage. |
| M4 | Done | [unit-settings-contract.ts](../../options/unit-settings-contract.ts) defines the Units projection, allowlisted patch and `save`/`populate` interface; [settings-patch-route.ts](../../options/settings-patch-route.ts) declares the `SETTINGS_PATCH` request and reply shapes around the unchanged `settings.js`, pinned by tests; no production caller uses that adapter until `options/options.ts` converts (M7). `options/unit-settings.ts` is converted. Pinned by [unit-settings-route.test.mts](../../test/options/unit-settings-route.test.mts). |
| M4.5 | Done | `@types/jsdom` 30 types every TypeScript jsdom test (JavaScript jsdom tests stay unchecked until M7 converts them); [typecheck-node.mts](../../scripts/typecheck-node.mts) checks jsdom/DOM-driving files with the DOM library and the rest without it. The browser DOM tier ([dom-tier.mts](../../scripts/dom-tier.mts), `npm run verify -- dom`) runs `test/dom/*.dom.mts` in hidden Chromium and Firefox and gates the required `chrome-required` aggregate through the `dom-tier` CI job. |
| M5 | Done | Svelte 5.57.3, svelte-check 4.7.8 and eslint-plugin-svelte 3.24.1 are pinned. The original esbuild integration passed byte-identical pre-M6 output checks. WXT now uses the shared settings in [svelte-build.mts](../../scripts/svelte-build.mts). [svelte-island.ts](../../src/ui/svelte-island.ts) is the typed mount adapter. |
| M6 | Done | Complete on November 18, 2026 (`83541e1f`, `c81c7cee`, `0aa1c6ef`). `options/UnitSettingsPanel.svelte` ships inside `dist/options/options.js` (+62,159 raw / +22,900 gzip minified; legacy bundles untouched) with 0 new `web-ext lint` warnings (`fragments: 'tree'`, `discloseVersion: false`) and full release/package/metadata guards. |
| M7 | In progress | Runtime and root Node tooling are converted. At `c9bc4a10`, 220 authored JavaScript files remain. The repository-wide policy and removal of `allowJs` are exit tasks. |
| M7.5 | In progress | The browser tier discovers nested suites and can run an individual owner. At `c9bc4a10`, 91 test files directly import or re-export jsdom, with more consumers through helpers. The request-count evidence probe now uses the browser tier. |
| M8 | Done locally | WXT/Vite builds development and release generations (`133384ab`). Paired publication and native development reload passed (`4286ede2`). Exact packages passed on current and floor browsers. Same-profile settings migration and compiler rollback were rehearsed locally. See [M8 evidence](#m8--cut-over-production-to-wxtvite). |

Remaining conversion scope at `0444ff28`, all of which M7 must finish:

| Area | TypeScript | JavaScript |
| --- | --- | --- |
| Runtime (`src`, `options`, `popup`, `photos`) | 72 | 248 |
| `scripts/` | 54 | 102 |
| `test/` | 110 | 258 |
| Other (root config, `docs/plans/`, `store-assets/`) | 3 | 15 |

These are a dated snapshot, not a target to maintain by hand. At `0444ff28` there
were no production Svelte components; `options/UnitSettingsPanel.svelte` is now
the single shipped Svelte component. The build produces 67 outputs: 65 IIFEs
and two ESM frames.
Recompute the runtime counts with
[`runtimeSourceFiles`](../../test/helpers/runtime-sources.mts), and the others
with `git ls-files` filtered by extension, when starting a batch.

Local verification at `dc985cc9` passed on Node 24.22.3. It covered 4,213
Node tests, 14 scale tests, typecheck, lint, the full branch TypeScript diff,
and the dependency audit. The hidden browser DOM tier passed 60 cases across
Chromium 158.0.8127.18 and Firefox 159.0. The fixture preflight passed in both
engines. Hosted Linux jobs and their browser-floor results remain open.

Limits of what is proven:

- **Verified:** the last recorded full-suite runs are `4,165/4,165` at `c45d32ef`
  and `4,177/4,177` at `166e55fc` (without a recorded Node version), `3,874/3,874`
  on Node `24.22.2` at `69c7a321` (November 6, 2026 baseline), `4,208/4,208`
  on Node `v26.13.1` at `f599ca20` (November 17, 2026), and `4,209/4,209` on
  Node `v26.13.1` at `0aa1c6ef` (November 18, 2026), and `4,213/4,213` on
  Node `24.22.3` at `3a3b61a6`.
- **Resolved guard gap:** the [Dependabot graph test](../../test/project/dependabot-auto-merge.test.mts)
  inspects actual production Vite/Rolldown module inputs for all 67 `ENTRIES`.
  It includes compiled Svelte runtime imports (`svelte`, `esm-env`, `clsx`)
  and excludes erased type-only imports.
- The **minified esbuild archives** at `fd12835a`
  passed real packaged Chromium 158.0.8127.18 and Firefox 160.0.1 checks at
  1000 × 760, including BFCache restore, worker and bridge checks. The four
  early M7 runtime conversions have [additional fixture evidence](#m7--convert-all-remaining-javascript-in-increasing-cost-batches).
- **Published peer ranges only (npm registry, November 13):** `@types/jsdom`
  30.0.0 exists for the locked jsdom 30.1.3; `esbuild-svelte` 0.9.5 admits
  esbuild ≥0.17 and Svelte ≥4.2.1 <6; `svelte-check` 4.7.8 admits TypeScript 5
  and 6; `eslint-plugin-svelte` 3.24.1 admits ESLint 8.57.1 through 10.
- The declared desktop floors passed on macOS. Hosted Linux jobs, native
  focus and window placement, the Firefox Android 142.0 floor and signed store
  delivery require their respective [release checks](../releasing.md).

## Owner decisions

The November 13 audit raised three choices the tree could not settle. The owner
decided them that day; the milestone text below follows these decisions.

| Decision | Chosen | Why | Not chosen |
| --- | --- | --- | --- |
| How M4 types the settings write route | A narrow typed adapter beside the Units owner | `settings.js` is a source in 24 bundles, and M7 step 2 already owns converting the store. | Converting `src/settings/settings.ts` inside M4. |
| Runner for M4.5's browser tier | A `verify` target on the existing `playwright` library harness | [verify-layout-stability.mts](../../scripts/verify-layout-stability.mts) already drives fixture pages in both engines inside CI's `layout` and `fixture-preflight` jobs. A second runner would add a package and a file convention that the `npm test` glob would also try to execute. | `@playwright/test`, which `904317c4` had named. |
| Where jsdom's retirement lives | Its own milestone, M7.5 | "No authored JavaScript" and "no jsdom" are different results. Once jsdom is gone every DOM test needs a browser, and Chrome launches are forbidden in the Codex Seatbelt sandbox, so that cost should not hold M7 open. | Keeping it in M7's exit, or dropping the retirement. |

## Milestone details

Each numbered step is a focused commit or, where necessary, a small set of
independently passing commits. Finish, check and commit one unit before starting
another. Update **Current progress** in the same change that finishes a milestone.

### M1 — Repair baseline bookkeeping

Status: complete on November 6, 2026 (`c1ba9599` JSON privacy scan rejecting
malformed JSON and invalid UTF-8, `6e4a3041` `.mts` script inventory, `01616f47`
nine moderate `minimatch` advisories removed, `a9de7d7b` dev-only audit
classification). After the November 6 Node `24.22.2` baseline at `69c7a321`
(`npm test` `3,874/3,874`), upstream removed vulnerable `deepmerge` from the
`addons-linter` / `web-ext` chain, and full `npm test` reached `4,208/4,208` on
Node `v26.13.1` (`f599ca20`); `npm audit --omit=dev` reports zero production
advisories, leaving only the unpatched development-only `picomatch` advisory
chain open in the [follow-up ledger](follow-ups.md).

1. Register the existing snow-depth legend JSON fixture in the
   [privacy manifest](../../test/helpers/fixture-privacy-manifest.mts), with
   decoding/validation coverage. Convert substantively changed modules/tests to
   `.mts`; do not bypass privacy checks for JSON or the fixture directory.
2. Register the missing ascent-filter verifier in [the script inventory](../../scripts/README.md).
   Make [its inventory test](../../test/project/verifier-assets.test.mts)
   recognize both `.mjs` and `.mts` modules so later tooling conversions cannot
   silently disappear. Convert that test to `.mts` when changing its logic.
3. Record a fresh full-suite baseline and run the checking/tooling tests on
   Node 24, rather than extrapolating from local Node 26. Re-run the dependency
   audit and assign any remaining failures separately. The checked-in reviewed
   development-advisory exception expired October 31; the flag does not waive
   expiry or additional findings. Do not extend it as migration housekeeping.

Exit: both fixture-registration failures and the inventory failure are gone;
typecheck/lint and focused tests pass; the full-suite and audit outcomes are
recorded without suppressing failures. An unresolved upstream audit finding
does not forbid independent local work, but blocks a claim that M6 is releasable.

### M2 — Convert small UI lifetime helpers

Status: complete on November 6, 2026 (`730c7039`, `7d916b3d`).

1. Convert [latest-read.ts](../../src/ui/latest-read.ts) to `.ts`, preserving
   abort ordering, stale-result rejection and reentrant cancellation behavior.
   Update exact caller references and retain its existing focused tests.
2. Convert [page-lifecycle.ts](../../src/ui/page-lifecycle.ts) to `.ts` with
   typed callbacks/events and the existing idempotent active/suspended/disposed
   state machine. Keep the public `create` alias and default window behavior.
   Extend its focused tests only where typed usage reveals a missing case.

Exit: strict checking and existing lifecycle/latest-read behavior tests pass;
source-policy owner paths and build references remain correct. These owners
are already under a watched directory, so M2 does not depend on repairing the
watcher. Run real-extension checks for changed content-script load dependencies.

### M3 — Complete build/watch support

Status: complete on November 6, 2026 (`bc5fa3b3`, `8d4590ef`, `17606ac8`).

1. Convert [build.mts](../../scripts/build.mts) to `.mts` without changing build
   behavior. Update command/workflow references, imports, literal source readers,
   inventories and docs together. Compare the development
   output inventory and hashes against the pre-conversion build.
2. Watch all `AUTHORED_SOURCE_ROOTS` recursively, plus the retained copied asset
   roots and root files; deduplicate overlapping watches. Document restart
   requirements for entry/compiler configuration and dependency changes. Keep
   one build writer and the existing publication/rollback/reload ordering.
3. Add executable watch regression coverage in a disposable checkout/fixture:
   edit an imported TS file under `src/storage/`, add an imported file in a new
   nested domain, introduce a syntax error, correct it and close during rebuild.
   Poll the published contents/token, not a fixed delay. Prove the missing-root
   assertion fails against the old watcher before accepting the fix.

Exit: successful edits publish a whole generation and advance the token;
syntax/build failures preserve the previous tree/token; correction recovers;
close removes watchers, contexts and staging trees. Existing JS/minified builds
and Chrome/Firefox development reload paths still work. Type errors remain the
separate checker's responsibility; a green esbuild run is not type safety.

### M4 — Type the pilot's boundaries

Status: complete on November 13, 2026.

- **Fixed and verified:** the Units owner is TypeScript and writes only
  frozen plain patches rebuilt from its allowlist and validated through the
  shared schema (`unitSettingsPatch`), so nested proxies and unrelated fields
  never reach `set`. The `SETTINGS_PATCH` request, success, sender-refusal and
  listener-failure replies are declared in `settings-patch-route.ts`, whose
  `settingsPatchRoute(transport)` delegates to the real `createSettingsStore`
  `set` rather than reimplementing it; it has no production caller yet. Tests
  cross a real structured clone into
  the worker's `applyPatch`, and cover transport loss, invalid replies,
  rejected writes and storage failure; ten `@ts-expect-error` examples fail the
  checker on misuse.
- **Intentionally not changed:** `src/settings/settings.ts` and the options
  controller `options/options.ts` stay JavaScript at M4 (M7). The controller's `save`
  still calls the store's `set` directly; the Units owner sees it only through
  the typed `UnitSettingsSave` contract. Reply validation and error messages are
  settings.js's own, including its existing acceptance of `{ ok: true }` with
  any truthy `settings` value, which it cleans to defaults.
- **Changed but not fully proven:** the live write path is typed only from the
  Units owner's side (`UnitSettingsSave`); the controller's `save` and its
  `S.set` call stay unchecked JavaScript. `SettingsPatch` checks keys, not
  values, and omits the computed `bpbPhotoTool:*` keys. A select value the
  schema rejects now throws in the panel's listener instead of being saved and
  cleaned; current markup cannot produce one, and no test drives that path.
  Node's `structuredClone` is not proof of Chrome's JSON messaging. No
  real-browser run; `test/options` and `test/settings` pass.

The Units panel never touches `src/ui/runtime-message.ts`. Its `save` goes from
the options controller to `set` in [settings.ts](../../src/settings/settings.ts),
which sends a `SETTINGS_PATCH` runtime message; the worker case in
[background.ts](../../src/background/background.ts) applies the patch. The
options page does not write storage itself. M4 types that route. Converting
`runtime-message.js` is a small M7 batch 1 module and does not block M5 or M6.

1. Type the `SETTINGS_PATCH` route the pilot uses: the request, the
   `ok`/`settings` reply and the error reply, on the page side. Treat the reply
   as `unknown` until validated; keep sender authorization and the wire
   envelope. The worker end and the schema are already TypeScript. Type the
   page side with a narrow adapter beside the Units owner, backed by step 3's
   tests; do not convert `settings.js` here. That store is a source in 24
   bundles and belongs to M7 step 2 ([owner decision](#owner-decisions)).
2. Define the Units panel's settings projection, allowed patch keys and
   `save`/`populate` interface beside its owner. Validate through the existing
   settings schema and retain the options controller's write queue, confirmed
   snapshot, rollback and feedback.
3. Test allowlisted plain-data construction with nested native proxies and real
   structured cloning, aimed at `set` and `SETTINGS_PATCH`. Compile negative
   request/response/patch examples. Cover successful replies, transport loss,
   invalid replies and rejected settings writes. New protocols, if needed
   later, must type and validate both ends.

Exit: incorrect usage fails checking, actual boundary failures preserve current
behavior, and cloneable payloads omit unapproved fields. Adapters/declarations
remain narrow compatibility promises backed by tests, not a second schema or
an assertion that all imported JavaScript is trusted.

### M4.5 — Choose the DOM test environment

Step 1 status (November 13, 2026):

- **Fixed and verified:** `@types/jsdom` 30.0.0 is pinned, grouped with jsdom in
  Dependabot (jsdom majors are held until a matching declaration major exists)
  and listed in `DEVELOPMENT_TOOLS`. `npm run typecheck` now runs
  [typecheck-node.mts](../../scripts/typecheck-node.mts), which derives the
  DOM program from import closures (jsdom, extension source, or a
  `/// <reference lib="dom" />`) instead of a hand-kept list, so the remaining
  Node files are checked without DOM globals. The page loader is
  [load-page.mts](../../test/helpers/load-page.mts) with typed `LoadedPage`
  and `PageChrome`; its trusted-dispatch internals sit behind one declaration
  that throws on a different jsdom major. All suppressed jsdom imports and both
  hand-typed constructors are gone; `test-dom.mts` only re-exports jsdom's
  types. Guard tests in `test/project/typescript-tooling.test.mts` pin the
  split and reject a suppressed or `require`d jsdom import.
- **Intentionally not changed:** fixture pages are typed through
  [page-dom.mts](../../test/helpers/page-dom.mts) and `page-types.mts`, which
  treat lookups in this repository's known markup as present; tests stub
  window members through narrow `as { member: unknown }` assignments, pass a
  jsdom window where a browser global is expected only through
  `browserWindow`, and use `!` where a missing fixture node already threw.
  `options-helpers.mjs` and other JavaScript helpers stay JavaScript, so their
  callers keep one documented cast each; the 114 JavaScript test files that reach jsdom stay
  unchecked (`checkJs: false`) until M7 converts them. Because the split
  follows imports, Node release tooling that imports one extension-source
  module (for example `publish-chrome.mts`) is checked in the DOM program.
  `fireTrustedEvent` is pinned to jsdom's major, and
  [jsdom-trusted-event.test.mts](../../test/project/jsdom-trusted-event.test.mts)
  proves on every run that it still dispatches trusted events of the right
  interface.
- **Changed but not fully proven:** type-only changes; no runtime behavior of
  shipped code changed. Ten browser-driving scripts (nine verifiers and the
  shared `weather-verification-types.mts`) gained a `/// <reference lib="dom" />`
  they previously inherited; they were typechecked, not run.

Steps 2–4 status (November 13, 2026):

- **Fixed and verified:** [dom-tier.mts](../../scripts/dom-tier.mts) and
  `npm run verify -- dom` run `test/dom/*.dom.mts` with one browser per engine
  and a fresh context per case: Chrome for Testing through `channel:
  'chromium'` after `assertChromeLaunchAllowed()`, and Playwright's Firefox.
  Pages load at their real HTTPS Peakbagger URL purely through request
  routing (every other request is aborted), with an init-script
  `chrome`/`browser` stub and built bundles from `dist/` or a disposable
  `--dist` copy. Unknown arguments and empty selections are rejected,
  retries are off, failure evidence goes through `retainBrowserFailure`, and
  the required `chrome-required` aggregate now needs the `dom-tier` job.
  [options-scroll-spy.dom.mts](../../test/dom/options-scroll-spy.dom.mts)
  replaces the jsdom "zero-layout world" test, which could only show the spy
  did not throw. Its cases gate on the spy's own output, never on frames or
  time, and prove three things: the 40px activation marker to the pixel; that
  a trusted click keeps its link current through every scroll event of the
  smooth scroll and after `scrollend`; and that with the editor off every
  scroll position reports the section an independent layout computation
  expects. Against disposable copies of `dist/`, each case failed in both
  engines on its own mutation: a 41px marker, a disabled navigation lock and
  a removed hidden-entry filter. A case also fails on any unplanned request
  (a missing built asset or one leaving the fixture origin). All six cases
  pass in Chromium 156 and Firefox 157, hidden, at 1000×760. The routing rule
  is recorded in [development.md](../development.md).
- **Intentionally not changed:** the tier does not load the extension. The
  stub follows the storage API's absent-key and `onChanged` semantics, answers
  unknown runtime routes with `{}` and keeps settings writes page-local, so
  worker-driven sections such as `#capture-garmin` stay hidden and the options
  layout differs from the real extension's. Extension pages are served at
  `https://www.peakbagger.com/dist/...`. Bundles are injected by each case
  (`inject`) rather than derived from manifest order, because the tier never
  reproduces execution worlds; step 2 had asked for manifest order.
- **Changed but not fully proven:** hosted CI has not run the new `dom-tier`
  job yet. The tier relies on `setup-verification` installing the selected
  browser, as the `fixture-preflight` job does.

`npm test` evaluates the shipped IIFE bundles in jsdom: 118 test files construct
it 297 times. When M4.5 started, jsdom shipped no type declarations here, so 18
converted tests suppressed the import (for example
[page-lifecycle.test.mts](../../test/ui/page-lifecycle.test.mts)) and two files
hand-typed a constructor:
[map-layer-inspection.test.mts](../../test/maps/map-layer-inspection.test.mts)
and the shared [test-dom.mts](../../test/helpers/test-dom.mts), which 14 tests
imported as an interim stand-in. Every M7 test batch would have repeated one of
those. jsdom also has no layout, mints only
untrusted events and is not Firefox; the shared
[page loader](../../test/helpers/load-page.mts) already reaches into jsdom
internals to dispatch trusted input. Settle both before M5 adds component tests
and before M7 converts DOM tests to TypeScript. This milestone changes test tooling only; no
shipped output changes.

1. **Type the existing jsdom tests.** Add `@types/jsdom` at the major matching
   the locked jsdom (30 at this checkpoint). Give jsdom tests a dedicated
   checking project that adds the `dom` library, selected explicitly by
   `npm run typecheck`; keep Node tooling and pure tests in the existing Node
   project without DOM globals. Convert the shared page loader to `.mts` with
   typed page objects so callers drop their `as unknown` casts, and keep its
   trusted-dispatch internals behind one narrow local declaration pinned to the
   locked jsdom version. Remove every suppressed import and both hand-typed
   constructors, retiring `test/helpers/test-dom.mts` or reducing it to a
   re-export of the real types. Group `jsdom` and `@types/jsdom` in Dependabot
   so their majors move together; this holds jsdom at 30 while `@types/jsdom`
   has no 31 (jsdom 31.0.1 is already published). Add `@types/jsdom` to
   `DEVELOPMENT_TOOLS` in
   [check-npm-audit.mts](../../scripts/check-npm-audit.mts), which otherwise
   classifies an unlisted direct dependency as shipped.
2. **Add a real-browser DOM tier.** Add a `verify` target built on the
   installed `playwright` library and the existing verifier helpers (fixture
   server, launch guard, resource stack, failure evidence), following
   [verify-layout-stability.mts](../../scripts/verify-layout-stability.mts). Do
   not add `@playwright/test` or another runner
   ([owner decision](#owner-decisions)). Use the tier for new tests whose
   behavior depends on layout, scrolling, trusted input, focus or
   browser-specific DOM. Load fixture HTML at its real HTTPS Peakbagger URL
   through request routing, install `chrome`/`browser` stubs with init scripts,
   inject the built IIFE bundles in manifest order and assert through typed
   evaluation and locators. Reuse one browser per engine and a fresh context
   per case. Run Chromium through `channel: 'chromium'` in new headless mode
   after `assertChromeLaunchAllowed()`, plus Playwright's Firefox. Keep retries
   off: a check that passes on re-run is a bug in the check. Like every
   verifier, it must reject unknown selections and zero executed cases.

   The tier is reached through `npm run verify`; it does not run inside
   `npm test`. That command's CI job installs no browsers, and Chrome cannot
   launch in the Codex Seatbelt sandbox where `npm test` must stay runnable.
   Enforce the tier in CI by adding its job to the `needs` of an existing
   required aggregator (`chrome-required` already gathers `layout` and
   `fixture-preflight`), or add a new name to `requiredChecks` in
   [release-preflight.mts](../../scripts/release-preflight.mts) and its test.
   The release workflow has run no tests since `8a9fa6ad`; it promotes packages
   those checks already verified. Document the new target in
   [development.md](../development.md) and register its script in
   [the script inventory](../../scripts/README.md).
3. **Prove the tier on an existing gap.** Port one test jsdom cannot establish,
   such as the options scroll-spy offsets or a pointer path that now needs the
   trusted-dispatch internals. Show the ported assertion fails against a
   deliberately broken disposable copy, then passes in both engines. Delete the
   jsdom original in the same change.
4. **Record the routing rule in [development.md](../development.md):** pure
   logic stays in `node:test` with no DOM; new DOM-behavior tests use the
   browser tier; legacy jsdom tests stay on typed jsdom until M7.5 moves them.

Exit: `npm run typecheck` checks jsdom usage with no suppressions or
hand-written jsdom types; the browser tier runs in both engines through
`npm run verify` and inside a required CI check with reliable teardown, and its
first ported test demonstrated a failure.
Proof limits: the tier does not load the extension, Playwright's Firefox is a
patched build, and hidden runs do not establish native focus or window
placement. `npm run verify -- browsers` stays the only check for the real
manifest, execution worlds, worker and bridge.

### M5 — Enable and prove Svelte compilation

Status: complete on November 13, 2026.

- **Fixed and verified:**
  - The set resolves cleanly against TypeScript 6.0.3, ESLint 10.14 and
    esbuild 0.28.2. Local runs used Node 26; CI's Node 24 has not run them. The three tools are in `DEVELOPMENT_TOOLS`,
    and the four packages share a `svelte` Dependabot group.
  - [svelte-build.mts](../../scripts/svelte-build.mts) gives every bundle one
    compiler definition: runes, production client output in every mode, and
    injected styles, with scoped style names hashed from CSS rather than a
    cwd-relative path, the runtime's development flag pinned off and the
    plugin's mtime cache disabled. Every file in `dist/` (212 in the
    development build, including all 67 bundles and maps) and every minified
    output is byte-identical with the plugin added.
  - `npm run typecheck` adds `svelte-check --tsconfig ./tsconfig.check.json`.
  - ESLint lints runtime-root components and rune modules as TypeScript and
    requires `<script lang="ts">`.
  - [svelte-tooling.test.mts](../../test/project/svelte-tooling.test.mts)
    compiles a test-only component and `.svelte.ts` dependency through the real
    normal, minified and incremental `esbuildOptions`, and asserts there is one
    output, no compiler code, no code loading or network calls, and only
    namespace and error-text URLs. Against `test/fixtures/svelte/`'s explicitly
    selected checking projects, it shows svelte-check rejecting wrong props at
    a mount site and on a child, plus a missing template name. It drives
    `watchAll` in a disposable checkout through transitive child-component and
    rune edits, a component syntax error that keeps the generation and token,
    and recovery.
  - [svelte-island.dom.mts](../../test/dom/svelte-island.dom.mts) mounts the
    minified fixture through the typed adapter beside legacy DOM in hidden
    Chromium 156 and Firefox 157. A trusted edit saves a frozen, allowlisted
    plain patch built from nested `$state`, which itself cannot be cloned.
    Controller updates re-render. A persisted pagehide holds updates until
    pageshow. A final pagehide removes only the island's DOM and ignores later
    updates. A re-mount works, and legacy listeners and node identity survive
    throughout, including after a re-mount and a direct `dispose()`. A
    component whose first effect throws reports the error and leaves no DOM.
  - The case failed in both engines when the adapter applied updates while
    suspended, when disposal skipped unmounting, and when a failed first
    flush was not disposed.
  - svelte-check also rejects wrong props passed to `mountIsland` and to
    `island.update`; the build test allowlists every bundled `node_modules`
    file, asserts the runtime's development flag is pinned, and rebuilds from
    another working directory to compare bytes.
- **Intentionally not changed:**
  - No production surface imports a component. The `svelte` runtime stays
    counted as shipped by the audit, the conservative side.
  - Bundles use no global `production` resolve condition, because it would
    change existing outputs; only Svelte's `esm-env/development` import is
    pinned to its production module.
  - `.svelte.ts` source maps point at type-stripped JavaScript labelled with
    the `.ts` name.
  - Exact svelte-check messages and bundle origins are pinned on purpose, so a
    `svelte` group update that changes them needs review.
  - The adapter's ordinary TypeScript imports its one rune module; ESLint
    forbids any other runtime TypeScript from importing components or rune
    modules, and island owners are tested through bundles or the DOM tier.
- **Changed but not fully proven:**
  - Injected component styles under production CSP, AMO review and the Chrome
    128/Firefox 152 floors.
  - BFCache is simulated with synthetic page-transition events, not a real
    back/forward navigation.
  - The fixture is served at the routed Peakbagger origin, not an extension
    page.
  - Hosted CI has not run these checks.

1. Resolve and lock a compatible Svelte 5/compiler-adapter/checker/lint set
   against this checkout's TypeScript 6.0.3, ESLint 10, esbuild 0.28 and Node 24.
   Add `svelte`, `esbuild-svelte`, `svelte-check` and `eslint-plugin-svelte` only
   after inspecting their actual peer ranges. Retain the TypeScript major hold.
   Group compiler/checker/lint tooling deliberately in Dependabot and list
   `esbuild-svelte`, `svelte-check` and `eslint-plugin-svelte` in
   `DEVELOPMENT_TOOLS`, so the audit does not count them as shipped. Classify
   the runtime as shipped only when M6 introduces it into production outputs.
2. Add shared compiler settings to the existing build-options path. Extend the
   explicit checking project and TS-aware Svelte lint scopes. Keep ordinary
   controller TS independent of compiled rune modules. Add no second writer to
   production `dist/` and no automatically discovered checker-only tsconfig.
3. Compile a test-only component plus `.svelte.ts` dependency through the actual
   normal, minified and incremental options. Check invalid props and missing
   template names, mount/update/unmount the built client in M4.5's browser
   tier, and repeat M4's
   serialization tests with compiled `$state` values.
4. Exercise transitive component/rune edits, syntax failure and correction with
   M3's generation/token assertions. Demonstrate the typed mount/update/dispose
   adapter beside legacy DOM in a faithful hidden Chrome/Firefox fixture on
   that tier, with
   suspension, resumption, removal and re-enable coverage.

Exit: checks reject deliberate component errors; compiled fixtures work in both
browsers; failed component generations preserve the prior build and recover;
no runtime compiler, remote code or unexpected chunks ship. This milestone
proves tooling and a fixture contract, not production CSP or host integration.

### M6 — Ship one bounded Svelte island

Status: complete on November 18, 2026 (`83541e1f`, `c81c7cee`, `0aa1c6ef`).

- **Fixed and verified:**
  - Pre-edit baseline verified (`npm run verify -- layout-stability --surface=settings` 8/8 in Chrome `158.0.8127.18` and Firefox `159.0`; `npm run verify -- chrome` passed).
  - [test/project/dependabot-auto-merge.test.mts](../../test/project/dependabot-auto-merge.test.mts) (`83541e1f`) derives bundled npm packages from actual esbuild `metafile.inputs` across all 67 `ENTRIES`, catches transitive bundled packages, includes compiled Svelte runtime packages (`svelte`, `esm-env`, `clsx`), ignores erased `import type` statements, and fails if `svelte`, `clsx`, or `esm-env` is removed from `.github/dependabot.yml`.
  - [scripts/svelte-build.mts](../../scripts/svelte-build.mts) sets `fragments: 'tree'` and `discloseVersion: false`, emitting DOM tree operations with zero `.innerHTML` assignments (`0` new `web-ext lint` warnings; `10` owned warnings observed within `WEB_EXT_WARNING_BASELINE` cap `11`).
  - `options/options.html` preserves `#general-units` and `#general-units-heading` while replacing the card interior with `<div data-unit-settings></div>`; `options/UnitSettingsPanel.svelte` and `options/unit-settings.ts` mount via [svelte-island.ts](../../src/ui/svelte-island.ts) (`initUnitSettings({ save })` / `{ populate }` unchanged so `options/options.ts`, then `.js`, needed no code edit).
  - Converted [scripts/dependency-metadata.mts](../../scripts/dependency-metadata.mts) and [scripts/third-party-notices.mts](../../scripts/third-party-notices.mts) from `.mjs`, registered `svelte` (`shipped: true`), updated [ACKNOWLEDGEMENTS.md](../../ACKNOWLEDGEMENTS.md) (version-neutral), [scripts/create-amo-metadata.mts](../../scripts/create-amo-metadata.mts) (`<= 3,000` chars), `.github/dependabot.yml`, and [docs/development.md](../development.md).
  - Measured `dist/options/options.js` bundle size: baseline dev `302,024` raw / `72,106` gzip, min `154,283` raw / `52,075` gzip; post-M6 dev `493,928` raw / `113,672` gzip (`+191,904` raw / `+41,566` gzip), min `216,442` raw / `74,975` gzip (`+62,159` raw / `+22,900` gzip); `dist/options/options.js` is the only production bundle importing `svelte`.
  - Verified full suite (`npm test` `4,209/4,209` including unchanged [options-units.test.mjs](../../test/options/options-units.test.mjs)), `npm run typecheck` (`594` files, 0 errors/warnings), `npm run lint` (`10` owned warnings), `npm run audit:ci` (0 shipped advisories), [test/dom/options-units.dom.mts](../../test/dom/options-units.dom.mts) (mutated-`dist` failure proved in both Chromium `158.0.8127.18` and Firefox `159.0`; `verify -- dom` `16/16` cases passed hidden across Chromium & Firefox including failed-save rollback, queued saves, external storage updates, BFCache suspend/resume/dispose, keyboard use, `390x900` 200% zoom, dark mode), `verify -- layout-stability --surface=settings` (`8/8` across `390`/`1280` light/dark), `verify -- settings-navigation` (Chrome `158.0.8127.18` `97`+`45`, Firefox `160.0` `96`+`45`), real unpacked `verify -- chrome` (`158.0.8127.18`) & `verify -- firefox` (`160.0`) with live `SETTINGS_PATCH` persistence (`options/unit-settings.ts` -> worker -> `storage.sync`), and `npm run release:verify-packages` (minified Chrome & Firefox store archives passed).
- **Intentionally not changed:** `options/options.ts` stayed JavaScript until M7 Batch 2.3; styles remain in `options/options.css` (component `<style>` omitted to preserve single-stylesheet tokens and avoid inline style rules); existing `WEB_EXT_WARNING_BASELINE` (cap `11`, `10` observed) stayed unchanged.
- **Changed but not fully proven:** Chrome `128` (`chrome-floor`) and Firefox `152.0` (`firefox-floor`) are tested by hosted Linux CI rather than local macOS installs; native focus/window placement, live extension store submission, and Firefox for Android `142.0` device checks remain outside automated desktop evidence.

1. Confirm the hidden verifier can load the real options page before editing UI.
   Use [the Units panel](../../options/unit-settings.ts) as the default pilot:
   it already has a small `initUnitSettings({ save })` / `populate` boundary,
   no native permission prompt and [focused behavior tests](../../test/options/options-units.test.mjs).
   Preserve the existing settings choices, IDs, examples, disclosure behavior
   and reset semantics. Do not redesign the rest of Settings.
2. Convert the
   [Dependabot graph test](../../test/project/dependabot-auto-merge.test.mts)
   to `.mts` and derive bundled packages from actual esbuild metafile inputs,
   as notices already do. Test compiled implicit imports and erased type-only
   imports using fixtures. Keep compiler-only dependencies classified separately
   until a production output actually contains them.
3. Convert the panel owner to `.ts` and mount one typed component in a dedicated
   descendant of the existing Units subsection. Transfer ownership of its
   controls once; keep the outer heading and unrelated native/legacy DOM.
   Retain the public initializer/populate contract so the parent's only change
   can be an exact filename reference. If the contract cannot be preserved,
   include the parent's required TS conversion explicitly in this milestone's
   cost instead of making substantive edits in JavaScript. In this same focused
   integration change, register Svelte and any shipped transitive packages in
   the correct dependency groups/metadata; update notices, acknowledgements and
   AMO notes. Removing the shipped runtime's group entry must make the guard
   fail. Do not commit a production component before its shipping metadata.
4. Run the unchanged Units tests plus focused mixed-owner/browser checks. Cover
   defaults, mixed units, reset, failed save/rollback, slow and repeated changes,
   external settings updates, keyboard use, re-enable and BFCache lifetime.
   Compare control/heading/following-content/scroll geometry at desktop and
   narrow widths, both themes and enlarged text, including intermediate states.
5. Run full repository gates, current and minimum Chrome/Firefox smokes
   (configured floors: Chrome 128 and Firefox 152.0), minified packages and exact
   archive inventories. Exercise the real messaging/persistence paths used by
   the panel, not only a JSON stub. Inspect CSP/style behavior, AMO warnings and
   bundle raw/gzip deltas; ensure legacy-only consumers do not acquire Svelte.

Exit: the real panel ships through the same mixed build with preserved behavior
and successful browser/package gates. Record remaining native-focus/live proof
limits explicitly. **M6 completes production TS/Svelte adoption; it does not
complete conversion of the repository or prove WXT compatibility.** A new
bounded owned-page feature may replace this pilot only with a recorded owner,
integration contract and equivalent gates; no unspecified future feature keeps
the milestone permanently open.

### M7 — Convert all remaining JavaScript in increasing-cost batches

Keep a per-owner checklist with source, callers/entries, tests, measured output
changes and proof limits. Separate behavior-preserving TS conversion from any
later Svelte rewrite of the same owner. Finish one owner before the next.
The pure-TS batches can begin after M3 without waiting for M4–M6; only additional
production Svelte surfaces depend on the proven M6 contract.

The batch order below is the default for planned work. A module converted
earlier because the TypeScript-on-modification policy required it counts toward
M7, and it owes the same gates as its batch: record it under **Changed but not
fully proven** in [Current progress](#current-progress) until those gates run.
The per-owner checklist does not exist yet; start it with the first planned
batch and backfill the conversions already listed there.

1. **Small pure modules:** begin with
   [storage-value.ts](../../src/storage/storage-value.ts), then bounded helpers
   such as [theme-resolve.ts](../../src/theme/theme-resolve.ts),
   [provider-url.ts](../../src/capture/provider-url.ts) and
   [runtime-message.ts](../../src/ui/runtime-message.ts) (preserve `send` and
   the `sendResult` response/unavailable distinction). Keep exports, algorithms
   and source-policy exceptions unchanged; run the owning behavior tests.
2. **Shared domain contracts/services:** convert the settings store (its schema
   is already TypeScript),
   request helpers, capture/GPX math and persistence owners in dependency order.
   Keep a single schema and the existing transport/storage owners. Preserve
   coercion/defaults, trust checks, sync/device split, migrations, transaction
   behavior and data retention. Review broad fan-out before choosing a batch;
   a pure module used by many bundles can cost more than a small controller.
3. **More extension-owned UI:** convert bounded options modules first, then
   complete page controllers, popup and photo workspace as separate projects.
   Reuse M6's adapter/visual checks. Keep editors, selection/composition, image
   workflows and pre-paint theme startup under their existing owners.
4. **Host-page islands:** start with one extension-owned card body/control;
   preserve card layout/drag owners and native nodes. Prove coexistence,
   collapse/reparenting, BFCache and geometry in Chrome/Firefox before widening.
   Existing typed map controls do not need a Svelte rewrite merely for uniformity.
5. **Large coordinators and cross-world graphics:** convert the MAIN-world GPX
   analyzer, the worker's remaining JavaScript route modules and other
   coordinators last, one boundary at a time. The background worker itself is
   already converted (`c45d32ef`) and passed the packaged Firefox check.
   Keep bundle order, sender/privacy/Save gates and shared math.
   Require real-manifest/worker/bridge checks and hardware-rendered terrain
   verification for affected graphics paths; pure unit tests cannot close these.

Convert touched Node tooling/tests alongside their owner; update `.mts` command,
inventory and test-discovery references, including scale-test discovery when
applicable. Test and script conversion is not a prerequisite for runtime batches,
but it is required to close M7: convert whatever remains in owner-sized batches
once its runtime owners are done.

A test converted alongside its runtime owner stays on typed jsdom, so a runtime
batch does not also become a test-environment migration. Moving tests off jsdom
is M7.5, not part of this milestone.

Exit: no authored JavaScript remains anywhere in the repository, including
`scripts/`, `test/`, `docs/plans/` and `store-assets/`, and the affected gates
pass. TypeScript tests may still use typed jsdom. The exclusions in `scripts/typescript-policy.mts` stay explicit for generated
and upstream code; a file a tool requires in JavaScript needs its own narrow
documented exception. To keep the result, make the policy reject any authored
JavaScript file rather than only changed ones, and remove `allowJs` from the
checking projects. Svelte conversion remains per-surface, based on a useful
ownership boundary rather than a percentage target.

Local owner verification at `b66b506e` used Node 24.22.3 and freshly built
esbuild bundles. The checks ran hidden, with isolated browser profiles.

| Converted owner | Local evidence |
| --- | --- |
| `src/terrain/terrain-coordinator.ts` (`20e54c38`), terrain frame and analyzer | Both `verify -- terrain` engines passed on ANGLE Metal Apple M3 Pro. Chromium 158.0.8127.18 exercised wide Ascent at 1280 × 950, BigMap at 1000 × 760 and Peak layouts at 820/375 × 900. Firefox 159.0 exercised Ascent and Peak at a 1000 × 760 baseline with a 375 px narrow layout. Both used synthetic terrain and activation fixtures. |
| `src/maps/big-map.ts` (`c3b47b04`) | `verify -- map-controls` passed 14 cases per engine, including both BigMap modes, in Chromium 158.0.8127.18 and Firefox 159.0 at 1280/375 × 1000 on the same renderer. |
| `src/capture/provider-page.ts` (`79fe003c`) | `verify -- provider-contracts` passed in Chromium 158.0.8127.18 and Firefox 159.0 at 1280 × 720 with intercepted provider fixtures. It exercised ownership, route changes and export responses. |
| `src/background/background.ts` (`c45d32ef`) | `verify -- capture-readiness` passed pending-image capture, helper startup and signed-out privacy gates with the real worker and a fixture provider in Chromium 158.0.8127.18 at 1000 × 760 and Firefox 160.0.1 at 1000 × 675. |

Teardown removed the browser profiles. Native window focus, live provider
permissions and hosted Linux browser-floor results require separate evidence.

### M7.5 — Retire jsdom

Split from M7's exit on November 13 ([owner decision](#owner-decisions)). This
is a test-environment migration, independent of the language conversion: it may
start once M4.5's browser tier exists and does not block M7 or M8.

The [provider access suite](../../test/dom/map-access/provider-access.dom.mts)
uses the shipped pages with a controlled permission response and close handler.
Packaging order remains covered by the pure
[map-access test](../../test/ui/map-access.test.mts). The full browser tier
ran 28 cases. All eight provider cases passed again after adding startup
observation, at 390 × 760 in hidden Chromium 158.0.8127.18 and Firefox 159.0.
Both engines rejected disposable builds that requested permission on load
or accepted synthetic input. These fixtures use stubs for the native
permission dialog and tab close.

The [saved-ascent chart probe](evidence/card-reuse-audit.mts) now renders
the shipped bundles in the browser tier. Hidden Chromium 158.0.8127.18 and
Firefox 159.0 at 1000 × 760 rendered wind labels `0, 2, 4`. A disposable
bundle with the original narrow scale reproduced `0, 1, 1` in both engines.

The [avalanche planning links suite](../../test/dom/avalanche/avalanche-links.dom.mts)
runs the shipped peak-links bundle on HTTPS fixtures. All 32 cases passed
across hidden Chromium 158.0.8127.18 and Firefox 159.0 at 1000 × 760. In both
engines a disposable bundle without the idempotence guard created a duplicate
panel and failed the new assertion. Provider registry and coordinate math
stay in the checked [Node suite](../../test/avalanche/avalanche-links.test.mts).
The [weather interval verifier](../../scripts/verify-weather-intervals.mts)
now prepares its Nepal fixture without jsdom. The old and new versions both
passed in hidden Chromium 158.0.8127.18 at 1440 × 1000, with the same 24.0 mm
sum, GMT+5:45 boundary labels, keyboard readout and two intercepted requests.
The ascent backup lifecycle and layout verifiers now share a checked edit-form
fixture transform. Hidden Chromium 158.0.8127.18 restored the exact BFCache
document with one control and zero writes at 1000 × 760 and 390 × 760. The
layout surface passed eight cases in that Chromium and Firefox 159.0 at
390 × 900 and 1280 × 900 in both themes. The fixture guard accepts LF and
CRLF checkouts and rejects missing and duplicate fields.
The profile units verifier prepares its metric fixture in a separate offline
browser page. Its before-and-after results matched across 16 cases each in
hidden Chromium 158.0.8127.18 and Firefox 159.0 at 1280/720 × 900, with both
themes and simulated 2× reflow. Chromium loaded the real unpacked extension.
Firefox used the shipped bundles with stubbed settings APIs.
The ascent columns and filters layout surfaces also prepare their native
fixtures offline in the browser. Each passed 16 cases across those two
hidden engines, at 390/1280 × 900 and 260/853 × 600, including light, dark
and simulated 150% reflow. This removes the last direct verifier imports.
All 28 terrain cache cases run in Node with the existing in-memory storage,
native fetch primitives, and controlled transports. The cases produced the
same results with and without the unused jsdom windows. A disposable change
to the tile coordinate bound failed the preserved out-of-range assertion.
The stable text case preserves all eight assertions in the real DOM tier.
Hidden Chromium 158.0.8127.18 and Firefox 159.0 passed at 1000 × 760. Removing
the equality guard in a disposable module produced 120 unwanted mutation
records in both engines, where the normal module produced zero.
The [Open-Meteo request audit](evidence/open-meteo-peak-request-audit.mts) ran
the exact built bundles in hidden Chromium 158.0.8127.18 at 1000 × 760. All
23 records and the default request URL/cache tuples matched the current jsdom
baseline after bypassing its obsolete standalone esbuild step. Source
fingerprints now use embedded development bundle maps. Suppressing the weather
intersection callback in a disposable bundle failed the `Only weather
intersects` count assertion.
The local GPX timestamp filter now exercises the native XML parser and
serializer in hidden Chromium 158.0.8127.18 and Firefox 159.0 at 1000 × 760.
Both passed the removal, metadata retention and invalid XML checks. Both
detected retained timestamps when the removal loop was disabled in a
disposable module. The complete DOM lane passed 64 cases.
The backup replacement review now checks its Cancel label, native Escape
handling, hidden state and return to the original trigger in the same two
hidden browsers at 1000 × 760. Removing Cancel focus in a disposable module
failed the opening focus assertion in each engine. The DOM lane passed 66
cases after the port.

1. Move the remaining jsdom tests to M4.5's browser tier, owner by owner. At
   `dc985cc9`, 93 files under `test/` directly import or re-export from jsdom,
   and additional tests reach it through helpers. Pure logic that needs no DOM
   moves to plain `node:test` instead. For each ported owner, show the new
   assertion fails against a deliberately broken disposable copy, and delete
   the jsdom original in the same change.
2. Remove `jsdom`, `@types/jsdom`, the jsdom checking project, the shared page
   loader's trusted-dispatch internals, and their Dependabot and
   `DEVELOPMENT_TOOLS` entries.

Exit: nothing in the repository imports jsdom and the package is gone; every
former jsdom assertion is either ported or recorded as intentionally dropped
with a reason. Cost to accept before starting: every DOM test then needs a
browser launch, which the Codex Seatbelt sandbox forbids for Chrome, so those
tests can no longer run there, and `npm test` covers pure logic only.

### M8 — Cut over production to WXT/Vite

The owner selected WXT/Vite for production after reviewing the
[full candidate evaluation](experiments/wxt-evaluation.md). The production
backend uses WXT's build API and public Vite config hook. It generates inert
entry definitions from the single ordered inventory and uses WXT's scheduler.
Each generation runs in a separate working directory and Node process so WXT's
build state and environment loading stay inside that generation. The existing
publisher, reload signal and browser-specific packaging still own their
respective contracts. [WXT build internals](https://wxt.dev/guide/resources/how-wxt-works#building)

#### Verified locally

- The production compiler passed 4,213 Node tests, 14 scale tests, strict
  typecheck, lint, the full branch TypeScript policy check, the dependency
  audit, and the 60-case DOM browser tier. Hidden Chromium 158.0.8127.18 and
  Firefox 160.0.1 at 1000 × 760
  passed the real unpacked and exact packaged verifiers on macOS, including
  BFCache restoration. Chrome for Testing 128.0.6613.137 and Firefox 152.0
  passed the same package verifier at the declared browser floors. Each
  archive contained 145 entries. The Chrome ZIP was 3,632,959 bytes and the
  Firefox ZIP was 3,632,901 bytes.
- Hardware terrain passed on Apple M3 Pro Metal in hidden Chromium with
  448 × 448 and 798 × 448 render canvases, and in hidden Firefox 159.0 at a
  1000 × 760 viewport.
- Hidden managed Chrome 158.0.8127.18 (1000 × 560) and Firefox 160.0.1
  (1000 × 675) loaded fresh HTTPS fixture documents after an edit, a syntax
  error, and its repair. The injected revision and external generation marker
  advanced together on both successful builds and kept their prior values
  during the error. Both processes and their profiles shut down cleanly.
  Filesystem tests forced Firefox swap and signal failures and verified
  rollback of both trees.
- Hidden Chromium 158.0.8127.18 and Firefox 160.0.1 at 1000 × 760 retained
  their extension identities and the dark theme and metric units settings
  when upgrading locally from esbuild 4.0.2 to the exact WXT 4.1.0 payloads.
  The worker migrated the legacy 287 MB terrain cache limit from sync to
  device storage. The Chrome rehearsal cleared the previous `Service Worker`
  directory in its disposable profile before reopening the same unpacked path.
  Extension settings storage was retained. Firefox migrated during same-ID
  temporary add-on replacement.
- Reversing `4286ede2` and `133384ab` in a disposable checkout reproduced the
  last esbuild tree and Git index at `d0eea8b2`. A clean pinned install built
  all 67 bundles on both sides. Five interleaved release builds on macOS arm64
  with Node 24.22.3 took a median 672 ms with esbuild and 2,568 ms with WXT.
  Wall time includes process startup, compilation, assets and notice writing.
  The owner accepted the roughly 1.9-second increase. The production adapter
  uses WXT's public scheduler. With the same ZIP Deflate settings, the release
  trees compressed to 3,702,067 bytes for esbuild and 3,631,327 bytes for WXT.

Hosted Actions, Firefox Android, and a signed store-delivered update still
require their respective release environments. The local update used unpacked
Chrome and a temporary Firefox add-on in disposable profiles.

#### Original cutover plan

This is feasible to investigate alongside legacy sources, but it is not just a
bundle-format flag. [WXT migration](https://wxt.dev/guide/resources/migrate)
changes entrypoint discovery and manifest generation. Its
[entrypoint guide](https://wxt.dev/guide/essentials/entrypoints) also warns that
unlisted entries are evaluated during build, which matters for existing
top-level side effects.

1. Create an experimental build into a **separate output directory**, keeping
   esbuild the only publisher of production `dist/`. Start with one owned HTML
   page and one classic content-script entry importing the same domain modules.
   Do not switch package/release commands yet.
2. Add a thin generated adapter layer from the existing manifest and `ENTRIES`
   rather than hand-maintaining two extension definitions. Preserve ordered
   multi-source side effects. Determine how WXT's build-time entry discovery can
   avoid executing legacy runtime initialization; do not assume a static import
   inside a new wrapper defers the imported module's side effects.
3. Derive the complete inventory from `ENTRIES`, including both ESM frames,
   on-demand injected scripts, the overlay worker, vendor preloads, synchronous
   head scripts, CSS and web-accessible assets. Preserve the paired Chrome worker
   and Firefox background references. Confirm current browser targets explicitly.
4. Prove manifest parity: permissions and optional grants, matches/exclusions,
   execution worlds, frame targeting, `run_at`, script/CSS order, resource
   exposure, CSP and update identity. Preserve JSZip/MapLibre patches and the
   audit/notice/source-package pipeline. A dynamic loader is not an acceptable
   substitute for an early synchronous script.
5. Recreate successful-generation reloads and publication with failure rollback.
   Integrate both Chrome and Firefox dev paths and the existing verifiers against
   the candidate tree, without two concurrent writers or browser launchers.
6. Switch the build in one dedicated cutover only after full parity, real
   extension/browser checks and packaged upgrade verification. If required
   ordering or synchronous startup cannot be preserved, keep the hybrid
   TS/Svelte/esbuild architecture and record the blocker.

Exit: the candidate passes the same manifest, runtime, reload, package and
upgrade checks as production, with reviewed size/startup differences and a
rollback path. The owner accepted the performance cost of the full candidate.
Any failure of a release compatibility gate still warrants restoring the last
verified publisher until the failure is fixed.

## Compatibility checklist for every implementation milestone

### TypeScript configuration and interoperability

- Keep strict checking separate from build transformation. Retain
  `tsconfig.check.json` and `tsconfig.node.check.json`, selected explicitly by
  `npm run typecheck`; point typed ESLint project configuration at the relevant
  project if enabled. In M5, select the browser project explicitly with
  `svelte-check --tsconfig ./tsconfig.check.json`. Test fixtures need dedicated
  project inputs so both positive and intentional-failure cases are checked.
  Do not introduce an automatically discovered root `tsconfig.json` as a
  checker-only change: esbuild reads it, and `strict: true` can introduce
  `use strict` into existing JavaScript IIFEs. If an editor-facing root config
  is added later, first select an explicit build configuration that preserves
  reviewed transform behavior. Compare legacy bundle output and exercise a
  strictness-sensitive regression fixture before accepting either arrangement.
  [esbuild documents its tsconfig discovery](https://esbuild.github.io/api/#tsconfig)
  and [the transform-affecting options](https://esbuild.github.io/content-types/#tsconfig-json).
- Keep browser checking scoped to `src/`, `options/`, `popup/` and `photos/`,
  matching `AUTHORED_SOURCE_ROOTS`; retain the existing divergence guard.
  Use `allowJs: true`, `checkJs: false`, `strict: true`, `noEmit: true`,
  `isolatedModules: true`, `erasableSyntaxOnly: true`,
  `verbatimModuleSyntax: true`, explicit-extension support and bundler resolution.
  TypeScript 6 changed several defaults and deprecated older options, so set
  every option this plan depends on explicitly, including `types`, rather than
  inheriting defaults that a later major may change again.
  Keep the existing browser targets in esbuild and the separate Node checking
  project for tooling/tests. Do not merge their globals into one project.
- `checkJs: false` leaves legacy JS outside strict checking; it does not make
  everything imported from JS safe. Keep declarations beside their owners or
  use a narrow adapter in that domain. Prefer inferred types and signatures
  checked against real behavior; use `unknown` plus validation for untrusted
  replies. Avoid blanket ambient modules or `as SomeResponse` at trust boundaries.
- Cover both the `chrome` and `browser` names actually used. Keep MAIN-world
  adapters free of extension APIs; compiler globals alone cannot enforce the
  execution world. Add declarations for existing `Chart`/`marked` globals only
  where consumed, preserving their manifest preload order.
- Keep the Node runner for pure and legacy jsdom tests, and untouched `.mjs`
  tests until M7 converts them to `.mts`; new/substantively changed Node tests use `.mts`.
  New DOM-behavior tests use M4.5's browser tier once it exists. Plain erasable `.ts` domain modules can be tested
  directly. Components and rune modules must be compiled
  first and exercised through client bundles. Do not let a Node-imported
  controller transitively import `.svelte` or `.svelte.ts`.
- Add compiler-failure fixtures that run the actual check commands with nonzero
  expected diagnostics. A `.d.ts` declaration is a compatibility promise, not
  proof that the old implementation satisfies it; retain behavioral tests.
- Use exact relative source extensions and update imports, entry aliases,
  commands, literal source readers and owner exceptions when renaming. Node
  rejects stale `.js` paths that esbuild may resolve to `.ts`; do not add a
  fallback loader. Node's [TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
  describes erasable syntax and explains that it ignores `tsconfig.json`.
- Recheck the locked dependency peers when adding Svelte, not a moving
  `latest` tag or the report's minimum versions. Preserve the compiler-major
  hold until its consumers admit the next major. Each dependency addition must
  pass `npm run audit:ci` under the
  existing policy; advisories in shipped code still fail closed. That audit
  treats every direct dependency missing from `DEVELOPMENT_TOOLS` in
  `scripts/check-npm-audit.mts` as shipped, so register each new build or test
  package there in the change that adds it.

### Source guards that must retain coverage

The source-discovery portion is implemented as of November 3, 2026. These
checks use [shared runtime discovery](../../test/helpers/runtime-sources.mts)
across the build-owned roots, exclude declarations and generated/vendor code,
and include `.svelte.ts` through the `.ts` suffix. Fixtures stay outside the
production scan. Existing policy counts are preserved; the newly discovered
photo-editor display read has an explicit reviewed owner. Watcher coverage across
all authored roots is complete in M3; executable Svelte coverage is M5.

| Existing test | Boundary to preserve |
| --- | --- |
| [units](../../test/ui/units.test.mts) | Single conversion-constant owner across discovered shared and page-local sources. |
| [settings schema](../../test/settings/settings-schema.test.mts) | Single default/bounds owner, including its explicit owner exclusion. |
| [settings read policy](../../test/settings/settings-read-policy.test.mts) | Passive `get()` versus authoritative `requireCurrent()` ownership; register any new adapter alias so the scanner still sees those reads. |
| [capture core](../../test/capture/capture-core.test.mts) | Single upload-limit owner. |
| [request deadlines](../../test/net/request-deadline.test.mts) | Bounded network requests and the path-keyed reviewed exceptions. |
| [Cloudflare classification](../../test/peakbagger/peakbagger-cloudflare.test.mts) | Centralized challenge detection and human-check copy. |
| [Peakbagger origin](../../test/peakbagger/peakbagger-origin.test.mts) | Canonical origins and host checks across runtime roots. |

The predicate alone does not make regex scans understand every TypeScript or
Svelte expression. Test representative typed declarations and template handlers;
if a syntax form evades a policy, use language-aware extraction for that rule.
Loose-file and page-local lint coverage are also migrated in
[development.test.mts](../../test/project/development.test.mts).

The [Dependabot group test](../../test/project/dependabot-auto-merge.test.mts)
is a package-graph guard, not a policy scan: broadening its file matcher does not
fix it. Replace its source-text import walk with metafile inputs in M6, before
the first production component ships.

### Build and packaging contract

- Keep [manifest.json](../../manifest.json) and `ENTRIES` authoritative. New
  authored `.ts` files still produce `.js` outputs. Add page-local aliases to
  `PAGE_LOCAL_RELATIVE` as necessary: unknown page source names currently resolve under
  `src/`, not automatically under `options/`, `popup/` or `photos/`.
- Add the Svelte plugin alongside the current browser-import and JSZip plugins,
  using the same options for normal, minified and watch builds. Keep the staging
  validation, whole-generation publication and reload-signal ordering intact.
  Do not introduce a second build that writes independently to `dist/`.
- Start with `fragments: 'tree'`, `css: 'injected'`, and
  `discloseVersion: false`. Share compiler settings with lint/check tooling.
  Confirm the locked adapter compiles rune modules and selects the browser
  runtime. Align compiler/runtime development mode deliberately. The
  [adapter documentation](https://github.com/EMH333/esbuild-svelte) describes rune
  module support, CSS output and export conditions; local compatibility remains
  an implementation gate. These are candidate
  [compiler options](https://svelte.dev/docs/svelte/svelte-compiler), not AMO/CSP
  certification; scoped CSS does not isolate a component from host selectors.
- Preserve synchronous early-theme and `*-head.js` execution. The deferred body
  entry can mount Svelte; the pre-paint theme path must not wait for it. Do not
  introduce dynamic-import loaders into classic or MAIN-world entries.
- Keep static outer shells, reserved feedback space and shared tokens in the
  existing copied stylesheets. No `{@html}` in new components. If runtime CSS
  fails the target CSP or startup checks, explicitly implement external CSS
  emission, copying, manifest/page references and package expectations as one
  change; do not silently accept an unstyled widget.
- When Svelte is first shipped, update
  [reviewed dependency metadata](../../scripts/dependency-metadata.mts),
  [AMO notes](../../scripts/create-amo-metadata.mts) and
  [acknowledgements](../../ACKNOWLEDGEMENTS.md). Notices are generated into
  `dist/THIRD_PARTY_NOTICES.txt` from bundled inputs, including shipped transitive
  packages. Do not mark an unused compiler-only dependency as `shipped: true`:
  the metadata test would then demand a runtime notice that the build cannot
  discover. Verify licenses for the actual graph rather than only `svelte`.

### UI ownership and lifetime

Use ordinary TS for controllers, data and injected services; keep runes within
the compiled UI boundary. The wrapper exposes typed updates and idempotent
disposal. Each separately built IIFE owns its own Svelte runtime and module
state; continue cross-bundle coordination through existing transports.

Reactive objects must not cross those transports directly. Before calling
runtime/window messaging, extension storage or IndexedDB, construct a validated,
allowlisted plain-data payload at the owning boundary. Use
[`$state.snapshot`](https://svelte.dev/docs/svelte/$state#$state.snapshot) inside
compiled UI where needed to detach reactive state, then serialize only the
permitted fields through the existing schema/owner. A snapshot is not validation
or permission to forward the whole UI state. A shallow spread can retain nested
proxies, and TypeScript structural types do not distinguish them from plain
objects. A clone failure can otherwise look like an unavailable worker through
the existing runtime helper, or reject a settings write.

In M4, test plain-data construction with nested native proxies and a real
structured-clone operation; assert that unapproved fields are absent. In M5,
repeat with compiled `$state` values. Before adoption, exercise the real
Chrome/Firefox messaging and persistence paths that the first feature uses,
including recoverable serialization failures and successful writes. Do not use
a JSON-only messaging stub as proof of Firefox clone compatibility.

| Surface | Coexistence rule |
| --- | --- |
| Extension-owned page | Mount in a dedicated empty container. Existing JS and Svelte must not both bind the same control or replace each other's subtree. |
| Peak card | Keep the shared layout owner's shell, header, disclosure and drag behavior. Mount into a dedicated descendant of its body after owner placement is established; do not replace native/reparented nodes. |
| Saved-ascent card | Keep the ascent columns and existing card/drag owner. It is not a peak-card-layout consumer. |
| Embedded GPX/form/map control | Keep the current owning feature and execution world; mount only an extension-owned child. Do not take over native forms, map layers or Save controls. |
| Standalone floating widget | Shadow DOM can be evaluated separately, with explicit theme, focus and accessibility handling. It is not a prerequisite for first adoption. |

Follow [card conventions](../card-conventions.md) and
[createPageLifecycle](../../src/ui/page-lifecycle.ts). A persisted `pagehide`
suspends external work without unmounting; `pageshow` resumes it. Final disposal,
feature removal or disabling unmounts the island and cancels its outstanding
work. These latter removals can occur while the document is still active.
Component cleanup alone is insufficient for BFCache: the controller must pause
its timers/subscriptions/requests explicitly and reject stale results.

Pair mount-owned subscriptions with synchronous cleanup registration, as the
repository UI skill recommends. Handle unmount promises and cleanup failures;
do not discard a rejected promise. Tests must wait for rendered postconditions:
[Svelte's mount API](https://svelte.dev/docs/svelte/imperative-component-api) does
not synchronously run every effect. DOM assertions cannot establish first paint,
focus, clipping or stable reading position.

## Optional library substitutions after M6

These are independent owner decisions, not additional requirements for marking
TS/Svelte adoption complete. Evaluate a new isolated use before replacing a
working shared owner; broad protocol/storage migration has the greatest cost.

| Report layer | Incremental decision | Later conversion gate |
| --- | --- | --- |
| WXT / Vite | Compile all development and release bundles through the public build API. | M8 records manifest, output, reload, package and local upgrade checks. |
| Valibot | Optional for a new protocol/schema in its existing owning domain. Keep `settings-schema.ts` authoritative. | Replacing a validator requires parity for coercion, defaults, bounds, unknown keys and failure behavior; no second settings schema. |
| `@webext-core/messaging` | Use typed wrappers over the current wire protocol first. | A new RPC library needs an explicit adapter or new protocol on both ends, sender validation and compatibility tests; it is not a transparent replacement for raw envelopes. |
| WXT storage | Keep the existing settings owner, sync/device split, subscriptions, write queue and theme mirror. | Demonstrate identical keys, migrations, authorization, error behavior and update/rollback behavior before replacement. |
| `idb` / Dexie | New features call the existing store owners; use one chosen helper only if it solves a concrete new storage need. | Preserve existing database names, versions, transactions, retention and disconnect cleanup; test real upgrade data and multiple open contexts. |
| LayerCake / uPlot | New charts may evaluate a candidate; do not require legacy chart replacement. | Compare interaction, local-time labels, data gaps, accessibility, theme and measured size/render cost with current charts. |
| MapLibre | Retain the packaged library and extension-frame architecture. | New controls can be TS/Svelte; camera, GPU renderer, workers, activation and network policy remain with their current owners. |
| TipTap / CodeMirror | Already present; retain editor ownership and serialization. | Any Svelte wrapper must preserve editor instances, selection, composition, pasted-image flows and cleanup. |
| Vitest / Playwright Test | M4.5 adds a DOM tier as a `verify` target on the installed `playwright` library; neither runner is added. | Add Vitest only for a concrete testing advantage, with compiler parity and retained manifest/worker/bridge tests. |
| Shadow DOM | Optional for a new standalone island. Retain light DOM for existing reparented host content. | Prove inherited tokens, dark mode, keyboard/focus, sizing and host integration. Scoped component CSS alone is not isolation. |

The [messaging library](https://webext-core.aklinker1.io/messaging/installation)
offers protocol maps and separate window messaging; adopting it still needs
application-specific validation. WXT's own
[storage migration guidance](https://wxt.dev/guide/essentials/storage) supports
retaining a working existing wrapper. None of these library substitutions is
required to unlock new TS/Svelte development.

## Acceptance and verification

Before implementing a UI pilot, confirm the intended hidden browser/fixture
surface can load the target. A small source file is not automatically a safe
pilot: the permission pages in the original report depend on trusted gestures,
native prompts and focus behavior. M6 uses the existing Units subsection;
M7 proves host-page islands separately. A test-only fixture can establish
compiler behavior without shipping a demonstration UI.

- Run `npm run typecheck`, its intentional-failure fixtures, `npm run lint` and
  owning tests for changed modules. Run the full suite and dependency audit at
  the recorded baseline and production-adoption gates. Extend the existing
  [test CI](../../.github/workflows/test.yml) checks to cover Svelte; adding a
  local command alone does not enforce it. The
  [release workflow](../../.github/workflows/release.yml) runs no tests itself
  since `8a9fa6ad` and relies on those required checks. Keep checks inside
  the existing checked jobs, or update the required-check names in
  [release-preflight.mts](../../scripts/release-preflight.mts) and its test if
  introducing a new job. Document it in
  [development.md](../development.md); the development test requires every
  `package.json` script to appear there exactly once.
- Before each commit, stage only the completed unit and run
  `npm run check:typescript-policy`. Do not weaken the policy to avoid a build,
  test or controller conversion; update exact filename references instead.
- Run `node --test test/project/documentation.test.mts` for plan and guide
  edits, including backticked repository paths as well as Markdown links.
- After changing build/load dependencies run `npm run verify -- browsers`, which
  loads real unpacked `dist/`. Keep the new UI's assertions alongside existing
  bridge, worker, early-theme and legacy-content assertions. Build-only fixtures
  do not replace this check.
- Exercise idle, slow pending, success, error and retry with repeated/keyboard
  activation, long feedback, narrow/desktop widths, both themes and enlarged
  text. Compare action, heading, following content and scroll geometry. Test
  BFCache and mount/dispose/re-enable behavior without duplicate handlers.
- Use hidden fixture browsers and follow the repository launch guard, HTTPS
  hostname and teardown rules. Record actual browser versions and viewports;
  assert hardware rendering if the feature touches WebGL. Retain native prompt,
  focus/window-placement and live-provider proof limits where untested.
- Build minified Chrome/Firefox artifacts, validate their exact inventories
  using the documented release/archive tooling, and run packaged checks when
  output handling changes. Check the actual Svelte-containing output for new
  AMO warnings and audit notices, rather than increasing the warning baseline.
- Measure which bundles include Svelte and their raw/gzip deltas. Confirm a
  legacy-only consumer has not acquired the runtime through a shared UI import.
  Give each new feature a dependency budget based on its measured contribution.

Record fixed-and-verified, intentionally-not-changed and changed-but-not-proven
outcomes when closing each milestone and when archiving. A passing fixture or
implementation commit cannot close an unrun production, browser, package or
native-behavior gate.
