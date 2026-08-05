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
// A GPX <trkseg> boundary is often only a recorder pause or an export
// container boundary. Treat nearby endpoints as one route, while keeping a
// conservative spatial cap so equal-elevation teleports cannot be joined.
const MAX_SEGMENT_JOIN_DISTANCE_M = 100;
const MAX_SEGMENT_JOIN_ELEVATION_DELTA_M = 100;
// Conservative terrestrial bounds. Values outside them cannot describe a
// Peakbagger ascent, but the wide margin avoids treating ordinary GPS/geoid
// disagreement near the lowest and highest land elevations as corrupt data.
const MIN_PLAUSIBLE_ELEVATION_M = -1000;
const MAX_PLAUSIBLE_ELEVATION_M = 10000;

const EARTH_RADIUS_M = 6371008.8;

const toRad = x => x * Math.PI / 180;

const isValidCoordinate = (lat, lon) => Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180;

const isValidTimestamp = ms => Number.isFinite(ms) && ms > 0;

const isPlausibleElevationM = elevationM => Number.isFinite(elevationM)
    && elevationM >= MIN_PLAUSIBLE_ELEVATION_M
    && elevationM <= MAX_PLAUSIBLE_ELEVATION_M;

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

const computeAdjustedDistances = points => {
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
        // Individual samples are never reordered, so a malformed or partial
        // series can still put the later timestamp first. Jump and pause
        // filtering depend on the elapsed magnitude, not serialization order.
        const elapsedSeconds = isValidTimestamp(current.ms) && isValidTimestamp(prev.ms)
            ? Math.abs(current.ms - prev.ms) / 1000
            : 0;
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
    let previousSegmentEnd = null;

    (segments || []).forEach((segment, segmentIndex) => {
        const coordinates = segment || [];
        const firstCoordinate = coordinates[0];
        const firstPoint = {
            lat: firstCoordinate?.[0],
            lon: firstCoordinate?.[1],
        };
        if (segmentIndex > 0
            && (!previousSegmentEnd
                || !isValidCoordinate(firstPoint.lat, firstPoint.lon)
                || haversineDistanceM(previousSegmentEnd, firstPoint) > MAX_SEGMENT_JOIN_DISTANCE_M)) {
            coordinateGroup++;
        }
        coordinates.forEach(coordinate => {
            const lat = coordinate?.[0];
            const lon = coordinate?.[1];
            if (!isValidCoordinate(lat, lon)) {
                coordinateGroup++;
                return;
            }
            points.push({ lat, lon, coordinateGroup });
        });
        const lastCoordinate = coordinates.at(-1);
        const lastPoint = {
            lat: lastCoordinate?.[0],
            lon: lastCoordinate?.[1],
        };
        previousSegmentEnd = isValidCoordinate(lastPoint.lat, lastPoint.lon) ? lastPoint : null;
    });

    return computeAdjustedDistances(points).distanceM;
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

const timeStateFor = point => {
    if (point.timeState === 'invalid') return 'invalid';
    if (point.timeState === 'missing') return 'missing';
    if (isValidTimestamp(point.ms)) return 'valid';
    return point.ms === undefined || point.ms === null || point.ms === 0 ? 'missing' : 'invalid';
};

const elevationStateFor = point => {
    if (point.elevationState === 'invalid') return 'invalid';
    if (point.elevationState === 'missing') return 'missing';
    if (!Number.isFinite(point.rawEleM)) return 'missing';
    return isPlausibleElevationM(point.rawEleM) ? 'valid' : 'suspect';
};

const summarizeCoordinateQuality = (totalPoints, validPoints) => ({
    status: validPoints === 0 ? 'unavailable' : validPoints === totalPoints ? 'complete' : 'partial',
    totalPoints,
    validPoints,
    invalidPoints: totalPoints - validPoints,
    coverage: totalPoints ? validPoints / totalPoints : 0,
});

const summarizeElevationQuality = points => {
    const counts = { valid: 0, missing: 0, invalid: 0, suspect: 0 };
    points.forEach(point => counts[point.elevationState]++);
    let status = 'unavailable';
    if (counts.valid === points.length && points.length) status = 'complete';
    else if (counts.valid > 0) status = 'partial';
    else if (counts.suspect > 0) status = 'suspect';
    return {
        status,
        totalPoints: points.length,
        validPoints: counts.valid,
        missingPoints: counts.missing,
        invalidPoints: counts.invalid,
        suspectPoints: counts.suspect,
        coverage: points.length ? counts.valid / points.length : 0,
    };
};

const summarizeTimeQuality = points => {
    const counts = { valid: 0, missing: 0, invalid: 0 };
    let minMs = Infinity;
    let maxMs = -Infinity;
    points.forEach(point => {
        counts[point.timeState]++;
        if (point.timeState === 'valid') {
            minMs = Math.min(minMs, point.ms);
            maxMs = Math.max(maxMs, point.ms);
        }
    });
    const hasProgress = counts.valid >= 2 && maxMs > minMs;
    let status = 'unavailable';
    let reason = 'missing';
    if (hasProgress) {
        status = counts.valid === points.length ? 'complete' : 'partial';
        reason = '';
    } else if (counts.valid > 0) {
        status = 'suspect';
        reason = counts.valid < 2 ? 'insufficient' : 'not-progressing';
    } else if (counts.invalid > 0) {
        reason = 'invalid';
    }
    return {
        status,
        reason,
        totalPoints: points.length,
        validPoints: counts.valid,
        missingPoints: counts.missing,
        invalidPoints: counts.invalid,
        coverage: points.length ? counts.valid / points.length : 0,
        hasProgress,
        minMs: hasProgress ? minMs : 0,
        maxMs: hasProgress ? maxMs : 0,
    };
};

const sampledPointSet = (points, groupProperty) => {
    const sampled = new Set(points.filter((point, index) =>
        index % 3 === 0 || index === points.length - 1));
    let groupStart = 0;
    for (let index = 1; index <= points.length; index++) {
        if (index < points.length
            && points[index][groupProperty] === points[groupStart][groupProperty]) continue;
        if (points[groupStart]) sampled.add(points[groupStart]);
        if (points[index - 1]) sampled.add(points[index - 1]);
        groupStart = index;
    }
    return sampled;
};

const sourceCoordinateGroupFor = point => Number.isSafeInteger(point.coordinateGroup)
    && point.coordinateGroup >= 0 ? point.coordinateGroup : null;

const splitSourceSegments = points => {
    const segments = [];
    let current = null;
    points.forEach((point, sourceIndex) => {
        const sourceCoordinateGroup = sourceCoordinateGroupFor(point);
        if (!current || current.sourceCoordinateGroup !== sourceCoordinateGroup) {
            current = {
                sourceCoordinateGroup,
                sourceOrder: segments.length,
                entries: [],
            };
            segments.push(current);
        }
        current.entries.push({ point, sourceIndex });
    });
    return segments;
};

const completeOrderedTimeRange = segment => {
    let previousMs = -Infinity;
    for (const { point } of segment.entries) {
        if (timeStateFor(point) !== 'valid' || point.ms < previousMs) return null;
        previousMs = point.ms;
    }
    return {
        startMs: segment.entries[0].point.ms,
        endMs: segment.entries.at(-1).point.ms,
    };
};

const safelySequenceSourceSegments = points => {
    const segments = splitSourceSegments(points);
    if (segments.length < 2) return segments;

    const timedSegments = segments.map(segment => ({
        ...segment,
        timeRange: completeOrderedTimeRange(segment),
    }));
    if (timedSegments.some(segment => !segment.timeRange)) return segments;

    const chronological = timedSegments.slice().sort((a, b) =>
        a.timeRange.startMs - b.timeRange.startMs || a.sourceOrder - b.sourceOrder);
    const intervalsDoNotOverlap = chronological.every((segment, index) =>
        index === 0 || chronological[index - 1].timeRange.endMs <= segment.timeRange.startMs);
    return intervalsDoNotOverlap ? chronological : segments;
};

const segmentBoundaryContinuity = (previousSegment, currentSegment) => {
    if (!previousSegment || !currentSegment) {
        return { coordinates: false, elevations: false };
    }
    const previous = previousSegment.entries.at(-1).point;
    const current = currentSegment.entries[0].point;
    const distanceM = isValidCoordinate(previous.lat, previous.lon)
        && isValidCoordinate(current.lat, current.lon)
        ? haversineDistanceM(previous, current)
        : Infinity;
    const elapsedSeconds = isValidTimestamp(previous.ms) && isValidTimestamp(current.ms)
        ? Math.abs(current.ms - previous.ms) / 1000
        : 0;
    const isBadJump = elapsedSeconds > 0
        && distanceM > DIST_CONFIRM_M
        && distanceM / elapsedSeconds > MAX_REASONABLE_SPEED_MPS;
    if (!isValidCoordinate(previous.lat, previous.lon)
        || !isValidCoordinate(current.lat, current.lon)
        || distanceM > MAX_SEGMENT_JOIN_DISTANCE_M
        || isBadJump) {
        return { coordinates: false, elevations: false };
    }
    const elevations = elevationStateFor(previous) === 'valid'
        && elevationStateFor(current) === 'valid'
        && Math.abs(previous.rawEleM - current.rawEleM) <= MAX_SEGMENT_JOIN_ELEVATION_DELTA_M;
    return { coordinates: true, elevations };
};

const computeMetrics = points => {
    let coordinateGroup = 0;
    let elevationSourceGroup = 0;
    const routePoints = [];
    const sequencedSegments = safelySequenceSourceSegments(points);
    sequencedSegments.forEach((segment, segmentIndex) => {
        const continuity = segmentBoundaryContinuity(sequencedSegments[segmentIndex - 1], segment);
        if (segmentIndex > 0 && !continuity.coordinates) coordinateGroup++;
        if (segmentIndex > 0 && !continuity.elevations) elevationSourceGroup++;

        segment.entries.forEach(({ point, sourceIndex }) => {
            if (!isValidCoordinate(point.lat, point.lon)) {
                coordinateGroup++;
                elevationSourceGroup++;
                return;
            }
            routePoints.push({
                ...point,
                index: sourceIndex,
                coordinateGroup,
                elevationSourceGroup,
                elevationState: elevationStateFor(point),
                timeState: timeStateFor(point),
            });
        });
    });

    const coordinateQuality = summarizeCoordinateQuality(points.length, routePoints.length);
    if (!routePoints.length) {
        return {
            hasTime: false,
            coordinateQuality,
            elevationQuality: summarizeElevationQuality([]),
            timeQuality: summarizeTimeQuality([]),
            distanceM: 0,
            gainM: 0,
            rawDistanceM: 0,
            rawGainM: 0,
            points: [],
            routePoints: [],
            timePoints: [],
            routeChartPoints: [],
            timeProgressChartPoints: [],
            chartPoints: [],
            timeChartPoints: [],
            startMs: 0,
            endMs: 0,
            summitMs: 0,
            maxEleM: -Infinity
        };
    }

    // Route distance and time belong to every coordinate-valid point, not only
    // the subset whose optional elevation survived. This keeps a missing <ele>
    // sample from replacing a bent route with the straight chord between the
    // nearest elevation samples, or from truncating the trip's clock span.
    // Missing timing on one point no longer erases every trustworthy timestamp.
    // Per-edge distance filtering uses time only when both adjacent values are
    // valid, while time-derived views use the valid chronological subset.
    const timeQuality = summarizeTimeQuality(routePoints);
    const elevationQuality = summarizeElevationQuality(routePoints);
    const hasTime = timeQuality.hasProgress;
    const { distanceM, rawDistanceM, distMByIndex } = computeAdjustedDistances(routePoints);

    let timeCoordinateGroup = 0;
    let previousTimeRouteGroup = null;
    let needsTimeBreak = false;
    const groupedRoutePoints = routePoints.map(point => {
        if (previousTimeRouteGroup !== null && point.coordinateGroup !== previousTimeRouteGroup) {
            timeCoordinateGroup++;
            needsTimeBreak = false;
        }
        previousTimeRouteGroup = point.coordinateGroup;
        if (point.timeState !== 'valid') {
            needsTimeBreak = true;
            return { ...point, timeCoordinateGroup: null };
        }
        if (needsTimeBreak) {
            timeCoordinateGroup++;
            needsTimeBreak = false;
        }
        return { ...point, timeCoordinateGroup };
    });

    const adjustedRoutePoints = groupedRoutePoints.map((point, index) => ({
        lat: point.lat,
        lon: point.lon,
        ms: point.ms || 0,
        coordinateGroup: point.coordinateGroup,
        timeCoordinateGroup: point.timeCoordinateGroup,
        rawEleM: point.rawEleM,
        elevationState: point.elevationState,
        timeState: point.timeState,
        distM: distMByIndex[index],
    }));
    const timePoints = hasTime
        ? adjustedRoutePoints.filter(point => point.timeState === 'valid')
            .sort((a, b) => a.ms - b.ms)
        : [];

    const routeSampled = sampledPointSet(adjustedRoutePoints, 'coordinateGroup');
    const timedRoutePoints = hasTime
        ? adjustedRoutePoints.filter(point => point.timeState === 'valid')
        : [];
    const timeProgressSampled = sampledPointSet(timedRoutePoints, 'timeCoordinateGroup');
    if (hasTime) {
        timeProgressSampled.add(timePoints[0]);
        timeProgressSampled.add(timePoints[timePoints.length - 1]);
        timeProgressSampled.forEach(point => routeSampled.add(point));
    }
    const routeChartPoints = adjustedRoutePoints.filter(point => routeSampled.has(point));
    const timeProgressChartPoints = hasTime
        ? routeChartPoints.filter(point => point.timeState === 'valid')
            .sort((a, b) => a.ms - b.ms)
        : [];

    // Elevation stays independent too. Missing samples split the elevation
    // profile so smoothing, gain, grade, and Chart.js never invent a climb over
    // a portion of the GPX that supplied coordinates but no trustworthy
    // heights. Numerically impossible terrestrial elevations are treated as
    // suspect rather than silently pulling the profile off scale.
    let elevationGroup = 0;
    let previousRouteGroup = null;
    let needsElevationBreak = false;
    const analysisPoints = [];
    groupedRoutePoints.forEach((point, index) => {
        if (previousRouteGroup !== null && point.elevationSourceGroup !== previousRouteGroup) {
            elevationGroup++;
            needsElevationBreak = false;
        }
        previousRouteGroup = point.elevationSourceGroup;
        if (point.elevationState !== 'valid') {
            needsElevationBreak = true;
            return;
        }
        if (needsElevationBreak) {
            elevationGroup++;
            needsElevationBreak = false;
        }
        analysisPoints.push({
            ...point,
            coordinateGroup: elevationGroup,
            distM: distMByIndex[index],
        });
    });

    if (!analysisPoints.length) {
        return {
            hasTime,
            coordinateQuality,
            elevationQuality,
            timeQuality,
            distanceM,
            gainM: 0,
            rawDistanceM,
            rawGainM: 0,
            points: [],
            routePoints: adjustedRoutePoints,
            timePoints,
            routeChartPoints,
            timeProgressChartPoints,
            chartPoints: [],
            timeChartPoints: [],
            startMs: timeQuality.minMs,
            endMs: timeQuality.maxMs,
            summitMs: 0,
            maxEleM: -Infinity
        };
    }

    const analysisDistances = analysisPoints.map(point => point.distM);
    const smoothedElevations = smoothElevations(analysisPoints, analysisDistances);
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
            coordinateGroup: point.coordinateGroup,
            timeCoordinateGroup: point.timeCoordinateGroup,
            rawEleM: point.rawEleM,
            elevationState: point.elevationState,
            timeState: point.timeState,
            eleM,
            distM: point.distM,
            grade: calculateGrade(index, analysisDistances, smoothedElevations, analysisPoints)
        };
    });
    let elevationTimeGroup = 0;
    let previousElevationTimeKey = null;
    const groupedAdjustedPoints = adjustedPoints.map(point => {
        if (point.timeState !== 'valid') {
            return { ...point, timeCoordinateGroup: null };
        }
        const key = `${point.coordinateGroup}:${point.timeCoordinateGroup}`;
        if (previousElevationTimeKey !== null && key !== previousElevationTimeKey) {
            elevationTimeGroup++;
        }
        previousElevationTimeKey = key;
        return { ...point, timeCoordinateGroup: elevationTimeGroup };
    });
    const elevationTimePoints = hasTime
        ? groupedAdjustedPoints.filter(point => point.timeState === 'valid')
            .sort((a, b) => a.ms - b.ms)
        : [];

    // Safely sequenced whole segments own route, distance, gain, and both chart
    // views. Individual samples are never sorted: malformed, partial, or
    // overlapping segment timing leaves source order intact. Array#sort is
    // stable, so equal timestamps retain their relative source order.
    const sampledPoints = sampledPointSet(groupedAdjustedPoints, 'coordinateGroup');
    if (elevationTimePoints.length) {
        // Combined tracks can put the elevation series' chronological endpoints
        // anywhere in GPX order. Keep both in the bounded shared sample so the
        // time chart retains every available end of its own profile.
        sampledPoints.add(elevationTimePoints[0]);
        sampledPoints.add(elevationTimePoints[elevationTimePoints.length - 1]);
    }
    const chartPoints = groupedAdjustedPoints.filter(point => sampledPoints.has(point));
    const timeChartPoints = hasTime
        ? chartPoints.filter(point => point.timeState === 'valid')
            .sort((a, b) => a.ms - b.ms)
        : [];

    return {
        hasTime,
        coordinateQuality,
        elevationQuality,
        timeQuality,
        distanceM,
        gainM,
        rawDistanceM,
        rawGainM,
        points: groupedAdjustedPoints,
        routePoints: adjustedRoutePoints,
        timePoints,
        routeChartPoints,
        timeProgressChartPoints,
        chartPoints,
        timeChartPoints,
        startMs: timeQuality.minMs,
        endMs: timeQuality.maxMs,
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
    MIN_PLAUSIBLE_ELEVATION_M,
    MAX_PLAUSIBLE_ELEVATION_M,
    toRad,
    normalizeLonDelta,
    isValidCoordinate,
    isPlausibleElevationM,
    distanceM: haversineDistanceM,
    computeRouteDistanceM,
    calculateConfirmedGainM,
    computeMetrics,
    limitMapRouteSegments,
    sanitizeMapRouteSegments,
};

export const gpxMetrics = API;
