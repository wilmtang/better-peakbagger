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
This is reproducible in Instagram's native captioned renderer; BPB currently
hosts that renderer without DOM access.

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

- None yet; baseline investigation only.

### Intentionally not changed

- Default-off per-post loading and the separate automatic-loading consent.
- Canonical post-link storage, one-use frame grants, no-referrer navigation,
  native captions/video controls and the saved-report response protections.
- Instagram availability/login policy and future provider DOM changes are
  external boundaries; unknown markup must not lead to arbitrary page edits.
- No all-frame color inversion, required Instagram host permission or provider
  content copying into Peakbagger.

### Changed but not fully proven

- IG01–IG04 remediation is pending implementation and browser verification.
- Native permission-prompt appearance cannot be proved by a headless grant or a
  fixture. Record the exact prompt/consent paths actually exercised.
