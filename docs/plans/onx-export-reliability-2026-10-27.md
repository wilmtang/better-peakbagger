# onX export reliability

The onX handoff previously waited for a completed tab with a readable URL, then
awaited script injection without an outer deadline. Cold authentication can
redirect to the ungranted identity host, hiding the URL; unresolved injection
could leave every destination unavailable indefinitely. Signed-in live startup
has not been reproduced, so authentication is a supported failure path rather
than a proven explanation of every reported hang.

The implementation follows the design reviewed with Astra at extra-high
reasoning: one ten-second automatic attempt after optional permission approval,
GPX-free immediate readiness probes, document-bound delivery once per attempt,
explicit manual-auth continuation, and durable uncertainty without replay.

## Fixed and verified

- Saved-GPX reading forwards cancellation and the remaining deadline into the
  existing bounded Peakbagger request helper. Seven focused source tests passed;
  the forwarding assertion failed against the unfixed reader.
- Controlled adapter regression proof against read-only commit `8247aa0b`
  supplied a file after an expired cutoff. The new assertion rejects that
  queued delivery without supplying a file.
- Focused route/adapter/UI coverage exercises unreadable login URLs, silent
  redirects, provisional blank tabs, navigation races, document/input changes,
  concurrency, lost replies, stale success, worker reconstruction, source
  suspension, explicit recovery and GPX exclusion from session metadata.
- Hidden real-extension Chrome 156.0.8078.4 and Firefox 158.0.1 each passed
  13 onX cases using HTTPS Backcountry/identity fixtures with identity access
  ungranted. Checks cover silent/manual authentication, delayed startup, preview
  timeout, manual Import, exact receipt, keyboard duplicate suppression, stable
  controls/panel/following content/scroll at 1280 and 390 × 900, light/dark and
  100%/150% zoom. HTML/2D rendering was used; no WebGL was needed.
- Screenshot inspection caught an overly narrow single-provider feedback column
  despite stable geometry. The final minimum-width reservation remains readable
  without stretching the action; an independent readability assertion now pins it.
- The eight shared handoff layout cases passed in hidden Chrome 156 and
  Playwright Firefox 157. The broader map-handoff check and real-extension
  Chrome startup/BFCache verifier passed. Scoped ESLint and diff checks passed.
- Focused route/adapter/CLI tests passed 64 cases; project/manifest/inventory
  tests passed 85 cases. Disposable profiles, certificates, proxies and browser
  processes were removed; screenshot evidence was intentionally retained under
  `/private/tmp/bpb-onx-evidence`.

## Intentionally not changed

- Optional access remains scoped to Backcountry. No identity-service access,
  password handling, login automation or broad tabs permission is added.
- GPX bytes remain in memory. Final onX Import belongs to the user.
- Other map providers retain their existing worker navigation policy.
- Manual sign-in ends the automatic attempt; Continue is a new trusted action
  and rereads the source GPX. There is no long-lived authentication task.
- The initial ten-second cutoff is a product limit, not a measured guarantee
  about the live service. Browser suspension can delay painting; a supplied
  file cannot be recalled from onX.

## Changed but not fully proven

- The preceding full `npm test` run passed all 3,703 tests. The final run
  passed 3,703 of 3,704 and failed the existing climber-card test “own profile
  links stay undecorated in headings, lists, report rows, and late content”
  (`test/favorites/climber-hover-card.test.mjs`, line 147), waiting for a changed
  self-profile link to close its card. An isolated run reproduced the timeout
  (18/19 passed). None of this task's changed files are among that bundle's
  31 inputs; the failure is left unchanged rather than bundled into this fix.
  The full suite is therefore not reported as clean.
- Signed-in live cold startup, actual OAuth account return behavior and native
  browser permission prompts remain separate manual release checks. Masked
  fixtures cannot prove those account-specific behaviors.

## Implementation boundaries

`onx-routes.js` journals only identity, phase, cutoff and outcome in session
storage. It records possible dispatch before delivery, never redrives work after
worker restart, and never downgrades terminal uncertainty after a late response.
Missing or evicted metadata cannot authorize continuation. A known unused tab
is reusable only after validating ownership and its exact importer route; an
unobservable login tab is focus-only, and an unrelated map is preserved.

The source UI independently releases the busy state if messaging stalls. The
worker reserves 100 ms of the same budget for its terminal reply. Open/Check
only focuses a recorded target after a trusted action. Source pagehide cancels
future page work; visibilitychange does not. Delayed tab creation may update
inspection metadata but cannot revive an expired transfer.

The isolated preflight carries no GPX, runs with immediate injection, and
establishes document identity without resetting the delivery latch. Delivery
has no pre-supply await; it rechecks cutoff, document nonce, attempt, route,
unique connected empty input, existing preview, and membership before assigning
the file and dispatching change synchronously. A delivery API error is never
retried with weaker targeting.
