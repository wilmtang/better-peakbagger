# Capture trust and recovery audit remediation

The external audit of 4.0.2 (`bf01e7c3`) was revalidated against source and
isolated worker/page probes before implementation. The owner authorized fixing
the legitimate findings. Existing photo-library work is outside this change.

## Implementation and acceptance ledger

| ID | Finding and scope | Required evidence | State |
| --- | --- | --- | --- |
| A1–A3 | Capture controls, draft delivery, and privileged UI routes need sender authorization. Restrict packaged surfaces and bind drafts to the actual top-frame Peakbagger URL. | Rejected foreign, embedded, wrong-page and wrong-identity senders; accepted intended callers; real extension startup in Chrome/Firefox. | Implemented; final integration pending |
| A4 | A failed draft preparation leaves stale busy feedback and a lease that blocks reload recovery. Preserve Save blocking until Preview succeeds or the capture is discarded. | Rollback, failure/retry, document replacement, stale acknowledgments, exactly-once Preview and rendered recovery/geometry checks. | Pending |
| A5 | Track-order comparison coerces unavailable distance to zero. | Mixed finite/null distance order agrees with suffix fallback. | Pending |
| A6 | Startup reconciliation accepts a payload missing the timestamp-free variant required for delivery. | Incomplete and legacy payloads fail closed; complete payloads and the explicit timestamp choice remain usable. | Pending |
| A7 | The initial ownership failure bypasses the public result allowlist. Current failure paths expose only an extra internal flag. | Exact public failure shape and no export or account identifiers. | Pending |
| A8 | The owner-reviewed development advisory exception expires October 24 at 00:00 Los Angeles time. | Preserve the exact expiry and fail-closed evaluator; no automatic renewal. | Intentionally unchanged |

Each independent implementation unit is committed after focused checks. Final
integration evidence and remaining proof limits are recorded below before the
ledger is archived.

## Fixed and verified

- A1–A3: three new authorization regressions failed against the original worker
  and passed after the fix. The focused capture/photo-worker run passes 221
  tests; GitHub integration, route-policy, report-draft and manifest tests also
  passed in the initial focused run. ESLint and diff whitespace checks pass.
  Hidden Chrome 153.0.8010.12 loads the real extension at 1000 by 760; final
  browser results are recorded at closure.

## Intentionally not changed

- A8: the exact, development-only `node-forge` exception and its expiry remain
  owner policy. The advisory listed no patched version during the review.
- Prepared/queued captures keep Save blocked until successful Preview or an
  explicit capture discard. Rollback alone does not authorize saving.
- No extension path clicks Save or publishes a release.

## Changed but not fully proven

None yet. Browser verification cannot prove live Garmin/Strava compatibility,
live Peakbagger form/save behavior, native focus/window placement, or actual
screen-reader speech; retain these limits after automated checks.
