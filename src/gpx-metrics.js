// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Better Peakbagger — pure GPX metrics pipeline. Loaded into the page MAIN
// world immediately before src/gpx-analyzer.js (see manifest.json) and into
// tests. This file intentionally has no DOM or extension-API dependency:
// input is parsed track points, output is adjusted distances, smoothed
// elevations, confirmed gain, grades, and bounded map-route sampling.

    const DIST_CONFIRM_M = 5;
    const ELEVATION_GAIN_THRESHOLD_M = 3;
    const ELEVATION_SMOOTH_WINDOW_M = 30;
    const ELEVATION_SMOOTH_POINT_RADIUS = 10;
    const GRADE_WINDOW_M = 60;
    const GRADE_MIN_DISTANCE_M = 10;
    const GRADE_MAX_LOOKBACK_POINTS = 50;
    const MAX_REASONABLE_SPEED_MPS = 10;
    const PAUSE_RESET_SECONDS = 300;
    const MAX_MAP_ROUTE_POINTS = 3000;

    const EARTH_RADIUS_M = 6371008.8;

    const toRad = x => x * Math.PI / 180;

    const normalizeLonDelta = delta => {
        let result = delta;
        while (result > 180) result -= 360;
        while (result < -180) result += 360;
        return result;
    };

    // Canonical haversine shared with src/capture-core.js (exported as
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
            return median(points.slice(start, end).map(p => p.rawEleM));
        });

        const halfWindowM = ELEVATION_SMOOTH_WINDOW_M / 2;
        return medianElevations.map((ele, index) => {
            const centerDistM = distMByIndex[index];
            const windowValues = [];

            for (let i = index; i >= Math.max(0, index - ELEVATION_SMOOTH_POINT_RADIUS); i--) {
                if (centerDistM - distMByIndex[i] > halfWindowM) break;
                windowValues.push(medianElevations[i]);
            }

            for (let i = index + 1; i < Math.min(medianElevations.length, index + ELEVATION_SMOOTH_POINT_RADIUS + 1); i++) {
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

    const calculateGrade = (index, distMByIndex, elevations) => {
        const centerDistM = distMByIndex[index];
        let baselineIndex = index;

        while (baselineIndex > 0 && index - baselineIndex < GRADE_MAX_LOOKBACK_POINTS && centerDistM - distMByIndex[baselineIndex] < GRADE_WINDOW_M) {
            baselineIndex--;
        }

        const distDiffM = centerDistM - distMByIndex[baselineIndex];
        if (distDiffM < GRADE_MIN_DISTANCE_M) return 0;
        return ((elevations[index] - elevations[baselineIndex]) / distDiffM) * 100;
    };

    const computeMetrics = points => {
        const validPoints = points
            .map((point, index) => ({ ...point, index }))
            .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(point.rawEleM));

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

        const hasTime = validPoints.every(point => Number.isFinite(point.ms) && point.ms > 0);
        const sortedPoints = validPoints.slice().sort((a, b) => {
            if (hasTime && a.ms !== b.ms) return a.ms - b.ms;
            return a.index - b.index;
        });

        const { distanceM, rawDistanceM, distMByIndex } = computeAdjustedDistances(sortedPoints, hasTime);
        const smoothedElevations = smoothElevations(sortedPoints, distMByIndex);
        const rawGainM = calculatePositiveGainM(sortedPoints.map(point => point.rawEleM));
        const gainM = calculateConfirmedGainM(smoothedElevations);

        let maxEleM = -Infinity;
        let summitMs = 0;
        const adjustedPoints = sortedPoints.map((point, index) => {
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
                grade: calculateGrade(index, distMByIndex, smoothedElevations)
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
            summitMs,
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
        // a gap or silently truncate it. Pathological GPX with more than 1,500
        // usable segments keeps Peakbagger's native route instead of drawing an
        // incomplete enhancement.
        if (segments.length * 2 > MAX_MAP_ROUTE_POINTS) return [];

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

    const API = {
        // Geometry primitives shared with src/capture-core.js, which loads
        // after this module in the background worker.
        EARTH_RADIUS_M,
        toRad,
        normalizeLonDelta,
        distanceM: haversineDistanceM,
        calculateConfirmedGainM,
        computeMetrics,
        limitMapRouteSegments
    };

    export const gpxMetrics = API;
