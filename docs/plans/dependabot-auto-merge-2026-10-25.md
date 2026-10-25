# Dependabot auto-merge investigation — 2026-10-25

All three requested branches are merged into local `main` with real merge
commits. Nothing was pushed and the remote PRs remain open. This is local
integration evidence, not a claim that remote CI or every browser verifier is green.

## Remote evidence

- [PR #58](https://github.com/wilmtang/better-peakbagger/pull/58), editor:
  [Test run 40156233568](https://github.com/wilmtang/better-peakbagger/actions/runs/40156233568).
- [PR #59](https://github.com/wilmtang/better-peakbagger/pull/59), vendored:
  [Test run 40156243997](https://github.com/wilmtang/better-peakbagger/actions/runs/40156243997).
- [PR #60](https://github.com/wilmtang/better-peakbagger/pull/60), tooling:
  [Test run 40156274060](https://github.com/wilmtang/better-peakbagger/actions/runs/40156274060).

The privileged auto-merge runs succeeded and all three PRs had native auto-merge
enabled. Required checks blocked them. Node tests never ran remotely because the
advisory step failed first. #58/#59 also contained real fast-uri and undici
advisories that local unpublished `main` had already repaired. #58's Firefox jobs
clicked a `ProseMirror-separator` image; the Chrome package job failed when it
subsequently ran that same Firefox check. #60's Firefox 152 job lost its browser
connection during the narrow analyzer case.

## Closure ledger

### Fixed and verified

- **Audit parent version:** replace the exact web-ext 10.7.0 requirement with
  stable compatible releases from the same floor. Keep the exact node-forge
  advisory, vulnerable dependency versions, development-only locations, edges,
  duplicate rejection, counts, severity, and expiry. The new regression failed
  before the fix and passed afterward; the final live opt-in audit passed.
- **Editor spacers:** Firefox interactions and caption assertions now select
  the extension-owned resizable photo. The spacer regression and both caption
  assertions failed with the old selectors and passed after correction. Hidden
  Firefox 158.0.1 extension verification passed at 1000×760 after the editor merge.
- **MapLibre compatibility:** 6.14.0 retains the identical distributed terrain
  update method from 6.13.0 and still omits the source LOD callback. Explicitly
  approve 6.14.0 for the existing patch. Build and shipped-method checks passed;
  hidden Firefox 157.0 terrain verification passed at 1000×760 using Apple M3 Pro
  Metal. This is an intentional vendor guard, not an arbitrary version assertion.
- **Mode placement assertion:** replace the stale 40px native-control gap limit
  with action position and size comparisons across successful activation and
  WebGL2-unavailable fallback, allowing one CSS pixel rounding. Preserve overlap
  checks. Chrome hardware checks exercised the transition, provider recovery,
  resize, and popup paths. The 2D/3D screenshots were inspected.
- **Test keychain isolation:** direct Chrome launches lacked Playwright's mock
  keychain/password-store defaults, causing a visible macOS Safe Storage prompt.
  All direct fixture launchers now use those defaults; showcase screenshots also
  use an owned disposable profile. The new guard failed before the fix; 30 launch,
  resource, and showcase checks passed afterward. Browser process arguments prove
  the flags are passed; hidden protocol verification does not establish native
  prompt absence or window-placement behavior.

### Intentionally not changed

- The default audit remains strict. The reviewed development-only exception
  still expires at **2026-10-31 00:00 America/Los_Angeles**. npm still reports the
  same three high findings; node-forge's registry latest was 1.4.0 during this run.
- Unreviewed MapLibre releases and changed/ambiguous patch input still stop the
  build. Future updates require reviewing the vendor workaround.
- Required checks, provenance validation, and manual review of GitHub Actions
  updates were not weakened. No blanket retries or bypasses were added.
- Unrelated documentation work in this shared checkout was preserved.

### Changed but not fully proven

- The full Chrome terrain verifier reached hardware rendering and passed the
  changed geometry checks, then timed out in a separate Sentinel cooldown case
  at the end of the run. Its root cause remains unresolved; full Chrome terrain
  success is not claimed.
- One local Firefox session disconnected during add-on installation. A diagnostic
  run passed, but that does not establish the cause or repair of the remote
  Firefox 152 connection loss. Linux and minimum-Firefox revalidation remain open.
- No push was authorized or performed. The remote default branch still lacks
  these repairs and has no new terminal CI result for them.

## Local integration

| Source branch | Merge commit |
| --- | --- |
| `dependabot/npm_and_yarn/editor-5e8c75a09f` | `643f1fc1` |
| `dependabot/npm_and_yarn/vendored-8f42b2fb74` | `40f7e43` |
| `dependabot/npm_and_yarn/tooling-3bd57b00f0` | `841fe172` |

The tooling merge's adjacent manifest conflicts were resolved by retaining all
three groups' updates. Each remote head is an ancestor of local `main`.

Final combined checks: `npm ci`, all **3,529** tests, **14** scale tests,
`npm run lint` (eight owned warnings), and the reviewed-advisory gate passed.
The final real unpacked extension also passed hidden Chrome for Testing
156.0.8078.4 verification at 1000×760, including analyzer controls at
1600/800/390px, both themes, and enlarged text. Teardown passed. This does not
replace the separate incomplete terrain verifier or prove native focus/window
placement or keychain-prompt absence.
