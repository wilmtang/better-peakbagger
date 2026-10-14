# Bug audit remediation — 2026-10-14

Status: **three findings fixed and verified locally**. The read-only audit
reviewed `08b7467f`; implementation was explicitly requested afterward.

## Fixed and verified

| Finding | Correction | Focused commit |
| --- | --- | --- |
| F1: a delayed Buddy report overwrites a confirmed membership change and can permit Ignore | Every report publisher uses the worker list lane and a persistent version comparison. Confirmations invalidate older reads across worker restarts. Rendered reports also check navigation time; repeated helper reads retain one timestamp and identical acknowledgements do not write again. | `24c6c353` |
| F2: capture save verification accepts matching GPX downloaded from another ascent | Display, edit-form, and GPX final response URLs require the requested origin, expected path, and a unique matching ascent ID. Same-ascent legacy GPX redirects remain supported. | `d495f043` |
| F3: ordinary favorites edits overwrite unsupported or malformed saved lists | All favorites mutations strictly validate the current stored list before applying changes. Only an absent key represents an empty list. | `0ba7351e` |

Regression coverage includes delayed report publication after Buddy add/remove,
Ignore protection, restart recovery, concurrent refreshes, stale rendered
reports, helper acknowledgement, the real worker sender gate, and the options
refresh race. Storage-write failures retain the established session-only fetched
list behavior. A helper integration regression checks that a later read cannot
make the rendered report newer.

Save tests reject missing final URLs, wrong ascent IDs, duplicate IDs, unrelated
origins/paths, and credential-bearing URLs. A regression uses the production
request helper with a matching GPX redirected to another ascent. Favorites tests
preserve unsupported schemas, malformed entries, duplicates, and over-capacity
saved values across add, remove, merge, and replacement operations.

Final verification on the completed runtime:

- `npm test`: **2,773 passed**, zero failed, skipped, or cancelled.
- `npm run lint`: passed, including build and packaged web-ext lint, with the
  existing six owned warnings; no warning policy was expanded.
- Hidden real unpacked extension verification: Chrome for Testing
  **153.0.8010.12** and Firefox **157.0.1**, primary viewport **1000×760**.
  Both passed, including first-party Buddy helper, favorites merge/mirror, and
  shared climber integration. Chrome restored BFCache; Firefox used its
  fresh-page fallback. No WebGL renderer evidence was collected for these
  persistence and identity changes.
- `git diff --check`: passed. Final process-command and disposable-directory
  inspection found no verifier browser or temporary profile remaining.

## Intentionally not changed

- Buddy confirmation remains scoped to the target; it does not refresh the age
  or completeness of the full Buddy List. Status checks do not repeat a POST.
- Capture privacy, account and draft ownership, optional permissions, list
  limits, and manual final Peakbagger Save remain enforced.
- No live account mutation, upload, GitHub write, push, merge, tag, release, or
  store submission was performed.

## Changed but not fully proven

The three reproduced failures are closed locally. Controlled fixtures and
injected response/storage failures do not establish current live Peakbagger
redirect, Buddy POST, or server export behavior. Hidden browser runs establish
manifest, worker, and integration behavior; they do not establish native window
focus/placement, browser chrome, permission prompts, screen-reader speech,
physical touch, or minimum-supported-browser behavior. No visual redesign was
part of this remediation, and no universal layout-stability claim is made.
