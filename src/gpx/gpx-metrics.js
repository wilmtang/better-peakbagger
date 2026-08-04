// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure GPX metrics pipeline. Loaded into the page MAIN
// world immediately before src/gpx/gpx-analyzer.js (see manifest.json) and into
// tests. This file intentionally has no DOM or extension-API dependency:
// input is parsed track points, output is adjusted distances, smoothed
// elevations, confirmed gain, grades, and bounded map-route sampling.
//
// The route-payload bounds live in src/gpx/map-route-limits.js because the
// terrain frame re-checks the same numbers on the far side of the bridge.

import { MAX_MAP_ROUTE_POINTS, MAX_MAP_ROUTE_SEGMENTS } from './map-route-limits.js';

const DIST_CONFIRM_M = 5;
const ELEVATION_GAIN_THRESHOLD_M = 3;
const ELEVATION_SMOOTH_WINDOW_M = 30;
const ELEVATION_SMOOTH_POINT_RADIUS = 10;
const GRADE_WINDOW_M = 60;
const GRADE_MIN_DISTANCE_M = 10;
const GRADE_MAX_LOOKBACK_POINTS = 50;
const MAX_REASONABLE_SPEED_MPS = 10;
const PAUSE_RESET_SECONDS = 300;

const EARTH_RADIUS_M = 6371008.8;

const toRad = x => x * Math.PI / 180;

const isValidCoordinate = (lat, lon) => Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180;

const normalizeLonDelta = delta => {
    let result = delta;
    while (result > 180) result -= 360;
    while (result < -180) result += 360;
    return result;
};

// Canonical haversine shared with src/capture/capture-core.js (exported as
// `distanceM`). Longitude deltas are normalized so antimeridian-crossing
// edges measure the short way. Named to avoid shadowing by the local
// cumulative-distance variables below.
const haversineDistanceM = (a, b) => {
    const latDelta = toRad(b.lat - a.lat);
    const lonDelta = toRad(normalizeLonDelta(b.lon - a.lon));
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(latDelta / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const median = values => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const calculatePositiveGainM = elevations => elevations.reduce((gain, ele, index) => {
    if (index === 0) return gain;
    const delta = ele - elevations[index - 1];
    return delta > 0 ? gain + delta : gain;
}, 0);

const calculateConfirmedGainM = elevations => {
    if (elevations.length < 2) return 0;

    let gainM = 0;
    let valley = elevations[0];
    let peak = elevations[0];
    let state = 'unknown';

    elevations.forEach(ele => {
        if (state === 'rising') {
            if (ele > peak) {
                peak = ele;
            } else if (peak - ele >= ELEVATION_GAIN_THRESHOLD_M) {
                gainM += peak - valley;
                state = 'falling';
                valley = ele;
                peak = ele;
            }
            return;
        }

        if (ele < valley) {
            valley = ele;
            peak = ele;
            return;
        }

        if (ele - valley >= ELEVATION_GAIN_THRESHOLD_M) {
            state = 'rising';
            peak = ele;
        }
    });

    if (state === 'rising') {
        gainM += peak - valley;
    }

    return gainM;
};

const smoothElevations = (points, distMByIndex) => {
    const medianElevations = points.map((point, index) => {
        const start = Math.max(0, index - 2);
        const end = Math.min(points.length, index + 3);
        return median(points.slice(start, end)
            .filter(candidate => candidate.coordinateGroup === point.coordinateGroup)
            .map(candidate => candidate.rawEleM));
    });

    const halfWindowM = ELEVATION_SMOOTH_WINDOW_M / 2;
    return medianElevations.map((ele, index) => {
        const centerDistM = distMByIndex[index];
        const windowValues = [];

        for (let i = index; i >= Math.max(0, index - ELEVATION_SMOOTH_POINT_RADIUS); i--) {
            if (points[i].coordinateGroup !== points[index].coordinateGroup) break;
            if (centerDistM - distMByIndex[i] > halfWindowM) break;
            windowValues.push(medianElevations[i]);
        }

        for (let i = index + 1; i < Math.min(medianElevations.length, index + ELEVATION_SMOOTH_POINT_RADIUS + 1); i++) {
            if (points[i].coordinateGroup !== points[index].coordinateGroup) break;
            if (distMByIndex[i] - centerDistM > halfWindowM) break;
            windowValues.push(medianElevations[i]);
        }

        if (!windowValues.length) return ele;
        return windowValues.reduce((sum, value) => sum + value, 0) / windowValues.length;
    });
};

const computeAdjustedDistances = (points, hasTime) => {
    const distMByIndex = new Array(points.length).fill(0);
    if (points.length < 2) {
        return { distanceM: 0, rawDistanceM: 0, distMByIndex };
    }

    let distanceM = 0;
    let rawDistanceM = 0;
    let anchor = points[0];
    let prev = points[0];
    let pendingSteps = [];
    let pendingIndices = [];

    const resetPending = current => {
        pendingSteps = [];
        pendingIndices = [];
        anchor = current;
    };

    for (let i = 1; i < points.length; i++) {
        const current = points[i];
        if (current.coordinateGroup !== prev.coordinateGroup) {
            distMByIndex[i] = distanceM;
            resetPending(current);
            prev = current;
            continue;
        }
        const stepM = haversineDistanceM(prev, current);
        const elapsedSeconds = hasTime ? (current.ms - prev.ms) / 1000 : 0;
        const isBadJump = elapsedSeconds > 0 && stepM > DIST_CONFIRM_M && stepM / elapsedSeconds > MAX_REASONABLE_SPEED_MPS;

        rawDistanceM += stepM;
        // Provisional: every point starts at the last *confirmed* cumulative
        // distance and is back-filled to its real value only once the pending
        // run is confirmed (>= DIST_CONFIRM_M of displacement). Points that
        // are still pending at the end of the track -- or that were dropped as
        // bad GPS jumps -- keep this last-confirmed value, which can slightly
        // under-count distance for a short tail. Acceptable for trail stats.
        distMByIndex[i] = distanceM;

        if (isBadJump) {
            resetPending(current);
            prev = current;
            continue;
        }

        pendingSteps.push(stepM);
        pendingIndices.push(i);

        const pendingDisplacementM = haversineDistanceM(anchor, current);
        const isLongPauseNoise = elapsedSeconds >= PAUSE_RESET_SECONDS && pendingDisplacementM < DIST_CONFIRM_M;

        if (isLongPauseNoise) {
            resetPending(current);
        } else if (pendingDisplacementM >= DIST_CONFIRM_M) {
            let runningDistanceM = distanceM;
            pendingIndices.forEach((index, pendingIndex) => {
                runningDistanceM += pendingSteps[pendingIndex];
                distMByIndex[index] = runningDistanceM;
            });
            distanceM = runningDistanceM;
            resetPending(current);
        }

        prev = current;
    }

    return { distanceM, rawDistanceM, distMByIndex };
};

const computeRouteDistanceM = segments => {
    let coordinateGroup = 0;
    const points = [];

    (segments || []).forEach((segment, segmentIndex) => {
        if (segmentIndex > 0) coordinateGroup++;
        (segment || []).forEach(coordinate => {
            const lat = coordinate?.[0];
            const lon = coordinate?.[1];
            if (!isValidCoordinate(lat, lon)) {
                coordinateGroup++;
                return;
            }
            points.push({ lat, lon, coordinateGroup });
        });
    });

    return computeAdjustedDistances(points, false).distanceM;
};

const calculateGrade = (index, distMByIndex, elevations, points) => {
    const centerDistM = distMByIndex[index];
    let baselineIndex = index;

    while (baselineIndex > 0
        && points[baselineIndex - 1].coordinateGroup === points[index].coordinateGroup
        && index - baselineIndex < GRADE_MAX_LOOKBACK_POINTS
        && centerDistM - distMByIndex[baselineIndex] < GRADE_WINDOW_M) {
        baselineIndex--;
    }

    const distDiffM = centerDistM - distMByIndex[baselineIndex];
    if (distDiffM < GRADE_MIN_DISTANCE_M) return 0;
    return ((elevations[index] - elevations[baselineIndex]) / distDiffM) * 100;
};

const sumByCoordinateGroup = (points, values, calculate) => {
    let total = 0;
    let start = 0;
    for (let index = 1; index <= points.length; index++) {
        if (index < points.length && points[index].coordinateGroup === points[start].coordinateGroup) continue;
        total += calculate(values.slice(start, index));
        start = index;
    }
    return total;
};

const hasUsableTimeSequence = points => {
    if (points.length < 2) return false;

    let advanced = false;
    for (let index = 0; index < points.length; index++) {
        const ms = points[index].ms;
        if (!Number.isFinite(ms) || ms <= 0) return false;
        if (index === 0) continue;
        if (ms < points[index - 1].ms) return false;
        if (ms > points[index - 1].ms) advanced = true;
    }
    return advanced;
};

const computeMetrics = points => {
    let coordinateGroup = 0;
    const validPoints = [];
    points.forEach((point, index) => {
        if (!isValidCoordinate(point.lat, point.lon)) {
            coordinateGroup++;
            return;
        }
        if (Number.isFinite(point.rawEleM)) validPoints.push({ ...point, index, coordinateGroup });
    });

    if (!validPoints.length) {
        return {
            hasTime: false,
            distanceM: 0,
            gainM: 0,
            rawDistanceM: 0,
            rawGainM: 0,
            points: [],
            chartPoints: [],
            startMs: 0,
            endMs: 0,
            summitMs: 0,
            maxEleM: -Infinity
        };
    }

    // A syntactically valid timestamp is not necessarily a usable time
    // series. Peakbagger exports exist with one generated timestamp copied to
    // every point; treating those as timed tracks produced a zero-duration
    // chart collapsed onto one x coordinate. Preserve GPX document order and
    // expose time only when that order is nondecreasing and advances at least
    // once. Duplicate samples remain valid within a progressing track.
    const hasTime = hasUsableTimeSequence(validPoints);
    const analysisPoints = validPoints;

    const { distanceM, rawDistanceM, distMByIndex } = computeAdjustedDistances(analysisPoints, hasTime);
    const smoothedElevations = smoothElevations(analysisPoints, distMByIndex);
    const rawGainM = sumByCoordinateGroup(
        analysisPoints,
        analysisPoints.map(point => point.rawEleM),
        calculatePositiveGainM,
    );
    const gainM = sumByCoordinateGroup(
        analysisPoints,
        smoothedElevations,
        calculateConfirmedGainM,
    );

    let maxEleM = -Infinity;
    let summitMs = 0;
    const adjustedPoints = analysisPoints.map((point, index) => {
        const eleM = smoothedElevations[index];
        if (eleM > maxEleM) {
            maxEleM = eleM;
            summitMs = point.ms || 0;
        }

        return {
            lat: point.lat,
            lon: point.lon,
            ms: point.ms || 0,
            rawEleM: point.rawEleM,
            eleM,
            distM: distMByIndex[index],
            grade: calculateGrade(index, distMByIndex, smoothedElevations, analysisPoints)
        };
    });

    return {
        hasTime,
        distanceM,
        gainM,
        rawDistanceM,
        rawGainM,
        points: adjustedPoints,
        chartPoints: adjustedPoints.filter((point, index) => index % 3 === 0 || index === adjustedPoints.length - 1),
        startMs: hasTime ? adjustedPoints[0].ms : 0,
        endMs: hasTime ? adjustedPoints[adjustedPoints.length - 1].ms : 0,
        summitMs: hasTime ? summitMs : 0,
        maxEleM
    };
};

const sampleRouteSegment = (points, targetCount) => {
    if (points.length <= targetCount) return points;
    if (targetCount <= 2) return [points[0], points[points.length - 1]];

    return Array.from({ length: targetCount }, (_, index) => {
        const sourceIndex = Math.round(index * (points.length - 1) / (targetCount - 1));
        return points[sourceIndex];
    });
};

const limitMapRouteSegments = segments => {
    const pointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (pointCount <= MAX_MAP_ROUTE_POINTS) return segments;

    // Every segment needs both endpoints or the overlay would either bridge
    // a gap or silently truncate it. Pathological GPX with more segments than
    // that budget allows keeps Peakbagger's native route instead of drawing an
    // incomplete enhancement — and the terrain frame rejects the same shape,
    // which is why both sides read one constant.
    if (segments.length > MAX_MAP_ROUTE_SEGMENTS) return [];

    const extraBudget = MAX_MAP_ROUTE_POINTS - segments.length * 2;
    const totalExtraPoints = pointCount - segments.length * 2;
    const targetCounts = segments.map(segment => {
        const proportional = Math.floor(extraBudget * (segment.length - 2) / totalExtraPoints);
        return Math.min(segment.length, 2 + proportional);
    });

    let remaining = MAX_MAP_ROUTE_POINTS - targetCounts.reduce((sum, count) => sum + count, 0);
    for (let index = 0; remaining > 0; index = (index + 1) % segments.length) {
        if (targetCounts[index] >= segments[index].length) continue;
        targetCounts[index]++;
        remaining--;
    }

    return segments.map((segment, index) => sampleRouteSegment(segment, targetCounts[index]));
};

const sanitizeMapRouteSegments = segments => {
    const sanitized = [];
    const flush = current => {
        if (current.length >= 2) sanitized.push(current.splice(0));
        else current.length = 0;
    };

    for (const segment of segments || []) {
        const current = [];
        for (const coordinate of segment || []) {
            const lat = coordinate?.[0];
            const lon = coordinate?.[1];
            if (isValidCoordinate(lat, lon)) {
                current.push([lat, lon]);
            } else {
                flush(current);
            }
        }
        flush(current);
    }

    return limitMapRouteSegments(sanitized);
};

const API = {
    // Geometry primitives shared with src/capture/capture-core.js, which loads
    // after this module in the background worker.
    EARTH_RADIUS_M,
    toRad,
    normalizeLonDelta,
    isValidCoordinate,
    distanceM: haversineDistanceM,
    computeRouteDistanceM,
    calculateConfirmedGainM,
    computeMetrics,
    limitMapRouteSegments,
    sanitizeMapRouteSegments,
};

export const gpxMetrics = API;
