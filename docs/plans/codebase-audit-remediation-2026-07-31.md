# Codebase audit remediation — 2026-07-31

Status: **approved and in progress.** This plan reassesses the seven findings in
an external audit against clean local `main` at `fb6733e`, 47 commits ahead of
`origin/main`. The external report's broad claim that every security boundary
is correct is not treated as proof; each accepted finding below is scoped to
the current source and receives focused regression coverage.

## Reassessed findings

| ID | Priority | Finding | Decision |
| --- | --- | --- | --- |
| F1 | P1 | capture starts can pass the in-flight guard before the process is registered | Fix with per-tab admission serialization |
| F2 | P1 | detached tab-removal and periodic cleanup promises can reject unobserved | Fix every detached cleanup owner together |
| F3 | P2 | MAIN-world settings snapshots are accepted without schema validation | Fix at the `postMessage` receiver |
| F4 | P2 | ascent-page metrics and route geometry accept finite but impossible coordinates | Fix in the shared analyzer geometry boundary |
| F5 | P3 | options labels contain more than one labelable descendant | Fix the semantics; the claimed number-input click toggle was not reproduced |
| F6 | P3 | theme startup duplicates the schema default | Replace the duplicate with the schema owner |
| F7 | P3 | the `mask-icon` branch is unreachable after all links are ignored | Remove the dead exception, preserving current behavior |

Priority describes product impact, not implementation effort. P1 is a material
reliability or recovery defect, P2 is a bounded trust/correctness defect, and P3
is accessibility or maintainability debt.

## Execution and proof

1. Serialize the entire capture admission path by source tab, while preserving
   same-activity reuse, changed-activity queuing, force recapture, cancellation,
   and generation ownership. Add a regression that overlaps starts before the
   existing `processes` map can be populated.
2. Give tab removal and the periodic cleanup alarm explicit rejection
   boundaries. Cover draft/job/photo cleanup failures without allowing one
   cleanup family to hide another.
3. Apply `settings-schema.js` validation before any `toPage` snapshot becomes
   confirmed state. Test ordinary pushes, successful acknowledgements, and late
   acknowledgements with spoofed invalid known values.
4. Share one geographic-coordinate predicate in `gpx-metrics.js` across metric
   points and route segments. Preserve segment breaks so invalid coordinates do
   not create a chord across discarded data. Keep provider/local capture's
   existing stricter `capture-core.js` sanitization unchanged.
5. Give every options control an unambiguous label, use the schema theme default,
   and remove only the unreachable mask-icon expression. Add structural or
   source-contract regressions where they protect against recurrence.
6. Run focused suites after each unit, then `npm run lint:js`, `npm test`,
   `npm run lint`, and hidden packaged Chrome/Firefox verification. UI markup
   changes also receive hidden rendered inspection at desktop and narrow
   Settings viewports.

## Closure ledger

### Fixed and verified

- Pending implementation and proof.

### Intentionally not changed

- Provider and local-file capture retain their existing bounds checks in
  `capture-core.js`; adding a second capture validation owner in the parser
  would not fix the separate analyzer path.
- A page script can originate same-window, same-origin `postMessage` traffic.
  Revalidation is therefore required, but the page remains the owner of its
  MAIN-world DOM and no new privileged bridge capability will be added.

### Changed but not fully proven

- Pending final verification and explicit proof gaps.
