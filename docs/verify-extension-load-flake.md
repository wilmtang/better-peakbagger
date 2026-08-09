# `verify:chrome` flakes under machine load

`npm run verify:chrome` is the Chrome check that loads the real unpacked
`dist/` in a browser, and it fails intermittently — but only when the machine is
busy, and not always on the same check. This note records what was measured on
2026-07-30, because a previous attempt to fix it changed a timeout that
measurement later showed was never firing.

## What flakes

Three distinct checks have been observed failing, all of them load-sensitive and
none of them related to each other:

| Failing check | Shape of the failure |
| --- | --- |
| `the first-party Buddy import fallback failed or leaked its tab` | `fallbackImport` is `false` while the page state is already correct |
| `the Chrome full-profile backup surface did not mount for its verified owner` | `{"copy":"","primary":""}` — the surface had not rendered yet |
| `waiting for locator('#bpb-terrain-consent') to be detached` | Playwright locator timeout |

The middle row turned out not to be a timing race at all — see
[What that means](#what-that-means).

Idle, the whole run passes reliably and takes about 21s. Under ten busy-loop
processes the pass rate drops to roughly half, with the failing check varying
between runs.

## What is *not* the cause

The Buddy import fallback opens a helper tab and waits for a real round trip: a
blank tab, an extension-helper navigation, Peakbagger's own Buddy List over the
network, then the content script that writes the cache. `SITE_TAB_REFRESH_MS`
in [`options/favorites.js`](../options/favorites.js) budgets 8s for all of it,
and that budget was the natural suspect.

It is not the cause. With the verifier instrumented to time the fallback from
click to landed import:

```
baseline  5228ms  5217ms  5234ms  5379ms  5138ms   landed=true ×5
patched   5152ms  5207ms  5201ms  5327ms  5166ms   landed=true ×5
```

The round trip takes **~5.2s against an 8s budget**, and `landed=true` in 10/10
runs *including under the same synthetic load that makes the check fail*. The
import always succeeds. What expires is the **verifier's own probe window**, not
the product's budget — confirmed directly by one failing run whose payload
showed `fallbackImport: false` alongside an `importStatus` of "Merge complete: 6
added, 0 removed" and all six favorites present. The state was right; the probe
had already given up.

A controlled A/B — only `options/favorites.js` swapped between the flat budget
and a progress-extended one, same load, same run count — produced baseline 2/3
and 3/5 against patched 1/3 and 1/5. No evidence the change helped, a hint it
hurt, nothing conclusive either way.

`62526de` claimed "5/5 green against a measured 2/5 baseline". That did not
reproduce. Its budget machinery was reverted; the half of it that was
independently correct was kept — see below.

## What was kept from the reverted fix

Two things in that commit were real and had nothing to do with timing:

- A fallback that merely **ran out of time** no longer re-throws the *signed-out*
  error that opened it. That told a signed-in user to sign in — wrong, and
  nothing they could act on. `loadBuddiesInSiteTab` now returns
  `{ cache, timedOut }` so a fallback that never ran (no `tabs` API) still
  leaves the original diagnosis standing, since it learned nothing, while one
  that timed out reports the timeout.
- The verifier no longer crashes on an absent favorites list. `check()`
  accumulates failures and reports them at the end, so an unguarded
  `current.entries` after a failed check threw away the entire collected report
  and replaced it with a stack trace pointing at the wrong line.

## Where the time actually goes

The terrain check was then instrumented end to end — an in-page click stamp, a
`MutationObserver` on the dialog, and timestamps inside the consent handler
itself — and run under 24 busy-loop processes on a 12-core machine.

**The probe is not starved.** Playwright saw the dialog detach within ~300ms of
the node actually leaving the DOM:

```
run1   click dispatched   16ms   node removed 27784ms   Playwright detach 27939ms
run2   click dispatched   21ms   node removed 45732ms   Playwright detach 46037ms
```

The product really does take 25–46s, and the delay is a single `await`:
`settings.set({ enable3dMap: true })` in the consent handler, which is a worker
round trip rather than a storage write. Timestamps from inside that handler, all
relative to the click:

```
              hop chain   bare ping returned   settings.set returned
run1              906ms               5465ms                 11092ms
run2              918ms              16200ms                 46310ms
```

- **hop chain** is 200 chained `setTimeout(0)` callbacks in the content script,
  run immediately before any messaging. Chrome clamps nested timeouts to ~4ms,
  so ~800ms is the floor. The site tab's renderer is turning over its task queue
  at roughly its nominal rate — it is not starved.
- **bare ping** is a trivial `CAPTURE_STATUS` round trip added only for this
  measurement. It has essentially no handler work and still took 5.5s and 16.2s.
- **settings.set** then added a further 5.6s and 30.1s, against a worker that
  the ping had just proven was awake.

Measured moments earlier under the same load, but from an *extension* page:
worker round trips 0–3ms (five samples per run), `chrome.storage.sync.set`
0–1ms, `chrome.storage.local.set` 0–1ms.

So both endpoints run their own JavaScript promptly, storage is fast, and the
worker answers an extension page instantly — yet `chrome.runtime.sendMessage`
from an isolated-world content script in a site tab takes seconds to tens of
seconds to come back. The cost is in cross-process delivery to and from the site
tab's renderer, not in either endpoint's own code.

## What that means

**One of the three checks was never about load.** The full-profile backup probe
waited for its container to reach `state: 'visible'` and then read that
container's text. The panel mounts before it is filled, so under load the probe
sampled a half-built surface — which is exactly the `{"copy":"","primary":""}`
payload, reported for a surface that was about to be correct. That is a wrong
postcondition, not a starved wait. It is now a `waitForFunction` on the asserted
content, matching every sibling check in the file.

**The consent dialog blocks its own dismissal on a cross-process round trip.**
That is a product-side defect a real user can hit on a loaded machine: after
clicking *Enable and open 3D* the dialog sits at "Enabling…" for as long as the
round trip takes. Dismissing optimistically would remove the stall, but the
dialog is also where the failure path lives — `Try again` and the error line
both depend on still being mounted when the write comes back. That trade-off is
a product decision, so the handler is unchanged for now.

## Method notes

Two of the measurements taken during this investigation were themselves invalid,
and both failure modes are easy to repeat:

- **Bare `node --test` proves nothing about your edit.** `npm test` runs
  `npm run build` first, and the suite evaluates built `dist/` bundles.
  Running `node --test` directly evaluates whatever was built last. A mutation
  test run this way "passed" with the behavior under test deleted.
- **Never run anything beside the verifier.** Running `npm test` or a build
  alongside it manufactures exactly the load being investigated. One failing run
  attributed to the product was entirely self-inflicted.

Two rules follow for anyone picking this up:

1. **Measure the duration before touching a timeout.** A budget is only
   implicated if the operation's measured time approaches it. Instrument, run
   under the load you care about, and look at the number.
2. **A responsive endpoint says nothing about the channel between endpoints.**
   The site tab's renderer was running timers at nominal rate, the worker was
   answering extension pages in under 3ms, and the round trip between them still
   took 16s. Time the hop, not just the two ends of it.
3. **Attribute each failure to a named check before comparing pass rates.** A
   rate difference built from runs that failed *different* checks says nothing.
   The verifier prints its failures under a `verification FAILED` header;
   everything after a passing run's summary is a success checklist with the same
   bullet shape, which is easy to grep by mistake.

## Still open

The terrain and Buddy probes remain load-sensitive, and both are ultimately
waiting on the same cost: a content-script→worker round trip that is
sub-millisecond on an idle machine and seconds long on an oversubscribed one.
Raising their ceilings to cover a 46s worst case would hide real regressions, so
the budgets are unchanged — the Buddy probe stays at 20s (≈4x its measured 5.2s)
and the terrain detach at 5s. The durable fixes are to stop blocking
user-visible state on that round trip, or to run this verifier on a machine that
is not oversubscribed.
