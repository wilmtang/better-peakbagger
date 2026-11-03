# Modern stack adoption with legacy compatibility

Status: TypeScript checking/lint foundation implemented; runtime and Svelte
migration have not started. Remaining enabling work is listed below.
Reviewed October 31, 2026 against commit `a951cf7b`; re-audited November 2, 2026
against `32cfc8ed` (findings 9–10 and the dependency-policy rows were added then).

## Recommendation

The first milestone should let a **new feature use strict TypeScript and Svelte 5
while existing JavaScript features continue to ship through the same build**.
It should not require converting existing features, replacing storage, or moving
to WXT first. Treat legacy conversion and build-system replacement as separate
later projects.

The supplied report makes two different recommendations: an incremental
TypeScript/Svelte/esbuild path for this repository, and a WXT/Vite-based stack for
a greenfield extension. The second is a useful candidate destination, not an
established optimum for this codebase. In particular, the report's runtime-size
estimates and proposed chart replacement need measurements before they become
acceptance criteria.

The compatibility foundation consists of language-aware checks, Svelte compilation,
typed access to existing owners, and an explicit DOM/lifecycle contract. Once
those pass the gates below, new features can use the new language and UI layer
without waiting for a rewrite of the worker or shared settings schema.

## Findings that change the supplied plan

1. **TypeScript transpilation already works; type checking is absent.**
   [The build options](../../scripts/build.mjs) bundle ES-module dependencies as
   browser code, and esbuild accepts `.ts` imports. A local probe imported the
   existing `src/ui/units.js` from new TypeScript and produced the expected
   browser IIFE. A second probe deliberately supplied an invalid TypeScript
   assignment: esbuild still built it. Add an enforced type-check command and CI
   step, not just `tsconfig.json`. [esbuild explicitly separates transpilation
   from type checking](https://esbuild.github.io/content-types/#typescript).

2. **Preserving `no-undef: error` for TypeScript is the wrong lint invariant.**
   [The current coverage test](../../test/project/development.test.mts) requires
   that exact rule for every page-local entry. Keep it for JavaScript; for
   TypeScript, require a configured TS parser, appropriate TS rules and an
   enforced compiler check instead. Core `no-unused-vars` and `no-shadow` also
   need their TypeScript-aware replacements in TS scopes. Configure Svelte
   separately so template syntax and `<script lang="ts">` use the right parsers.
   Do not spread the existing formatting rules blindly onto template markup.
   At investigation time the gap was silent, not loud: the former
   `eslint.config.mjs` (now [eslint.config.mts](../../eslint.config.mts))
   matches only `*.js`/`*.mjs`, so `eslint src options popup photos …` skips a
   new `.ts` or `.svelte` file without a diagnostic (`calculateConfigForFile`
   returns no config for either). A TS scope must exist before the first `.ts`
   file lands, and the coverage test must assert that it applies.
   [typescript-eslint recommends disabling core `no-undef` for TypeScript and
   using extension rules](https://typescript-eslint.io/troubleshooting/faqs/eslint/).

3. **New features do not need a `.js`-to-`.ts` fallback loader.**
   Use exact relative extensions: new `.ts` dependencies are imported with `.ts`;
   existing JavaScript keeps `.js`. Mixed imports work in the local Node probe.
   When an existing file is eventually renamed, update its callers, entry aliases,
   text readers and exception lists in that commit. The local probe confirmed
   that Node rejects a stale `.js` path that esbuild resolves to `.ts`.
   A global resolver hook would create another resolution policy and would not
   fix hardcoded `readFile()` paths anyway. Node's
   [TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
   requires explicit extensions and explains that Node ignores `tsconfig.json`.

4. **Broader file matching is necessary but insufficient for boundary tests.**
   Source coverage was resolved on November 3; see the closure ledger below.
   At investigation time, the seven source walkers listed below matched only `.js`. Several also hardcode
   owner filenames or path-keyed policy counts. Changing only the matcher makes
   a renamed schema fail its own forbidden-literal test. Moreover, most walkers
   inspect only `src/`, so new page-local components can escape the same rules.
   Preserve each test's policy, broaden relevant runtime roots, update owner
   exceptions deliberately, and prove inclusion with failing fixture cases.

5. **The watcher misses an existing domain, not just future components.**
   Deriving the watched directories from
   [entry roots and copied assets](../../scripts/build.mjs) leaves `src/storage/`
   uncovered in this checkout. A new component-only domain would have the same
   problem. Recursively watch `src/` plus page-local roots; configuration and
   dependency changes need an explicit restart policy too.

6. **The inventory and one verification command are stale.**
   Current [build configuration](../../scripts/build-config.mjs) has **66 bundles:
   64 IIFEs and two ESM frames**, including `dist/terrain/vector-map-frame.js`.
   The report's 63-bundle/one-ESM inventory must not drive migration coverage.
   `npm run verify:audit` does not exist in [package.json](../../package.json).
   Dependency-metadata assertions run in
   [the release tests](../../test/project/release.test.mjs); npm dependency
   advisories use `npm run audit:ci`.

7. **A typed messaging facade does not establish end-to-end safety by itself.**
   The worker dispatches handler maps and prefix routes before its switch, not
   only the switch cases counted by the report. New typed clients must preserve
   existing wire envelopes, sender checks, authorization and failure semantics.
   [The runtime helper](../../src/ui/runtime-message.js) distinguishes an
   unavailable transport from a response in `sendResult`; do not erase that
   distinction or retry a possibly committed remote write.

8. **Svelte compiler settings are a starting point, not AMO/CSP proof.**
   `fragments: 'tree'` avoids the template-cloning HTML sink; it does not certify
   every runtime path or stylesheet injection. `css: 'injected'` fits today's
   output inventory but must be checked under the target page's CSP. Scoped CSS
   does not isolate a component from host selectors. Start with an extension-owned
   surface and light-DOM islands; test host-page adoption separately.
   The [compiler options](https://svelte.dev/docs/svelte/svelte-compiler) document
   these choices, including `discloseVersion: false`.

9. **"Latest" TypeScript is not an admissible version, and updates auto-merge.**
   On November 2, 2026 npm's `typescript@latest` is **7.0.2**, while
   `typescript-eslint@8.72.1` peers on `typescript >=4.8.4 <6.1.0` and
   `svelte-check@4.7.8` on `^5.0.0 || ^6.0.0`. The newest admissible line is
   **6.0.x**. [Dependabot](../../.github/dependabot.yml) auto-merges every npm
   group once the required checks pass, uses `versioning-strategy: increase`, and
   sends unmatched packages to the `remaining-npm` catch-all. An unplanned
   TypeScript 7 bump would either fail `npm ci` on the peer conflict, stalling
   every other catch-all update, or slip through if a check stops running.
   Group the TS/Svelte toolchain deliberately and hold the TypeScript major
   until both peers admit it.

10. **The Dependabot shipping-graph guard cannot see compiled Svelte imports.**
    [The group test](../../test/project/dependabot-auto-merge.test.mjs) decides
    which packages are bundled by regex-scanning authored source text from
    `ENTRIES`, appending `.js` to extensionless relative paths. Compiled
    components import `svelte/internal/client` even when their authored source
    never names `svelte`, so a shipped runtime can avoid the `bundled-runtime`
    assertion. Conversely, `import type` lines would register type-only packages
    as shipped. Third-party notices are already derived from esbuild metafile
    inputs ([third-party-notices.mjs](../../scripts/third-party-notices.mjs)); the
    group check should use the same source of truth before Svelte ships.

## 1. Enable new features without converting old ones

Each row is a proposed focused commit. Finish and check one before beginning the
next. These are enabling changes, not permission to refactor existing features.

| Unit | Concrete changes | Completion evidence |
| --- | --- | --- |
| 1A — TypeScript checking and lint | Add compatible locked versions of `typescript` (6.0.x; see finding 9), `typescript-eslint`, `@types/chrome`, and browser-namespace types where actually needed. Add an explicitly selected `tsconfig.check.json`, TS-aware ESLint scopes, a `typecheck` npm command, CI enforcement and command documentation. Update language-specific lint coverage assertions. Add the new tooling to the Dependabot `tooling` group with a TypeScript major-version hold, and update the group test. | A valid new TS module consuming existing JS passes; deliberate undeclared-name, wrong-type and unused-binding fixtures fail the responsible check. `calculateConfigForFile` returns a TS config for `.ts` paths under every authored root. Existing JS lint behavior and legacy bundle transformation remain unchanged. |
| 1B — Source coverage and watching | Add a shared authored-runtime file predicate beside [walkFiles](../../test/helpers/walk-files.mts), rooted at `AUTHORED_SOURCE_ROOTS` from [build-config.mjs](../../scripts/build-config.mjs), with focused fixture cases. Move the three guards with private walkers (units, settings read policy, request deadlines) onto it. Update the seven guards, applicable page roots and loose-file detection. Watch `src/` recursively and retain all page/asset roots. Document watcher restart requirements for dependencies, entry configuration and compiler configuration. | Guards reject forbidden values/calls in `.ts` and `.svelte` source-text fixtures, including page-local files. A transitive plain `.ts` edit triggers a completed generation; a TS syntax failure preserves the previous generation and reload token. Executable Svelte watch coverage belongs to 1D. |
| 1C — Typed compatibility boundaries | Add narrow typed adapters or colocated declarations for settings, runtime messages and lifecycle methods needed by the first feature. Define validated, allowlisted plain-data payloads at transport/storage boundaries. Keep the existing JS implementations and wire/storage formats. Type new protocols at both caller and handler boundaries. | Wrong requests/responses fail compilation; actual success, unavailable transport, invalid payload and settings failure behavior are checked against existing implementations. Nested-proxy fixtures prove the serializer produces cloneable payloads without extra fields. No new declaration silently converts arbitrary input to trusted data. |
| 1D — Svelte compilation | Add compatible locked `svelte`, `esbuild-svelte`, `svelte-check`, and `eslint-plugin-svelte`; add shared compiler configuration and the plugin in the existing build-options path. Extend `typecheck` to run `svelte-check` against the explicit checking project. Add a representative test-only component compiled with the production options. | `.svelte` and `.svelte.ts` compile in one-off, minified and incremental builds; a transitive Svelte edit rebuilds, a syntax failure preserves the prior generation/token, and a correction recovers. Wrong props fail checking; built client code mounts, updates and unmounts in a fixture. Actual rune state passes the plain-data boundary tests. No extra chunks, runtime compiler or remote code appear. |
| 1E — Mixed UI contract | Add a small mount/update/dispose adapter in the existing UI domain, with tests beside it, and update card/development guidance. Demonstrate a Svelte island beside an unchanged legacy feature in a faithful browser fixture. | Single mount, repeated update, teardown, BFCache suspend/resume, collapse/reparenting where relevant, keyboard activation and state-dependent geometry pass. Legacy content and listeners survive. |
| 1F — First real new feature | Build a real, bounded feature using the new path. Register only its actual entry/assets and new schema fields/messages. Complete shipped-dependency metadata when Svelte first enters production bundles, add `svelte` to the `bundled-runtime` Dependabot group, and switch the group test's package discovery to esbuild metafile inputs (finding 10). | Full repository gates, target-specific Chrome/Firefox UI checks (including the Chrome 128 and Firefox 152.0 floor smokes), packaged-file validation and measured bundle-size changes pass. Removing `svelte` from `bundled-runtime` makes the group test fail. This is the milestone that proves production adoption. |

Resolve package versions as one compatible set against this checkout's ESLint 10,
esbuild 0.28 and CI Node 24, and commit the lockfile. The report's minimum versions
are not a verified dependency combination, and `npm install typescript` without a
range would currently select an incompatible 7.x release. Pin the TypeScript line
explicitly and recheck the peer ranges of `typescript-eslint` and `svelte-check`
before lifting the major-version hold. Place the TS/Svelte compiler, checker and
lint packages in `tooling`, never in the catch-all, so peer-coupled updates move
together. Every addition must also pass the CI form of the zero-advisory gate,
`npm run audit:ci -- --allow-reviewed-development-advisory`.

### TypeScript configuration and interoperability

- Keep strict checking separate from build transformation. Name the initial
  project `tsconfig.check.json` and select it explicitly with
  `tsc --project tsconfig.check.json --noEmit`; point typed ESLint configuration
  at that same project when enabled. In 1D, also select it explicitly with
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
- Scope the initial compiler project to `src/`, `options/`, `popup/` and `photos/`,
  which is today's `AUTHORED_SOURCE_ROOTS`; add a test that fails if the two
  diverge.
  Use `allowJs: true`, `checkJs: false`, `strict: true`, `noEmit: true`,
  `isolatedModules: true`, `erasableSyntaxOnly: true`,
  `verbatimModuleSyntax: true`, explicit-extension support and bundler resolution.
  TypeScript 6 changed several defaults and deprecated older options, so set
  every option this plan depends on explicitly, including `types`, rather than
  inheriting defaults that a later major may change again.
  Keep the existing browser targets in esbuild. Do not include all Node scripts
  and tests in a browser-global project; introduce a separate Node configuration
  only when those authored files need TypeScript.
- `checkJs: false` leaves legacy JS outside strict checking; it does not make
  everything imported from JS safe. Keep declarations beside their owners or
  use a narrow adapter in that domain. Prefer inferred types and signatures
  checked against real behavior; use `unknown` plus validation for untrusted
  replies. Avoid blanket ambient modules or `as SomeResponse` at trust boundaries.
- Cover both the `chrome` and `browser` names actually used. Keep MAIN-world
  adapters free of extension APIs; compiler globals alone cannot enforce the
  execution world. Add declarations for existing `Chart`/`marked` globals only
  where consumed, preserving their manifest preload order.
- Keep the current `.mjs` tests and Node runner. Plain erasable `.ts` domain
  modules can be tested directly. Components and rune modules must be compiled
  first and exercised through client bundles. Do not let a Node-imported
  controller transitively import `.svelte` or `.svelte.ts`.
- Add compiler-failure fixtures that run the actual check commands with nonzero
  expected diagnostics. A `.d.ts` declaration is a compatibility promise, not
  proof that the old implementation satisfies it; retain behavioral tests.

### Source guards that must retain coverage

The source-discovery portion is implemented as of November 3, 2026. These
checks use [shared runtime discovery](../../test/helpers/runtime-sources.mts)
across the build-owned roots, exclude declarations and generated/vendor code,
and include `.svelte.ts` through the `.ts` suffix. Fixtures stay outside the
production scan. Existing policy counts are preserved; the newly discovered
photo-editor display read has an explicit reviewed owner. The watcher portion
of 1B remains open.

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

The [Dependabot group test](../../test/project/dependabot-auto-merge.test.mjs)
is a package-graph guard, not a policy scan: broadening its file matcher does not
fix it. Replace its source-text import walk with metafile inputs (finding 10).

### Build and packaging contract

- Keep [manifest.json](../../manifest.json) and `ENTRIES` authoritative. New
  authored `.ts` files still produce `.js` outputs. Add page-local aliases to
  `PAGE_LOCAL` as necessary: unknown page source names currently resolve under
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
  an implementation gate.
- Preserve synchronous early-theme and `*-head.js` execution. The deferred body
  entry can mount Svelte; the pre-paint theme path must not wait for it. Do not
  introduce dynamic-import loaders into classic or MAIN-world entries.
- Keep static outer shells, reserved feedback space and shared tokens in the
  existing copied stylesheets. No `{@html}` in new components. If runtime CSS
  fails the target CSP or startup checks, explicitly implement external CSS
  emission, copying, manifest/page references and package expectations as one
  change; do not silently accept an unstyled widget.
- When Svelte is first shipped, update
  [reviewed dependency metadata](../../scripts/dependency-metadata.mjs),
  [AMO notes](../../scripts/create-amo-metadata.mjs) and
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

In 1C, test plain-data construction with nested native proxies and a real
structured-clone operation; assert that unapproved fields are absent. In 1D,
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
[createPageLifecycle](../../src/ui/page-lifecycle.js). A persisted `pagehide`
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

## 2. Adopt the remaining proposed stack selectively

| Report layer | Incremental decision | Later conversion gate |
| --- | --- | --- |
| WXT / Vite | Defer build ownership replacement; new TS/Svelte does not depend on it. | Separate compatibility build and manifest/output parity proof described below. |
| Valibot | Optional for a new protocol/schema in its existing owning domain. Keep `settings-schema.js` authoritative. | Replacing a validator requires parity for coercion, defaults, bounds, unknown keys and failure behavior; no second settings schema. |
| `@webext-core/messaging` | Use typed wrappers over the current wire protocol first. | A new RPC library needs an explicit adapter or new protocol on both ends, sender validation and compatibility tests; it is not a transparent replacement for raw envelopes. |
| WXT storage | Keep the existing settings owner, sync/device split, subscriptions, write queue and theme mirror. | Demonstrate identical keys, migrations, authorization, error behavior and update/rollback behavior before replacement. |
| `idb` / Dexie | New features call the existing store owners; use one chosen helper only if it solves a concrete new storage need. | Preserve existing database names, versions, transactions, retention and disconnect cleanup; test real upgrade data and multiple open contexts. |
| LayerCake / uPlot | New charts may evaluate a candidate; do not require legacy chart replacement. | Compare interaction, local-time labels, data gaps, accessibility, theme and measured size/render cost with current charts. |
| MapLibre | Retain the packaged library and extension-frame architecture. | New controls can be TS/Svelte; camera, GPU renderer, workers, activation and network policy remain with their current owners. |
| TipTap / CodeMirror | Already present; retain editor ownership and serialization. | Any Svelte wrapper must preserve editor instances, selection, composition, pasted-image flows and cleanup. |
| Vitest / Playwright | Keep Node tests and existing browser verifiers initially; Playwright is already installed. | Add Vitest only for a concrete testing advantage, with compiler parity and retained manifest/worker/bridge tests. |
| Shadow DOM | Optional for a new standalone island. Retain light DOM for existing reparented host content. | Prove inherited tokens, dark mode, keyboard/focus, sizing and host integration. Scoped component CSS alone is not isolation. |

The [messaging library](https://webext-core.aklinker1.io/messaging/installation)
offers protocol maps and separate window messaging; adopting it still needs
application-specific validation. WXT's own
[storage migration guidance](https://wxt.dev/guide/essentials/storage) supports
retaining a working existing wrapper. None of these library substitutions is
required to unlock new TS/Svelte development.

## 3. If WXT/Vite becomes the chosen destination

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
3. Inventory and compare all 66 current outputs, including both ESM frames,
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

## Acceptance and verification

Before implementing a UI pilot, confirm the intended hidden browser/fixture
surface can load the target. A small source file is not automatically a safe
pilot: the permission pages in the original report depend on trusted gestures,
native prompts and focus behavior. Prefer a bounded new owned-page feature,
then separately prove a host-page island beside legacy content. A test-only
fixture can establish compiler behavior without shipping a demonstration UI.

- Run the new `npm run typecheck` and its intentional-failure fixtures, focused
  tests, then `npm test`, `npm run lint` and `npm run audit:ci`. Integrate the new
  check with [test CI](../../.github/workflows/test.yml) and the independent
  [release verification job](../../.github/workflows/release.yml); adding a local
  command alone does not enforce it. Keep it inside the existing checked job, or
  update the required-check names in
  [release-preflight.mjs](../../scripts/release-preflight.mjs) and its test if
  introducing a new job. Document it in
  [development.md](../development.md); the development test requires every
  `package.json` script to appear there exactly once.
- Run `node --test test/project/documentation.test.mjs` for plan and guide
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

**Milestone 1 is complete only when a new feature uses checked TS/Svelte, the
legacy paths still pass, and the shipped mixed build passes these gates.** The
TypeScript conversion of old modules, a new RPC/storage library, chart
replacement and WXT cutover can then proceed independently when justified.

## Evidence and outstanding work

- **TypeScript-on-change policy:** `AGENTS.md` now requires new authored code and
  modified JavaScript modules to use TypeScript, including scripts and tests.
  The staged Git guard and committed CI/release comparisons enforce the rule;
  untouched legacy modules and the documented generated/vendor roots remain
  compatible. The guard itself and its regression tests are authored as `.mts`.
  Focused policy/tooling/development/documentation/privacy checks passed 37/37;
  type checking and lint passed. The final full suite passed 3,853 of 3,856,
  retaining the same three existing fixture/inventory failures listed below.
  The pre-commit guard inspects staged content; CI checks the whole PR/push diff,
  and release verification compares against the tooling/adoption baseline.
  The initial policy counted import-only edits as modifications. Its map-layer
  follow-up permits exact filename-reference upgrades with every other byte
  unchanged, avoiding unrelated caller conversion cascades.
- **November 2 implementation checkpoint:** strict browser and Node checking
  projects, typed ESLint configuration, `.test.mts` discovery, the Node 24 floor,
  CI/release type checks and the compiler-major Dependabot hold are implemented.
  The selected Chrome definitions already declare the `browser` alias; a second
  global Firefox definitions package conflicts and is not installed. The full
  development build remains byte-for-byte identical to the pre-tooling build.
  Source-walker/watch changes, typed runtime adapters, Svelte compilation and
  the production UI milestone remain open; do not treat tooling as UI readiness.
  Type checking and lint passed; 36 focused checks passed. All `dist/` files
  matched the pre-tooling build by SHA-256. The full suite passed 3,846 of 3,849
  checks: two unchanged fixture-registration checks reject the existing snow-depth
  JSON fixture, and the unchanged script inventory lacks its ascent-filter entry.
  The dependency audit fails on the existing deepmerge and minimatch advisories;
  an isolated audit of the committed pre-tooling lockfile confirmed both IDs.
  The new ESLint toolchain adds six affected packages to that existing chain.
  Audit policy is unchanged; release readiness and local Node 24 execution remain
  unproven (these checks ran on Node 26.13.0).
- **Verified during investigation:** inventory derived from current `ENTRIES`;
  watcher-root coverage; six disposable Node/esbuild assertions covering mixed
  JS/TS, browser bundling, stale specifiers, missing type checking and uncompiled
  runes; `node --test test/project/development.test.mts` passed **17/17**.
  Local probes ran on **Node v26.13.0**, not CI's Node 24; Node 24 behavior was
  cross-checked against its official docs, not executed locally.
- **Review corrections:** qualify the generated frame path with `dist/`;
  separate checker configuration from esbuild transformation; require validated
  plain-data serialization of reactive state; and defer executable Svelte watch
  proof until 1D installs its compiler. Review probes reproduced the strictness
  change and nested-proxy clone failures using disposable fixtures and existing
  helpers; those probes do not establish real browser or compiled-Svelte behavior.
  After these documentation corrections,
  `node --test test/project/documentation.test.mjs test/project/development.test.mts`
  passed **20/20**, including the previously failing document-path assertion.
- **November 2 re-audit (verified):** against `32cfc8ed`, the 66-bundle
  inventory (64 IIFE, ESM `dist/terrain/vector-map-frame.js` and
  `dist/terrain/terrain-frame.js`), the `src/storage/` watcher gap, the seven `.js`-only
  walkers, the `no-undef` lint assertion, the worker's prefix routes and the
  `sendResult` distinction all still hold. A disposable esbuild probe reconfirmed
  that a discovered `tsconfig.json` with `strict: true` prepends `"use strict"` to
  a plain `.js` IIFE. New evidence: ESLint's `calculateConfigForFile` returns no
  config for `.ts`/`.svelte` paths under authored roots; npm registry metadata
  for `typescript`, `typescript-eslint`, `svelte-check`, `esbuild-svelte`
  (0.9.5, peers `esbuild >=0.17.0`, `svelte >=4.2.1 <6`) and `eslint-plugin-svelte`
  (3.23.1, peers ESLint 10); and the Dependabot group test's source-text walk.
  No package was installed, and the TS 6 option defaults were not executed.
- **Intentionally not changed:** runtime source, manifest, storage formats and
  existing features. Investigation originally left dependencies and check
  configuration untouched; the implementation checkpoint above records their
  subsequent changes. The external report was read without editing it.
- **Not yet proven:** locked Svelte/plugin/ESLint compatibility, compiled Svelte
  output under the actual AMO baseline, production CSP/style injection,
  browser/BFCache/geometry behavior, size estimates, native permissions and a
  WXT parity build. Svelte tooling is not installed in this checkout. Whether
  Svelte 5's client runtime runs unchanged at the Chrome 128 and Firefox 152.0
  floors is unverified. No full
  suite, full build, lint or real-browser run was performed for this docs-only
  investigation; those are implementation gates, not claimed results.

Source report: the externally supplied
`ts_svelte_vite_migration_and_stack_report.md`. The pasted attachment was its
review summary; the complete report was also read during this investigation.

### Bounded map-layer TypeScript adoption

The map-layer control and location popup are now authored as TypeScript, with a
new typed layer point-inspection interface and validated provider readers.
Their legacy callers change only filename references. This establishes a
bounded plain-DOM runtime use of TypeScript; it does not complete the general
source-walker/watch prerequisites or enable Svelte. The affected map directory
is already watched. The source-walker follow-up has now migrated all seven
policy scans to shared runtime coverage. Focused point-reader tests continue to cover the new requests,
permissions, bounds and cancellation. The broader watcher portion of 1B remains
open.

### Source-walker migration closure ledger (November 3, 2026)

- **Fixed and verified:** all seven structural guards use one typed discovery
  helper rooted at `AUTHORED_SOURCE_ROOTS`; the three private walkers and units'
  manually enumerated page list are removed. The guards, development checks and
  shared test helpers are TypeScript. Loose-source and test organization checks
  recognize TypeScript, and page-local lint coverage checks transitive sources
  plus typed probes. The fixture suite injects forbidden values/calls into every
  authored root as TypeScript and Svelte, exercises template handlers, verifies
  reviewed owner boundaries, and proves the old `.js` filter would skip them.
  Strict type checking, repository ESLint and 121 focused checks passed.
- **Intentionally not changed:** runtime modules, wire/storage formats, build
  entry composition, the single deadline exception and existing settings-read
  ownership counts. The newly covered `photos/photos.js` read controls only
  export-size warning/report-width presentation and is registered as display-only.
  The source-walker scope does not include the build watcher or Svelte compiler.
- **Changed but not fully proven:** the full suite passed **3,868/3,871**,
  retaining the same two unregistered snow-legend fixture failures and missing
  script-inventory entry documented above. No extension runtime or build inputs
  changed, so no additional browser verification was run for this test-tooling
  migration.

Separate prerequisites: the `src/storage/` build-watcher gap and watch
generation/recovery proof remain in 1B. Svelte compilation and executable
component integration remain in 1D/1E. Source-policy fixtures establish text
coverage, not Svelte compiler or browser execution behavior.
