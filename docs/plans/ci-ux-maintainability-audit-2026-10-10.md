# CI, UI, and maintainability follow-up — 2026-10-10

Baseline: `2b7c859`, clean `codex/code-removal-audit` checkout. Preserve the
existing code-removal work. The owner requests fixes, including a distinctive
outdoor visual identity. Each independent unit is verified and committed.

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
  [October 3 ledger](ci-ux-maintainability-audit-2026-10-03.md).
- Existing audits already removed substantial dead/duplicated code. No whole
  runtime module is newly proven unused. Remove actual duplicate owners rather
  than compressing readable code or deleting correctness/privacy guards.
- No push, merge, tag, workflow dispatch, or store submission is authorized.

## Closure ledger

### Fixed and verified

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

### Changed but not fully proven

- New workflow wiring has local execution and YAML contract evidence; a hosted
  run, declared-floor run, and three-pass rehearsal were not dispatched.
- Remote CI, native browser chrome, screen-reader speech, live
providers, store acceptance, and window-placement behavior require separate
evidence. Hidden layout checks do not establish those outcomes.
