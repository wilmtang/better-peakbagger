# Code, performance, engineering and UX audit — October 27, 2026

Status: **plan only; no runtime fixes implemented**. Audited revision:
`471c60a82951dda3b1ce4c5dc9f50fd7463e35d2` on `main`, initially clean.
The findings below are confirmed on that tree. This is a risk-focused review,
not a claim that every feature or interaction is defect-free.

## Findings first

| ID | Priority | Problem | Evidence | Independent fix unit |
| --- | --- | --- | --- | --- |
| A01 | P1 | CI's reviewed dependency exception no longer matches the live advisory graph | Exact CI command rejects four development-tool findings; production audit is zero | Dependency remediation and exact policy tests |
| A02 | P2 | Settings import overwrites a newer ImgBB Save or Remove | Real stores, controlled interleaving; import returns success with the stale file key | Conditional forward credential write |
| A03 | P2 | 3D Retry cannot recover an initial TileJSON failure | Actual renderer/client with a map adapter: one request before and after Retry, zero sources | Missing-source recovery |
| A04 | P2 | Reload reuses private worker bytes and resolved metadata | Actual client/private fetch/relay: provider changes, Reload still returns old bytes | End-to-end source refresh |
| A05 | P2 | GeoJSON refresh leaks Leaflet canvases and map listeners | Hidden Chrome with real Leaflet: three reloads retain four canvases after Off/dispose | Explicit renderer lifetime ownership |
| A06 | P2 | A first asynchronous custom layer throws before its pane exists | Hidden Chrome with real Leaflet: synchronous `update()` TypeError | Readiness-safe ordering |
| A07 | P2 | A maintained audit document breaks the documentation/test gate | Full suite: 3,703 pass, one missing-path failure | Correct the document's line-reference syntax |

P1 means a normal release/CI gate is currently blocked; it does **not** imply
that a shipped extension exploit was demonstrated. P2 findings affect ordinary
recovery, saved state, resource lifetime or required verification.

## A01 — current development advisories invalidate the reviewed gate

**Evidence.** [The audit policy](../../scripts/check-npm-audit.mjs) (lines
21–78) accepts one exact graph with three high findings. Both
[`test.yml`](../../.github/workflows/test.yml) (line 61) and
[`release.yml`](../../.github/workflows/release.yml) (line 101) opt into that
policy. The exact command `npm run audit:ci -- --allow-reviewed-development-advisory`
now rejects `addons-linter, deepmerge, node-forge, web-ext`.

The live registry snapshot reports **four affected development packages (one
high, three low)** across two advisory identities. The lock has `node-forge`
1.4.0 and `deepmerge` 4.3.1. The
[deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) was
reviewed/updated October 27 and lists no patched release. The
[node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) also
lists no patched release. npm's suggested web-ext 3.2.1 downgrade is not an
acceptable automatic repair of the current tooling. `npm audit --omit=dev
--json` reports zero vulnerabilities. No exploitation or runtime-bundle
exposure was established.

**Plan.** Trace the actual installed consumers and current upstream releases.
Prefer compatible patched/removal paths, verified with lint and package checks.
If upstream still offers no usable repair, present a separately reviewed,
exact-version/path/advisory exception with a finite expiry; do not silently
expand or extend the existing approval. Keep unknown findings fail-closed.

**Acceptance.** Raw full and production audits recorded separately; the exact
CI command passes only the approved graph. Policy tests reject an extra
advisory, changed severity/path/version, expired exception and missing metadata.
Run lint and package verification for tooling changes. Hosted CI remains a
separate check after an authorized push.

## A02 — settings import loses concurrent ImgBB credential intent

**Evidence.** [Settings import](../../src/background/settings-file-routes.js)
(lines 180–238) snapshots the ImgBB record, awaits conditional settings and
custom-layer writes, then calls unconditional `keyStore.replace`. Concurrent
[Save/Remove handlers](../../src/background/photo-routes.js) (lines 179–195)
can change that same store during those waits. The key store already provides
[queue-owned comparison and replacement](../../src/photos/imgbb-auth.js)
(lines 53–65); import uses it only during rollback.

Two controlled probes used the real settings, credential and import modules.
Immediately after settings replacement, one probe saved a newer synthetic key;
the other removed the key. Both imports reported `ok: true` and
`imgbb: committed`, and both ended with the older file key. This can restore a
credential the user has just removed. The existing
[settings-file tests](../../test/background/background-settings-file.test.mjs)
cover preservation of newer keys during rollback, not this successful forward
write.

**Plan.** Commit the imported key with `replaceIfCurrent(previousImgbb,
installedImgbb)`. On a mismatch, mark the store conflicted, stop subsequent
stages and conditionally roll back already committed stores. Do not claim this
is a global transaction across unrelated credential operations. Preserve
explicit-null import as an intentional deletion when there is no conflict.

**Acceptance.** Regressions fail before the fix for concurrent Save and Remove,
including a file containing explicit null. Confirm the newer value/deletion
survives, import reports a conflict, settings/layers roll back conditionally,
and a newer third-party write is not undone. Existing success/null and rollback
tests must still pass. UI feedback should use the current conflict flow.

## A03 — 3D Retry does no work after an initial metadata failure

**Evidence.** [The custom renderer](../../src/maps/custom-overlay-render.js)
(lines 102–113 and 193–200) creates a terrain source only after metadata resolves.
After that initial resolution fails, Retry clears error fields but chooses
`map.getSource(entry.key)?.setTiles(...)`; the source does not exist, so it
never calls `paint` or fetches again. The corresponding 2D branch does call
`paint` when its layer is missing. GeoJSON already calls `paint` independently
and is outside this finding.

A deterministic probe with the actual renderer/client first rejected metadata,
then made the endpoint healthy and advanced the reload token. Provider request
count remained **1**, source count remained **0**, and the last published state
remained the original error. This was a Node/jsdom map-adapter probe, not real
MapLibre or visual 3D proof.

**Plan.** Retry metadata-backed raster/MVT initialization when the terrain
source is absent. Distinguish initialization from refreshing an existing source;
guard against duplicate paints and stale completions. Retain good geometry
during failed refreshes. Keep this small fix independent of A04's refresh
protocol.

**Acceptance.** Metadata-only raster and MVT initial failure → Retry → visible
tiles in the actual packaged 3D frame, including private approval failure →
approval → Retry. Test repeated activation, cancellation, source changes and
held slow responses. Verify Chrome/Firefox on hardware graphics, both themes,
narrow/desktop sizes and enlarged text; compare Retry, panel, following content
and scroll geometry through pending/error/success. A green adapter test alone
does not complete the UI verification.

## A04 — Reload does not refresh the complete source

**Evidence.** [The renderer](../../src/maps/custom-overlay-render.js) (lines
106–109 and 195–200) resolves metadata only when tiles are absent, mutates
`entry.source` to that resolved result, and on Reload evicts only the
[renderer client cache](../../src/maps/custom-overlay-client.js) (line 125).
The [private relay](../../src/background/custom-layer-relay.js) (lines 137–162
and 177–182) separately retains resolved signed endpoints and response bytes
without a Reload invalidation path or freshness expiry. The documented
[Reload contract](../map-layers.md) (line 85) promises to refresh a loaded source.

A probe composed the real custom client, private fetch wrapper and relay. It
read synthetic provider value `old`, changed the provider to `new`, evicted the
client cache as Reload does, and read `old` again; only **one** provider request
occurred. Separately, the source-read branches show that both public and private
metadata descriptors are not re-resolved on ordinary Reload. Worker-cache
eviction alone would therefore be insufficient.

**Plan.** Give explicit source refresh one bounded owner from the renderer to
the private relay. Retain the original validated saved descriptor separately
from resolved state and re-resolve it when refreshing. Invalidate only the
authorized source/revision's response and metadata caches, with generation
checks so older flights cannot repopulate them. Safely update/recreate rendering
when template, bounds or native zoom changes. Keep unrelated layers and
last-known-good output while work is pending or fails.

Refresh must retain grant expiry, remaining allowance, durable provider budgets,
cooldowns, permissions, host review and cancellation. It must not become an
unbounded page-controlled cache-bypass capability; reuse the isolated trusted
action boundary and validate the requesting document/source. TTL may bound
ordinary caching, but TTL alone does not satisfy explicit Reload.

**Acceptance.** Public/private changed tile/data bytes and changed/signed
TileJSON URLs become visible after Reload. Cover raster, MVT and GeoJSON,
metadata-derived versus manual overrides, stale-flight completion, revoked
permission, changed source revision, exhausted allowance and 429 cooldown.
Assert unrelated caches and counters survive; no request before approval and
no secrets cross public messages. Exercise packaged 2D/3D Chrome/Firefox
transitions and stable action/reading-position geometry. Do not add settings
or increase request budgets to work around stale data.

## A05 — GeoJSON Reload leaves renderer canvases and listeners on the map

**Evidence.** [Leaflet GeoJSON painting](../../src/maps/custom-overlay-render.js)
(lines 114–126) creates fresh `L.canvas` owners on every successful paint and
overwrites `entry.renderers`. It removes the prior feature group only.
[Removal](../../src/maps/custom-overlay-render.js) (lines 55–62) likewise
removes the feature group, leaving the renderer layers registered with Leaflet.

Hidden Chrome 156.0.8078.4 at **1000×760** ran the real renderer and hash-pinned
Leaflet 1.9.4 on an HTTPS Peakbagger fixture. One point rule and one line rule
were supplied; only the point rule had matching geometry, creating one active
canvas per generation. After three Reloads:

| State | Custom canvases | Total map layers | `moveend` listeners |
| --- | ---: | ---: | ---: |
| Native baseline | 0 | 3 | 3 |
| First loaded generation | 1 | 8 | 4 |
| After three Reloads | 4 | 11 | 7 |
| After Off | 4 | 7 | 7 |
| After renderer disposal | 4 | 7 | 7 |

The retained canvases were empty after Off; this demonstrates resource and
listener retention, not persistent visible stale polygons or a measured
frame-rate regression. Each retained renderer still owns map-update listeners,
so repeated refresh/toggle use accumulates work and canvas backing storage.
The startup exception in A06 was recorded and caught in this disposable probe
so lifecycle measurement could continue; product code was not patched.

**Plan.** Treat each feature group and its owned canvas renderers as one lifetime.
After a successful replacement, remove the previous pair. Off/dispose removes
the current pair. Failed refresh retains the old pair; partial setup failure
cleans only newly allocated owners. Never remove native/shared map renderers.

**Acceptance.** A real-Leaflet regression repeats successful/failed refresh,
Off/on and final disposal. Active refresh retains only the current generation;
after Off/final disposal, layer/listener/canvas counts settle to the native
baseline. Old geometry remains usable after a failed refresh and native route,
markers and interactions survive. Cover point/line/polygon rules and empty
GeoJSON in Chrome/Firefox. Measure ownership counts independently of heap-GC
timing; add a scale/performance check only if necessary to verify bounded work.

## A06 — layer ordering dereferences an absent canvas before initialization

**Evidence.** [Ordering](../../src/maps/custom-overlay-render.js) (lines 35–45)
compares `container?.parentNode === pane`. Before the custom pane and layer
exist, both sides are undefined, the comparison succeeds, and `container.style`
throws. `update()` calls ordering while asynchronous GeoJSON/metadata painting
is still pending (lines 215–218).

The fresh GeoJSON-only real-browser fixture above reproduced
`Cannot read properties of undefined (reading 'style')` synchronously from
`update`. A prior directly configured raster creates the pane synchronously and
can mask it. The same source path applies to metadata-only raster/MVT.
The already-started paint can still complete; this finding does **not** claim
the map is permanently dead.

**Plan.** Require an existing pane and container before manipulating ownership
or stacking. Treat an unpainted entry as a valid pending state and let completed
painting apply the saved order. Do not precreate fake nodes merely to satisfy
the current assumption.

**Acceptance.** Fresh maps with GeoJSON-only and TileJSON-only selections must
not throw during initial load, error, Retry, reordering or removal while pending.
No pre-created custom pane in the fixture. Confirm final saved stacking and
native-layer priority after data arrives, plus successful existing raster-first
behavior. Run the assertion against the original source to prove it catches
this TypeError rather than a fixture setup failure.

## A07 — a prose line reference is treated as a nonexistent repository file

**Evidence.** [The onX reliability record](onx-export-reliability-2026-10-27.md)
(line 61) puts a colon-suffixed line number inside a backticked repository path.
The maintained-document [path validator](../../test/project/documentation.test.mjs)
(lines 192–205) correctly rejects the resulting nonexistent filename. The full
baseline ran **3,704 tests: 3,703 passed, 1 failed**, with that document as the
sole failure. The historical climber-card timeout described there did not
recur in this run; this does not establish that its timing issue is resolved.

**Plan.** Write the file path and line number separately, following existing
documentation conventions. Preserve the historical failure record. No parser
rewrite or hover-card runtime change is justified by this missing-path failure.

**Acceptance.** Run the documentation test against the current document to
retain the expected failure, correct the prose, then run it again and run
`npm test`. Keep historical tests and their proof gaps distinct from the
current baseline. Commit this small documentation repair independently.

## Execution plan and review agreement

Execute A07 and A01 first to restore trustworthy local gates, then A02, A06,
A05, A03 and A04. Each ID is a separate focused commit after its checks pass;
do not bundle the five renderer/storage fixes into a refactor. A04 is last
because its cache/refresh protocol crosses renderer, isolated bridge and worker
boundaries and needs the broadest browser/privacy verification.

The user requested an independent **Astra high** review. That reviewer inspected
the source and challenged the candidates and plans. The debate:

- Narrowed A03 to metadata-backed raster/MVT in 3D; GeoJSON already retries.
- Expanded A04 from client/worker byte-cache eviction to original-descriptor
  re-resolution, signed metadata rollover and stale-flight ownership, while
  retaining all spending/consent gates.
- Kept A05 and A06 separate because resource lifetime and pending readiness
  have independent causes and regression checks; limited the startup claim
  because asynchronous paint can still complete.
- Added A02 after independent reproduction and required forward-write conflict
  handling, including explicit-null and conditional rollback.
- Rejected metadata completion as a demonstrated credential disclosure: the
  returned metadata is synthetic/public, and no secret leak was reproduced.
- Did not turn intentional provider-policy differences, file-exported private
  parameters or generic duplication/large modules into speculative findings.

Capacity and usage interruptions delayed that review; it resumed on the same
requested model/effort. After reviewing the complete draft, the reviewer
requested two precision corrections: distinguish affected dependency packages
from advisory identities, and require the Leaflet native baseline after
Off/disposal rather than during active refresh. Both were applied. The reviewer
then explicitly confirmed agreement with the entire updated document, all
A01–A07 findings, priorities, fix units, execution order and acceptance checks,
with **no unresolved disagreements**.

## Verification and scope limits

- Source review covered recent custom-overlay schema/client/render/control,
  private relay/store/transfer, settings-file and ImgBB storage, trusted actions,
  saved-GPX/onX routes and adapters, their focused tests, manifest/build ownership,
  active audit ledgers and CI/dependency policy. Other runtime surfaces were
  covered by the baseline suite and existing ledgers, not an exhaustive new
  line-by-line review.
- `npm test`: build succeeded; **3,703/3,704 passed**, only A07 failed.
- `npm run lint`: passed; web-ext reported the **eight owned warnings**.
- `npm run test:scale`: **14 passed**, including production-scale analysis,
  cancellation checkpoints, full ascent/favorites lists, 100,000-point parsing
  and a 1,200-photo library. These checks do not exercise A05's repeated
  custom-renderer lifetime.
- Default and reviewed `audit:ci`: failed on the current unowned graph in A01.
  The first sandboxed attempt lacked usable registry metadata; an authorized
  network-enabled run established the advisory findings. Production audit: zero.
- Controlled Node/jsdom probes reproduced A02–A04. They use synthetic keys and
  responses; no account data or live provider write was involved.
- A05/A06 used **hidden** full Chrome for Testing 156.0.8078.4, pinned Leaflet
  1.9.4 and an HTTPS `www.peakbagger.com` fixture at 1000×760. This was canvas 2D;
  no WebGL renderer claim applies. The runtime was bundled into a disposable
  diagnostic page, not loaded as the entire extension. First attempts failed
  on an unavailable temporary asset and then a missing browser binary; neither
  was counted as product evidence. A later run recorded the actual A06 error
  and the A05 ownership counts. No visible window or user profile was used.
- Browser/profile/server/certificate cleanup ran in `finally`; subsequent
  process inspection found no owned audit browser. Playwright's installed
  browser cache is reusable tooling, not a disposable profile.
- Real 3D Retry/Reload, Firefox lifecycle reproduction, theme/narrow/enlarged-text
  layout transitions, screen readers, visible focus/window placement, native
  permission UI, live providers, hosted CI and store/release checks remain
  unexecuted for this audit. Do not infer these from the baseline or old ledgers.
- The documentation check was rerun after writing this report: two tests passed,
  and the only failure remained A07's existing onX path. All relative links in
  this report resolve; `git diff --check` passed. The plans index links this
  report. Final independent Astra high review agreed with the complete plan.

## Closure ledger

### Fixed and verified

None. This change writes an audit and implementation plan only.

### Intentionally not changed

- Runtime source, dependencies, permissions, settings and user-owned state.
- Manual Peakbagger Save and onX Import; no provider login or account operation.
- Provider ownership, raw-GPX privacy, exact destination/host gates and durable
  allowance/cooldown policies. Manual private-parameter file export follows the
  explicit owner decision in the maintained map-layer guide.
- Historical audit evidence and external/manual proof gaps; no cosmetic or
  abstraction rewrite without a concrete defect.

### Changed but not fully proven

Only this report and its plans-index entry. A01–A07 remain open until their
individual fixes and acceptance checks are completed. Baseline failures and
the unexecuted checks above remain explicit; this audit is not remediation.
