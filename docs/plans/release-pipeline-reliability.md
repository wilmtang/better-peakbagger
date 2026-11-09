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

No new extension version or store submission is part of this implementation.
Each completed code unit receives independent review and its own checked commit.

## Closure ledger

### Fixed and verified

- Unit 1: maintained store copy, required/optional API and host permission diffs,
  content-script match diffs, and bounded opt-in public probes. Independent review
  has no remaining comments. All 4,055 tests, typecheck and lint passed; the three
  public links and public-land/slope PNG probes passed once on 2026-11-08.
  Google acceptance, authentication and browser rendering remain separate checks.

### Intentionally not changed

- Browser coverage, first-attempt three-pass rehearsal, teardown requirements,
  privacy boundaries, immutable tags, required reviewers and store-version checks.
- Native ascent Save remains manual. No speculative runtime patch is justified
  by the single unreproduced Preview verification failure.

### Changed but not fully proven

- None yet. The original Preview timeout remains unresolved.
- Live publication and native/mobile behavior cannot be inferred from fixture or
  read-only workflow checks; record remaining evidence here before handoff.
