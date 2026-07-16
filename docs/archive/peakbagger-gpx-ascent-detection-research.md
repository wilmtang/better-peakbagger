# Peakbagger GPX Ascent Logger

## Current detection behavior and a proposed summit-matching mechanism

Status: Technical research note  
Prepared: July 13, 2026  
Code reviewed: `main` commit `e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e`  
Method: Static source inspection plus Peakbagger and GPS.gov documentation; no authenticated live upload

## Summary

`peakbagger_gpx_ascent_logger` is a Chrome extension that reads a GPX file, finds nearby Peakbagger summits, estimates ascent statistics, and prepares Peakbagger ascent forms.

Its current auto-detection rule is simple:

> Show a summit when one retained GPX track point is less than 500 feet (152 metres) horizontally from Peakbagger's summit coordinate.

This is a broad candidate-discovery heuristic. It is not GPX ownership validation and it is not proof that the summit was attained.

The proposed replacement keeps a broad radius for discovering candidates, then scores each candidate using horizontal distance, elevation compatibility, whether the encounter is a local high point, the surrounding route shape, and track quality. Results should be presented as strong, probable, possible, or weak matches with supporting evidence.

## What the extension currently does

### GPX processing

When the user selects a GPX file, the extension:

1. Parses the file as XML.
2. Collects every `<trkpt>` element.
3. Requires at least two track points.
4. Requires every track point to contain `<ele>` and `<time>`.
5. Reads latitude, longitude, elevation, and timestamp values.
6. If track points plus waypoints exceed 3,000, simplifies the track before running summit detection.

Elevation and time are required because the extension uses them to calculate distance, elevation gain, duration, and the estimated summit date and time. See [`gpx-utils.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/gpx-utils.js) and [`popup.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/popup.js).

### Automatic peak detection

The extension then:

1. Calculates one bounding box around the complete track.
2. Expands that box by 500 feet.
3. Sends the box to Peakbagger's internal `pllbb2.aspx` endpoint.
4. Receives Peakbagger peaks inside the box.
5. For each peak, compares the summit coordinate with every retained GPX point.
6. Finds the closest point.
7. Keeps the peak if that point is less than 500 feet from the summit.
8. Sorts candidates by distance and checks them by default.

The endpoint call is implemented in [`background.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/background.js). The distance filter and result selection are implemented in [`popup.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/popup.js).

For a selected peak, the closest GPX point is treated as the summit event. The track is split at that point to estimate the trip up and down.

| Stage | What the code checks | What it actually means |
| --- | --- | --- |
| GPX parsing | At least two track points; each has elevation and time | Enough fields for the extension's calculations |
| Point limit | Track points and waypoints are reduced toward 3,000 | Compatibility with Peakbagger's upload limit |
| Peak query | Peak is inside a padded track bounding box | Broad candidate discovery |
| Auto match | Closest retained track point is under 500 feet from the summit | Horizontal proximity, not a verified summit |
| Submission | Logged-in account, previewed GPX, user clicks Save | Who submits the record, not who recorded the GPX |

### Drafting the ascent

For each selected peak, the extension:

1. Opens Peakbagger's ascent editor in a new tab.
2. Fills the date, estimated summit time, elevations, distances, durations, and gain fields.
3. Attaches a generated `track.gpx` file.
4. Clicks Peakbagger's Preview button.
5. Leaves the final review and Save action to the user.

This behavior is implemented in [`content.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/content.js).

### Manual selection

Manual mode bypasses the 500-foot filter. It searches Peakbagger by name, sorts results by distance from the track, and allows the user to draft an ascent for the selected peak even when the track is far away.

Manual selection is a useful fallback for database-coordinate errors, but it should be clearly labelled as a manual choice rather than a GPX-detected summit.

## What “validation” means

In this extension, “validate” means “usable by the extension.” It does not mean authentic, owned by the uploader, or proven to represent a completed ascent.

The extension checks:

- Minimum track-point count.
- Presence of elevation and timestamp elements.
- The 3,000-point upload constraint.

It does not check:

- Whether latitude, longitude, elevation, and time values are valid or realistic.
- Whether timestamps are ordered.
- Impossible speed or location jumps.
- Whether the GPX came from the logged-in user's device.
- Cryptographic provenance or an authenticated Garmin, Strava, or similar activity.
- Whether the track reaches the summit elevation.
- Whether the nearby point is a local high point.
- Whether the person actually reached the summit.

Peakbagger's own [GPS Data Help](https://www.peakbagger.com/help/HelpGPS.aspx) says user-posted tracks are unverified. It also permits tracks to be edited or sketched, provided they reasonably represent the user's trip.

Logging in identifies the account submitting the ascent. It does not establish who created, carried, downloaded, or edited the GPX file.

## Weaknesses in the current detector

### The 500-foot cutoff is too broad for acceptance

A trail can pass 152 metres beside or below a summit and still be selected. The radius is reasonable for discovering candidates but too generous for declaring a strong match.

### It measures track points instead of the path

The detector compares the summit only with recorded GPX points. A sparse track may cross directly over a summit between two samples but appear farther away because the line segment between those points is ignored.

### Simplification happens before detection

The extension simplifies long tracks before matching peaks. Its simplification preserves horizontal path shape, not summit evidence, so it can discard a useful summit-near point.

Detection should use the original GPX. Simplification should happen only when preparing the final file for Peakbagger upload.

### Elevation is ignored

Only horizontal distance is considered. A track can pass close to a summit coordinate while remaining far below it on a steep slope.

### Track-segment boundaries are flattened

The parser collects all `<trkpt>` elements into one sequence. Separate tracks or segments can therefore be treated as continuous movement, producing misleading distance, duration, gain, or closest-path results across GPS gaps.

### Loose candidates are checked by default

Automatically checking every candidate turns a loose discovery rule into an implied acceptance decision. This is particularly risky on crowded ridges and around closely spaced subsidiary summits.

## GPS accuracy assumptions

On a clear summit with open sky, a practical consumer-device assumption is approximately:

- 3–10 metres of horizontal error.
- 10–20 metres of vertical error.

[GPS.gov](https://www.gps.gov/gps-accuracy) reports that smartphones are typically accurate within a 4.9-metre radius under open sky. The [2020 GPS Standard Positioning Service Performance Standard](https://www.gps.gov/technical/ps/2020-SPS-performance-standard.pdf) illustrates the usual vertical disadvantage: approximately 6.4 metres horizontal versus 11.9 metres vertical at 95% under its stated benign assumptions.

The observed summit difference is not necessarily all GPS drift. It can also include:

- Error in Peakbagger's summit coordinates.
- Uncertainty in Peakbagger's listed elevation.
- Receiver and antenna quality.
- Signal blockage or reflection from terrain and the user's body.
- Differences between GPS and map elevation datums.

The extension does not receive a per-peak coordinate-uncertainty value from Peakbagger. Therefore, the detector should expose uncertainty instead of hiding it inside one binary radius.

## Proposed summit-detection mechanism

### Design goal

Maximize precision without hiding plausible candidates. The detector should return evidence and confidence, not claim that an ascent is verified.

### Stage 1: Validate and preserve the original track

- Require finite latitude and longitude values within valid ranges.
- Validate timestamps and preserve their order.
- Preserve separate track and segment boundaries.
- Do not calculate or draw across GPS gaps.
- Flag impossible jumps, reversed time, and extreme speeds.
- Use original GPX points for detection.
- Simplify only the final upload file.

If elevation is missing or unreliable, the detector may still find a horizontal candidate, but its confidence should be capped.

### Stage 2: Discover broad Peakbagger candidates

Query Peakbagger around a 200–300 metre corridor along the track.

For a short track, one padded bounding box is sufficient. For a long track, query a series of smaller corridor tiles and deduplicate results by Peakbagger peak ID. A single large rectangle can return many peaks nowhere near the actual path.

This radius is for discovery only. It should not count as evidence that a summit was reached.

### Stage 3: Find actual track encounters

For each candidate peak:

1. Measure the summit against every GPX line segment, not only recorded vertices.
2. Find the closest point along the path.
3. Interpolate its position, timestamp, and elevation when possible.
4. Group consecutive near-summit points into one encounter window, such as ±5 minutes or ±300 metres of travelled distance.
5. Keep encounters separate when the track leaves the area and later returns.

This supports sparse sampling and multiple visits to the same summit.

### Stage 4: Score independent evidence

| Signal | Question answered | Initial weight |
| --- | --- | ---: |
| Horizontal proximity | How close did the path come to the summit coordinate? | 50% |
| Elevation compatibility | Was the encounter reasonably close to summit elevation? | 20% |
| Local high point | Was the encounter high relative to the surrounding route? | 15% |
| Approach/departure shape | Did the track generally climb in and descend out? | 10% |
| Track quality | Are sampling, timestamps, and speeds credible? | 5% |

An initial score could be:

```text
confidence =
    0.50 × horizontal proximity
  + 0.20 × elevation compatibility
  + 0.15 × local high point
  + 0.10 × approach/departure shape
  + 0.05 × track quality
```

The inputs should decay smoothly rather than use abrupt pass/fail cliffs. For example:

- Horizontal proximity could decay around a 25-metre scale.
- Elevation compatibility could decay around a 40-metre scale.
- Missing evidence should cause the remaining signals to be reweighted and confidence to be capped.

These values are starting assumptions. They should be calibrated against a labelled collection of real tracks.

### Stage 5: Classify and explain the result

| Classification | Starting rule | User experience |
| --- | --- | --- |
| Strong match | Score ≥0.80 and normally within 30 metres horizontally | May be preselected; always show supporting evidence |
| Probable | Score 0.60–0.79 | Show prominently but leave unchecked |
| Possible | Score 0.35–0.59 | Show as a nearby candidate and leave unchecked |
| Weak | Score below 0.35, or more than 150 metres away without a known coordinate issue | Suppress from automatic results; retain manual search |

Every result should explain itself. For example:

> Strong match: the track passed within 14 m, reached 8 m below the listed elevation, formed a local high point, and descended afterward.

A 150-metre pass should never look equivalent to a 14-metre pass.

## Edge cases

The detector must handle:

- A summit at the beginning or end of the GPX, where only one side of the ascent/descent pattern exists.
- Traverses and trail runs that reach the summit without stopping or turning around.
- Closely spaced main and subsidiary summits.
- Routes that pass below a summit on a steep face.
- Sparse sampling where the path crosses the summit between points.
- Multiple track segments separated by signal loss or device pauses.
- Repeated visits to the same summit.
- Missing or biased elevation.
- Driving, lifts, skiing, or other movement where hiking-specific speed assumptions are unsafe.

Approach and descent shape should be supporting evidence, not an absolute requirement.

## Recommended implementation order

1. Move GPX simplification after summit detection and preserve segment boundaries.
2. Add strict numeric and timestamp validation with explicit track-quality warnings.
3. Replace nearest-vertex distance with summit-to-polyline distance and encounter windows.
4. Introduce confidence levels using horizontal distance first; retain 500 feet only for discovery.
5. Add elevation, local-high-point, and approach/departure signals with missing-data handling.
6. Change the UI so only strong matches may be preselected and every result shows evidence.
7. Build a labelled test set and tune thresholds for precision.

## Minimum regression scenarios

- Direct summit crossing with dense points → strong match.
- Track passes 150 metres below or beside summit → possible or suppressed, never strong.
- Sparse track crosses summit between two points → detected using segment distance.
- GPS gap spans the summit → no artificial straight-line match across segments.
- Two nearby ridge summits → ambiguity displayed rather than both silently accepted.
- Missing elevation → horizontal candidate with a confidence cap.
- Summit is the first or last point → no requirement for both approach and descent.
- Manual distant selection → clearly labelled manual, not GPX-detected.

## Non-goal: proof of ownership

No geometry-based detector can prove that the uploader personally recorded or completed the activity.

Stronger provenance would require an authenticated activity-provider integration, such as importing directly from Garmin or Strava and associating that provider account with the Peakbagger account. Even then, it would provide evidence of provenance rather than certainty about who physically completed the activity.

## Sources

- [`README.md`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/README.md): Feature description, requirements, and review-before-submit workflow.
- [`gpx-utils.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/gpx-utils.js): Point parsing, metrics, closest-point calculation, and reduction.
- [`popup.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/popup.js): File workflow, 500-foot filter, manual search, and default selections.
- [`background.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/background.js): Peakbagger bounding-box request and ascent-tab creation.
- [`content.js`](https://github.com/npwolf/peakbagger_gpx_ascent_logger/blob/e0bb25a1a2ccffad9eca1a19c26abdb3f237ae9e/content.js): Form prefilling, GPX attachment, and Preview action.
- [Peakbagger GPS Data Help](https://www.peakbagger.com/help/HelpGPS.aspx): Upload limits, preview process, unverified-data warning, and acceptance of edited or sketched tracks.
- [GPS.gov: GPS Accuracy](https://www.gps.gov/gps-accuracy): Open-sky smartphone accuracy and factors affecting user accuracy.
- [GPS Standard Positioning Service Performance Standard](https://www.gps.gov/technical/ps/2020-SPS-performance-standard.pdf): Illustrative horizontal and vertical accuracy under stated assumptions.
