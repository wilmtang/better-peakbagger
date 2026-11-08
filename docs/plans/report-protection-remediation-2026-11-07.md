# Report protection remediation

User-authorized scope: fix encoded-route overblocking, preserve report-script
denial and BPB compatibility, then implement the reviewed compact notice and
original-source code inspector. Each independent unit receives its own commit
after tests and independent review. Existing unrelated settings edits are out
of scope.

## Fixed and verified

- Route policy uses generated compiler-sized partitions and a shared Firefox
  priority evaluator. All 524,288 supported mixed report/map aliases pass the
  focused tests. Full suite: 4,000 passed, none failed.
- Hidden Chrome 156 and Firefox 159 each pass 30 route cases, including ordinary
  encoded-page recovery, mixed trailing-dot restrictions, Cloudflare exemption,
  native/encoded maps under protected parents, and wrong-root map denials under
  unprotected parents. Chrome accepts all 81 packaged regexes. The new Chrome
  regression assertion failed against the old bundle on the actual blocked
  encoded-profile script, then passed after the fix.
- Existing security fixtures pass six cases in each browser, with zero attack
  or Instagram requests. The real unpacked Chrome extension verifier passes,
  including MAIN-world startup and chart behavior. Route fixture content sizes:
  Chrome 1000 x 760, Firefox 1000 x 815. All checks ran hidden; native window
  placement and assistive-technology speech were not tested.
- Independent code review approved the route unit with no remaining findings;
  compiler/priority verification is wired into the browser CI jobs. Remote CI
  itself has not run for these local changes.

## Intentionally not changed

- All report-owned executable JavaScript remains disabled, including benign
  scripts submitted through Plain mode. Blocked does not mean malicious.
- Native Quick Search uses its packaged replacement. Native map/YouTube and
  extension frame boundaries remain separate.
- Nested/reserved/control/non-ASCII encodings, malformed escapes and residual
  path-normalization ambiguities remain fail-closed. The ordinary unreserved
  profile/editor aliases are the compatibility defect being corrected.
- No automatic trust from BPB-looking classes, IDs or data attributes, no
  remote source-code fetches, no persistence of report code, and no Save action.

## Changed but not fully proven

- Compact notice/collector: design approved; implementation pending the route
  unit's verified commit. Count only original executable report source, with
  type/context checks, overlapping-root deduplication, bounded records and
  private idempotence state.
- Native assistive-technology speech, live provider playback and arbitrary
  server-side rewrite/recursive-decoding behavior remain outside local proof.
