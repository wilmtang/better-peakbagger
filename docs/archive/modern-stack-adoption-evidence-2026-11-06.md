# Modern stack adoption evidence — through November 6, 2026

Dated evidence moved from the [adoption plan](../plans/modern-stack-adoption.md)
when it was restructured around goal, milestones and progress. Results describe
the runs on their stated dates, not the current repository. Milestone names follow
the plan; the old 1A–1F labels are mapped below.

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
