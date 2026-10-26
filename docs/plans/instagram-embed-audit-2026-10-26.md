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

## Resolved cause and replacement fix — October 26

The original failure is now reproduced with the navigation helper disabled.
The earlier inconclusive comparisons used a different loading order; they were
insufficient grounds either to blame Instagram generally or to rule out BPB.

### BPB changes the native viewport while the carousel initializes

The card has a 2px left border and 10px left padding. Absolute positioning starts
inside that border. The pending media used `left: 12px`, giving it 2px less
content width than the completed, normally positioned media. At the fixture's
1000×900 viewport, the measured frame widened from **460.59375px pending** to
**462.59375px loaded**; Instagram saw rounded viewports of **461px then 463px**.
A full-width post similarly changed from 526px to 528px.

Ordinary fast-avatar loads often finished before Instagram mounted its carousel,
so earlier direct/iframe tests correctly stopped at the final video. To exercise
the different loading order, the diagnostic held only the header avatar request
until Instagram created its real ten-item carousel, then released the request.
No media list, native state, navigation handler or arrow was altered. Packaged
BPB ran without optional Instagram access. The browser was hidden Chrome
156.0.8078.4 at 1000×900, using a disposable copy of committed `35296b7d`.

### The resize loses Instagram's visible-width update

The actual native modules `PolarisHScrollAnimationController.react` and
`PolarisHScrollContainer.react` decide Next from remaining measured space, not
from the media count: content width − visible width − scroll position.
Instagram animates item widths during resizing and updates content/visible
widths through separate callbacks. Each callback copies the other dimension
from the old React state. When both updates share a batch, the later update can
overwrite the earlier update's new dimension.

An observation-only trace recorded this interleaving during the failed load:

- Visible-width update submitted content **4614.375**, visible **463** while
  the previous visible width was **0**.
- About **0.3ms** later, content-width update submitted content **4616.875**,
  visible **0**, still reading the old state. The committed visible width
  remained **0** after the animation finished.
- At the final video, native state was content **4630**, visible **0**, scroll
  **4167**. Its formula reported **463px** remaining and displayed Next.
- Clicking that native Next moved scroll to **4630**, putting all ten items
  offscreen at **index 10**, exactly reproducing the reported blank step.

A second un-delayed run retained the old 461px width instead of 463px, producing
an unnecessary 2px terminal step. This is the same lost update with a different
initial value, not an eleventh media object. A real-session resize trace also
captured the same two-callback overwrite with differing nonzero widths.

### Fix the loading geometry and leave navigation native

`instagram.css` now uses `left: 10px`, matching the card's content padding.
Pending and completed frames have identical widths. The same slow-avatar load
then retained **462.59375px** throughout; Instagram's cached visible width
settled at **463**, and its own Next disappeared at the final video. All ten
items remained reachable, with no optional permission or navigation helper.

The former slot inspection, MutationObserver, click interception, arrow-hiding,
overflow recovery and focus-moving code has been removed. The optional helper
only applies BPB's theme and is labelled **Instagram theme → Match BPB theme**.
It does not inspect, alter or advance Instagram's carousel.

## Closure ledger

### Fixed and verified

- **IG01:** correct BPB's pending/completed width invariant, removing the
  initialization resize that triggers the traced native lost update. The
  controlled native load reproduced the complete blank step before the fix and
  ended naturally at the final video after it, without the former guard.
- **IG02/IG04:** retain authenticated optional theme access, packaged isolated
  CSS/code, stored/system theme updates and native media colors. Permission
  state remains browser-owned; navigation no longer requires Instagram access.
- **IG03:** real-browser fixture assertions compare pending and completed iframe
  widths at desktop/narrow widths in both themes and enlarged text. The new
  assertion fails on the original CSS with the actual 2px viewport movement,
  then passes with corrected CSS. Native terminal navigation is checked outside
  the optional-theme branch, so a theme helper cannot mask a broken endpoint.
- The theme unit checks explicitly verify that native markup, clicks and
  navigation are left untouched, including theme removal and page disposal.
- Detailed current verification results are recorded below.

### Intentionally not changed

- Default-off per-post loading and the separate automatic-loading consent.
- Canonical post-link storage, one-use frame grants, no-referrer navigation,
  native captions/video controls and the saved-report response protections.
- Instagram availability/login policy and future provider DOM changes are
  external boundaries; unknown markup must not lead to arbitrary page edits.
- No all-frame color inversion, required Instagram host permission or provider
  content copying into Peakbagger.

### Changed but not fully proven

- Verification below uses a disposable copy of committed `35296b7d` plus only
  this change. Concurrent custom-map relay work in the shared checkout is
  preserved and excluded from the test source/commit.
- Native permission-prompt appearance and native grant/revocation UI remain
  unverified. Display-enabled fixtures pregrant optional access only in a
  disposable manifest and stub native permission outcomes for the Settings
  controller checks. The user's installed profile/permissions were not changed.
- The provider has its own lost-update behavior under resizing; this change
  removes BPB's unnecessary initialization resize. It does not patch Instagram's
  private React state or claim to repair all provider-controlled manual-resize,
  login or availability behavior.
- Hidden checks do not establish visible-window placement, browser zoom, touch
  or assistive-technology behavior. The existing native Chrome profile was also
  inspected read-only and its controls exercised, without raising its window.
- Full-source checks and any remaining unrelated failures are listed below;
  no failed gate is described as a complete pass.

### Current verification

- Build and 24 focused Instagram tests passed in the isolated source. Full-source
  ESLint passed. The full unit run executed 3,646 tests: 3,645 passed, with one
  script-inventory mismatch caused by accidentally copying the concurrent map
  relay's new README entry without its new module. Removing only that foreign
  entry from the disposable copy and re-running the metadata/documentation/
  fixture tests passed. The first archive run also lacked a Git inventory; that
  test setup was corrected. These were test-copy setup failures, not suppressed
  runtime assertions; the initial commands are not described as green runs.
- The new viewport-width assertion failed against the original CSS on the actual
  2px movement and passed against the fix. Chrome 156.0.8078.4 and Firefox 158.0.1
  packaged fixture matrices passed at 1000/375×900, both themes and normal/26px
  text, including error/retry/cancel, native video, theme removal/re-enable and
  stable geometry. Settings checks passed at Chrome 1000/375×900 and Firefox
  1000/500×900, with 22px narrow text and stubbed permission outcomes.
- The controlled Chrome slow-avatar comparison reproduced native cached width
  zero and the complete extra step before the fix. The same initialization
  sequence after the fix naturally ended at index 9, with native visible width
  463 and no optional Instagram permission. No native React state was patched.
- Firefox's public photo/Reel/carousel check passed without optional access,
  including all ten slots, decoded final-video frames, and native backward/
  forward terminal navigation. Chrome's real manifest/worker/startup/bridge
  verifier passed at 1000×760. No runtime map-relay files were included.
- Settings screenshots were visually inspected at the narrow viewport; the
  theme helper retains the already-verified dark CSS. No remote ascent was
  submitted or saved. Temporary live diagnostic styles/listeners were restored,
  and task-created public tabs were closed while the user's report stayed open.
