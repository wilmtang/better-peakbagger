# Release pipeline reliability and turnaround

The 4.1.0 release exposed late store-readiness failures, insufficient evidence for
an intermittent native Preview timeout, and repeated verification of rebuilt
packages. This plan implements the independently reviewed retrospective.

## Work units

1. Add maintained store metadata and cheap readiness checks. Flag new permissions,
   prepare reviewed justifications, and offer bounded public URL/provider probes.
   Authentication and Google-specific validation remain explicit manual checks;
   a local HTTP 200 must never be reported as Google acceptance.
2. Add permanent privacy-safe native submission diagnostics and fresh-profile
   capture verification. Preserve deadlines and runtime behavior. A passing
   investigation does not establish the original Preview timeout's root cause.
3. Retain CI's exact verified packages. Rehearsal consumes those packages and runs
   current Chrome, current Firefox and both browser floors on separate runners,
   preserving three consecutive passes and teardown per browser.
4. Promote the same verified bytes on tag publication. Coordinate workflow,
   documentation, evidence validators and tests: trusted repository/workflow/run
   attempts, exact source/version/artifact IDs and digests, complete test evidence,
   freshness, a fresh audit, protected-main ancestry and publication protections.
5. Separate Chrome upload from publication with a secretless, tag-only required
   metadata-review checkpoint. Keep credentials and OIDC in `browser-stores`.
   The reviewer checks Google's validation and the latest draft version after
   upload. The v2 API cannot prove an unsubmitted draft's current digest, nor
   condition publication atomically on a draft revision. Receipts must not claim
   otherwise. Preserve global publication serialization and reconciliation.
6. Repair verifier defects exposed by hosted CI without relaxing product
   assertions: isolate sibling Cloud traffic from weather interaction counters,
   then investigate the settings deep-link geometry failure separately.

No new extension version or store submission is part of this implementation.
Each completed code unit receives independent review and its own checked commit.

## Closure ledger

### Fixed and verified

- Unit 1: maintained store copy, required/optional API and host permission diffs,
  content-script match diffs, and bounded opt-in public probes. Independent review
  has no remaining comments. All 4,055 tests, typecheck and lint passed; the three
  public links and public-land/slope PNG probes passed once on 2026-11-08.
  Google acceptance, authentication and browser rendering remain separate checks.
- Unit 2: bounded, sanitized native Preview events, per-provider browser/server
  POST stage counters and a bounded control snapshot on timeout. CI now exercises
  three independent capture profiles, alternating the first provider. Independent
  review has no remaining comments; 4,058 tests, typecheck and lint passed. The
  final hidden Chrome for Testing 156.0.8078.4 run passed all three profiles at
  1000×760, including teardown; process/root inspection found no owned leftovers.
  HTTPS fixtures stub providers and Peakbagger; no live provider, native focus,
  WebGL or original-timeout root-cause proof is claimed.
- Units 3–4: CI retains exact packages; four rehearsal browsers run independently;
  tag promotion and operator preflight share trusted evidence reconstruction.
  Source CI/rehearsal attempts, required coverage, current-job timestamps,
  archive/API digests, independent downstream identity pins and post-download
  freshness are checked. Main/tag/environment protections are checked read-only;
  publication and Firefox recovery share a global lock. Independent review is
  clear. All 4,086 tests, typecheck, lint and actionlint passed; final added
  freshness/API-root regressions passed in the 30-case evidence suite. Exact
  production packages passed hidden Chrome 156.0.8078.4 and Firefox 159.0.1 at
  1000×760 (plus existing responsive header cases), including teardown. No
  current-run process/profile/extraction leftovers remained. Historical code
  failed the new fresh-extraction assertion on repetition two; the fix passed.
- Unit 5: Chrome upload and publication are separated by the tag-only protected
  `chrome-metadata-review` checkpoint. Its configured environment was read back
  with owner review, no admin bypass, zero secrets and zero variables. Credentials
  and WIF remain in `browser-stores`. Receipts bind local sent bytes, source and
  optional API version; they do not claim remote draft identity. Publish-only
  cannot upload, and preserves exact-version reconciliation without replaying
  writes. Receipt paths are exclusively reserved before upload; receipt and
  original verification deadlines are checked at mutation boundaries. Primary
  jobs revalidate evidence and dependency advisories after approval waits.
  Independent review has no remaining comments. All 4,109 tests, typecheck,
  lint, actionlint and staged TypeScript policy passed. No store mutation was
  performed to test the new checkpoint.
- Hosted CI exposed shared Cloud/weather request counters in the interaction
  fixture. The typed verifier now disables the unrelated Cloud card, waits for
  the weather card's own busy state and outgoing request, and preserves strict
  duplicate-input assertions. It also restores a previously ineffective scalar
  scroll assertion. A controlled historical browser run failed the same request
  count assertion with one weather and two legitimate pressure-profile requests;
  the fixed run passed the same overlap scenario. All 4,112 tests, typecheck and
  lint passed. Final hidden Chrome 156.0.8078.4 and Firefox 159.0.1 passed all
  eight desktop/narrow, theme and 100%/200% interaction cases with teardown.
  Independent review is clear. No weather runtime change was made.
- The legacy ignored-climber backup fragment now shares the existing 24px
  anchor inset. Old hosted CI failed the actual 1px visibility assertion;
  the fixed CI-configuration trace matched its 7228.71875px target offset and
  landed 23.71875px inside the short pane. Hidden Chrome 156.0.8078.4 passed
  eight full navigation cases and four direct real-200%-zoom cases (CSS
  viewports 500×380 and 240×380, both themes), with clamp-aware 1px checks.
  Firefox 159.0.1 passed the canonical full extension check and settings matrix.
  Screenshots were inspected; owned profiles/processes were removed. All 4,112
  tests and lint passed; independent review is clear. No scroll JavaScript,
  native anchoring behavior, tolerance or timeout was changed.

### Intentionally not changed

- Browser coverage, first-attempt three-pass rehearsal, teardown requirements,
  privacy boundaries, immutable tags, required reviewers and store-version checks.
- Native ascent Save remains manual. No speculative runtime patch is justified
  by the single unreproduced Preview verification failure.
- The legacy combined Chrome API and separate Firefox recovery contract remain
  compatible. Firefox recovery shares the global lock but retains its existing
  preserved-artifact/unused-version proof rather than claiming the new primary
  tag pipeline's freshness checks.

### Changed but not fully proven

- None yet. The original Preview timeout remains unresolved.
- Live publication and native/mobile behavior cannot be inferred from fixture or
  read-only workflow checks; record remaining evidence here before handoff.
- At the implementation commit, new hosted CI package retention, four-runner
  rehearsal and tag promotion had not executed live. Subsequent hosted evidence
  belongs in the PR/CI record; local fixtures and read-only API validation do not
  establish GitHub scheduling or a store submission.
- The Chrome v2 API cannot prove the current unsubmitted draft digest or provide
  an atomic publish precondition. The protected reviewer must inspect the latest
  version and Google's validation, while external draft edits are excluded from
  the transaction. The new checkpoint still needs first live release proof.
- PR #70's original 2.28px settings displacement source remains unknown; the
  corrected missing-inset contract is not claimed to fix an inferred JS race.
  Its hash/owning navigation were correct. The original interaction failure
  lacked request identities, so its exact historical sequence is not claimed
  proven merely from the controlled Cloud-overlap reproduction.
- A read-only smoke check found that raw job-log retrieval is rejected by the
  current GitHub CLI's ANSI protection. Binary artifact retrieval passed; the
  log-reader correction is the next separate unit.
