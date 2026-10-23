# Garmin workflow prototype

This documentation-only HTML/CSS/JavaScript prototype accompanies the
[Garmin integration plan](../../garmin-personal-api-draft-inbox.md). It reuses
[the shared panel stylesheet](../../../../src/theme/panel.css) and the packaged
extension icon. It is outside the extension's runtime build.

Open [index.html](index.html) in a browser to explore the scenes. The controls
above the application switch screens, light/dark appearance, and simulated
success/offline responses. All data is fictional. The page has no fetch, storage,
extension messaging, downloads or tab creation; its content security policy
blocks connections. The personal-key field is a read-only demo value.

Interactions represented:

- Connect → choose preferences → Enable Garmin drafts → open the inbox.
- Four-hour default, Manual only, Custom interval, and manual Check now.
- A slow check followed by success or an actionable offline error, with Retry
  represented by the same Check now action.
- Explicit historical import and a draft older than 30 days.
- Strong/Probable selection, zero-selection guard, refresh and dismissal Undo.
- Credential export off/on; enabling it includes the Garmin personal key in the
  described file contents. The prototype never creates an actual file.

The create-key link is deliberately non-navigating text. Sign-in, history
discovery, form preparation and export show example outcomes only. Both Review
activity links open the same illustrative October review screen. The prototype
does not model real auth expiry, API quotas, storage migration, cross-device
import, Save reconciliation or the complete permission/account flow.

## Regenerate and verify

From the repository root, with the installed Playwright browsers available:

```sh
node docs/plans/mocks/garmin-api/render.mjs --preflight
node docs/plans/mocks/garmin-api/render.mjs
node --test test/project/documentation.test.mjs
```

On macOS, launch outside the Codex Seatbelt sandbox through the approved
execution path. The script uses the repository's Chrome launch guard, hidden
Chrome for Testing and Firefox, isolated browser profiles, and a disposable
HTTPS certificate for a locally resolved Peakbagger hostname. It closes its
browsers/server and deletes the certificate in teardown. It neither loads the
real extension nor touches the user's browser profile. Inspect remaining process
command lines after running, as required by the repository's verification rules.

The renderer saves Chromium images under `images/`. Its assertions check the
mock interactions, horizontal overflow, keyboard focus during busy/disabled
states, and action/heading/list/footer geometry across idle → pending → error →
retry → success at 1180px and 390px in both themes and browsers. A 200% CSS zoom
case checks enlarged settings layout; this is not native browser zoom or
operating-system text scaling. Static screenshots and mock checks do not prove
the proposed runtime implementation, real browser permission prompts, native
focus/window behavior or production layout stability.

Last verified October 23, 2026: hidden Chrome for Testing 156.0.8078.4 and Firefox
157.0, 1180 × 900 and 390 × 1000 viewports, light and dark. The images are Chromium
captures inspected visually. Rendering is DOM/CSS, with no WebGL or map tiles.
The enlarged settings evidence is split into [top](images/08-enlarged-settings.png)
and [actions](images/09-enlarged-settings-actions.png) viewport captures; CSS-zoom
full-page stitching repeated image tiles and was not used as visual evidence.
