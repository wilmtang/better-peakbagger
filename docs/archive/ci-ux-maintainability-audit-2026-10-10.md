# CI, UI, and maintainability follow-up — 2026-10-10

Baseline: `2b7c859`, clean `codex/code-removal-audit` checkout. Preserve the
existing code-removal work. The owner requests fixes, including a distinctive
outdoor visual identity. Each independent unit is verified and committed.
Local implementation is closed at `a3595ad`; hosted and external proof remains
explicit below.

## Findings before implementation

| ID | Finding | Acceptance |
| --- | --- | --- |
| C1 | Ordinary current-browser CI runs popup sizing, pending-resource capture, toolbar capture, and sequential summit drafts; release verification omits all four. `.github/workflows/test.yml` and `.github/workflows/release.yml` maintain separate package-gate step lists. | One shared package-verification action runs the same gates for ordinary CI, rehearsals, and tags. Auxiliary checks consume the already-built minified `dist/` without rebuilding it. Preserve version, identity, floor, security, store, and consecutive-pass gates. |
| U1 | At 390×600, twelve matches place Open drafts at y=565–603 and Delete data below the viewport. An unbroken peak name extends to x=568 within a clipped card. The full confidence sentence squeezes normal names into narrow columns. Evidence: hidden Chrome 153.0.8010.12, shipped popup bundle/styles. | Long names wrap; semantic confidence and percent remain available; the bounded result list and review action fit. Verify ready/opening/opened and error states in both browsers, themes, and dense results. |
| U2 | The panel vocabulary gives every popup datum its own rounded, shadowed card. The owner selected an outdoor identity. | A shared warm paper/forest palette, restrained contour detail, and flatter grouped rows improve hierarchy across extension panels. Inspect settings, popup, and photo workspace at narrow/desktop sizes in both themes. |
| C2 | `scripts/verify-capture-popup.mjs` combines source HTML/CSS with the built script and tests only error states. Its mock layout can miss shipped asset drift and ready-result clipping. | Read all fixture assets from `dist/`, cover dense and long-name results, and require visible contained controls. Retain the real action-popup sizing test. |
| C3 | Local packaged Firefox 155 verification fails with `NoSuchWindowError` after Shift+Enter moves the existing Settings tab into a new window. The old WebDriver handle is destroyed although extension tab identity survives. | Reacquire exactly one matching extension URL, tolerate disappearing handles while enumerating, and prove the moved tab retains its original extension tab ID. Cover delayed navigation and duplicate destinations deterministically. |
| E1 | Photo catalog, upload response, and IndexedDB secrets repeat the same bounded HTTPS/credential validator. | Use one pure validator with the existing 4,096-character limit. Preserve optional-field semantics and every boundary's independent validation. Run photo and worker regressions plus real-extension checks. |
| E2 | Three verification orchestrators repeat child spawning, exit rejection, registration, and cleanup. | Reuse the existing resource-stack owner through one runner. Test exit failure, spawn failure, and teardown; preserve fail-fast repetitions and canonical archive hashes. |
| E3 | The shared panel repeats every dark palette mapping for the OS media query and explicit preference. | Let the supported browser color-scheme select one light/dark mapping per token. Preserve explicit overrides, blocked-storage OS fallback, native controls, contrast, and semantic status colors. |

## Current evidence and retained boundaries

- Baseline `npm test`: 2,385 passed, zero failed.
- Read actual logs for release rehearsal [37906237779](https://github.com/wilmtang/better-peakbagger/actions/runs/37906237779)
  and job results for [37904401979](https://github.com/wilmtang/better-peakbagger/actions/runs/37904401979).
  The former fails on a Firefox wait; the latter fails the package job.
  Their subsequent repairs are already in this checkout and must not be redone.
- Latest main [37913722337](https://github.com/wilmtang/better-peakbagger/actions/runs/37913722337)
  and three-pass rehearsal [37910756804](https://github.com/wilmtang/better-peakbagger/actions/runs/37910756804)
  succeeded at their snapshots. This is not remote proof for new local changes.
- Keep the exact existing development-advisory exception and October 17 expiry.
  Historical-tag Firefox recovery has the separate limitations recorded in the
  [October 3 ledger](../plans/ci-ux-maintainability-audit-2026-10-03.md).
- Existing audits already removed substantial dead/duplicated code. No whole
  runtime module is newly proven unused. Remove actual duplicate owners rather
  than compressing readable code or deleting correctness/privacy guards.
- No push, merge, tag, workflow dispatch, or store submission is authorized.

## Closure ledger

### Fixed and verified

- U2 follow-through: the ImgBB key recovery message and packaged guide now
  point to the actual Capture & reports → Report photos labels. The guide's
  backup setting name also matches Settings. All 28 upload/guide tests, scoped
  ESLint, and diff checks passed.
- Integration caught two stale source contracts requiring the removed CSS
  mapping blocks and old success prose. Updated the shared-palette assertions
  and strengthened the teardown guard to reject a missing cleanup marker.
  All 25 focused panel/Firefox-process tests, scoped ESLint, and diff checks
  passed. The first full integration run had 2,388 passes and these two failures;
  the final full run is recorded below rather than hiding that result.
- E3: one `light-dark()` mapping per token replaces the duplicated OS/explicit
  dark blocks. Explicit preferences, native controls, OS fallback when the
  bootstrap cannot run, and Strong/Probable colors remain consistent. Browser
  support predates our floors: [Chrome 123](https://developer.chrome.com/blog/new-in-chrome-123)
  and [Firefox 120](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/120).
  All 76 focused theme/popup tests, scoped ESLint, and diff checks passed.
  Hidden Chrome 153.0.8010.12 / Firefox 155.0 rendered 196 popup states at
  390×600: both themes, DPR 2, opposite OS preferences, and both OS fallbacks.
  Every case checked the resolved background and contained controls; final
  light Chrome and system-dark Firefox screenshots were inspected.
- E2: package building, archive execution, and repeated browser checks share
  one resource-owned child runner. It waits for child closure, rejects spawn,
  exit, and signal failures, and retains cleanup. Firefox uses the existing
  bounded condition wait. Compact structured success records preserve browser,
  viewport, BFCache evidence, and teardown; all assertion/failure diagnostics
  remain. Success appears only after teardown and Firefox failures no longer
  mislabel every stage as startup. All 28 focused ownership/repetition/archive
  tests, scoped ESLint, and diff checks passed.
- E1: one pure photo URL policy replaces the catalog, upload, and IndexedDB
  copies. HTTPS normalization, rejection of credentials/other schemes, the
  exact 4,096-character ceiling, nullable-field handling, and independent
  boundary validation remain intact. All 331 photo/worker/manifest tests,
  scoped ESLint, and diff checks passed, including the real bundled-worker boot.
- C1/C3: ordinary CI and release use one five-step production package/capture
  gate. Both install the popup fixture browser; auxiliary checks consume the
  minified build instead of rebuilding development bundles. Bash pipefail and
  failure artifacts remain mandatory. Firefox reacquires exactly one moved
  Settings destination and asserts the original extension tab ID survived.
  The real failure was reproduced before this correction. All 65 focused
  release/fixture tests, scoped ESLint, and five Bash syntax checks passed.
  The complete shared gate then passed locally: exact Chrome/Firefox archives,
  popup, pending-resource capture, toolbar capture, and sequential summit
  drafts, hidden Chrome 153.0.8010.12 / Playwright Firefox 155.0. No check was
  retried into success without identifying and correcting its failure.
- U1/U2/C2: warmer paper/forest palettes, contour navigation, flatter grouped
  popup rows, shorter confidence labels with full accessible descriptions,
  wrapped names, and a 240px result list. Technical track details use a native
  disclosure; privacy copy stays visible. Settings use plain Report labels and
  a descriptive climber-list explanation. All 103 focused popup/options/theme
  tests, contrast checks, scoped ESLint, and diff checks passed.
- The popup verifier reads shipped HTML/CSS/icons/scripts and checks 14 states
  in hidden Chrome 153.0.8010.12 and Firefox 155.0 at 390×600, both themes and
  DPR 2. Dense ready/opening/opened results and unbroken long names fit, with
  the correct enabled/disabled controls. Real Chrome action sizing also passes
  both themes and source-tab zoom 100%/200%. Settings screenshots inspected at
  1024×900 and 390×844; photo editor screenshots inspected at 1000×760 and
  390×760 with behavioral checks at seven sizes. Photo verification reports
  hardware ANGLE Metal / Apple M3 Pro. Owned processes/profiles were removed.

### Intentionally not changed

Privacy, ownership, cancellation, settings schema, manual Save, package identity,
store protections, browser floors, and existing advisory scope/expiry.
Read-only registry checks still report node-forge 1.4.0, adbkit 3.3.9, and
web-ext 10.7.0 as their latest versions. No patched dependency was available.
The live audit accepted only the existing exact development-only advisory until
2026-10-17T07:00:00Z; raw audit still has three high findings and the default
remains strict. This is a real dependency limitation, not a timing flake.

### Changed but not fully proven

- New workflow wiring has local execution and YAML contract evidence; a hosted
  run, declared-floor run, and three-pass rehearsal were not dispatched.
- Remote CI, native browser chrome, screen-reader speech, live
  providers, store acceptance, and window-placement behavior require separate
  evidence. Hidden layout checks do not establish those outcomes.
- Local Node is 26.11.1; the workflow uses Node 24. Actionlint was unavailable;
  workflow contract tests and the five extracted Bash steps were checked.

## Final local verification

- `npm test`: 2,390 passed, zero failed. `npm run test:scale`: all 14 passed.
  `npm run lint`: passed with the six existing owned web-ext warnings.
  The subsequent label-only recovery correction passed all 28 upload/guide
  tests and scoped ESLint. Documentation checks passed.
- Executed the shared action's five exact Bash steps locally, with
  `BPB_VERIFY_REPETITIONS=3`. The canonical minified Chrome archive and its
  derived Firefox archive passed three consecutive pairs with fresh profiles,
  unchanged SHA-256 hashes between checks, and teardown required every time.
  Hidden Chrome 153.0.8010.12 / Firefox 155.0 used 1000×760 base viewports.
  Chrome restored BFCache; Firefox safely remounted exactly one analyzer.
- The same gate then passed real popup sizing, 196 shipped-asset popup layouts,
  pending-resource capture, toolbar-to-draft privacy/recovery/cancellation,
  and sequential summit drafts. Source bundles were never rebuilt over the
  minified artifacts during these checks. No test failure was retried into
  success without a correction.
- Final Settings captures: hidden Chrome 153.0.8010.12, light/dark at 1024×900
  and 390×844, keyboard/Undo/transfer states also checked. Final photo editor:
  hidden hardware ANGLE Metal / Apple M3 Pro at seven sizes, including 1000×760
  and 390×760. Inspected both target surfaces at desktop/light and narrow/dark,
  plus popup previews in both themes at 390×600. Synthetic fixtures were used;
  no live upload, GitHub write, or Save occurred.
- Final process command-line inspection found no owned browser/driver/server;
  exact verifier/profile directory prefixes were absent. Review previews and
  logs are retained as task artifacts; disposable run output is removed.
- Compared with `2b7c859`, runtime source is 54 lines smaller and verification
  implementation/workflows are 47 lines smaller: **101 net implementation lines
  removed**. Tests add 80 net lines; the ledger and maintained documentation
  add lines overall. This count excludes generated bundles and avoids claiming
  the entire checkout became smaller.
- `npm run audit:ci -- --allow-reviewed-development-advisory` passed under the
  exact existing exception; the raw graph remains three high findings. No
  security waiver was added, expanded, or renewed.

Verified archive SHA-256:

```text
Chrome  a85f1f5e0ea3b70c8fdf040ff64197091a3d4ec056c843a82685cb9e84e7d199
Firefox fd7dd7617496b5f07eaf4c096f378784f7a597184f8737921e94272c5f6b48e4
```

## Focused commits

| Commit | Independent unit |
| --- | --- |
| `3135e59` | Findings-first audit and index |
| `ff8ee12` | Outdoor panels, popup layout, shipped-asset layout coverage |
| `47f08fe` | Shared production gates and Firefox tab identity recovery |
| `618854d` | Shared bounded photo URL policy |
| `e40285c` | Resource-owned verifier runner and compact outcome records |
| `898f114` | Single panel theme mapping and override/fallback coverage |
| `07b3144` | Integration contract corrections |
| `a3595ad` | Recovery and guide labels aligned with Settings |

No push, merge, tag, workflow dispatch, or store submission occurred. The older
October 3 audit stays active for its separate dependency, historical-tag recovery,
and remote-evidence limitations.
