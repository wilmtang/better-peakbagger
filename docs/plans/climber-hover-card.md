# Climber hover card

Status: name-link card implemented with local Favorite/Ignore actions;
inline Buddy mutation deferred pending a verified native form contract.
Date: 2026-10-10.

## Findings that shape the feature

The useful part of a Twitter-style card is quick access to a person without
leaving the page. Reuse that interaction, with Better Peakbagger's warm surfaces
and green accents, rather than adding a social profile, statistics, or a second
relationship system.

Three existing boundaries matter:

- Favorites follows either the Peakbagger Buddy List or custom favorites, never
  their union. The profile star is currently mounted only in custom mode.
  See [favorite source](../../src/favorites/favorite-source.js) and
  [profile controls](../../src/favorites/climber-favorite.js).
- Ignore is a report-visibility preference. New ignored membership conflicts
  with both custom favorites and known buddies, including an inactive favorite
  source. Existing overlaps can be resolved through removals. Pending ignored
  sync can also reserve a climber ID. See
  [membership policy](../../src/background/climber-list-policy.js) and
  [the maintained behavior](../climber-lists.md).
- Buddy changes currently happen through native profile controls. The extension
  observes those changes and verifies the signed-in Buddy List afterward. The
  [profile fixture](../../test/fixtures/pages/climber-other.html) uses a stub
  button, with no real server form fields. The authenticated inspection below
  establishes the current native form markup, but the write adapter and its
  server-effect verification remain unimplemented. The existing
  [MAIN-world capture transport](../../src/peakbagger/peakbagger-page.js) is a
  narrow allowlist, not a general authenticated request API.

The design includes all three actions inside the card. Inline Buddy mutation
must be proven before it is advertised as working. A profile-navigation fallback
must be labeled **Manage buddies on profile**, not **Add climbing buddy**.

## Recommended card

Use a single, approximately 312 px wide card, limited to the available viewport
width minus 24 px. It floats beside the hovered name without moving the table
or covering the trigger. Use the existing warm light/dark palette, 8 px control
corners, a restrained elevation shadow, and 14 px body text. Allow long names and
guidance to wrap. Do not fetch a portrait, biography, location, or ascent counts.

The header contains the climber's displayed name, a **View profile** link, and a
small accessible Close button. The three actions remain in a stable order:

| Action | Default presentation | After confirmed success |
| --- | --- | --- |
| Add climbing buddy | Filled green button; primary action | Remove climbing buddy; quieter button |
| Add favorite climber | Secondary button; custom mode only | Remove favorite climber |
| Ignore climber | Quiet separated row; “Hide their reports” | Unignore climber; “Show their reports again” |

The compact alternative places the two positive actions next to each other,
with Ignore below. Prefer the stacked design: labels and conflict guidance
remain readable at narrow widths and after localization or browser zoom.

Existing status is conveyed through action labels and a small check icon, not
another badge strip. Show one short status/error area only when needed.
Do not color Ignore red by default: it is a reversible viewing preference.

## Where it appears

Enhance visible person-name links to HTTPS Peakbagger climber profiles in the
top-level page: `/climber/climber.aspx?cid=<positive integer>`, case-insensitive
for the pathname and restricted to the shared Peakbagger host allowlist.
Resolve relative links against the page URL and rebuild the profile destination
through the existing URL helper. Reject credentials, duplicate/ambiguous `cid`
parameters, missing names, and invalid IDs.

This covers names in peak ascent tables, report authors, ascent detail pages,
Buddy reports, and climber lists. Use delegated listeners so filtering, sorting,
and subsequently inserted rows work without scanning and fetching every profile.
Do not infer identity from the label alone, decorate generic navigation such as
**My Home Page**, or attach to editor fields, hidden links, extension-owned
controls, or embedded map frames. For the signed-in user's own name, show only
the profile link; omit relationship actions.

The original name remains a normal link. Primary click, Enter, middle click,
modifier click, context menu, copy-link, and browser-native long press retain
their existing behavior. Clicking a name never means adding or ignoring it.

## Opening, moving, and closing

- Open after 1 second of pointer dwell on a name. Crossing a dense table should
  not flash a succession of cards. Hover itself performs no server request or
  mutation; render the name and validated saved membership immediately.
- Keep the card open while the pointer is on either the trigger or card, or
  keyboard focus is within that interaction. Use a small pointer corridor and
  a 200 ms close grace period so the gap is traversable, including diagonally.
  Close timers must never override focus inside the card.
- Keep only one card open. Hovering another climber replaces an idle card after
  the same dwell. An explicit action pins the card to its climber while the
  transaction is pending; dismissal is still allowed.
- Place below the trigger when possible, flip above near the bottom, and clamp
  horizontally. Reposition on scroll/resize; close if the trigger is removed
  or becomes hidden. Use a top-layer nonmodal surface or a tested portal so
  table overflow and transformed ancestors cannot clip it.
- Escape, Close, or an outside activation dismisses the card. Escape suppresses
  immediate reopening for the same hover/focus session. Pointer departure closes
  only after neither the trigger nor card holds pointer or focus.
- Use a brief 100–120 ms opacity transition; remove it for reduced motion.
  Do not animate table geometry.

## Keyboard and touch

This is an interactive nonmodal popover, not an ARIA tooltip. Tooltips do not
contain focusable controls; the
[WAI tooltip guidance](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)
points interactive hover content toward a nonmodal dialog. The card must remain
dismissible, hoverable, and persistent as described in
[WCAG's hover/focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html).

Focusing a name may show the card without moving focus. Place a native
**Climber actions for [name]** button immediately after the link in keyboard
order; reveal it on focus-within and hover, and keep it visible on coarse
pointers. It must not shift the text or obscure neighboring names. On touch,
tapping the name still navigates; tapping this separate button opens the card.
Avoid first-tap interception and long-press gestures.

Explicitly activating the actions button opens the card and focuses its first
available action. Give that button `aria-haspopup="dialog"`, `aria-expanded`,
and `aria-controls`. Label the nonmodal dialog with the climber's name; do not
set `aria-modal="true"` or trap focus. Tab traverses its native controls and
returns to ordinary page order on leaving. Escape returns focus to the actions
button when focus was inside the card, with reopening suppressed. A hover-only
dismissal never moves focus. Announce confirmed changes and actionable errors
through a polite live region, never every hover.

Provide approximately 44 px touch targets, clear focus rings, and adequate
light/dark contrast. At 320 px and 200% zoom, labels and guidance must fit
without horizontal overflow. An Ignore operation can hide its originating
report row; finish the announcement in a page-level live region and restore
focus to a nearby surviving report control rather than a detached node.

## Membership and failure states

| State | Buddy | Custom favorite | Ignore |
| --- | --- | --- | --- |
| Neither protected nor ignored | Add, after authenticated eligibility check | Add | Available after membership check |
| Custom favorite | Add allowed | Remove | Disabled: “Remove from favorites to ignore” |
| Known buddy | Remove | Add/Remove according to custom membership | Disabled: “Remove from your Buddy List to ignore” |
| Both buddy and custom favorite | Remove | Remove | Disabled: “Remove from both lists to ignore” |
| Ignored | Addition disabled | Addition disabled | Unignore; “Unignore to add to your lists” |
| Existing overlap | Removals remain available | Removals remain available | Unignore remains available |
| Pending ignored sync | Addition disabled for reserved ID | Addition disabled for reserved ID | Show current state and review-sync guidance |
| Unknown/failed membership | Check status; do not assume absent | Disable unsafe additions | Disable unsafe additions; Retry |

In **Buddy List source mode**, replace the custom-favorite button with the quiet
line **Favorites follow your Buddy List** and a **Use custom favorites…** link
to the existing setting. It must not silently change the source or pretend that
a custom favorite will affect the current filter. A confirmed Buddy addition
already makes the climber an effective favorite in that mode.

Custom favorites and Ignore keep their existing device-local/account-change
semantics. Buddy status uses only a cache whose owner matches the signed-in
account. A matching stale cache can indicate saved membership, but must be
identified as saved status; absence in it does not prove current server absence.
A mismatching cache must not be presented as the current user's relationships.
Do not weaken existing conservative worker checks for known protection.

Keep unrelated actions disabled during a same-climber save. Show **Adding…**,
**Removing…**, or **Saving…** immediately. Update membership labels only after
confirmed persistence. Failure preserves the last confirmed state and offers a
specific recovery action. Local list limits remain 1,500 entries. Removals remain
possible at the limit.

If signed out, the Buddy row says **Sign in to add a climbing buddy** and offers
a normal sign-in link. Custom favorites and Ignore can still work when their
local membership requirements are met. If the native form is unsupported,
show **Manage buddies on profile**. If a server write times out after dispatch,
show **Buddy change not confirmed · Check status**; re-read before offering a
new write. Never automatically replay an ambiguous server mutation.

## Implementation boundaries

The local card is implemented in `src/favorites/climber-card-state.js` and
`src/favorites/climber-hover-card.js`, with its own bundled stylesheet. The
following boundaries guide the delivered card and the remaining Buddy adapter;
items 3–5 remain deferred.

1. Add a small isolated-world `climber-hover-card` content surface for top-level
   Peakbagger pages. Register its bundle/CSS in the manifest and build config;
   retain the existing stylesheet-before-theme ordering. Reuse identity parsing,
   settings validation, and membership subscriptions rather than adding another
   storage schema or a page-world extension API.
2. Share a membership presenter/action client with the profile controls only
   where required to keep rules identical. Keep the saved-list observer
   read-only. Send Favorites and Ignore operations to their existing worker
   mutation APIs; never write full list snapshots from the card.
3. Add a narrowly scoped Buddy adapter only after inspecting the actual signed-in
   profile form. On an explicit trusted click, obtain a fresh profile, verify
   current owner, target CID, exact supported native control, form action and
   same-origin destination, then submit only that supported Buddy operation
   with its fresh required fields. Never reuse the hovered page's ascent form,
   guess a write endpoint, execute downloaded scripts, or expose a general
   page-message POST facility. The existing capture transport stays allowlisted.
4. Coordinate extension Buddy intents with the shared climber-list lane. Reserve
   the target before leaving that lane for network work, recheck ignored and
   pending-sync membership, and make Ignore reject while a Buddy write is
   unresolved. Persist only minimal bounded intent/identity/status in session
   state if worker restart recovery requires it, never cookies or native form
   tokens. Release confirmed reservations atomically with cache reconciliation;
   ambiguous outcomes remain protected until status is checked. An expiry alone
   must not turn an unknown server write into safe absence. Native profile
   pending actions must participate in the same coordination, rather than only
   using a DOM flag in one tab. This coordinates extension actions; it cannot
   make Peakbagger writes from another browser/device globally atomic.
5. Verify resulting Buddy membership through an owner-matching server response.
   Preserve current automatic custom-favorite addition after a confirmed Buddy
   add and the configured removal behavior. If Buddy succeeds but the local
   favorite update fails, report that partial outcome and retry only the local
   update. Do not roll back or replay the server action implicitly.
6. Bind callbacks to owner, target CID, card generation, and operation identity.
   Closing/switching a card cancels only disposable reads and presentation work.
   A dispatched write continues reconciliation for its original identity and
   cannot repaint another person's card. Clean up listeners/timers on pagehide
   and refresh state safely on BFCache restoration.

Opening a card does not crawl profiles or persist browsing history. Before a
state-changing action that requires current Buddy absence, fetch/revalidate only
the relevant authenticated membership, using bounded, rate-limited reads.
Cross-tab/account changes invalidate pending eligibility. No analytics, avatar
requests, new provider host permissions, or changes to manual ascent Save.

## Delivery and verification

Implement each completed independent unit as a focused commit: first the pure
membership/state presenter, then the card with existing local actions, then the
verified Buddy adapter and cross-tab intent coordination. If shipping the card
before inline Buddy is proven, use the honestly labeled profile fallback.

Acceptance coverage must include:

- Real bundled link eligibility, delayed opening/cancellation, traversable hover
  gap, Escape suppression, ordinary name navigation, keyboard order, and touch
  actions without intercepting the name link.
- Every table state above in both source modes; corrupt/missing storage,
  pending sync, stale/wrong-owner cache, self links, 1,500-entry limits, and
  removals from overlaps.
- Repeated clicks; two tabs editing the same climber; native-profile Buddy versus
  Ignore races; switching cards/accounts during reads and writes; ambiguous
  server outcomes; worker restart; and Buddy-success/local-favorite-failure.
- A masked fixture containing the verified native Buddy form contract, including
  login redirects, unsupported controls, changed CID/owner, rejected form
  destinations, and confirmation checks. The present stub is insufficient.
- Real unpacked `dist/` in hidden Chrome for Testing and Firefox over HTTPS
  Peakbagger fixtures; light/dark at desktop and 320/480 px, long names,
  conflicting-state wrapping, viewport edges, scroll/zoom, and report-row removal.
  Visually inspect screenshots; DOM assertions alone do not prove polish.
- Minimal authenticated manual Buddy validation before release, initiated by an
  explicit user action. Keep that server-effect proof separate from fixture
  proof. Native screen-reader speech, touch-device behavior, and browser focus
  behavior require their own evidence.

Design-stage verification: source and policy inspected. The interactive preview passed
simulated add/remove, conflict guards, source-mode/sign-in, Close, Escape, and
focus checks in hidden Chrome for Testing 153.0.8010.12. Both layouts were rendered
in light/dark at 736, 360, and 320 px content widths; screenshots were inspected
at desktop and 320 px. This is ordinary HTML/CSS rendering, with no WebGL or
extension loaded. At that stage no native Buddy write contract, deployed hover-card behavior,
screen-reader speech, or visible browser focus/window behavior is established.
The documentation target checks passed (3 tests).

## Authenticated Buddy inspection — 2026-10-10

Read-only inspection used the user's signed-in Chrome 155 session in background
tabs at a 2048 × 950 px content viewport. A non-buddy profile and an existing
buddy profile exposed the following contract; no Buddy action, contact message,
or ascent Save was submitted. No cookies or hidden field values were recorded.

| Field | Not a buddy | Existing buddy |
| --- | --- | --- |
| `#BuddyLabel` text | `Add this Climber as a Buddy` | `This Climber is one of your buddies.` |
| Submit control ID and name | `AddBuddy` | `RemoveBuddy` |
| Submit control value | `Add to your Buddy List` | `Remove from your Buddy List` |
| Control type | `submit` | `submit` |

Both controls belong to `form#Form1`, with method `post`, encoding
`application/x-www-form-urlencoded`, and action `./climber.aspx?cid=TARGET`.
Its hidden field names are `__EVENTTARGET`, `__EVENTARGUMENT`, `__VIEWSTATE`,
`__VIEWSTATEGENERATOR`, `__SCROLLPOSITIONX`, `__SCROLLPOSITIONY`, and
`__EVENTVALIDATION`. Required state must come from the freshly fetched target
profile, remain in memory, and never be logged or persisted. Submit only the
chosen Buddy control; an existing buddy's form also contains unrelated
`ContactTextBox` and `ContactButton` controls.

The Buddy control sits inside `UpdatePanel1` and is registered with
`Sys.WebForms.PageRequestManager` as an asynchronous postback control. Native
clicks are therefore configured for partial-page updates, consistent with
[Microsoft's PageRequestManager documentation](https://learn.microsoft.com/en-us/previous-versions/aspnet/bb386571(v=vs.100)).
An ordinary full-page form POST is a candidate adapter transport, not a proven
Peakbagger write path: no POST or resulting response was inspected. Do not
execute downloaded scripts or assume every native response is HTML.

The confirmation rule for implementation is a fresh, uncached profile GET
after the attempted write, requiring all of the following:

1. The resolved response is the expected Peakbagger climber profile for the
   original target CID. Its account links identify the same signed-in owner
   as before the operation. The live site retains a `Log In` link even while
   signed in, so that link alone cannot establish signed-out state.
2. A confirmed add has the exact existing-buddy label and supported
   `RemoveBuddy` submit control, with no `AddBuddy` control. A confirmed removal
   has the exact non-buddy label and supported `AddBuddy` control, with no
   `RemoveBuddy` control. Missing or contradictory markup is unknown, not
   successful absence. An explicit add/remove intent must never become a toggle
   when fresh state differs from the card's cached state.
3. Only confirmed state can reconcile the cache and existing custom-favorite
   sync behavior. An ambiguous POST must be followed by a status read rather
   than an automatic repeat of the write. Keep the pending reservation until
   reconciliation succeeds; the current native observer clears its marker
   before its verification request finishes and needs coordination under
   implementation items 4–5.

The authenticated Buddy report contained 89 distinct climber rows, with no
pager. Its other-climber IDs matched all 88 actual options in the ascent
editor's `#BuddyList`; the report additionally included the owner, while the
editor had a placeholder instead. This supports completeness for this observed
account, not all possible empty, hidden, or no-ascent Buddy lists. The help page's
stated 50-buddy limit disagrees with this live state and must not become a local
validation bound. Prefer the target's affirmative profile state for confirmation
and use the report to refresh the cache.

The Add/Remove markup and current-account report coverage are established.
Actual mutation success, rejection, timeout recovery, final-buddy removal,
cross-tab races, and the inline adapter remain unproven. This inspection does
not establish visible focus/window behavior, physical touch, or screen-reader
speech. The existing synthetic form fixture still needs to be replaced with a
masked fixture covering the observed contract before implementing the adapter.

## Delivery ledger

### Fixed and verified

- The pure presenter validates profile identity, source mode, self links,
  existing overlaps, pending sync, missing membership, wrong-owner cache and
  list ceilings. It follows the worker's conservative conflict protection.
- The isolated card preserves original anchors, uses delayed pointer/focus
  opening and an explicit actions button, and saves Favorite/Ignore operations
  through the existing worker APIs. Changes become visible after confirmation.
  Ignore additions verify current Buddy absence; failed reads and account
  changes cannot authorize a write. Hover performs no network request.
- Bundled regressions cover cancellation, Escape suppression, source changes,
  synthetic-click rejection, dismissed saves, moved/changed name links, hidden
  rows, settings failure, Buddy verification failure and BFCache restoration.
  `npm test` passed all 2,406 tests.
- `npm run verify:browsers` passed with the real unpacked extension in hidden
  Chrome for Testing 153.0.8010.12 and Firefox 157.0.1 over HTTPS Peakbagger
  fixtures. Native pointer travel, Tab/Enter opening, confirmed list actions,
  Escape focus recovery, self links and top-layer containment passed. Card
  captures use native HTML/CSS, with no WebGL on this surface, at 1000, 480, 360
  and 320 × 760 px content viewports in both themes. Default, favorite, ignored
  and long-name states were captured; representative desktop and narrow
  screenshots were visually inspected after animation and placement settled.
- Visual inspection found the site's blanket dark-button repaint and early
  animation captures. Card-owned controls now opt out of that repaint. The
  shared verifier waits for opaque, finished animation and placement clear of
  the name; Firefox uses an exact BiDi content viewport and measures inline
  links by their rendered rectangle. Both final browser teardowns passed.
  A separate process/path check found no remaining disposable test browsers or
  profiles; the user's existing browsers were not touched.
- `npm run lint` passed with six existing owned dependency/manifest warnings;
  the final verifier edit passed ESLint. Documentation target checks passed
  (3 tests), and `git diff --check` passed.

### Intentionally not changed

- Buddy management uses **Manage buddies on profile**. The accepted design allows
  this fallback until the native write adapter and intent coordination are
  implemented and verified. Authenticated inspection established the current
  form markup and confirmation signals above, but did not submit a Buddy change.
- Existing profile Buddy behavior and local mutation-lane policy remain the
  authority. No cross-tab Buddy intent protocol, new schema, preference, host
  permission, or page-world messaging capability was added. Changes on other
  devices remain outside any local transaction.

### Changed but not fully proven

- Authenticated inspection establishes current Buddy form markup, but actual
  server writes and error behavior remain unproven. Fixture evidence cannot
  establish physical touch input, screen-reader speech, visible browser focus
  or window placement, or all live Peakbagger markup variants. Those remain
  release proof gaps. The fixed-position fallback is exercised in jsdom;
  current Chrome and Firefox use the native popover top layer.
