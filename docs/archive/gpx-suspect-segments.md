# Suspect GPX segments: cause analysis and remedy plan

Status: implemented locally; see the closure ledger for verification and limits.

The analysis and proposed rules below preserve the pre-implementation record.
Current maintained behavior lives in [GPX data quality](../gpx-data-quality.md).

Date: 2026-09-26. Source review baseline: `7587054`.

## 1. Problem and intended result

The GPX for [ascent 1170663](https://www.peakbagger.com/climber/ascent.aspx?aid=1170663)
contains a coherent hike plus two segments that appear unrelated to the hike's
measurements. Better Peakbagger currently accepts those segments as ordinary
input. Its displayed 20.32 miles and 68h 28m therefore look more authoritative
than the underlying data warrants.

This is recoverable data contamination, not an unreadable GPX. The intended
remedy is an explainable, reversible interpretation for the analyzer. Keep the
original download untouched, retain access to the source interpretation, and
show exactly what the analyzer excluded. Do not try to make the distance and
time curves overlap: they represent different horizontal scales even on a
healthy track.

The user subsequently authorized implementation. That authorization does not
include editing the saved ascent or uploading a replacement GPX.

## 2. Evidence and reproduction

The [direct GPX download](https://www.peakbagger.com/climber/GPXFile.aspx?aid=1170663&sep=1)
was fetched read-only on 2026-09-26 and parsed with the repository's
`gpxParse.parseGpxDocument` using `includeQuality: true`. The parsed fields were
mapped into the same `gpxMetrics.computeMetrics` inputs used by the analyzer.
Diagnostics were computed for all segments, without the duplicate, and for the
hike segment alone. No source records were rewritten.

Snapshot identity:

- File size: 11,669 UTF-8 bytes.
- SHA-256: `89bd8130a63e4c127d25bfc3acc3c540f346c55913b368770007bebed5d9ff69`.
- Three track segments, containing 1, 56, and 56 points: 113 source track points.
- The checksum identifies this observation, not a permanent property of the
  remote endpoint. Re-fetching later may return changed data.
- Exact coordinates are intentionally not reproduced here. In particular, the
  isolated point is not evidence of a campsite or a person's home.

### Segment inventory

Segment numbers below are one-based source order.

| Segment | Points | UTC timestamps | Elevations | Interpretation |
| --- | ---: | --- | --- | --- |
| 1 | 1 | 2019-06-06 03:42 | 133 m | Isolated point, 55h 56m before the hike; approximately 143.18 km from the nearest recorded hike point |
| 2 | 56 | 2019-06-08 11:38 through 2019-06-09 00:10 | 1,341–2,578 m | Coherent hike with changing elevations and progressing timestamps |
| 3 | 56 | Every point is 2019-06-08 11:38 | Every elevation is exactly 0 m | Same ordered coordinate sequence as segment 2, with degenerate elevation and time metadata |

The duplicate assertion is exact equality of the parsed latitude/longitude
pairs at all 56 positions. It is not approximate route similarity, a reversed
return trip, or byte-for-byte equality of the complete point records. The time
and elevation fields differ.

The structure suggests an export, merge, or conversion artifact. The source
file alone does **not** establish which application or workflow created it.
Segment 1's relationship to the trip is also unknown: it could be intentional
context, an accidental recording, or another artifact.

### Recomputed measurements

These are outputs of the existing pure metrics code on different input subsets,
not outputs of an implemented detector.

| Input | Adjusted distance | Raw distance | Clock span | Adjusted gain |
| --- | ---: | ---: | --- | ---: |
| All three segments | 20.319081 mi → **20.32 mi** | 20.328004 mi | **68h 28m** | **3,637 ft** |
| Segments 1 and 2 | 10.158068 mi → **10.16 mi** | 10.164002 mi | **68h 28m** | **3,637 ft** |
| Segment 2 only | 10.158068 mi → **10.16 mi** | 10.164002 mi | **12h 32m** | **3,637 ft** |

The raw gain is approximately 5,138 ft; the existing gain adjustment reduces it
by approximately 1,501 ft. That is a separate existing adjustment, not evidence
that duplicate-segment repair has already happened. Gain happens to remain
unchanged for this source when the two suspect segments are removed. A remedy
must still recompute gain rather than assume that outcome for other files.

For segment 2, the summit timestamp is 2019-06-08 15:50 UTC. In PDT the hike
starts June 8 at 04:38 AM, reaches that summit point at 08:50 AM, and ends at
05:10 PM: 4h 12m to summit and 8h 20m back. These are elapsed recorded spans,
not a claim about moving time.

### Repeatable diagnostic procedure

1. Fetch the direct download once; verify it is GPX/XML rather than an HTML
   challenge or error. Record the checksum and retrieval date.
2. Parse through `src/gpx/gpx-parse.js`, preserving all owned track segments.
   Do not count extension-owned lookalike elements as track data.
3. Record segment lengths, timestamp ranges, elevation ranges, and coordinate
   equality between candidate pairs. Verify segment boundaries are preserved.
4. Map each point to the analyzer fields: latitude, longitude, raw elevation,
   elevation state, milliseconds, time state, and original segment group.
5. Run `computeMetrics` for the complete source and each retained subset above.
   Use meters/seconds for comparisons; apply miles/feet formatting afterward.
6. Confirm that excluding only segment 3 fixes distance but not the clock span.
   This separates the two faults and prevents a superficially successful patch.

Future regression fixtures should be synthetic, preserving this structure and
its relationships without requiring live Peakbagger requests. Keep the source
URL/checksum as supporting evidence; do not make automated tests depend on it.

## 3. Why the current analyzer accepts it

The broken invariant is that syntactically valid measurements are treated as a
coherent activity. Coordinate, elevation, and timestamp validity do not prove
that every segment belongs to the same hike or represents another traversal.

### Parsing and field quality are working as currently designed

`src/gpx/gpx-parse.js` parses owned track points without inferring activity
membership. All 113 coordinates in this file are numerically valid. Zero meters
is a plausible elevation, and each timestamp is individually valid.

`src/gpx/gpx-metrics.js` reports complete time coverage when all included points
have valid timestamps and there is progression somewhere in the combined input.
For this file it reports 113 of 113 valid timestamps and `hasProgress: true`.
A constant-time segment is therefore not necessarily surfaced as a defect when
another segment supplies time progression. Complete coverage means field
availability here; it does not mean an internally consistent recording.

Do not redefine every zero elevation or equal timestamp as malformed. Those
values can be legitimate. Add segment diagnostics as a separate concept.

### Distance counts the repeated geometry twice

The distance engine respects disconnected segment groups; it does not add a
143 km connector from the isolated point to the hike. The doubled distance
comes from traversing the same 56-point sequence twice.

Existing distance adjustments suppress small drift and some implausibly fast
jumps. Their speed test requires a positive elapsed interval. The duplicate's
zero elapsed intervals do not make its spatial edges disappear. The metrics
module has no exact-degenerate-duplicate segment detector.

Safe segment sequencing only rearranges compatible complete time ranges; it
neither deduplicates geometry nor removes outlying segments. Timestamp overlap
also prevents treating these three segments as a straightforward ordered trip.

### The activity clock includes the isolated early point

The time summary takes the minimum and maximum valid timestamps across the
retained route. Segment 1 therefore becomes the start and the hike's final
point becomes the end. The resulting 68h 28m includes a 55h 56m interval before
the main hike starts.

The analyzer assigns relative days and derives possible camping locations from
calendar-day changes between timed points. With complete timestamp coverage,
the isolated point can become a misleading camping candidate. A date boundary
between disconnected, distant recordings is not evidence of camping.

The starting route coordinate also owns mountain-timezone selection. In this
particular file both locations resolve to PDT, but another remote outlier could
select the wrong timezone. Changing the retained route must update this owner.

### The two chart axes amplify the bad interpretation

`src/gpx/gpx-analyzer.js` plots elevation by distance against the bottom axis and
elevation by time against the top axis:

- The orange profile traverses the real hike during approximately the first
  half of the doubled distance. Segment 3 occupies the second half at zero
  elevation, producing the orange zero line.
- The early timestamp expands the time axis. The real hike starts about 81.7%
  of the way through the displayed 68h 28m span, so its blue profile appears
  near the right edge.
- The duplicate's timestamps collapse its temporal extent to one instant;
  they do not describe another 10-mile walk over time.

Thus two largely similar elevation profiles are widely separated horizontally.
Changing axis scaling or forcing the curves to align would conceal the bad
input while leaving the statistics wrong.

## 4. Remedy policy and conservative detection rules

Analyze before chart sampling. Preserve the parsed source and attach an explicit
segment disposition: retained, excluded from the interpreted view, or warning
only. Never infer the complete source count from a filtered/sampled array.

### Rule A: exact duplicate with degenerate metadata

Allow automatic exclusion in the interpreted view only for a narrow conjunction
of evidence. The proposed first implementation requires all of the following:

1. Both segments have valid coordinates and the same complete coordinate sequence
   in the same order. Compare parsed numeric coordinates exactly; do not round,
   reverse, rotate, or use a proximity tolerance.
2. The candidate has at least eight points, at least two distinct coordinates,
   and at least 100 m of path length. These are conservative initial floors to
   avoid interpreting tiny coincident segments as a full duplicate recording.
3. Every candidate elevation is explicitly present and equals zero. Missing or
   malformed elevations are not silently converted to zero.
4. Every candidate timestamp is valid, identical, and equals the counterpart's
   start timestamp. It has spatial movement but no elapsed progression.
5. The retained counterpart has complete plausible elevation data, including a
   nonzero elevation, and complete nondecreasing timestamps with positive duration.
6. There is one unambiguous qualifying counterpart. If multiple possible donors
   make the retained identity ambiguous, report a warning without exclusion.

Segment 3 satisfies this profile relative to segment 2. Keep the original
segment ID, the counterpart ID, and the evidence behind the decision.

Do not remove legitimate repeat laps with independently progressing timestamps,
reverse out-and-back geometry, ordinary overlapping routes, sea-level tracks,
or untimed tracks just because they share coordinates. A match that fails any
part of this rule remains included with a diagnostic where useful.

The eight-point and 100 m floors are proposed product policy, not facts derived
from this single example. Pin boundaries in tests and review false-positive
fixtures before enabling the rule by default.

### Rule B: isolated distant point outside the main activity

Apply this rule after Rule A so a duplicate cannot influence identification of
the main route. It is less conclusive than Rule A and must be described as an
inference, with the source view readily available.

For the initial implementation, propose exclusion only when:

1. There is exactly one coherent multi-point segment left, with complete,
   progressing timestamps and enough geometry to qualify as the main route
   under Rule A's minimum point/distance floors.
2. The candidate is a separate one-point segment with valid coordinates/time.
3. Its time is at least 24 hours before the main route begins or at least 24
   hours after it ends.
4. Its location is at least 50 km from the main route, including the connecting
   geometry between recorded vertices, not merely from the start/end points.
5. There is no competing multi-point activity or connecting recording that
   makes the file an ambiguous multi-trip recording.

This case comfortably passes the point-count and temporal conditions. The
143.18 km measurement above is distance to the nearest recorded vertex; the
implementation must also measure distance to the path before claiming the
50 km path-distance rule is verified. The path-distance acceptance check was open when planned. Implementation has
since measured the full great-circle path at 143.177673 km from the singleton,
confirming the threshold for the cached source (see closure).

Twenty-four hours and 50 km are conservative proposed thresholds, not universal
hiking limits. Do not exclude a whole multi-day segment, a nearby early trailhead
fix, a pause in an otherwise continuous track, or a useful isolated point within
the activity's time range. Multi-route ambiguity should produce a warning and
preserve all segments, not trigger a "keep the longest segment" heuristic.

If false-positive fixtures show this rule cannot be trusted as an automatic
choice, ship Rule A first and make Rule B review-only. This is an explicit
fallback decision, not permission to silently broaden the detector.

### General safeguards

- Keep the original GPX bytes, point order, and segment identities intact.
- Always retain at least one usable route segment; do not turn a warning into
  an empty chart through cascading exclusions.
- Never infer a repaired timestamp, elevation, location, or moving duration.
- Hashing may accelerate exact duplicate matching, but verify full equality
  before excluding a candidate; a hash match alone is insufficient.
- Bound work using the existing 20,000-point and 50-segment parser limits from
  `src/capture/capture-resource-limits.js`. Avoid all-point-pairs searches and
  repeated diagnostics on hover, resize, or unit changes.
- Keep coordinate calculations local. No geocoding, routing, or elevation API
  is necessary for this repair.

## 5. Architecture and data flow

The intended flow is:

```text
Owned parsed GPX segments (unchanged)
  -> segment diagnostics + stable source point/segment IDs
  -> selected analysis view (interpreted or source)
  -> existing shared metric calculations
  -> chart sampling, stats, clock, Sun selection, extension-owned map overlay
```

Keep the diagnostic policy in a pure GPX module with no browser/storage/network
access. It may live alongside the existing metrics code. Do not place it inside
a Chart.js callback or introduce independent distance/gain formulas in the UI.
If an additional geometric primitive is needed, share it through the pure GPX
geometry boundary rather than duplicating it across consumers.

Initially call the policy from the saved-ascent analyzer. Do not change the
behavior of every existing `computeMetrics` caller by introducing implicit
filtering there: the capture worker also consumes shared metrics. Keep existing
capture/draft calculations unchanged until their distinct ownership and input
contracts are reviewed and tested.

Proposed diagnostic results should carry:

- Source segment ID, source point IDs, and original point count.
- Reason code and disposition, plus matched counterpart ID when applicable.
- Evidence values such as duplicate length, timestamp span, temporal separation,
  and geographic separation. Generate UI text from reason codes, not source HTML.
- Included and excluded counts, with a complete inventory for the disclosure.

Maintain separate source and interpreted metric results. "Source view" should
mean all source segments passed through today's normal metrics engine. It must
not be mislabeled as unsmoothed/raw measurements: the existing `raw GPX` deltas
refer to numerical adjustment, a different concept from segment exclusion.

### Dependent surfaces must change together

Switching analysis views must recompute distance, gain, duration, summit timing,
relative days, timezone ownership, chart domains, and source/active counts.
Camping inference must not bridge disconnected segment groups without evidence
of a continuous recording. Do not invent replacement camping locations.

Keep point identity stable through filtering and sampling. Preserve a selected
point if it survives; otherwise clear selection and its Sun/copy-coordinate
state with an understandable prompt. Clear stale hover, route highlights, and
outdated overlays before rebuilding. Never allow a sampled array index to
select a different source point after the view changes.

The extension-owned map overlay and highlights should follow the chosen analysis
view. Peakbagger's native layers must remain untouched and may still show the
source track. Explain that distinction in the details if necessary. Terrain
bounds/drape inputs need explicit review so excluded remote geometry cannot
silently continue setting the extension's viewport.

## 6. Compact and reversible UI

Keep the current metrics/count row; do not add an always-visible warning block.
For this case, once both rules are verified and enabled, the compact form is:

> Adjusted GPX metrics (…) · 113 points · 2 segments excluded

The source count stays **113**, not 56. An accessible, plainly styled disclosure
on "2 segments excluded" explains:

| Segment | Decision | Reason |
| --- | --- | --- |
| 1 | Excluded from interpreted statistics | Isolated point nearly 56 hours before the hike and far from the route |
| 2 | Retained | 56-point hike with progressing time and elevation |
| 3 | Excluded from interpreted statistics | Exact coordinate copy of segment 2 with all-zero elevation and one repeated timestamp |

Show **56 points used; 57 points excluded** and the resulting differences:
20.32 → 10.16 miles and 68h 28m → 12h 32m. State that the GPX download is unchanged.

Use "Show all source segments" and "Use interpreted view" for the reversible
view choice. Scope the choice to this loaded GPX; do not create a global setting
that permanently hides suspect data. If detection is warning-only, say so and
do not use the word "excluded."

Preserve the one-line point count. At narrow widths prioritize the count and
short disclosure label; truncate the explanatory metrics text with access to
its full wording. The closed header must not gain height. An explicitly opened
details surface may use more space. Keep controls keyboard accessible, announce
the view change, and avoid color-only distinctions.

The current source-count change in `7587054` already displays the count; it is
not a segment-detection fix. Its total must remain source-based once filtering
is introduced.

## 7. Scope boundaries

Intentionally preserve:

- The exact GPX download and saved Peakbagger ascent.
- Provider handoffs: Gaia, onX, AllTrails, and CalTopo still receive the original
  saved GPX. A filtered chart must not silently change exported content.
- Existing unit preferences, numerical distance/gain adjustment, and legitimate
  track segment boundaries.
- MAIN-world/isolated-world boundaries. Diagnostics need no new extension
  messaging, permissions, or settings bridge writes.
- Local analysis without new storage of source GPX or new remote data sharing.

A future "download cleaned GPX" feature would require its own explicit scope,
provenance, serialization, and privacy review. It is not part of this remedy.

## 8. Implementation sequence

Complete, verify, and commit each independent unit before beginning the next.
Do not ship a partial UI that suggests exclusions have occurred when they have not.

1. **Reproduction and pure diagnostic contract.** Add synthetic fixtures for the
   three-segment shape and each counterexample below. Define stable identities,
   structured reasons, thresholds, and original-versus-active count semantics.
   Establish baseline metrics before detector changes.
2. **Exact degenerate-duplicate detection.** Implement Rule A and its bounded
   matching/indexing strategy. Test conservative fallbacks and idempotence.
3. **Isolated-point classification.** Implement and verify path distance and
   Rule B, or explicitly choose the review-only fallback based on evidence.
   Keep this decision distinct from the stronger duplicate fix.
4. **Analyzer integration.** Derive the active view once per GPX/view choice;
   recompute all dependent surfaces and prevent stale selection/overlay state.
   Preserve existing shared-metrics and capture behavior.
5. **Disclosure and source-view interaction.** Add the inline explanation and
   reversible view switch. Exercise keyboard, narrow layouts, and failure states.
6. **Closure.** Record completed checks and remaining gaps below. Archive this
   plan only after the implementation has an honest disposition, updating the
   maintained GPX/architecture documentation and plan indexes as appropriate.

## 9. Regression and verification matrix

| Case | Required outcome |
| --- | --- |
| Synthetic counterpart of segments 1/2/3 | Detect both candidates; interpreted 56-point route has one hike's distance and duration; source view restores all 113 points |
| Remove only duplicate | Distance decreases; early clock span remains until isolated point is handled |
| Duplicate metadata shape with no early point | Fix distance/zero profile without shifting a valid hike start |
| One isolated point but no duplicate | Do not require duplicate detection to diagnose the clock issue |
| Legitimate repeated lap with different progressing timestamps | Retain both laps |
| Reversed out-and-back or near-matching geometry | Retain; no approximate deduplication |
| Flat sea-level track, missing elevation, or constant time alone | Preserve legitimate/degraded data; do not apply Rule A without all evidence |
| Multiple possible duplicate counterparts | Warn without selecting an arbitrary survivor |
| Multi-day hike, overnight pause, early nearby trailhead fix | Retain; no duration-only exclusion |
| Multiple coherent activities in one GPX | Preserve and report ambiguity |
| Isolated point near the middle of a sparsely sampled long edge | Path-distance check prevents a vertex-only false exclusion |
| Threshold boundary, antimeridian, and high-latitude geometry | Deterministic classification with correct distance bounds |
| Invalid coordinates or nested extension lookalikes | Existing parser/quality handling preserved; counts and source ownership remain correct |
| All suspect or no retained route | Safe fallback; do not create a misleading empty/corrected success state |
| Unit/theme/resize changes | Stable exclusions and source counts; no repeated classification or lost source-view choice |
| Selection of an excluded point when switching views | Clear stale map/Sun/copy state; preserve surviving identities |
| Source-view switch repeated or load retried | No accumulated exclusions, duplicated listeners, stale requests, or altered source |
| Capture/draft regression suite | No unintended changes to worker-owned capture or drafted metrics |
| Original download/provider handoff | Exact original GPX preserved in either chart view |
| 20,000 points / 50 segments | Bounded CPU/memory; interactive hover and resize remain responsive |

Verification gates for implementation:

- Run pure detector/metrics tests and bundled analyzer regression tests after
  building `dist/`. Keep performance limits and malformed-input cases explicit.
- Run relevant map, settings, capture, and transfer tests for touched boundaries;
  run the full suite before declaring the remedy complete.
- Run lint and real unpacked-extension verification after changing bundle
  composition or a load dependency. Exercise both Chrome and Firefox before
  release for pointer/keyboard/disclosure behavior.
- Use dedicated hidden profiles and HTTPS Peakbagger fixtures. Inspect light and
  dark views at 1000×760 and 430×760, plus a desktop layout comparable to the
  reported screenshot. Measure closed-header height with/without diagnostics.
- Verify pointer hover versus deliberate selection, keyboard navigation, and
  map/chart agreement after toggles. Geometry tests alone do not establish visual
  quality; inspect rendered screenshots too.
- A minimal, read-only live check of this ascent can supplement the synthetic
  fixtures. Do not repeatedly fetch it or save changes as a verification shortcut.
- Record browser/renderer/viewport and teardown evidence. Hidden checks do not
  prove physical-device gestures, native prompts, or screen-reader speech.

## 10. Closure ledger

Implementation date: 2026-09-26. Focused runtime sequence:

- `3dd301b`: synthetic 1/56/56 reproduction, separating distance and clock faults.
- `a1200c0`: pure exact-degenerate-duplicate policy and stable source identities.
- `e490740`: complete-path geometry and conservative isolated-point policy.
- `610fda0`: analyzer view lifecycle, compact disclosure, selection/map/terrain
  updates, and browser regression coverage.

### Fixed and verified

- Rule A requires every conjunct above and one unambiguous donor. Legitimate
  laps, reversed/near-matching geometry, missing fields, invalid coordinates,
  all-zero donors, short/tiny tracks and ambiguous donors are preserved.
- Rule B uses distance to minor great-circle path edges, not merely vertices.
  Antimeridian, poles, sparse-edge interiors, endpoints, threshold floors and
  ambiguous antipodal edges have focused coverage. Automatic exclusion requires
  exactly one remaining multi-point recording and **one singleton**, a stricter
  safeguard than the original minimum proposal; multiple singleton breadcrumbs
  remain review-only because they could describe a connecting recording.
- Cached source SHA-256 above: segment 1 path distance 143.177673 km; segments 1
  and 3 excluded; 56 used/57 excluded out of 113 source points. Existing metrics
  produce 10.158068 miles and 12h 32m. No additional live fetch was needed.
- Source and interpreted metric results are cached per file. The 113-point
  source count survives filtering/sampling. Repeat toggles do not accumulate
  changes. Source IDs preserve surviving selection, and excluded selection
  clears Sun, coordinate copying and highlights.
- Clock, summit, timezone and map inputs share the selected view. Camping no
  longer crosses disconnected time-coordinate groups. Extension overlays
  rebuild and open terrain restarts with the selected route. Interpreted terrain
  initialization omits the native source camera, letting its route own fitting.
- Inline disclosure is keyboard accessible; open state and source-toggle focus
  survive updates. Warning-only cases retain their source data and offer no
  spurious exclusion toggle. Count/disclosure fit without closed-header growth
  at 430, 1000 and 1600 px. Light/dark rendered Chrome screenshots were inspected;
  both browser verifiers exercise the disclosure and selection transition.

Validation completed before closure:

- Pure detector/metrics: 63 tests passed; bounded 20,000-point/50-segment case.
- Bundled analyzer, coordinator and manifest contracts: 90 tests passed.
- Hidden Chrome for Testing 153.0.8010.12, full new-headless unpacked extension:
  passed, including segment interactions and existing extension checks.
- Hidden Firefox 156.0.1, disposable derived extension: passed, including the
  same segment interaction and header-geometry contract.
- Chart rendering uses Canvas2D. No WebGL software-rendering flags were added.
  Browser runs used HTTPS Peakbagger fixtures and disposable profiles/certificates;
  teardown inspection found no remaining verifier browser processes.
- `npm test`: 2,054 passed, zero failed/skipped (including capture, draft,
  transfer, schema and parser ownership regressions); approximately 102 seconds.
- `npm run lint`: passed, with the existing eight allowlisted cross-browser /
  upstream dependency warnings; no new warning exemption.
- `node scripts/verify-map-handoffs.mjs`: passed hidden Chrome HTTPS fixtures
  at 1000×760 and 430×760. Exact original saved GPX reached all four provider
  adapters; manual Save/Import/Upload remained required, and GPX was not stored
  in extension storage. These are fixture results, not live provider proof.
- `node --test test/project/documentation.test.mjs`: three passed; all relative
  maintained/archive links resolve.

### Intentionally not changed

- Original GPX bytes, saved ascent, download and Gaia/onX/AllTrails/CalTopo files.
- Shared distance/gain smoothing, capture/draft algorithms and source point order.
- Native Peakbagger map layers. They can still display source geometry.
- Missing measurements, approximate duplicates, reversed routes, ordinary
  multi-day recordings, and ambiguous membership. No repair is invented.
- No new settings, persistence, permissions, external APIs, or cleaned export.

### Changed but not fully proven

- The isolated-point rule infers activity membership. Even at these conservative
  thresholds, the source author might have intentionally included contextual
  data; the explanation and source toggle remain necessary. Thresholds are
  product policy, not universal evidence of corruption.
- Terrain route payload, camera omission and restart behavior are covered by
  contract tests. The new view-toggle transition was not visually inspected in
  a fully rendered 3D terrain scene; existing browser startup tests do not
  establish its WebGL appearance or external tile-service availability.
- Hidden browser evidence does not prove physical-device trackpad gestures,
  native browser prompts/focus, screen-reader speech, or live third-party
  import workflows. No publication, remote CI run, or store release occurred.
- The source diagnosis does not identify the exporting application's fault or
  certify the remaining hike as a surveyed/ground-truth record.
