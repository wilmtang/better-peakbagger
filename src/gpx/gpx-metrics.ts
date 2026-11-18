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

import { MAX_MAP_ROUTE_POINTS, MAX_MAP_ROUTE_SEGMENTS } from './map-route-limits.ts';

export interface GeoPoint {
    lat: number;
    lon: number;
}

export interface MaybeGeoPoint {
    readonly lat?: number | null;
    readonly lon?: number | null;
}

export type CoordinateQualityStatus = 'unavailable' | 'partial' | 'complete';

export interface CoordinateQuality {
    status: CoordinateQualityStatus;
    totalPoints: number;
    validPoints: number;
    invalidPoints: number;
    coverage: number;
}

export type ElevationState = 'valid' | 'missing' | 'invalid' | 'suspect';
export type ElevationQualityStatus = 'unavailable' | 'partial' | 'complete' | 'suspect';

export interface ElevationQuality {
    status: ElevationQualityStatus;
    totalPoints: number;
    validPoints: number;
    missingPoints: number;
    invalidPoints: number;
    suspectPoints: number;
    coverage: number;
}

export type TimeState = 'valid' | 'missing' | 'invalid';
export type TimeQualityStatus = 'unavailable' | 'partial' | 'complete' | 'suspect';
export type TimeQualityReason = '' | 'missing' | 'invalid' | 'insufficient' | 'not-progressing';

export interface TimeQuality {
    status: TimeQualityStatus;
    reason: TimeQualityReason;
    totalPoints: number;
    validPoints: number;
    missingPoints: number;
    invalidPoints: number;
    coverage: number;
    hasProgress: boolean;
    minMs: number;
    maxMs: number;
}

export interface MetricPointInput {
    lat?: number | null;
    lon?: number | null;
    rawEleM?: number | null;
    ms?: number | null;
    coordinateGroup?: number | null;
    elevationState?: ElevationState;
    timeState?: TimeState;
    draftEncounter?: boolean;
}

export interface RouteMetricPoint {
    lat: number;
    lon: number;
    ms: number;
    coordinateGroup: number;
    timeCoordinateGroup: number | null;
    rawEleM: number | null | undefined;
    elevationState: ElevationState;
    timeState: TimeState;
    sourceIndex: number;
    draftEncounter: boolean;
    distM: number;
}

export interface AdjustedMetricPoint {
    lat: number;
    lon: number;
    ms: number;
    coordinateGroup: number;
    timeCoordinateGroup: number | null;
    rawEleM: number;
    elevationState: ElevationState;
    timeState: TimeState;
    sourceIndex: number;
    draftEncounter: boolean;
    eleM: number;
    distM: number;
    grade: number;
}

export interface ComputeMetricsResult {
    hasTime: boolean;
    coordinateQuality: CoordinateQuality;
    elevationQuality: ElevationQuality;
    timeQuality: TimeQuality;
    distanceM: number;
    gainM: number;
    rawDistanceM: number;
    rawGainM: number;
    points: AdjustedMetricPoint[];
    routePoints: RouteMetricPoint[];
    timePoints: RouteMetricPoint[];
    routeChartPoints: RouteMetricPoint[];
    timeProgressChartPoints: RouteMetricPoint[];
    chartPoints: AdjustedMetricPoint[];
    timeChartPoints: AdjustedMetricPoint[];
    startMs: number;
    endMs: number;
    summitMs: number;
    maxEleM: number;
}

export interface SegmentTrackPointInput {
    lat?: number | null;
    lon?: number | null;
    ele?: number | null;
    time?: number | null;
    invalidTime?: boolean;
    draftEncounter?: boolean;
}

export interface DraftEncounterInput {
    segmentIndex?: number | null;
    edgeIndex?: number | null;
    fraction?: number | null;
    distanceM?: number | null;
    segmentDistanceM?: number | null;
    globalDistanceM?: number | null;
    lat?: number | null;
    lon?: number | null;
    ele?: number | null;
    time?: number | null;
}

export interface AscentMetricsQuality {
    coordinates: CoordinateQuality;
    elevation: ElevationQuality;
    time: TimeQuality;
    upElevationComplete: boolean;
    downElevationComplete: boolean;
}

export interface AscentMetrics {
    startElevationM: number | null;
    endElevationM: number | null;
    upDistanceM: number | null;
    downDistanceM: number | null;
    upGainM: number | null;
    downGainM: number | null;
    upDurationMinutes: number | null;
    downDurationMinutes: number | null;
    encounterTime: number | null;
    quality: AscentMetricsQuality | null;
}

export interface SampleChartPointsOptions<T> {
    groupProperty?: (keyof T & string) | (string & {});
    valueProperty?: (keyof T & string) | (string & {});
    required?: readonly T[];
}

interface ConfirmedClimb {
    valley: number;
    valleyIndex: number;
    peak: number;
    peakIndex: number;
    gainM: number;
}

interface SourceSegmentEntry {
    point: MetricPointInput;
    sourceIndex: number;
}

interface SourceSegment {
    sourceCoordinateGroup: number | null;
    sourceOrder: number;
    entries: SourceSegmentEntry[];
}

interface TimeRange {
    startMs: number;
    endMs: number;
}

interface TimedSourceSegment extends SourceSegment {
    timeRange: TimeRange;
}

interface InternalRoutePoint extends MetricPointInput {
    lat: number;
    lon: number;
    index: number;
    coordinateGroup: number;
    elevationSourceGroup: number;
    elevationState: ElevationState;
    timeState: TimeState;
}

interface AnalysisPoint extends InternalRoutePoint {
    rawEleM: number;
    timeCoordinateGroup: number | null;
    distM: number;
}

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
const MIN_UTC_OFFSET_MINUTES = -14 * 60;
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

const EARTH_RADIUS_M = 6371008.8;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

const toRad = (x: number): number => x * Math.PI / 180;

const isValidCoordinate = (lat: unknown, lon: unknown): boolean => isFiniteNumber(lat) && lat >= -90 && lat <= 90
    && isFiniteNumber(lon) && lon >= -180 && lon <= 180;

const isValidGeoPoint = <T extends MaybeGeoPoint>(point: T): point is T & GeoPoint =>
    isValidCoordinate(point.lat, point.lon);

const isValidTimestamp = (ms: unknown): ms is number => isFiniteNumber(ms) && ms > 0;

const isValidUtcOffsetMinutes = (value: unknown): value is number => isFiniteNumber(value)
    && value >= MIN_UTC_OFFSET_MINUTES
    && value <= MAX_UTC_OFFSET_MINUTES;

const longitudeUtcOffsetMinutes = (longitude: unknown): number | null => isFiniteNumber(longitude)
        && longitude >= -180 && longitude <= 180
    ? Math.round(longitude / 15) * 60
    : null;

const isPlausibleElevationM = (elevationM: unknown): elevationM is number => isFiniteNumber(elevationM)
    && elevationM >= MIN_PLAUSIBLE_ELEVATION_M
    && elevationM <= MAX_PLAUSIBLE_ELEVATION_M;

const normalizeLonDelta = (delta: number): number => {
    let result = delta;
    while (result > 180) result -= 360;
    while (result < -180) result += 360;
    return result;
};

// Canonical haversine shared with src/capture/capture-core.js (exported as
// `distanceM`). Longitude deltas are normalized so antimeridian-crossing
// edges measure the short way. Named to avoid shadowing by the local
// cumulative-distance variables below.
const haversineDistanceM = (a: GeoPoint, b: GeoPoint): number => {
    const latDelta = toRad(b.lat - a.lat);
    const lonDelta = toRad(normalizeLonDelta(b.lon - a.lon));
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(latDelta / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

// Nearest distance to minor great-circle arcs, including edge interiors.
// Ambiguous antipodal geometry returns NaN so classification cannot assume a
// remote point. Vector projection handles antimeridian and polar routes.
const distanceToPathM = (point: MaybeGeoPoint, path: readonly MaybeGeoPoint[]): number => {
    if (!isValidGeoPoint(point) || !path.length) return NaN;
    const validPath: GeoPoint[] = [];
    for (const p of path) {
        if (!isValidGeoPoint(p)) return NaN;
        validPath.push(p);
    }
    const vector = (p: GeoPoint): [number, number, number] => {
        const lat = toRad(p.lat), lon = toRad(p.lon);
        return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    };
    const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, x, i) => sum + x * b[i], 0);
    const cross = (a: readonly number[], b: readonly number[]): [number, number, number] =>
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a: readonly number[]): number => Math.hypot(...a);
    const angle = (a: readonly number[], b: readonly number[]): number => Math.atan2(norm(cross(a, b)), dot(a, b));
    const p = vector(point);
    let a = vector(validPath[0]);
    let minimum = angle(p, a);
    for (let i = 1; i < validPath.length; i++) {
        const b = vector(validPath[i]);
        const arc = angle(a, b);
        if (arc > Math.PI - 1e-6) return NaN;
        minimum = Math.min(minimum, angle(p, b));
        const normal = cross(a, b);
        const length = norm(normal);
        if (length > 1e-12) {
            const unitNormal = normal.map(x => x / length);
            const projection = p.map((x, j) => x - dot(p, unitNormal) * unitNormal[j]);
            const projectionLength = norm(projection);
            if (projectionLength > 1e-12) {
                const foot = projection.map(x => x / projectionLength);
                // Only the near projection can improve endpoint distance.
                if (angle(a, foot) + angle(foot, b) <= arc + 1e-10) {
                    minimum = Math.min(minimum, angle(p, foot));
                }
            }
        }
        a = b;
    }
    return minimum * EARTH_RADIUS_M;
};

const median = (values: readonly number[]): number => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const calculatePositiveGainM = (elevations: readonly number[]): number => elevations.reduce((gain, ele, index) => {
    if (index === 0) return gain;
    const delta = ele - elevations[index - 1];
    return delta > 0 ? gain + delta : gain;
}, 0);

const confirmedClimbs = (elevations: readonly number[]): ConfirmedClimb[] => {
    if (elevations.length < 2) return [];

    let valley = elevations[0];
    let valleyIndex = 0;
    let peak = elevations[0];
    let peakIndex = 0;
    let state: 'unknown' | 'rising' | 'falling' = 'unknown';
    const climbs: ConfirmedClimb[] = [];

    for (let index = 0; index < elevations.length; index++) {
        const ele = elevations[index];
        if (state === 'rising') {
            if (ele > peak) {
                peak = ele;
                peakIndex = index;
            } else if (peak - ele >= ELEVATION_GAIN_THRESHOLD_M) {
                climbs.push({ valley, valleyIndex, peak, peakIndex, gainM: peak - valley });
                state = 'falling';
                valley = ele;
                valleyIndex = index;
                peak = ele;
                peakIndex = index;
            }
            continue;
        }

        if (ele < valley) {
            valley = ele;
            valleyIndex = index;
            peak = ele;
            peakIndex = index;
            continue;
        }

        if (ele - valley >= ELEVATION_GAIN_THRESHOLD_M) {
            state = 'rising';
            peak = ele;
            peakIndex = index;
        }
    }

    if (state === 'rising') {
        climbs.push({ valley, valleyIndex, peak, peakIndex, gainM: peak - valley });
    }

    return climbs;
};

const calculateConfirmedGainM = (elevations: readonly number[]): number => confirmedClimbs(elevations)
    .reduce((sum, climb) => sum + climb.gainM, 0);

const smoothElevations = (points: readonly AnalysisPoint[], distMByIndex: readonly number[]): number[] => {
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
        const windowValues: number[] = [];

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

const computeAdjustedDistances = (points: readonly InternalRoutePoint[]): {
    distanceM: number;
    rawDistanceM: number;
    distMByIndex: number[];
} => {
    const distMByIndex = new Array<number>(points.length).fill(0);
    if (points.length < 2) {
        return { distanceM: 0, rawDistanceM: 0, distMByIndex };
    }

    let distanceM = 0;
    let rawDistanceM = 0;
    let anchor = points[0];
    let prev = points[0];
    let pendingSteps: number[] = [];
    let pendingIndices: number[] = [];

    const resetPending = (current: InternalRoutePoint): void => {
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

const calculateGrade = (
    index: number,
    distMByIndex: readonly number[],
    elevations: readonly number[],
    points: readonly AnalysisPoint[],
): number => {
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

const sumByCoordinateGroup = (
    points: readonly AnalysisPoint[],
    values: readonly number[],
    calculate: (groupValues: number[]) => number,
): number => {
    let total = 0;
    let start = 0;
    for (let index = 1; index <= points.length; index++) {
        if (index < points.length && points[index].coordinateGroup === points[start].coordinateGroup) continue;
        total += calculate(values.slice(start, index));
        start = index;
    }
    return total;
};

const timeStateFor = (point: MetricPointInput): TimeState => {
    if (point.timeState === 'invalid') return 'invalid';
    if (point.timeState === 'missing') return 'missing';
    if (isValidTimestamp(point.ms)) return 'valid';
    return point.ms === undefined || point.ms === null || point.ms === 0 ? 'missing' : 'invalid';
};

const elevationStateFor = (point: MetricPointInput): ElevationState => {
    if (point.elevationState === 'invalid') return 'invalid';
    if (point.elevationState === 'missing') return 'missing';
    if (!isFiniteNumber(point.rawEleM)) return 'missing';
    return isPlausibleElevationM(point.rawEleM) ? 'valid' : 'suspect';
};

const summarizeCoordinateQuality = (totalPoints: number, validPoints: number): CoordinateQuality => ({
    status: validPoints === 0 ? 'unavailable' : validPoints === totalPoints ? 'complete' : 'partial',
    totalPoints,
    validPoints,
    invalidPoints: totalPoints - validPoints,
    coverage: totalPoints ? validPoints / totalPoints : 0,
});

const summarizeElevationQuality = (points: readonly { elevationState: ElevationState }[]): ElevationQuality => {
    const counts = { valid: 0, missing: 0, invalid: 0, suspect: 0 };
    points.forEach(point => counts[point.elevationState]++);
    let status: ElevationQualityStatus = 'unavailable';
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

const summarizeTimeQuality = (points: readonly { timeState: TimeState; ms?: number | null }[]): TimeQuality => {
    const counts = { valid: 0, missing: 0, invalid: 0 };
    let minMs = Infinity;
    let maxMs = -Infinity;
    points.forEach(point => {
        counts[point.timeState]++;
        if (point.timeState === 'valid' && isValidTimestamp(point.ms)) {
            minMs = Math.min(minMs, point.ms);
            maxMs = Math.max(maxMs, point.ms);
        }
    });
    const hasProgress = counts.valid >= 2 && maxMs > minMs;
    let status: TimeQualityStatus = 'unavailable';
    let reason: TimeQualityReason = 'missing';
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

const readProperty = (point: object | null | undefined, key: string): unknown =>
    point ? (point as unknown as Record<string, unknown>)[key] : undefined;

const sampledPointSet = <T extends object>(points: readonly T[], groupProperty: string): Set<T> => {
    const sampled = new Set<T>(points.filter((_point, index) =>
        index % 3 === 0 || index === points.length - 1));
    let groupStart = 0;
    for (let index = 1; index <= points.length; index++) {
        if (index < points.length
            && readProperty(points[index], groupProperty) === readProperty(points[groupStart], groupProperty)) continue;
        if (points[groupStart]) sampled.add(points[groupStart]);
        if (points[index - 1]) sampled.add(points[index - 1]);
        groupStart = index;
    }
    return sampled;
};

// Reduce a chart view to the number of samples its canvas can distinguish.
// Endpoints, explicit selections, global extrema, and ordinary group
// boundaries take priority; bucket extrema preserve the remaining profile
// shape. Pathological files can contain more disconnected groups than pixels,
// so boundary candidates are themselves sampled rather than defeating the
// hard work bound.
const sampleChartPoints = <T extends object>(points: readonly T[], maxPoints: number, {
    groupProperty = 'coordinateGroup',
    valueProperty = 'eleM',
    required = [],
}: SampleChartPointsOptions<T> = {}): T[] => {
    if (!Array.isArray(points) || !points.length) return [];
    const limit = Math.max(2, Math.floor(Number(maxPoints) || 0));
    if (points.length <= limit) return points.slice();

    const selected = new Set<T>();
    const add = (point: T | undefined): void => {
        if (point && selected.size < limit) selected.add(point);
    };
    const addEvenly = (candidates: readonly T[], count: number): void => {
        if (count <= 0 || !candidates.length) return;
        if (candidates.length <= count) {
            candidates.forEach(add);
            return;
        }
        for (let index = 0; index < count; index++) {
            const sourceIndex = count === 1
                ? Math.floor((candidates.length - 1) / 2)
                : Math.round(index * (candidates.length - 1) / (count - 1));
            add(candidates[sourceIndex]);
        }
    };

    const numericValue = (point: T): number => {
        const value = readProperty(point, valueProperty);
        return isFiniteNumber(value) ? value : Number.NaN;
    };

    add(points[0]);
    add(points.at(-1));
    required.forEach(point => {
        if (points.includes(point)) add(point);
    });

    const finiteValues = points.filter(point => isFiniteNumber(readProperty(point, valueProperty)));
    if (finiteValues.length) {
        add(finiteValues.reduce((minimum, point) =>
            numericValue(point) < numericValue(minimum) ? point : minimum));
        add(finiteValues.reduce((maximum, point) =>
            numericValue(point) > numericValue(maximum) ? point : maximum));
    }

    const boundaries: T[] = [];
    let groupStart = 0;
    for (let index = 1; index <= points.length; index++) {
        if (index < points.length
            && readProperty(points[index], groupProperty) === readProperty(points[groupStart], groupProperty)) continue;
        boundaries.push(points[groupStart], points[index - 1]);
        groupStart = index;
    }
    const boundaryCandidates = [...new Set(boundaries)].filter(point => !selected.has(point));
    addEvenly(boundaryCandidates, Math.min(boundaryCandidates.length, limit - selected.size));

    const remaining = limit - selected.size;
    if (remaining > 0) {
        const bucketCount = Math.max(1, Math.floor(remaining / 2));
        const extrema: T[] = [];
        for (let bucket = 0; bucket < bucketCount; bucket++) {
            const start = Math.floor(bucket * points.length / bucketCount);
            const end = Math.max(start + 1, Math.floor((bucket + 1) * points.length / bucketCount));
            const bucketPoints = points.slice(start, end)
                .filter(point => isFiniteNumber(readProperty(point, valueProperty)));
            if (!bucketPoints.length) continue;
            let minimum = bucketPoints[0];
            let maximum = bucketPoints[0];
            bucketPoints.forEach(point => {
                if (numericValue(point) < numericValue(minimum)) minimum = point;
                if (numericValue(point) > numericValue(maximum)) maximum = point;
            });
            extrema.push(minimum);
            if (maximum !== minimum) extrema.push(maximum);
        }
        extrema.forEach(add);
    }

    if (selected.size < limit) {
        addEvenly(points.filter(point => !selected.has(point)), limit - selected.size);
    }
    return points.filter(point => selected.has(point));
};

const sourceCoordinateGroupFor = (point: MetricPointInput): number | null => isSafeInteger(point.coordinateGroup)
    && point.coordinateGroup >= 0 ? point.coordinateGroup : null;

const splitSourceSegments = (points: readonly MetricPointInput[]): SourceSegment[] => {
    const segments: SourceSegment[] = [];
    let current: SourceSegment | null = null;
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

const completeOrderedTimeRange = (segment: SourceSegment): TimeRange | null => {
    let previousMs = -Infinity;
    for (const { point } of segment.entries) {
        if (timeStateFor(point) !== 'valid' || !isValidTimestamp(point.ms) || point.ms < previousMs) return null;
        previousMs = point.ms;
    }
    const firstMs = segment.entries[0]?.point.ms;
    const lastMs = segment.entries.at(-1)?.point.ms;
    if (!isValidTimestamp(firstMs) || !isValidTimestamp(lastMs)) return null;
    return {
        startMs: firstMs,
        endMs: lastMs,
    };
};

const hasTimeRange = (segment: SourceSegment & { timeRange: TimeRange | null }): segment is TimedSourceSegment =>
    segment.timeRange !== null;

const safelySequenceSourceSegments = (points: readonly MetricPointInput[]): SourceSegment[] => {
    const segments = splitSourceSegments(points);
    if (segments.length < 2) return segments;

    const timedSegments = segments.map(segment => ({
        ...segment,
        timeRange: completeOrderedTimeRange(segment),
    }));
    const validTimedSegments = timedSegments.filter(hasTimeRange);
    if (validTimedSegments.length !== segments.length) return segments;

    const chronological = validTimedSegments.slice().sort((a, b) =>
        a.timeRange.startMs - b.timeRange.startMs || a.sourceOrder - b.sourceOrder);
    const intervalsDoNotOverlap = chronological.every((segment, index) =>
        index === 0 || chronological[index - 1].timeRange.endMs <= segment.timeRange.startMs);
    return intervalsDoNotOverlap ? chronological : segments;
};

const segmentBoundaryContinuity = (
    previousSegment: SourceSegment | undefined,
    currentSegment: SourceSegment | undefined,
): { coordinates: boolean; elevations: boolean } => {
    if (!previousSegment || !currentSegment) {
        return { coordinates: false, elevations: false };
    }
    const previousEntry = previousSegment.entries.at(-1);
    const currentEntry = currentSegment.entries[0];
    if (!previousEntry || !currentEntry) {
        return { coordinates: false, elevations: false };
    }
    const previous = previousEntry.point;
    const current = currentEntry.point;
    if (!isValidGeoPoint(previous) || !isValidGeoPoint(current)) {
        return { coordinates: false, elevations: false };
    }
    const distanceM = haversineDistanceM(previous, current);
    const elapsedSeconds = isValidTimestamp(previous.ms) && isValidTimestamp(current.ms)
        ? Math.abs(current.ms - previous.ms) / 1000
        : 0;
    const isBadJump = elapsedSeconds > 0
        && distanceM > DIST_CONFIRM_M
        && distanceM / elapsedSeconds > MAX_REASONABLE_SPEED_MPS;
    if (distanceM > MAX_SEGMENT_JOIN_DISTANCE_M || isBadJump) {
        return { coordinates: false, elevations: false };
    }
    const elevations = elevationStateFor(previous) === 'valid'
        && elevationStateFor(current) === 'valid'
        && isFiniteNumber(previous.rawEleM)
        && isFiniteNumber(current.rawEleM)
        && Math.abs(previous.rawEleM - current.rawEleM) <= MAX_SEGMENT_JOIN_ELEVATION_DELTA_M;
    return { coordinates: true, elevations };
};

const computeMetrics = (points: readonly MetricPointInput[]): ComputeMetricsResult => {
    let coordinateGroup = 0;
    let elevationSourceGroup = 0;
    const routePoints: InternalRoutePoint[] = [];
    const sequencedSegments = safelySequenceSourceSegments(points);
    sequencedSegments.forEach((segment, segmentIndex) => {
        const continuity = segmentBoundaryContinuity(sequencedSegments[segmentIndex - 1], segment);
        if (segmentIndex > 0 && !continuity.coordinates) coordinateGroup++;
        if (segmentIndex > 0 && !continuity.elevations) elevationSourceGroup++;

        segment.entries.forEach(({ point, sourceIndex }) => {
            if (!isValidGeoPoint(point)) {
                coordinateGroup++;
                elevationSourceGroup++;
                return;
            }
            routePoints.push({
                ...point,
                lat: point.lat,
                lon: point.lon,
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
    let previousTimeRouteGroup: number | null = null;
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

    const adjustedRoutePoints: RouteMetricPoint[] = groupedRoutePoints.map((point, index) => ({
        lat: point.lat,
        lon: point.lon,
        ms: point.ms || 0,
        coordinateGroup: point.coordinateGroup,
        timeCoordinateGroup: point.timeCoordinateGroup,
        rawEleM: point.rawEleM,
        elevationState: point.elevationState,
        timeState: point.timeState,
        sourceIndex: point.index,
        draftEncounter: point.draftEncounter === true,
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
    let previousRouteGroup: number | null = null;
    let needsElevationBreak = false;
    const analysisPoints: AnalysisPoint[] = [];
    groupedRoutePoints.forEach((point, index) => {
        if (previousRouteGroup !== null && point.elevationSourceGroup !== previousRouteGroup) {
            elevationGroup++;
            needsElevationBreak = false;
        }
        previousRouteGroup = point.elevationSourceGroup;
        if (point.elevationState !== 'valid' || !isFiniteNumber(point.rawEleM)) {
            needsElevationBreak = true;
            return;
        }
        if (needsElevationBreak) {
            elevationGroup++;
            needsElevationBreak = false;
        }
        analysisPoints.push({
            ...point,
            rawEleM: point.rawEleM,
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
    const adjustedPoints: AdjustedMetricPoint[] = analysisPoints.map((point, index) => {
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
            sourceIndex: point.index,
            draftEncounter: point.draftEncounter === true,
            eleM,
            distM: point.distM,
            grade: calculateGrade(index, analysisDistances, smoothedElevations, analysisPoints)
        };
    });
    let elevationTimeGroup = 0;
    let previousElevationTimeKey: string | null = null;
    const groupedAdjustedPoints: AdjustedMetricPoint[] = adjustedPoints.map(point => {
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

const metricPointsForSegments = (
    segments: ReadonlyArray<ReadonlyArray<SegmentTrackPointInput>> | null | undefined,
): MetricPointInput[] => (segments || []).flatMap((segment, coordinateGroup) =>
    (segment || []).map(point => ({
        lat: point.lat,
        lon: point.lon,
        rawEleM: point.ele,
        elevationState: isFiniteNumber(point.ele)
            ? (isPlausibleElevationM(point.ele) ? 'valid' : 'suspect')
            : 'missing',
        ms: point.time,
        timeState: point.invalidTime
            ? 'invalid'
            : (isValidTimestamp(point.time) ? 'valid' : 'missing'),
        coordinateGroup,
        draftEncounter: point.draftEncounter === true,
    })));

const computeMetricsForSegments = (
    segments: ReadonlyArray<ReadonlyArray<SegmentTrackPointInput>> | null | undefined,
): ComputeMetricsResult => computeMetrics(metricPointsForSegments(segments));

const withDraftEncounter = (
    segments: ReadonlyArray<ReadonlyArray<SegmentTrackPointInput>> | null | undefined,
    encounter: DraftEncounterInput | null | undefined,
): SegmentTrackPointInput[][] | null => {
    const segmentIndex = isSafeInteger(encounter?.segmentIndex)
        ? encounter.segmentIndex
        : -1;
    const edgeIndex = isSafeInteger(encounter?.edgeIndex)
        ? encounter.edgeIndex
        : -1;
    if (!encounter || segmentIndex < 0 || edgeIndex < 0 || !segments?.[segmentIndex]?.[edgeIndex]) return null;

    const result: SegmentTrackPointInput[][] = segments.map(segment => segment.slice());
    const segment = result[segmentIndex];
    const fraction = isFiniteNumber(encounter.fraction)
        ? Math.max(0, Math.min(1, encounter.fraction))
        : 0;
    if (fraction <= 0 || edgeIndex >= segment.length - 1) {
        segment[edgeIndex] = { ...segment[edgeIndex], draftEncounter: true };
    } else if (fraction >= 1) {
        segment[edgeIndex + 1] = { ...segment[edgeIndex + 1], draftEncounter: true };
    } else {
        segment.splice(edgeIndex + 1, 0, {
            lat: encounter.lat,
            lon: encounter.lon,
            ele: isPlausibleElevationM(encounter.ele) ? encounter.ele : null,
            time: isValidTimestamp(encounter.time) ? encounter.time : null,
            draftEncounter: true,
        });
    }
    return result;
};

const completeDurationMinutes = (points: readonly RouteMetricPoint[]): number | null => {
    if (points.length < 2 || points.some(point => point.timeState !== 'valid')) return null;
    for (let index = 1; index < points.length; index++) {
        if (points[index].ms < points[index - 1].ms) return null;
    }
    const last = points.at(-1);
    if (!last) return null;
    const minutes = (last.ms - points[0].ms) / 60000;
    return minutes > 0 ? minutes : null;
};

const partitionConfirmedGain = (
    points: readonly AdjustedMetricPoint[],
    encounterIndex: number,
): { upGainM: number; downGainM: number } => {
    let upGainM = 0;
    let downGainM = 0;
    let groupStart = 0;
    for (let index = 1; index <= points.length; index++) {
        if (index < points.length
            && points[index].coordinateGroup === points[groupStart].coordinateGroup) continue;
        const group = points.slice(groupStart, index);
        const splitIndex = encounterIndex >= groupStart && encounterIndex < index
            ? encounterIndex - groupStart
            : null;
        for (const climb of confirmedClimbs(group.map(point => point.eleM))) {
            if (index - 1 <= encounterIndex) {
                upGainM += climb.gainM;
            } else if (groupStart >= encounterIndex) {
                downGainM += climb.gainM;
            } else if (splitIndex !== null && climb.peakIndex <= splitIndex) {
                upGainM += climb.gainM;
            } else if (splitIndex !== null && climb.valleyIndex >= splitIndex) {
                downGainM += climb.gainM;
            } else if (splitIndex !== null) {
                const upPart = Math.max(0, Math.min(
                    climb.gainM,
                    group[splitIndex].eleM - climb.valley,
                ));
                upGainM += upPart;
                downGainM += climb.gainM - upPart;
            }
        }
        groupStart = index;
    }
    return { upGainM, downGainM };
};

const deriveAscentMetrics = (
    segments: ReadonlyArray<ReadonlyArray<SegmentTrackPointInput>> | null | undefined,
    encounter: DraftEncounterInput | null | undefined,
): AscentMetrics => {
    const markedSegments = withDraftEncounter(segments, encounter);
    if (!markedSegments) {
        return {
            startElevationM: null,
            endElevationM: null,
            upDistanceM: null,
            downDistanceM: null,
            upGainM: null,
            downGainM: null,
            upDurationMinutes: null,
            downDurationMinutes: null,
            encounterTime: null,
            quality: null,
        };
    }
    const metrics = computeMetricsForSegments(markedSegments);
    const encounterRouteIndex = metrics.routePoints.findIndex(point => point.draftEncounter);
    const encounterElevationIndex = metrics.points.findIndex(point => point.draftEncounter);
    const routeComplete = metrics.coordinateQuality.status === 'complete'
        && encounterRouteIndex !== -1;
    const startPoint = metrics.routePoints[0];
    const endPoint = metrics.routePoints.at(-1);
    const upRoute = routeComplete ? metrics.routePoints.slice(0, encounterRouteIndex + 1) : [];
    const downRoute = routeComplete ? metrics.routePoints.slice(encounterRouteIndex) : [];
    const upElevationComplete = upRoute.length > 0
        && upRoute.every(point => point.elevationState === 'valid');
    const downElevationComplete = downRoute.length > 0
        && downRoute.every(point => point.elevationState === 'valid');
    const partitionedGain = encounterElevationIndex === -1
        ? { upGainM: null, downGainM: null }
        : partitionConfirmedGain(metrics.points, encounterElevationIndex);

    return {
        startElevationM: startPoint?.elevationState === 'valid' && isFiniteNumber(startPoint.rawEleM)
            ? startPoint.rawEleM
            : null,
        endElevationM: endPoint?.elevationState === 'valid' && isFiniteNumber(endPoint.rawEleM)
            ? endPoint.rawEleM
            : null,
        upDistanceM: routeComplete ? metrics.routePoints[encounterRouteIndex].distM : null,
        downDistanceM: routeComplete
            ? Math.max(0, metrics.distanceM - metrics.routePoints[encounterRouteIndex].distM)
            : null,
        upGainM: upElevationComplete ? partitionedGain.upGainM : null,
        downGainM: downElevationComplete ? partitionedGain.downGainM : null,
        upDurationMinutes: routeComplete ? completeDurationMinutes(upRoute) : null,
        downDurationMinutes: routeComplete ? completeDurationMinutes(downRoute) : null,
        encounterTime: routeComplete && metrics.routePoints[encounterRouteIndex].timeState === 'valid'
            ? metrics.routePoints[encounterRouteIndex].ms
            : null,
        quality: {
            coordinates: metrics.coordinateQuality,
            elevation: metrics.elevationQuality,
            time: metrics.timeQuality,
            upElevationComplete,
            downElevationComplete,
        },
    };
};

const sampleRouteSegment = <T>(points: readonly T[], targetCount: number): T[] => {
    if (points.length <= targetCount) return points.slice();
    if (targetCount <= 2) return [points[0], points[points.length - 1]];

    return Array.from({ length: targetCount }, (_, index) => {
        const sourceIndex = Math.round(index * (points.length - 1) / (targetCount - 1));
        return points[sourceIndex];
    });
};

function limitMapRouteSegments<T>(segments: T[][]): T[][];
function limitMapRouteSegments<T>(segments: readonly (readonly T[])[]): (readonly T[])[];
function limitMapRouteSegments<T>(segments: readonly (readonly T[])[]): (readonly T[])[] {
    const pointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (pointCount <= MAX_MAP_ROUTE_POINTS) return segments.slice();

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
}

const sanitizeMapRouteSegments = (
    segments: ReadonlyArray<ReadonlyArray<ReadonlyArray<number | null | undefined> | null | undefined> | null | undefined> | null | undefined,
): [number, number][][] => {
    const sanitized: [number, number][][] = [];
    const flush = (current: [number, number][]): void => {
        if (current.length >= 2) sanitized.push(current.splice(0));
        else current.length = 0;
    };

    for (const segment of segments || []) {
        const current: [number, number][] = [];
        for (const coordinate of segment || []) {
            const lat = coordinate?.[0];
            const lon = coordinate?.[1];
            if (isFiniteNumber(lat) && isFiniteNumber(lon) && isValidCoordinate(lat, lon)) {
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
    isValidTimestamp,
    isValidUtcOffsetMinutes,
    longitudeUtcOffsetMinutes,
    isPlausibleElevationM,
    distanceM: haversineDistanceM,
    distanceToPathM,
    sampleChartPoints,
    computeMetrics,
    computeMetricsForSegments,
    deriveAscentMetrics,
    limitMapRouteSegments,
    sanitizeMapRouteSegments,
};

export const gpxMetrics = API;
