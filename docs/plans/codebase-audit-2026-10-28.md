# Code, performance, engineering and UX re-audit — October 28, 2026

Status: **remediation in progress**. The user authorized implementation after
the audit. The findings below record the review of `141ad723`, following the
[October 27 remediation](../archive/codebase-audit-2026-10-27.md), not a claim
that its historical checks failed or that every repository surface was audited.

The highest-value work is protecting credential intent during slow imports,
making Reload reach the provider, and preserving usable map output through
cancellation. The editor also has a reproduced keyboard-focus defect that the
current full verifier cannot reach because of incorrect earlier assertions.

## Findings

| ID | Priority | Finding | Evidence | Proposed independent unit |
| --- | --- | --- | --- | --- |
| R01 | P2 | Import snapshots taken after credential validation overwrite newer user changes | Real routes and credential stores, held validation | Snapshot participating stores before validation |
| R02 | P2 | Public Reload can serve the browser's old HTTP-cache response | Hidden Chrome, real renderer/client, cacheable HTTPS fixture | Revalidate requests owned by explicit refresh |
| R03 | P2 | Cancelled replacement tiles can retire the retained usable layer | Real renderer/client with MapLibre adapter | Separate replacement readiness from request accounting |
| R04 | P2 | Cleanup failure reports a committed private-layer Save/Delete as failed | Real store with a failure after public commit | Preserve authoritative mutation success |
| R05 | P2 | Keyboard help scrolls its focused control out of the editor at enlarged zoom | Real packaged editor, Chrome, actual Tab | Bound scrolling by the visible trigger and help space |
| R06 | P2 | Full editor verification contains false failures and incomplete geometry coverage | Original failures and temporary corrected probes | Repair targets, clipping assertions and actual viewport checks |

### R01 — capture import expectations before slow validation

**Source:** `src/background/settings-file-routes.js` (lines 134–148, 180–210,
220–258). The existing conditional writes are sound only relative to their
expected snapshots. GitHub verification, and optionally Garmin verification,
finish before the settings, ImgBB, GitHub and layer snapshots are captured.
Garmin captures its own credential snapshot earlier, but not the other stores.

**Reproduction:** start a file import containing GitHub and ImgBB credentials;
hold GitHub verification; clear both existing credentials; release verification.
The actual routes return success and commit the file credentials. GitHub moves
from the user's disconnected epoch 1 to an imported connection at epoch 2.
The newer ImgBB removal is also undone. The October 27 ImgBB fix covers changes
after its snapshot; this is a different, earlier interval.

**Fix:** inside the serialized import transaction, read all participating
expected snapshots before either remote verification begins. Verify against
those snapshots, then retain the existing conditional forward writes and
conditional rollback. A changed store must produce conflict, preserving the
newer state. Do not convert a conflict into an unconditional retry or silently
reconnect an account. Retain serialized imports and fail-before-write behavior
when verification fails. This closes the slow-validation interval; it does not
make snapshots or writes across separate stores atomic.

**Acceptance:** hold GitHub and Garmin verification separately; interleave
GitHub Disconnect/Save, ImgBB Remove/Save, settings changes and layer edits.
Assert exact surviving values, conflict status and per-store rollback results.
Cover files with and without each optional credential section, concurrent
imports, verification failure and ambiguous storage writes. Use the real store
implementations with controlled storage, not a CAS mock that always succeeds.

### R02 — explicit public refresh must revalidate the HTTP cache

**Source:** `src/maps/custom-overlay-client.js` (lines 38–48, 75–100) and
`src/maps/custom-overlay-render.js` (lines 263–272). Reload evicts the
JavaScript cache, but the fetch uses the browser's default HTTP-cache behavior.
Clearing the extension cache is insufficient to obtain current provider data.

**Reproduction:** serve GeoJSON with `Cache-Control: public, max-age=3600`;
load it through the actual renderer; change the server document; invoke the
renderer Reload token. The data handed to the map adapter remains the old document and the
provider request count remains **one**. A control fetch with `cache: 'no-cache'`
returns the new document and increments the count to **two**. The hidden Chrome
probe uses real HTTPS and browser caching, without network interception.

**Fix:** carry explicit, source/revision/refresh-generation ownership into
public metadata, GeoJSON and tile requests, and conditionally revalidate those
requests against the provider. Preserve ordinary browser/in-memory caching,
single-flight behavior and bounded concurrency; do not globally disable caching
or add arbitrary cache-busting URL parameters. Bound revalidation to the
refresh-owned requests/URLs rather than all future pan requests. Keep private relay authorization,
allowances and cooldowns unchanged. A stale generation cannot refill or satisfy
the refreshed generation with obsolete bytes.

**Acceptance:** cacheable HTTPS fixtures for TileJSON, GeoJSON and raster/vector
tiles; changed bytes and unchanged data with a valid conditional 304; unrelated source reuse;
ordinary pan/zoom reuse; concurrent old response completion; Off/disposal and
provider failure. Run real Chrome and Firefox without request interception that
disables the HTTP cache. Verify the fresh visible result as well as server counts.

### R03 — retire retained output only for a usable replacement

**Source:** `src/maps/custom-overlay-render.js` (lines 69–72, 84–105, 263–269).
The general outcomes table counts successful metadata as `loaded`. It also
preserves successful outcomes from the previous generation. A tile finalizer
retires the old layer whenever pending and failure counts are zero and anything
is loaded, including after an ignored `AbortError`.

**Reproduction:** change TileJSON geometry parameters so Reload stages another
MapLibre source; start its first tile request; abort that request as viewport
changes can do. The real renderer/client adapter probe returns `AbortError`,
removes the original source and reports **Loaded**, although **zero replacement
tiles succeeded**. A second probe first accepts an original-source tile and
reproduces the same removal. The adapter does not rasterize either source:
this proves incorrect ownership/readiness logic, not pixel disappearance.
Hardware-rendered panning reproduction remains an implementation acceptance check.

**Fix:** track replacement-generation rendering readiness separately from
metadata and historical request outcomes. Only an accepted usable replacement
may release retained output. Cancellation, zero pending requests, old tile
successes or metadata success are not readiness. Integrate with the rendering
owner's completion boundary so retirement cannot precede usable paint; moving
the condition into request success is insufficient because raster drawing and
MapLibre consumption happen afterward. Do not wait indefinitely for every
future pan request. Preserve
bounded ownership, opacity/order, failure retention and Off/disposal cleanup.
Define explicitly how a viewport with no eligible replacement tiles completes;
do not manufacture readiness or retain redundant owners indefinitely.

**Acceptance:** cancel-only, old-success/new-cancel, mixed success/error,
successful replacement, no eligible visible tiles, pan during refresh and
repeated Retry. Cover raster/MVT and Leaflet/MapLibre where applicable. A mere
`loaded > 1` change is insufficient. Use real hidden hardware rendering to
observe old-to-new output and check owner/canvas/source cleanup; retain the
deterministic cancellation regression alongside it.

### R04 — do not report committed writes as failed cleanup

**Source:** `src/background/custom-overlay-store.js` (lines 112–120) and
`src/maps/custom-overlay-editor.js` (lines 237–246). Save/Delete commits the
public registry before pruning old private records. A cleanup exception enters
the generic failure catch. Bulk replacement in the same store already separates
this cleanup boundary from mutation success.

**Reproduction:** successfully save private revision 1; save revision 2 with a
failure injected only in post-commit pruning. The reply is `ok: false` even
though public revision 2 and the new private credential are stored. The editor
keeps expected revision 1, so Retry reports a conflict. Delete similarly reports
failure although the public source count is already zero.

**Fix:** acknowledge the authoritative committed snapshot/revision after the
public write, while recording failed credential cleanup separately. Reconcile
or retry cleanup without replaying Save/Delete; cleanup must be scoped so it
cannot delete a newer revision. Do not swallow pre-commit storage failures or
claim obsolete credentials were erased when cleanup failed. Keep unreachable
records unable to authorize provider requests.

**Acceptance:** failure before private write, during public write, and after
public commit for Save/Delete; correct returned revision and subsequent edit;
eventual cleanup; newer save racing cleanup retry; private records still fail
closed. Assert provider/public mutation counts so recovery cannot repeat a write.

### R05 — enlarged keyboard help must retain visible focus

**Source:** `src/maps/custom-overlay-editor.js` (lines 53–83, 94–99). The focus
handler uses the tooltip's unconstrained natural height to calculate scrolling.
When that height exceeds the available editor field area, it scrolls the
focused trigger above the clip. The scroll handler then hides the help.

**Reproduction:** packaged Options editor in hidden Chrome 156.0.8078.4,
375×800 browser viewport, 200% browser zoom; actual editor iframe 151×358 CSS
pixels. Expand Advanced, focus its summary, then press Tab. The Source type
information button retains keyboard focus at **y = −53.95 to −25.95**; the
scrolling field clip is **y = 125.70 to 220.41** and the help is hidden. A
page screenshot was inspected: the user sees unrelated lower fields, not the
focused control or its explanation. This is a real keyboard transition, not
only a direct DOM focus assertion.

**Fix:** prioritize keeping the trigger inside the visible field clip and
bound any deliberate scroll accordingly. Size/position help using the remaining
usable space; ensure long text remains reachable and readable by keyboard.
Retain Escape behavior, pointer movement into help, stable title/actions and
ordinary Tab order. Choose the smallest accessible help/disclosure adjustment;
do not solve this by clipping text or introducing a global layout redesign.

**Acceptance:** real Tab/Shift+Tab, pointer and Escape for all help controls at
normal/enlarged text and desktop/narrow layouts in both browsers. Check actual
viewport dimensions, trigger hit-testing, scroll position, visible help content
and unchanged footer/action geometry through each transition. First demonstrate
that the new assertion catches the unfixed focus loss. Firefox at the exact
failing geometry remains unproven in this audit.

### R06 — restore meaningful full editor verification

**Sources:** `scripts/custom-overlay-editor-verification.mjs` (lines 6–13,
47–57); `scripts/verify-custom-overlays.mjs` (lines 255–282, 417–423); and
`src/maps/custom-overlay-editor.css` (the intentional negative field margins).

Four related verifier problems undermine the complete editor matrix:

1. The geometry helper selects `.help summary`, which now matches a hidden
   nested private-access disclosure. Comparing its zero rectangle does not
   verify the visible troubleshooting row.
2. Chrome requires form scroll width to equal client width. The field area's
   intentional −4px margins produce **128 versus 124px**, while its actual
   right edge is **141.5px inside a 151px iframe**. This assertion reports a
   false overflow before the existing focus check can detect R05.
3. Firefox moves to a clipped help button without scrolling it into view.
   The button center is below the scrolling field boundary; pointer events hit
   the footer. The resulting hover timeout does not establish a product defect.
4. Firefox requests a 375px outer window, but the measured iframe is **464px**
   wide. The reported requested width is not proof of the intended narrow case.

**Fix:** select visible intended elements, assert that geometry targets are
nonzero, scroll and hit-test hover targets, and measure meaningful clipping and
text/action bounds rather than incidental parent scroll width. Set and assert
the browser content viewport explicitly, using the existing Firefox BiDi path
where necessary. Keep complete verification enabled by default; report actual
dimensions and executed cases and continue rejecting unknown/empty selections.

**Evidence:** temporary copies correcting the first three blockers completed
Firefox's 18 editor cases plus public loading/retry/hardware rendering. Their
actual editor widths were 618 and 464px, so this is not 375px proof. The corrected
Chrome copy reached the real R05 failure. Neither temporary result changes the
repository verifier or makes its current full commands green.

**Acceptance:** prove the geometry checks fail on misplaced/hidden controls and
real clipping, while accepting intentional in-bounds margins; assert actual
requested content widths, valid visible targets and nonzero case counts. Run the
full commands after R05 is fixed, including pending/error/success/retry, long
feedback, keyboard focus and enlarged labels. Preserve loading-only scope as an
explicit subset, never as the full editor acceptance result.

## Fix sequence and review boundaries

Implement R01, R02, R03, R04, R05 and R06 as focused independent commits, each
with its own regression evidence and appropriate checks. R02 and R03 touch the
same renderer but correct different invariants and should remain independently
reviewable. Use temporary corrected probes to verify R05, then land the R06
verifier repair with the complete matrix green. No unrelated refactoring,
dependency upgrade, provider operation or publication is part of this plan.

Final implementation acceptance should include the focused tests, full unit
suite, scale/lint gates, real manifest/worker/bridge browser checks for worker
changes, public/private refresh matrices, complete editor matrices and package
validation. Run each expensive gate once after its related changes settle; do
not substitute previous audit results for new implementation evidence.

## Verification performed during this audit

- `npm test`: **3,723 passed**, zero failures/skips.
- `npm run test:scale`: **14 passed**.
- `npm run lint`: passed with the existing **eight owned web-ext warnings**.
- `npm run audit:ci -- --allow-reviewed-development-advisory`: passed against
  current registry metadata. The first sandboxed request returned no usable
  advisory metadata; the permitted network run succeeded. The full graph still
  has the reviewed deepmerge advisory across three low development packages,
  expiring **October 31 at 00:00 PDT / 07:00 UTC**. This is not a clean raw audit.
- Original full custom-overlay browser checks failed at the R06 blockers.
  Temporary verifier corrections and the R05 Tab probe used the real packaged
  Options iframe. Firefox 158.0.1 completed the corrected full run on Apple M3
  Pro Metal hardware. Chrome 156.0.8078.4 reached R05 and did not complete its
  full matrix. Editor screenshots were inspected.
- R01/R04 probes used real store/routing code with controlled asynchronous
  verification/storage failures. R03 used the real renderer/client with an
  adapter, not GPU paint. R02 used real hidden Chrome HTTP caching with an
  HTTPS Peakbagger fixture and a renderer adapter, not a live provider.

All browser runs were hidden in disposable profiles. Final process-command
inspection found no task-owned browser or helper; disposable profiles and
certificates were removed by the probes' teardown. No existing user browser,
account or live provider was changed. Fixture network/storage failures and
controlled providers remain distinct from native prompts and live services.
The temporary probes required readiness fixes of their own (awaiting the iframe
and avoiding an out-of-view Selenium move); those failed setups are not product
evidence. They did not change repository source.

## Peer review

The requested **Astra high** reviewer independently reproduced R01–R04 and
agreed with their priority and scope. Its challenge improved R02 to preserve
normal caching and R03 to require generation-specific usable output instead of
changing a counter threshold. It rejected unsupported additional claims about
private-parameter export, broader provider guarantees and metadata defaults.

Astra reached its usage limit before reviewing the complete final plan. The
user authorized an available replacement reviewer. That reviewer independently
reran R01/R03/R04 probes, inspected the R02 browser fixture/source, and reviewed
the R05 screenshot/log/source and R06 evidence. It agrees with all six P2
findings, the refined fix boundaries, acceptance checks and exclusions. It did
not rerun the browser matrices. Final wording review is complete and no
disagreements remain. This is agreement with the authorized replacement
reviewer; do not describe all six findings as Astra-approved.

## Closure ledger

### Fixed and verified

- **R01:** all import expectations are captured before either remote validator.
  Twelve held-validation regressions failed against the original implementation,
  then passed; 84 settings-file and credential-store tests plus scoped ESLint
  passed. Conditional commits/rollback and serialized imports remain intact.
- **R02:** explicit refresh owns HTTP revalidation of metadata/data and current
  viewport tiles. Token-scoped bytes/flights reject older work; ordinary requests
  reuse the refreshed cache. Twenty-seven focused client/renderer/private-client
  checks and scoped ESLint passed. Six cacheable HTTPS/real-Leaflet cases each
  passed hidden Chrome 156 and Firefox 157 at 1000/390×760, checking changed
  painted pixels, conditional 304 responses and ordinary browser-cache reuse.
  The first Chrome check sampled before Leaflet finished painting; it now waits
  for conditionally stable pixels. Two new client assertions failed before the
  fix; the new browser check also rejected the historical client because Reload
  never reached the cacheable provider. MapLibre GL integration remains part of
  final acceptance.

### Intentionally not changed

- Permissions, provider approval limits and manual Peakbagger Save/Import.
- Private-parameter manual-file export, the documented product decision.
- Ordinary cache reuse and existing data-retention/privacy boundaries.
- The finite reviewed development advisory and historical audit records.
- No speculative abstractions or performance rewrites. Scale checks passed;
  no separate quantified performance regression was established in this pass.

### Changed but not fully proven

R03–R06 remain open. Final integration, hosted CI, release packages, live providers,
native permission UI, visible-window focus/placement, screen readers and the
exact narrow Firefox R05 state are not proven. Peer review of this audit and its
fix plans is complete; implementation remains a separate step.
