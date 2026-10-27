# Private custom-layer relay — October 26, 2026

Implementation authorized: add editable HTTP query parameters, keep credentials
out of Peakbagger and relay protected map requests through BPB. Public layers
without private parameters retain their existing direct/CORS path.

## Boundaries

- Private source definitions and parameter values live in extension-origin
  IndexedDB, outside public layer records, page messages, sync and backups.
  Public descriptors contain only opaque layer IDs, revisions and local relay
  resource descriptors. Editing is restricted to the real Settings page/editor.
- Requests name a saved layer/revision, resource kind and integer z/x/y. The
  worker builds GET URLs from saved configuration, validates HTTPS destinations,
  rejects redirects, omits cookies/referrers and never accepts caller URLs or
  headers. Metadata-discovered hosts require explicit review/permission; no
  credential forwarding across origins. Responses/errors must not echo secrets.
- No protected requests before approval in a full BPB extension page. Approval
  is bound to the requesting tab/document, layer revision, a fixed request budget
  and expiry. Page events only open that review surface; they cannot approve it.
  Shared persistent request budgets survive service-worker restarts; cancelling,
  closing, revoking permission and source changes invalidate ongoing authority.
- An authorized map necessarily can consume its approved allowance. Do not claim
  zero quota risk. Bound total requests, concurrency, response bytes, retries and
  cooldowns; duplicate suppression/cache reduces repeated spending.
- Restored protected-layer descriptors require reconnecting on this device.
  Credentials are omitted from all backups, including credential-inclusive files.

## Acceptance

Test hostile messages, synthetic activation, destination/path substitutions,
wrong tabs/documents/revisions, navigation, duplicate/replayed authority,
worker restart and clock changes, cross-tab budgets, retries/429, cancellation,
oversized responses, metadata URL leakage and revocation. Verify saved params
can be edited/removed without page/storage/export leakage. Exercise actual
Chrome/Firefox packaged 2D/3D request paths and Settings at narrow/desktop sizes,
themes, keyboard and pending/error/retry states. Keep native permission-prompt,
live-provider and any broader suite failures explicit.

## Closure ledger

### Fixed and verified

- Source setup follow-up: new overlays need name and URL; source type, URL
  format and appearance are inside collapsed Advanced. Local URL hints require
  no network request. Check/automatic Save read only the supplied document and
  fill validated type, zoom, scheme, bounds, declared tile size and a unique
  vector source layer. Manual fields/styles and saved credits are preserved;
  ambiguous vectors require an explicit layer choice. URL edits abort pending
  detection and stale results cannot fill or save the changed draft. Explicit
  type/format selection retains the manual-save fallback.
- Source detection shares a pure field reader between CORS and Settings-only
  private checks. Private GeoJSON inspection does not enable a map metadata
  request for a data-only layer. Private metadata and signed URLs remain in
  extension surfaces, while map requests still require separate approval.
- Detection verification: the initial collapsed-form regression failed against
  the old form. The full suite passed 3,678 tests; the final 78-case focused run
  includes the additional GeoJSON resource-boundary test, metadata/editor cases,
  manifest boot and documentation checks. Lint passed with the
  eight owned warnings. Chrome 156.0.8078.4 passed all 15 map surfaces. Chrome
  and Firefox 158.0.1 each passed 18 editor cases: name/URL-only raster, MVT and
  GeoJSON setup, help, manual overrides, held detection error/retry and held Save
  pending/error/retry. Heading/actions/document/scroll geometry remains stable
  within one pixel. Editor frames were 618/339×718 in Chrome and 618/464×642 in
  Firefox at requested 1000/375 browser widths, in light/dark themes; Chrome also
  checked 200% browser zoom. Screenshots were visually inspected.
- Private detection passed in hidden Chrome/Firefox at 1000×900 with narrow
  375/500-width Settings layouts, masked saved editing and a no-CORS TileJSON
  provider requiring the synthetic key. Only the explicit Settings metadata
  check fetched before map approval; no tile requests did. Subsequent 2D and
  hardware 3D raster rendering, secret-free public storage/export/messages and
  reload revocation passed. Both used hardware Metal/Apple M3 Pro. Chrome's real
  startup/bridge check also passed. Native permission prompts remain pregranted.
- Masked editable query rows in the source editor. Saving/checking requests only
  configured optional HTTPS hostnames. The fixed editor markup is packaged HTML;
  private values are assigned through DOM input properties. Packaging lint no
  longer reports the former runtime-template warning.
- Private definitions and values live in extension-origin IndexedDB. Public
  records/backups contain only validated opaque relay descriptors, appearance
  and identity. Settings-only `editSource` replies are confined to a real options
  tab/editor. Failed public commits retain the prior private revision; source
  removal deletes the private definition. Removing parameter rows retains private mode
  so signed metadata URLs cannot be silently declassified. Restore increments
  revisions, invalidating private records and requiring reconnection.
- The relay constructs bounded GETs from saved IDs/revisions and resource/tile
  coordinates. It rejects arbitrary destinations/resources, foreign origins,
  redirects, cookies and referrers. Parameters stay on the original input
  origin. Raw metadata and signed tile URLs never cross to MAIN. Responses and
  errors are reduced to bounded bytes/safe status fields.
- One-use, real-extension-page approval grants 20,000 attempts for 8 hours in
  the original active tab, with source/navigation/permission revocation and
  abortable transport. Four jobs, 25,000 attempts/hour and 100,000/day per configured
  provider hostname are enforced across layers/tabs using durable atomic
  counters. Failed attempts count, clock rollback fails closed and HTTP 429
  applies shared cooldown. Cache and duplicate sharing avoid additional GETs;
  one cancelled consumer cannot cancel a sibling, but cancelling all aborts.
- Power-user allowances replace the initial preview-sized budgets. A 4K map can
  cover about 160 256-pixel tiles per layer; 20,000 attempts leaves room for about
  125 entirely fresh views of one layer before failures/metadata requests.
  The shared 25,000/hour and 100,000/24-hour ceilings allow several active layers
  and long planning sessions. These are geometric workload estimates, not user
  telemetry or a guarantee for every workflow; larger approvals also permit
  greater spending if an approved page is compromised. Provider billing rules
  and quotas remain separate from BPB's network-attempt counters.
- Allowance follow-up verification: 53 focused relay/client/control/manifest
  tests and three documentation checks passed; `npm run lint` passed with the
  same eight owned warnings. The new extended-planning regression failed on the
  original implementation at tile 257, then passed for 1,025 distinct tiles,
  six-hour continuation and the exact eight-hour expiry. Boundary coverage
  exhausts 20,000 failed attempts and both provider counters, including sharing
  across tabs/layers, restart persistence and fixed-window renewal.
- Hidden Chrome 156.0.8078.4 and Firefox 158.0.1 private-layer checks passed again
  with hardware Metal/Apple M3 Pro rendering. The longer allowance text fits
  light/dark approval pages at 1000/375 px in Chrome and 1000/500 px in Firefox;
  screenshots were visually inspected. The map and approval text match enforced
  limits, actions remain within the viewport, and heading/buttons/scroll remain
  anchored within one pixel through approval success. The real Chrome
  startup/bridge check passed. Fixture grants still do not verify native prompts.
- Parent-owned BigMap requests use the executing owner window for the isolated
  message bridge while drawing in MasterMap. Its native child and authenticated
  terrain renderer can use the same tab approval. Browser fixtures caught the
  initially incorrect child-window message source before shipping.
- `npm test`: 3,662 tests passed after the runtime/static-editor changes.
  Focused tests cover corrupt-ledger rejection, typed client transport/cancellation and two
  separately approved tabs/layers sharing a provider budget. Full-source ESLint
  and `npm run lint` passed (eight previously owned vendor/cross-browser warnings).
- Hidden Chrome 156.0.8078.4 and Firefox 158.0.1 packaged fixtures passed with a
  synthetic key and an HTTPS tile server supplying no CORS headers. Both checked
  no request before approval; masked saved editing; no key in page DOM/messages,
  public storage or credential-inclusive export; forged resource rejection;
  actual 2D/3D rendering/worker reads; and no network requests after reload until
  reapproval. 3D used hardware Metal/Apple M3 Pro, rejecting software renderers.
- Settings inspected at 1000/375×900 in Chrome and 1000/500×900 in Firefox (its
  privileged-window minimum). Light/dark rows fit. Actual Save controls retained
  position/dimensions, focus and scroll through pending, duplicate activation,
  recoverable error, retry and success within one pixel. The disposable fixture
  held local writes; production write code and permission pregrant were retained.
- The real unpacked Chrome startup/bridge verifier passed. The public custom
  overlay verifier also passed: 15 map surfaces, actual CORS recovery, 2D/3D
  raster/vector rendering, 14 editor states, keyboard retry and anchored feedback.
  No live Peakbagger report, user profile or installed permissions were changed.
- Owned process command lines and disposable profile paths were inspected after
  teardown; no verification browsers/profiles remained.

### Intentionally not changed

- Detection does not search provider endpoints, sample global tile coverage or
  infer logical raster tile size from image dimensions. Unknown raw template
  types and vector source layers still need a user choice. Source inspection
  retains the metadata/data byte bounds; large `.json` GeoJSON documents can use
  explicit GeoJSON type. Full map styles remain unsupported. Actual feature and
  vertex validation remains in the packaged data parser during rendering.
- Existing public layers and native map owners. No generic fetch proxy, remote
  relay server, arbitrary headers, cookies or server/admin credential support.
- An approved hostile page can spend its allowance and read map data. Provider
  credentials/data are not protected from the configured provider or someone
  controlling the local device. Permission warnings cover hostnames, whereas
  runtime requests are more narrowly pinned to saved HTTPS origins/resources.
- Worker suspension/restart loses in-memory approvals and requires another
  explicit approval; durable counters cannot be reset that way. No silent
  renewal, background scraping, unlimited grants or synced credentials.

### Changed but not fully proven

- The broader Firefox custom-overlay verifier reaches terrain with raster and
  MVT loaded but GeoJSON remains `Loading`; the full verifier therefore exits
  nonzero after its 18 editor cases pass. Its Retry selector was corrected to
  target Retry instead of the hidden private-approval action. The remaining
  terrain GeoJSON condition is unresolved and is not claimed fixed or fully
  verified by the source-setup work. Chrome's broader run and both private raster
  integrations pass. The GeoJSON fetch/render functions themselves were not
  changed in this follow-up; a full baseline browser attribution was not done.
- Native permission prompts and provider-specific access policies require
  independent evidence; fixture grants cannot establish them.
- Native grant/revocation prompt appearance, visible-window focus/placement,
  physical touch, browser zoom and assistive-technology behavior were not proved.
  No provider-specific API key was used. Generic raster integration is proven in
  both browsers; MVT/GeoJSON and TileJSON privacy/limits have focused unit coverage
  plus the existing public renderer checks, rather than a live authenticated
  provider survey for each format.
