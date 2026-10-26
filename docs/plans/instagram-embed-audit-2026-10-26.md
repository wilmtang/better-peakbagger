# Instagram embed display audit — October 26, 2026

Scope: audit and fix the reported empty carousel tail, embedded-post dark mode,
and the related permission, lifecycle, privacy and verification boundaries.
Implementation is authorized by the user's audit-and-fix request. No release,
push, live-report edit or silent Instagram permission grant is authorized.

## Findings before implementation

### IG01 — native carousel advances beyond its media list (high)

The public Mount Jefferson post `Cis30nUPJSJ` has ten media `<li>` slots. In
hidden Chrome 156 at 1000×900, the video occupied slot 10 with its left edge at
zero. Instagram still rendered **Next**. Clicking it shifted the first slot to
−4630px for 463px-wide items, putting all ten slots offscreen and leaving an
empty viewport. No eleventh media item appeared. **Go back** remained present.
This was observed in Instagram's captioned renderer hosted inside BPB during
the original check. That establishes an overflowing rendered state, not whether
Instagram's code, BPB integration, timing or another environmental condition
caused it. See the direct comparison below before attributing the cause.

### IG02 — theme is not applied to provider content (medium)

[The presentation stylesheet](../../src/reports/instagram.css) themes the BPB
toolbar only. [The packaged wrapper](../../src/reports/instagram-frame.js) loads
the cross-origin provider and cannot style it with the current permissions.
The live provider stayed `rgb(255, 255, 255)` after both an inherited dark
color-scheme preference (`prefers-color-scheme` confirmed true) and a reload with
`?theme=dark`. A whole-frame inversion would also recolor photos and videos and
is unsuitable.

### IG03 — verification stops before the broken end state (high)

[The live verifier](../../scripts/verify-instagram.mjs) traverses the initial ten
slots, confirms decoded video frames, then stops. It does not assert that Next
is unavailable at the media boundary or attempt to advance beyond it. Previous
green playback results therefore did not prove a correct carousel ending.

### IG04 — display changes need a separate, explicit access boundary (high)

[The manifest](../../manifest.json) grants no Instagram host access. Existing
per-post loading consent authorizes loading the provider, not reading or
changing its document. Styling and guarding native controls require optional
Instagram access. It must remain separate from automatic-loading consent and
must never be silently granted or become a required installation permission.

## Follow-up: direct comparison and attribution correction — October 26

The user challenged the claim that Instagram's own carousel miscounted its
media. That causal claim was too strong. A fresh, read-only comparison used the
same public post in hidden Chrome 156.0.8078.4 at 1000×900:

| Environment | Result |
| --- | --- |
| Direct captioned embed URL, BPB absent | Ten slots; Next absent at the final video |
| Plain 463px iframe, BPB absent | Ten slots; Next absent at the final video |
| Same iframe with `allow-scripts allow-same-origin`, BPB absent | Ten slots; Next absent at the final video |
| Current BPB wrapper, optional Instagram access absent | Ten slots; Next absent at the final video |
| Earlier video-fix wrapper from `cb753a8c`, compiled into a disposable copy | Ten slots; Next absent at the final video |
| Current BPB wrapper through the verifier's restrictive proxy, display fixes absent | Ten slots; Next absent after three seconds of video |

The no-proxy wrapper comparisons also retained the correct endpoint after
three seconds of playback. An additional plain-iframe check inspected Next
immediately as the last transition began; it was already absent. These tests
do not reproduce the original overflow and do not isolate the original session's
conditions. They also do not cover every complete video/replay cycle or a
provider version change.

The original screenshot and recorded overflowing slot positions remain symptom
evidence. **The boundary guard is a defensive mitigation, not a demonstrated
repair of Instagram's internal media-counting logic. The precise cause remains
unresolved.** No runtime behavior was changed by this attribution correction.

## Implementation and acceptance

1. Add an optional Instagram display permission with an explicit Settings action.
   Its native browser scope is `https://www.instagram.com/*`; explain that scope
   and confine BPB's helper to captioned embeds inside its own packaged wrapper.
   Denial leaves the existing native viewer and external link usable. Revocation
   unregisters the helper and restores existing embeds' native presentation.
2. Register packaged CSS/isolated-world code only after the permission exists.
   No remote script, proxy, API token, caption extraction or image download is
   introduced. Authenticate configuration by the actual parent WindowProxy and
   extension origin. Keep the native player sandbox and report CSP intact.
3. Derive carousel limits from the recognized native slot geometry, not a fixed
   ten-item limit or whether virtualized slots currently contain an image. Guard
   the terminal Next control and recover a recognized out-of-bounds end state.
   Unknown layouts retain native behavior. Test longer carousels, sparse slots,
   partial transitions, repeated activation and clean restoration.
4. Apply a restrained dark palette to provider chrome/text/icons through scoped
   packaged CSS. Do not invert/filter media. Follow BPB's resolved light/dark
   theme live without reloading the frame, losing carousel position or causing
   requests. Check keyboard focus, captions, links and video controls.
5. Extend packaged Chrome/Firefox fixtures and the public-post check to verify
   every media slot, decoded video playback, terminal navigation, reversibility,
   theme transitions, unchanged media colors, no contact before loading, and the
   retained Peakbagger-cookie/script isolation. Build and run the full unit suite,
   manifest/startup checks and focused lint/documentation checks.

## Closure ledger

### Fixed and verified

- **IG01 symptom guard:** `instagram-provider.js` derives the recognized horizontal slot
  bounds, guards repeated terminal activation, hides unavailable arrows and
  recovers a single recognized overflow. It retains sparse 2/10/20-item lists,
  RTL and localized controls. Firefox's empty virtual slots have different
  vertical baselines, so vertical alignment is deliberately not an invariant.
  Viewport-unit widths may include the scrollbar gutter. Completed CSS
  transitions and native mutations reconcile the controls; disappearing arrows
  transfer focus to a usable native control without scrolling.
- **IG02:** scoped packaged CSS themes headers, location text, captions, links,
  footer and monochrome sprite icons. Photos, posters and video have no filter.
  Stored/system theme changes configure the existing player without replacing
  it, changing carousel position or reflowing report content. Actual light/dark
  header and caption/footer renders were visually inspected in both browsers.
- **IG03:** the packaged verifier now checks backward/forward traversal at the
  final video and terminal activation. Its native public-post run verified ten
  slots and decoded video frames in hidden Chrome 156.0.8078.4 and Firefox
  158.0.1 at 1000×900. Both retained slot index 9 and the same iframe across
  dark/light changes. A fixture disables the helper to reproduce the empty end,
  re-enables it to recover, and verifies focus and restoration. The virtual-slot
  regression assertion also fails on the earlier equal-height/baseline
  assumption with the actual extra-slide index defect, then passes on the fix.
- **IG04:** Instagram remains an **optional** host permission requested only
  from the explicit Settings checkbox. Registration is serialized and reconciled
  before a valid native player loads. The helper is isolated, packaged, matched
  only to captioned endpoints, and inactive without configuration from the
  actual BPB parent and extension origin. The worker supplies the authoritative
  permission boolean because Firefox restricts APIs in embedded extension
  pages. Stale replies/page disposal are guarded. Tests cover denial, busy
  duplicate actions, retry/grant, removal and registration cleanup.
- **Focused checks:** build passed; 68 Instagram, manifest, origin and settings
  contract tests passed. ESLint over `src options popup photos scripts test`
  passed. The real unpacked Chrome startup/bridge check passed at 1000×760.
- **Browser fixtures:** both no-access viewers and display-enabled matrices
  passed in hidden Chrome/Firefox. Report states covered idle, pending,
  cancel/error/retry, loaded and hidden at 1000/375×900, light/dark and normal/26px
  text. Settings keyboard/pending/denied/retry/grant/removal paths kept the
  control, row and following heading within one pixel: Chrome 1000/375×900,
  Firefox 1000/500×900 (its privileged window minimum), with narrow row text
  enlarged to 22px. The native permission results were stubbed in a disposable
  copy. Fixture positioning is instantaneous so setup scrolling does not get
  mistaken for interaction jitter.
- **Security:** the six hostile saved-report cases passed in each browser at
  1000×760, with zero provider or attack requests. The Instagram fixture also
  retained blocked parent/top access, forms, popups and navigation while its
  same-origin lazy video loader decoded frames. No live ascent was edited,
  submitted or saved.
- Owned browser-process command lines and disposable profile paths were checked
  after teardown; no verification browser processes or profiles remained.

### Intentionally not changed

- Default-off per-post loading and the separate automatic-loading consent.
- Canonical post-link storage, one-use frame grants, no-referrer navigation,
  native captions/video controls and the saved-report response protections.
- Instagram availability/login policy and future provider DOM changes are
  external boundaries; unknown markup must not lead to arbitrary page edits.
- No all-frame color inversion, required Instagram host permission or provider
  content copying into Peakbagger.

### Changed but not fully proven

- **IG01 cause:** fresh direct, plain/sandboxed iframe and current/earlier BPB
  wrapper comparisons did not reproduce the original empty tail. Do not describe
  this as a proven general Instagram bug or claim the underlying cause is fixed;
  the verified guard prevents/reverses a recognized out-of-range state.
- Display-enabled runs pregranted the optional host only in a disposable test
  manifest. Restoration configurations and native permission outcomes were
  supplied by fixture-only packaged hooks. This proves the shipped helper and
  controller behavior, not the browser-owned permission prompt or real native
  grant/revocation UI. The user's installed profile and permissions were not
  changed. Headless checks do not prove visible-window focus, placement,
  browser zoom, touch or assistive-technology behavior.
- `npm test`: 3,647/3,648 passed; the unchanged hover-card case **own profile links
  stay undecorated in headings, lists, report rows, and late content** timed out
  at `test/favorites/climber-hover-card.test.mjs:147`. A full run with concurrency
  four also hit that timeout; the isolated file passed 19/19. This remains a
  suite/check defect to investigate separately, not a green full-suite result.
- `npm run lint`: ESLint passed, but the packaging gate rejects an existing
  unowned `UNSAFE_VAR_ASSIGNMENT` at `custom-overlay/editor.js:619`, originating
  from the unchanged static-template construction in
  `src/maps/custom-overlay-editor.js:22`. Raw web-ext results have zero errors,
  zero notices and nine warnings. No warning allowance or unrelated overlay
  code was changed to make this audit appear green.
- Future Instagram markup, availability and login policies remain provider
  controlled. Unknown carousel layouts intentionally preserve native behavior.
