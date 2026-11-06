# Modern stack adoption with legacy compatibility

Status: TypeScript tooling, adoption policy, source-policy coverage and bounded
map runtime adoption are implemented. Build-watcher coverage, shared typed
boundaries and Svelte adoption remain open.
Replanned November 5, 2026 against `fe151c5a`. Earlier investigation and
implementation evidence is retained below with its original dates and limits.

## Recommendation

Finish a **checked TypeScript/Svelte path through the existing esbuild build**,
then convert existing domains in small batches. WXT/Vite and replacement
messaging, storage or chart libraries remain separate decisions. They are not
prerequisites for this transformation.

The supplied report makes two different recommendations: an incremental
TypeScript/Svelte/esbuild path for this repository, and a WXT/Vite-based stack for
a greenfield extension. The second is a useful candidate destination, not an
established optimum for this codebase. In particular, the report's runtime-size
estimates and proposed chart replacement need measurements before they become
acceptance criteria.

The original plan bundled completed prerequisites and substantial unfinished
work into one milestone. The sequence below separates those costs, gives each
step an observable exit condition and uses an existing bounded UI owner for the
first production pilot. Do not add a demonstration feature merely to exercise
the stack.

## Current baseline — do not redo completed work

| Area | Implemented state | Remaining boundary |
| --- | --- | --- |
| Checking and lint | Strict browser and Node checking projects, TS ESLint scopes, intentional-failure tests, CI/release enforcement and Node 24 floor. Locked TypeScript is 6.0.3. | Svelte compiler/checker/lint integration is absent; legacy JS is intentionally not strictly checked. |
| Adoption policy | New and substantively changed authored JS-family modules must use TS; staged and committed-diff guards enforce this. Exact filename-reference changes may remain in legacy callers. | Every planned substantive edit to a legacy build script, test or controller includes its conversion cost. |
| Runtime source policies | All seven guards use shared discovery across `AUTHORED_SOURCE_ROOTS`, including typed and Svelte source-text fixtures. | This proves scan coverage, not Svelte compilation or browser execution. |
| Runtime TS | Three authored modules: map-layer control, point inspection and location menu. Existing JS imports them. | The broader shared boundaries and most runtime modules remain JS. |
| Production build | 66 outputs: 64 IIFEs and two ESM frames. Existing generation publication/reload machinery is retained. | Watching is derived from entry/asset directories and misses `src/storage/`; unseen future domains have the same risk. |
| Shipping dependencies | Notices use esbuild metafile inputs. | The Dependabot shipping-graph test still scans source imports and cannot reliably classify compiled Svelte or type-only imports. |

The runtime-root inventory currently contains **307 JavaScript modules, three
TypeScript modules and no Svelte components**. These counts describe migration
scope, not a requirement to rewrite every working feature before adoption.
Recompute them from the build-owned roots when starting a conversion batch.

## Milestones ordered from least to most effort

Effort is relative implementation **plus verification** cost, not a calendar
promise. M0 records completed work. Follow M1–M6 for production adoption; M7 is
the longer conversion backlog and M8 is an optional build-system project. Cheap
work within a later milestone may be prepared early, but its prerequisites and
exit gates still apply. External advisory fixes and native/browser availability
can delay verification independently of implementation effort.

| Milestone | Effort / scope | Prerequisite | Concrete result |
| --- | --- | --- | --- |
| M0 — Existing foundation | Complete; retain evidence limits | None | Checked mixed JS/TS, enforced adoption policy, shared source guards and three runtime TS modules. |
| M1 — Repair baseline bookkeeping | Small; two focused repairs plus baseline recording | M0 | Fixture and script inventories agree with the tree; current gate failures have owners. |
| M2 — Convert small UI lifetime helpers | Small; one owner per commit | M0; existing `src/ui/` watch coverage | Typed latest-read and page-lifecycle contracts with unchanged behavior. |
| M3 — Complete build/watch support | Medium; build-script conversion, then watcher repair | M1 for affected test gates | Any authored source edit triggers a complete successful generation; failed generations keep the last usable build. |
| M4 — Type the pilot's boundaries | Medium; narrow adapters and serialization tests | M2; M3 before adding a new domain | Typed settings/UI and runtime contracts without changing wire/storage formats. |
| M5 — Enable and prove Svelte compilation | Medium–large; dependency, build and fixture work | M3 and M4 | Checked components and runes compile, mount, update, dispose and recover in watch mode. No production UI conversion yet. |
| M6 — Ship one bounded Svelte island | Large; UI integration plus release/browser evidence | M1–M5 and dependency-audit gate | The existing Units settings panel works through checked TS/Svelte beside unchanged legacy sections. |
| M7 — Convert the remaining domains in batches | Very large in aggregate; small modules first | M3; M6 before more production Svelte | A tracked sequence from pure TS domains to owned pages, host islands and high-risk coordinators. |
| M8 — Evaluate and optionally cut over WXT/Vite | Largest cross-cutting risk; separate project | M6 baseline; independent of finishing M7 | A separately built parity candidate, then a dedicated cutover only if all contracts survive. |

Each numbered step below is a focused commit or, where necessary, a small set of
independently passing commits. Finish, check and commit one unit before starting
another. This document update queues the work; it does not implement it.

### M1 — Repair baseline bookkeeping

1. Register the existing snow-depth legend JSON fixture in the
   [privacy manifest](../../test/helpers/fixture-privacy-manifest.mts), with
   decoding/validation coverage. Convert substantively changed modules/tests to
   `.mts`; do not bypass privacy checks for JSON or the fixture directory.
2. Register the missing ascent-filter verifier in [the script inventory](../../scripts/README.md).
   Make [its inventory test](../../test/project/verifier-assets.test.mjs)
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

1. Convert [latest-read.js](../../src/ui/latest-read.js) to `.ts`, preserving
   abort ordering, stale-result rejection and reentrant cancellation behavior.
   Update exact caller references and retain its existing focused tests.
2. Convert [page-lifecycle.js](../../src/ui/page-lifecycle.js) to `.ts` with
   typed callbacks/events and the existing idempotent active/suspended/disposed
   state machine. Keep the public `create` alias and default window behavior.
   Extend its focused tests only where typed usage reveals a missing case.

Exit: strict checking and existing lifecycle/latest-read behavior tests pass;
source-policy owner paths and build references remain correct. These owners
are already under a watched directory, so M2 does not depend on repairing the
watcher. Run real-extension checks for changed content-script load dependencies.

### M3 — Complete build/watch support

1. Convert [build.mjs](../../scripts/build.mjs) to `.mts` without changing build
   behavior. Update command/workflow references, imports, literal source readers,
   inventories and docs together. Keep build configuration in its current owner;
   convert it only if it also needs a substantive edit. Compare the development
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

1. Convert [runtime-message.js](../../src/ui/runtime-message.js) to `.ts`, then
   add only the typed protocol wrappers actually needed. Preserve `send` and
   the `sendResult` response/unavailable distinction. Treat remote input as
   `unknown` until validated; keep sender authorization and all wire envelopes.
   Include worker handler maps and prefix routes when auditing a protocol.
2. Define the Units panel's settings projection, allowed patch keys and
   `save`/`populate` interface beside its owner. Validate through the existing
   settings schema and retain the options controller's write queue, confirmed
   snapshot, rollback and feedback. Do not require converting the shared schema
   or the 4,169-line background coordinator to type this one panel.
3. Test allowlisted plain-data construction with nested native proxies and real
   structured cloning. Compile negative request/response/patch examples. Cover
   successful replies, transport loss, invalid replies and rejected settings
   writes. New protocols, if needed later, must type and validate both ends.

Exit: incorrect usage fails checking, actual boundary failures preserve current
behavior, and cloneable payloads omit unapproved fields. Adapters/declarations
remain narrow compatibility promises backed by tests, not a second schema or
an assertion that all imported JavaScript is trusted.

### M5 — Enable and prove Svelte compilation

1. Resolve and lock a compatible Svelte 5/compiler-adapter/checker/lint set
   against this checkout's TypeScript 6.0.3, ESLint 10, esbuild 0.28 and Node 24.
   Add `svelte`, `esbuild-svelte`, `svelte-check` and `eslint-plugin-svelte` only
   after inspecting their actual peer ranges. Retain the TypeScript major hold.
   Group compiler/checker/lint tooling deliberately in Dependabot; classify the
   runtime as shipped only when M6 introduces it into production outputs.
2. Add shared compiler settings to the existing build-options path. Extend the
   explicit checking project and TS-aware Svelte lint scopes. Keep ordinary
   controller TS independent of compiled rune modules. Add no second writer to
   production `dist/` and no automatically discovered checker-only tsconfig.
3. Compile a test-only component plus `.svelte.ts` dependency through the actual
   normal, minified and incremental options. Check invalid props and missing
   template names, mount/update/unmount the built client, and repeat M4's
   serialization tests with compiled `$state` values.
4. Exercise transitive component/rune edits, syntax failure and correction with
   M3's generation/token assertions. Demonstrate the typed mount/update/dispose
   adapter beside legacy DOM in a faithful hidden Chrome/Firefox fixture, with
   suspension, resumption, removal and re-enable coverage.

Exit: checks reject deliberate component errors; compiled fixtures work in both
browsers; failed component generations preserve the prior build and recover;
no runtime compiler, remote code or unexpected chunks ship. This milestone
proves tooling and a fixture contract, not production CSP or host integration.

### M6 — Ship one bounded Svelte island

1. Confirm the hidden verifier can load the real options page before editing UI.
   Use [the Units panel](../../options/unit-settings.js) as the default pilot:
   it already has a small `initUnitSettings({ save })` / `populate` boundary,
   no native permission prompt and [focused behavior tests](../../test/options/options-units.test.mjs).
   Preserve the existing settings choices, IDs, examples, disclosure behavior
   and reset semantics. Do not redesign the rest of Settings.
2. Convert the
   [Dependabot graph test](../../test/project/dependabot-auto-merge.test.mjs)
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

### M7 — Convert the remaining domains in increasing-cost batches

Keep a per-owner checklist with source, callers/entries, tests, measured output
changes and proof limits. Separate behavior-preserving TS conversion from any
later Svelte rewrite of the same owner. Finish one owner before the next.
The pure-TS batches can begin after M3 without waiting for M4–M6; only additional
production Svelte surfaces depend on the proven M6 contract.

1. **Small pure modules:** begin with
   [storage-value.js](../../src/storage/storage-value.js), then bounded helpers
   such as [theme-resolve.js](../../src/theme/theme-resolve.js) and
   [provider-url.js](../../src/capture/provider-url.js). Keep exports, algorithms
   and source-policy exceptions unchanged; run the owning behavior tests.
2. **Shared domain contracts/services:** convert the settings schema and store,
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
5. **Large coordinators and cross-world graphics:** convert the background
   worker, MAIN-world GPX analyzer and map/frame coordinators last, one boundary
   at a time. Keep bundle order, sender/privacy/Save gates and shared math.
   Require real-manifest/worker/bridge checks and hardware-rendered terrain
   verification for affected graphics paths; pure unit tests cannot close these.

Convert touched Node tooling/tests alongside their owner; update `.mts` command,
inventory and test-discovery references, including scale-test discovery when
applicable. Do not schedule wholesale test or script rewrites as a prerequisite.
If complete runtime TS conversion is chosen, M7 closes only when no authored
legacy JS remains in build-owned runtime roots (generated/vendor exclusions stay
explicit) and the affected gates pass. Svelte conversion remains per-surface,
based on a useful ownership boundary rather than a percentage target.

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
- Keep the Node runner and untouched `.mjs` tests; new/substantively changed
  Node tests use `.mts`. Plain erasable `.ts` domain modules can be tested
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
  pass `npm run audit:ci -- --allow-reviewed-development-advisory` under the
  existing policy; expired exceptions and extra advisories still fail closed.

### Source guards that must retain coverage

The source-discovery portion is implemented as of November 3, 2026. These
checks use [shared runtime discovery](../../test/helpers/runtime-sources.mts)
across the build-owned roots, exclude declarations and generated/vendor code,
and include `.svelte.ts` through the `.ts` suffix. Fixtures stay outside the
production scan. Existing policy counts are preserved; the newly discovered
photo-editor display read has an explicit reviewed owner. Watcher completion is
M3; executable Svelte coverage is M5.

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
fix it. Replace its source-text import walk with metafile inputs in M6, before
the first production component ships.

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

## Optional library substitutions after M6

These are independent owner decisions, not additional requirements for marking
TS/Svelte adoption complete. Evaluate a new isolated use before replacing a
working shared owner; broad protocol/storage migration has the greatest cost.

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

## M8 — Evaluate WXT/Vite only after the mixed build is proven

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
3. Derive the complete inventory from `ENTRIES` (66 outputs at this checkpoint),
   including both ESM frames,
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
rollback path. A successful one-page spike alone cannot close M8. Do not combine
the cutover with new messaging/storage libraries or a visual redesign. Keep
declining WXT as an explicit supported outcome if parity or benefit is absent.

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
  [test CI](../../.github/workflows/test.yml) and independent
  [release verification job](../../.github/workflows/release.yml) checks to cover
  Svelte; adding a local command alone does not enforce it. Keep checks inside
  the existing checked jobs, or update the required-check names in
  [release-preflight.mjs](../../scripts/release-preflight.mjs) and its test if
  introducing a new job. Document it in
  [development.md](../development.md); the development test requires every
  `package.json` script to appear there exactly once.
- Before each commit, stage only the completed unit and run
  `npm run check:typescript-policy`. Do not weaken the policy to avoid a build,
  test or controller conversion; update exact filename references instead.
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

Keep the three closure categories below at every milestone and when archiving.
A passing fixture or implementation commit cannot close an unrun production,
browser, package or native-behavior gate.

## Current closure ledger — November 5, 2026

- **Fixed and verified:** the implemented M0 foundation remains present on
  `fe151c5a`: two strict checking projects, TS-aware lint and policy enforcement,
  shared typed source discovery, and bounded map runtime TS. During replanning,
  `npm run typecheck` and `npm run lint` passed; lint rebuilt all 66 bundles and
  retained eight owned web-ext warnings. The 29 focused documentation,
  development, TS-tooling, runtime-source and source-policy checks passed. This does not
  re-establish every historical runtime/browser result.
- **Intentionally not changed:** this update changes the plan and its index,
  not runtime/build/test behavior, dependencies, permissions, storage or wire
  formats. Existing esbuild, Node tests, MapLibre and editor owners remain the
  default architecture. WXT and library substitutions are conditional choices.
- **Changed but not fully proven:** the effort ordering and Units pilot are
  implementation recommendations, not an executed migration. Baseline probes
  reproduced the three existing failures: two fixture privacy checks reject
  the unregistered snow-depth legend JSON, and the script inventory omits the
  ascent-filter verifier. The audit exception is expired in source; no fresh
  network audit was run for this document update. Node 24, the full suite,
  browser/visual checks, Svelte, production CSP and packaged upgrades were not
  re-run or established here. These remain explicit milestone gates.

## Historical implementation evidence

The old 1A–1F labels below refer to the original plan: 1A is in M0; 1B's source
scans are in M0 and its watcher work is M3; 1C maps to M2/M4; 1D/1E to M5 and
the applicable M6/M7 integration gates; 1F to M6. Dated test counts describe
those runs, not the current repository baseline.

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
