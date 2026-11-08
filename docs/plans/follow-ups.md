# Repository follow-up ledger

Status: opened November 6, 2026, when the completed audit and implementation
records moved to [the archive](../archive/README.md). This is the single list of
what those records left open. Their original evidence and limits stay in the
archived documents; add new open items here rather than reopening them.

Feature backlog is not tracked here. It stays in its own
[active plan](README.md).

## Fixed and verified

| Item | Outcome | Evidence |
| --- | --- | --- |
| Snow-legend JSON fixture missing from the privacy scan | `c1ba9599`: JSON is parsed and scanned; malformed JSON and invalid UTF-8 are rejected | Both baseline failures reproduced, then passed |
| Script inventory ignored `.mts` and missed a verifier | `6e4a3041` | Original assertion failed first |
| Moderate minimatch advisories in the lint toolchain | `01616f47`: scoped to former 10.x consumers | Nine findings removed; production audit is zero |
| Custom-overlay reorder check failed in Chrome | `7719f08d`: waits for the deep-link scroll to settle. The product did not move | Probe saw a 305px pane scroll; settled geometry matched exactly |
| Recorded editor Chrome zoom-fit and Firefox hover-help failures | Did not reproduce | Full custom-overlay runs pass in hidden Chrome 156 and Firefox 159 |
| Firefox custom-overlay GeoJSON stuck on "Loading" | No longer occurs | Same Firefox run; see the [October 27 ledger](../archive/codebase-audit-2026-10-27.md) |
| Intermittent climber-hover late-content timeout | Product defect, fixed in `e9a0b694`: replacement focus opened the next climber's card | Test file failed 4 of 5 runs before the fix, passed 8 of 8 after |
| `verify -- chrome` and `-- firefox` stopped at the Garmin section check | `69c7a321`: the verifier expected the section to hide, but `132303e1` keeps it available for Disconnect | Failed 4 of 4 runs before; both browsers pass after |
| Terrain visual 2D gap (41px against 40px) and Firefox Sentinel trigger | No longer occur | `verify -- terrain chrome` and `firefox` pass on Metal |
| Terrain LOD probe could not run | No longer blocked; the suite now reaches its criteria | See the warming item below |

### Acceptance run — November 6, 2026

Run on Node 24.22.2 against `69c7a321`, on macOS with Apple M3 Pro. Browser checks
ran hidden.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with the eight owned web-ext warnings |
| `npm test` | 3,874 of 3,874 passed |
| `npm run test:scale` | 14 of 14 passed |
| `npm run verify -- chrome` | Passed in Chrome 156 at 1000×760 |
| `npm run verify -- firefox` | Passed in Firefox 159 at 1000×760 |
| `npm run verify -- terrain chrome` and `firefox` | Passed on hardware rendering |
| `npm run verify -- settings-navigation` | Passed in Chrome and Firefox |
| Climber transitions | 24 of 24 cases passed in Chrome 156 and Firefox 157 |
| Backup layout suite | 16 of 16 cases passed on macOS |
| Release archives and `verify -- packages` | Passed for the minified Chrome and Firefox packages |
| `npm audit --omit=dev` | Zero vulnerabilities |
| `npm run audit:ci` | **Failed:** addons-linter, deepmerge and web-ext |
| `npm run verify -- terrain lod` | **Failed:** see the warming item below |

## Intentionally not changed

- **Expired deepmerge exception.** It lapsed on October 31 and was not extended.
  The chain is development-only, and upstream lists no patched release. It stays
  a release blocker until the chain is patched or someone reviews it again. See
  [the release guide](../releasing.md).
- **Terrain warming budget.** The 120ms budget was not loosened to turn the check
  green.
- **Historical-tag Firefox recovery.** It stays limited by current-main metadata;
  see [the release guide](../releasing.md). Supporting it is a separate decision.

## Changed but not fully proven

### Needs a decision or a person

- **Garmin distribution agreement.** The review is still open.

### Reproduced or still open

- **Terrain warming.** `verify -- terrain lod` still fails its strict tile-level
  criterion: tilt 58°→61° took 158ms and 67°→70° took 154ms, against 120ms. The
  probe recorded no visible pixel shortfall on either step, so this is a timing
  gate, not an observed visual defect. It is a local-only measurement.
- **Linux backup actions.** Fallback fonts caused a 1.2–1.6px ascent action-width
  shift and equal-width profile actions on hosted Linux. There is no local Linux
  or container runtime, so this was not rerun; the suite stays on macOS runners,
  where it passes. See the [CI latency record](../archive/ci-latency-2026-10-25.md).
- **Firefox verifier isolation.** `verify-custom-overlays` exited before its first
  page in one run while a personal Firefox was open, and passed with `-no-remote`.
  Other Selenium verifiers have not adopted it. `verify -- firefox` passes without
  it, so the cause is not fully established.

### Local proof limits

- **Report source inspector.** Native picker keyboard navigation in Chrome and
  Firefox, Firefox popup focus return, browser chrome zoom and assistive speech
  remain unverified. Hidden fixtures prove source switching and layout stability
  with normal/doubled inspector text; the focused change handler preserves focus.
  Live provider playback and unknown server-side URL rewrites remain outside that
  evidence. See the [report protection closure ledger](../archive/report-protection-remediation-2026-11-07.md).
- **Replacement focus.** The fix is proven in jsdom. Real-browser transition runs
  pass but do not drive a row disappearing under an open card.
- **Hosted CI.** The commits behind this ledger are local and unpushed. No hosted
  run, including the Linux surfaces or the Dependabot workflow on a real update,
  is claimed.

### Release-only checks

Fixtures cannot establish these, so check them by hand before a release:

- Live Garmin and onX sign-in, cold start and recovery, including a truly expired
  Garmin key and a real Cloudflare challenge.
- Live Peakbagger acceptance and saved-trip persistence, and Peakbagger cookie
  isolation for signed-out users.
- Live Strava, NRCS and other provider compatibility and throttling.
- Provider-specific private-layer policies and authenticated map formats.
- Instagram's own resize, login and availability behavior.
- Actual Firefox BFCache delivery with real extension messages.
- Native permission prompts, browser menus and browser zoom.
- Screen-reader output, physical touch, and visible focus and window placement.
- Store submission and acceptance.
