// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — one owner for unit constants, unit resolution, and the
// strings the user reads.
//
// FEET_PER_METER and METERS_PER_MILE used to be redeclared in four modules, and
// `units: 'auto'` was resolved by two unrelated page heuristics. Those two run
// on different pages, so they could not visibly disagree — which is exactly why
// a divergence would have shipped unnoticed. AGENTS.md already requires shared
// math to live in one place so drafted and displayed values cannot diverge.
//
// Pure by construction: no DOM, no extension APIs, no imports. That is what
// lets the background worker, both content-script worlds, and the popup all
// bundle it. Page detection stays with the surface that owns the page — each
// passes its own probe to resolveUnits() against this one contract.

const FEET_PER_METER = 3.28084;
const METERS_PER_MILE = 1609.344;

const METRIC = 'metric';
const IMPERIAL = 'imperial';

const feetFromMeters = meters => meters * FEET_PER_METER;
const milesFromMeters = meters => meters / METERS_PER_MILE;

// `probe` answers "what is this page already showing?" and is optional: a
// surface with no page to sniff (the popup) passes nothing. Anything other than
// a definite 'metric'/'imperial' falls back to imperial, matching Peakbagger's
// own default for a signed-out or unconfigured reader.
const resolveUnits = (settings, probe) => {
    const preference = settings?.units;
    if (preference === METRIC || preference === IMPERIAL) return preference;
    const probed = typeof probe === 'function' ? probe() : null;
    return probed === METRIC ? METRIC : IMPERIAL;
};

// Long ground distances: track length, distance walked.
const formatDistance = (meters, units) => units === METRIC
    ? `${(meters / 1000).toFixed(1)} km`
    : `${milesFromMeters(meters).toFixed(1)} mi`;

// Vertical distances: elevations and elevation differences. `digits` exists for
// the few values where sub-unit precision is the point — the capture's max
// track deviation is a fidelity figure, and rounding 2.4 m to 2 m discards
// what it is there to say.
const formatElevation = (meters, units, digits = 0) => {
    const value = units === METRIC ? meters : feetFromMeters(meters);
    return `${digits > 0 ? value.toFixed(digits) : Math.round(value)} ${units === METRIC ? 'm' : 'ft'}`;
};

// Short ground distances — how far a point sits from a summit. Same units as an
// elevation, but a distinct name so call sites stay readable.
const formatApproach = formatElevation;

export const units = {
    FEET_PER_METER,
    METERS_PER_MILE,
    METRIC,
    IMPERIAL,
    feetFromMeters,
    milesFromMeters,
    resolveUnits,
    formatDistance,
    formatElevation,
    formatApproach
};
