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
- The notice starts collapsed and displays only original report source as text.
  Script-free BPB Rich/Markdown output, quoted examples, inert types, callback
  properties and non-JavaScript sanitizer removals produce no alarm. Tests cover
  hostile BPB markers, URL/type/namespace precedence, overlapping roots, repeat
  mounting, source limits, long labels and whitespace-prefix omissions.
- Final implementation checks: 4,013 tests passed, typecheck passed, lint passed
  with the eight existing warnings plus two narrowly reviewed detached-template
  assignments, and staged TypeScript policy passed. Both six-case security
  fixtures and the real unpacked Chrome extension verifier pass again after the
  manifest/TypeScript conversion. Independent source and design review has no
  remaining findings.
- Hidden Chrome 156 and Firefox 159 pass the native script-type/count comparison,
  bounded/partial/frame-source cases, and eight layout states each: light/dark,
  normal/doubled inspector text, desktop/narrow. Content widths: Chrome 360/1000,
  Firefox 500/1000 (its native minimum); height 760 for those layouts. Source
  switching preserves summary, report heading, notice, following content,
  document scroll and the actual focused source button. No horizontal overflow
  or external-script/frame-resource requests occurred. Disclosure expansion and
  collapse deliberately change report height; native focus reveal is distinct
  from source-switch jitter. Dark native-control repainting is overridden only
  for this surface's source-choice buttons.
- Final collapsed/expanded and doubled-text screenshots were inspected in both
  engines. Task-owned browser/helper processes exited and disposable report
  profiles/certificates were absent after teardown. Native browser chrome,
  onscreen window placement and assistive-technology speech were not exercised.

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

- Native picker keyboard navigation could not be established through hidden
  Chrome/Firefox automation. Chrome's select-option API and Firefox's native
  option-click path prove source switching and unchanged geometry/scroll;
  Firefox's automated option click focuses BODY, so native popup focus return
  remains unproven. A separate change event on the focused picker proves the
  product's change handler preserves focus and geometry in both engines.
- Browser chrome zoom was not tested; doubled inspector text was tested instead.
  No historical pre-fix UI regression proof exists for this newly added surface;
  the old-bundle route regression proof above is separate.
- Native assistive-technology speech, live provider playback and arbitrary
  server-side rewrite/recursive-decoding behavior remain outside local proof.
