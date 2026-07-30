# `verify:extension` flakes under machine load

`npm run verify:extension` is the only check that loads the real unpacked
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

## Method notes

Two of the measurements taken during this investigation were themselves invalid,
and both failure modes are easy to repeat:

- **Bare `node --test` proves nothing about your edit.** `npm test` runs
  `npm run build` as `pretest`, and the suite evaluates built `dist/` bundles.
  Running `node --test` directly evaluates whatever was built last. A mutation
  test run this way "passed" with the behavior under test deleted.
- **Never run anything beside the verifier.** Running `npm test` or a build
  alongside it manufactures exactly the load being investigated. One failing run
  attributed to the product was entirely self-inflicted.

Two rules follow for anyone picking this up:

1. **Measure the duration before touching a timeout.** A budget is only
   implicated if the operation's measured time approaches it. Instrument, run
   under the load you care about, and look at the number.
2. **Attribute each failure to a named check before comparing pass rates.** A
   rate difference built from runs that failed *different* checks says nothing.
   The verifier prints its failures under a `verification FAILED` header;
   everything after a passing run's summary is a success checklist with the same
   bullet shape, which is easy to grep by mistake.

## Still open

The load-sensitivity itself is unfixed. All three checks wait on a
user-visible postcondition, which is correct per `AGENTS.md`, so the likely work
is in how long they are willing to wait and whether the probes themselves get
starved — not in the product budgets they surround. Raising probe ceilings would
mask the symptom and hide real regressions, so the Buddy probe was deliberately
left at 20s (≈4x the measured 5.2s) rather than raised.
