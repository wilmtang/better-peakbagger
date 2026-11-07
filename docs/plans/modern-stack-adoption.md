# Modern stack adoption with legacy compatibility

Last updated November 6, 2026 against `b6cb5a6b`.

## Goal

Write new and changed extension code in checked TypeScript and, where a UI owner
benefits, Svelte. Do this through the existing esbuild build, beside legacy
JavaScript, without changing behavior, storage or wire formats, permissions or
packaging.

- **Production adoption is done at M6:** one real settings panel ships through
  checked TS/Svelte beside unchanged legacy code and passes the browser and
  package gates.
- **The end state is no authored JavaScript (M7):** all remaining runtime code,
  scripts and tests move to TypeScript in small batches. Generated output and
  upstream third-party code keep their required formats. Svelte conversion stays
  per surface and is not required for every UI.
- **WXT/Vite is optional (M8):** declining it is a supported outcome.

Out of scope: rewriting working features in Svelte for uniformity, adding a demonstration
feature to exercise the stack, and requiring WXT/Vite or replacement messaging,
storage or chart libraries first. The supplied
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
| M5 — Enable and prove Svelte compilation | Medium–large; dependency, build and fixture work | M3 and M4 | Checked components and runes compile, mount, update, dispose and recover in watch mode. No production UI conversion yet. |
| M6 — Ship one bounded Svelte island | Large; UI integration plus release/browser evidence | M1–M5 and dependency-audit gate | The existing Units settings panel works through checked TS/Svelte beside unchanged legacy sections. |
| M7 — Convert all remaining JavaScript in batches | Very large in aggregate; small modules first | M3; M6 before more production Svelte | No authored JavaScript remains, from pure TS domains through owned pages, high-risk coordinators, scripts and tests. |
| M8 — Evaluate and optionally cut over WXT/Vite | Largest cross-cutting risk; separate project | M6 baseline; independent of finishing M7 | A separately built parity candidate, then a dedicated cutover only if all contracts survive. |

## Current progress

**Next: M2, then M3.** Production adoption has not started: nothing ships through
Svelte, and Svelte is not installed.

| Milestone | Status | Where it stands |
| --- | --- | --- |
| M0 | Done | Strict browser and Node checking, TS lint scopes, adoption policy in hooks/CI/release, and shared discovery for all seven source guards. |
| M1 | Done | `c1ba9599`, `6e4a3041`, `01616f47`. Results are in the [follow-up ledger](follow-ups.md). |
| M2 | Done | `src/ui/latest-read.ts` and `src/ui/page-lifecycle.ts` are converted. |
| M3 | In progress | `scripts/build-config.mts` (`bc5fa3b3`) and `scripts/build.mts` are converted. The watcher still derives directories from entries and misses `src/storage/`. |
| M4 | Not started | `src/ui/runtime-message.js` is still JavaScript. No Units panel contract exists. |
| M5 | Not started | No Svelte compiler, checker or lint packages in `package.json`. |
| M6 | Not started, **blocked for release** | `options/unit-settings.js` is unchanged. `npm run audit:ci` fails on addons-linter, deepmerge and web-ext (run November 6). The deepmerge chain has no patched release and its exception has expired. |
| M7 | Started out of order | 13 more map, terrain and hover-card modules became TS during other work, ahead of the batch order. The first planned batch, starting with `src/storage/storage-value.js`, has not begun. |
| M8 | Not started | Depends on M6. |

Remaining conversion scope, all of which M7 must finish:

| Area | TypeScript | JavaScript |
| --- | --- | --- |
| Runtime (`src`, `options`, `popup`, `photos`) | 16 | 294 |
| `scripts/` | 8 | 133 |
| `test/` | 32 | 295 |
| Other (root config, `docs/plans/`, `store-assets/`) | 1 | 16 |

Runtime TS is all in `src/maps/` and `src/terrain/`, plus
`src/favorites/climber-hover-card.ts`. There are no Svelte components. The build
produces 66 outputs: 64 IIFEs and two ESM frames. Recompute the runtime counts with
[`runtimeSourceFiles`](../../test/helpers/runtime-sources.mts) when starting a batch.

Limits of what is proven:

- **Verified:** the last recorded full-suite runs are 3,874/3,874 on Node 24 at
  `69c7a321` ([ledger](follow-ups.md)) and 3,895/3,895 at `e35ed8cd`. Neither was
  re-run for this update, which changes documents only.
- **Known gap in a guard:** the [Dependabot graph test](../../test/project/dependabot-auto-merge.test.mjs)
  scans source imports and cannot classify compiled Svelte or type-only imports.
  M6 replaces it before the first component ships.
- **Not established:** locked Svelte/plugin compatibility, Svelte at the Chrome 128
  and Firefox 152.0 floors, production CSP and AMO behavior, bundle size,
  BFCache and geometry behavior, and WXT parity.

Earlier dated evidence is in the
[adoption evidence archive](../archive/modern-stack-adoption-evidence-2026-11-06.md).

## Milestone details

Each numbered step is a focused commit or, where necessary, a small set of
independently passing commits. Finish, check and commit one unit before starting
another. Update **Current progress** in the same change that finishes a milestone.

### M1 — Repair baseline bookkeeping

Status: complete on November 6, 2026 (`c1ba9599`, `6e4a3041`, `01616f47`). The
full-suite and audit outcomes are in the
[follow-up ledger](follow-ups.md); the deepmerge finding is still unresolved.

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

### M7 — Convert all remaining JavaScript in increasing-cost batches

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
   worker, MAIN-world GPX analyzer and remaining coordinators last, one boundary
   at a time. Keep bundle order, sender/privacy/Save gates and shared math.
   Require real-manifest/worker/bridge checks and hardware-rendered terrain
   verification for affected graphics paths; pure unit tests cannot close these.

Convert touched Node tooling/tests alongside their owner; update `.mts` command,
inventory and test-discovery references, including scale-test discovery when
applicable. Test and script conversion is not a prerequisite for runtime batches,
but it is required to close M7: convert whatever remains in owner-sized batches
once its runtime owners are done.

Exit: no authored JavaScript remains anywhere in the repository, including
`scripts/`, `test/`, `docs/plans/` and `store-assets/`, and the affected gates
pass. The exclusions in `scripts/typescript-policy.mts` stay explicit for generated
and upstream code; a file a tool requires in JavaScript needs its own narrow
documented exception. To keep the result, make the policy reject any authored
JavaScript file rather than only changed ones, and remove `allowJs` from the
checking projects. Svelte conversion remains per-surface, based on a useful
ownership boundary rather than a percentage target.

### M8 — Evaluate and optionally cut over WXT/Vite

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
- Keep the Node runner, and untouched `.mjs` tests until M7 converts them;
  new/substantively changed Node tests use `.mts`. Plain erasable `.ts` domain modules can be tested
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
  existing policy; advisories in shipped code still fail closed.

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
| WXT / Vite | Defer build ownership replacement; new TS/Svelte does not depend on it. | Separate compatibility build and manifest/output parity proof in M8. |
| Valibot | Optional for a new protocol/schema in its existing owning domain. Keep `settings-schema.ts` authoritative. | Replacing a validator requires parity for coercion, defaults, bounds, unknown keys and failure behavior; no second settings schema. |
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
  [release-preflight.mts](../../scripts/release-preflight.mts) and its test if
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

Record fixed-and-verified, intentionally-not-changed and changed-but-not-proven
outcomes when closing each milestone and when archiving. A passing fixture or
implementation commit cannot close an unrun production, browser, package or
native-behavior gate.
