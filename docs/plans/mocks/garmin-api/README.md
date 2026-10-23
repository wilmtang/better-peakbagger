# Garmin workflow prototype

This documentation-only HTML/CSS/JavaScript prototype accompanies the
[Garmin integration plan](../../garmin-personal-api-draft-inbox.md). It reuses
[the shared panel stylesheet](../../../../src/theme/panel.css) and the packaged
extension icon. It is outside the extension's runtime build.

The [toolbar popup prototype](popup.html) also loads the actual
[popup stylesheet](../../../../popup/popup.css). It adds a persistent **Activity
inbox** button below the header, a pending-activity count and an explicit
**Capture this activity** action. Use the controls below the popup to try other
websites, active/error captures, empty/unconfigured inboxes, checking/reconnect,
expired keys, manual checks, an unavailable count, 125 pending items, and a
failed opening. The badge counts
activities needing review or attention, not peaks or unread messages; opening
the inbox does not clear it. All three example pending rows count, including
the one waiting for Peakbagger.

Open [index.html](index.html) in a browser to explore the scenes. The controls
above the application switch screens, light/dark appearance, and simulated
success/offline/expired/rejected responses and connection state. All data is
fictional. The page has no fetch, storage, extension messaging or downloads;
its content security policy blocks connections. The personal-key field is a
read-only demo value. Its **Get a Garmin API key** link opens the official
[Garmin key page](https://connect.garmin.com/app/settings/personalApiToken) in a
new tab only when followed; Garmin handles sign-in and key creation.

Interactions represented:

- Connect → choose preferences → Enable Garmin drafts → open the inbox.
- Expired key → Update key → get a key in Garmin → Reconnect Garmin. Expiry
  pauses imports while keeping drafts available. A successful replacement keeps
  the schedule and history choice; a rejected replacement keeps the existing
  connection. Network errors do not label the key invalid or expired.
- Toolbar popup → Activity inbox from any website, with keyboard activation,
  guarded repeated clicks, opening feedback and an error/retry state.
- Empty inbox → Check now, or Connect Garmin before setup. Retained drafts stay
  accessible during checking and reconnect states.
- Four-hour default, Manual only, Custom interval, and manual Check now.
- A slow check followed by success or an actionable offline error, with Retry
  represented by the same Check now action.
- Explicit historical import and a draft older than 30 days.
- Strong/Probable selection, zero-selection guard, refresh and dismissal Undo.
- Credential export off/on; enabling it includes the Garmin personal key in the
  described file contents. The prototype never creates an actual file.

Sign-in, history discovery, form preparation and export show example outcomes
only. Both Review activity links open the same illustrative October review
screen. The prototype
simulates auth expiry and recovery but does not verify Garmin's actual error
responses, credential validation, API quotas, storage migration, cross-device
import, Save reconciliation or the complete permission/account flow.
The popup navigates in the same page to simulate opening the inbox; it does not
reuse/create a real extension tab, close a native popup or capture an activity.
Its context selector stands in for a read-only lookup of the current tab/job.
The activity capture button only toggles the illustrative capture state.
The mock's body width cap accommodates a constrained ordinary webpage at zoom;
do not copy it over the production popup's intrinsic-width sizing contract.

## Regenerate and verify

From the repository root, with the installed Playwright browsers available:

```sh
node docs/plans/mocks/garmin-api/render.mjs --preflight
node docs/plans/mocks/garmin-api/render.mjs
node docs/plans/mocks/garmin-api/render.mjs --popup-only
node docs/plans/mocks/garmin-api/render.mjs --auth-only
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

The focused popup suite covers eleven cases per browser: 390 × 600 and 320 × 600
in both themes, three additional capture contexts, and two empty/setup
destinations plus two reconnect destinations. It exercises nine count/copy
states, Enter/Space activation, duplicate activation guards, retained focus and
anchored header/entry/capture/following
content during opening, failure and retry. An additional 390 × 1000 check at
200% CSS zoom requires the inbox label to fit whole words and keeps the layout
stable through opening/error feedback. That assertion first failed on the
observed fragmented label, then passed after hiding the decorative icon in the
constrained layout. These simulate local
counts and tab-opening acknowledgements; worker lifecycle, account switches,
real tab reuse and native popup constraints remain implementation proof gaps.

The key-recovery suite covers eight cases per browser. It checks the direct
key-page link with intercepted navigation, then expiry → paused imports →
rejected replacement → offline retry → successful reconnect in both themes at
1180px and 390px. Button, heading, panel, following content and scroll remain
within 1px through pending/error/retry; focus and drafts are retained. Separate
cases check unknown rejection, replacement of a working key, and 200% CSS zoom.
The link's signed-out Garmin redirect was checked separately; the mock test
does not make a Garmin request or validate an authenticated key-management page.

Last verified October 23, 2026: hidden Chrome for Testing 156.0.8078.4 and Firefox
157.0, 1180 × 900 and 390 × 1000 workflow viewports; 390 × 600 and 320 × 600 popup
viewports, plus 390 × 1000 at 200% CSS zoom; light and dark. The images are Chromium
captures inspected visually. Rendering is DOM/CSS, with no WebGL or map tiles.
The enlarged settings evidence is split into [top](images/08-enlarged-settings.png)
and [actions](images/09-enlarged-settings-actions.png) viewport captures; CSS-zoom
full-page stitching repeated image tiles and was not used as visual evidence.

The configurable recent-check and full-history range controls remain a plan-only
design; these mocks still show the earlier history control.
