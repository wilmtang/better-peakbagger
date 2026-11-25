// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure capture/detection helpers shared by the MV3 background worker and tests.
// This file intentionally has no DOM or extension-API dependency. Geometry and
// gain primitives shared with the GPX Analyzer live in src/gpx/gpx-metrics.js.

import { gpxMetrics as Metrics } from '../gpx/gpx-metrics.ts';
import { units as Units } from '../ui/units.ts';
import { MAX_UPLOAD_POINTS, MAX_TRACK_SEGMENTS } from './upload-limits.ts';
import type { MatchClassification } from './match-confidence.ts';

export interface LatLon {
    lat: number;
    lon: number;
}

export interface RawTrackPoint {
    lat?: unknown;
    lon?: unknown;
    ele?: unknown;
    time?: unknown;
    invalidTime?: unknown;
}

export interface TrackPoint {
    lat: number;
    lon: number;
    ele: number | null;
    time: number | null;
}

export interface TrackPointLike {
    lat: number;
    lon: number;
    ele?: number | null;
    time?: number | null;
}

export type TrackSegment = TrackPoint[];

export interface TrackQuality {
    inputPoints: number;
    retainedPoints: number;
    invalidCoordinates: number;
    invalidTimes: number;
    reversedTimes: number;
    extremeSpeeds: number;
    longGaps: number;
    untimedGaps: number;
    spatialGaps: number;
    missingElevation: number;
    suspectElevation: number;
    missingTime: number;
    score: number;
}

export interface SanitizedTrack {
    segments: TrackSegment[];
    quality: TrackQuality;
}

export interface RawWaypoint {
    lat?: unknown;
    lon?: unknown;
    name?: unknown;
    [field: string]: unknown;
}

export interface Waypoint {
    lat: number;
    lon: number;
    name: string;
}

export interface WaypointInput {
    lat: number;
    lon: number;
    name?: string | null;
}

export interface CorridorQueryBox {
    miny: number;
    maxy: number;
    minx: number;
    maxx: number;
}

export interface PeakCandidate {
    id: number;
    name: string;
    location: string;
    lat: number;
    lon: number;
    elevationM: number | null;
    prominenceFt?: number | null;
}

export interface ParsePeakbaggerPeaksOptions {
    maxPeaks?: number;
}

export interface PeakEncounter {
    segmentIndex: number;
    edgeIndex: number;
    fraction: number;
    distanceM: number;
    segmentDistanceM: number;
    globalDistanceM: number;
    lat: number;
    lon: number;
    ele: number | null;
    time: number | null;
}

export interface MatchEvidence {
    distanceM: number;
    elevationDeltaM: number | null;
    localHighDeltaM: number | null;
    trackQuality: number;
    ambiguous?: boolean;
}

export interface PeakMatch extends PeakCandidate {
    encounter: PeakEncounter;
    confidence: number;
    classification: MatchClassification;
    evidence: MatchEvidence;
}

export type AsyncCheckpoint = () => Promise<void> | void;

export interface AsyncCheckpointOptions {
    checkpoint?: AsyncCheckpoint;
}

export interface ReducedTrack {
    segments: TrackSegment[];
    originalPointCount: number;
    retainedPointCount: number;
    maxDeviationM: number;
}

export interface SerializeUploadGpxOptions {
    includeTimestamps?: boolean;
}

export interface DurationParts {
    days: number;
    hours: number;
    minutes: number;
}

export interface ProviderMetadata {
    utcOffsetMinutes?: number | null;
    localStart?: string | null;
    displayedLocalStart?: string | null;
    [field: string]: unknown;
}

export interface FormattedDateTime {
    date: string;
    time: string;
}

export interface DayStat {
    date: string;
    gainM: number | null;
    lossM: number | null;
    distanceM: number | null;
    maxElevationM: number | null;
    campElevationM: number | null;
}

export interface DraftFields {
    date: string;
    time: string;
    startElevationM: number | null;
    endElevationM: number | null;
    upDistanceM: number | null;
    downDistanceM: number | null;
    upGainM: number | null;
    downGainM: number | null;
    upDuration: DurationParts | null;
    downDuration: DurationParts | null;
    quality: ReturnType<typeof Metrics.deriveAscentMetrics>['quality'];
}

export interface PublicMatchInput {
    id: number;
    name: string;
    location: string;
    confidence: number;
    classification: MatchClassification;
    evidence: MatchEvidence;
}

export interface PublicPeakMatch {
    id: number;
    name: string;
    location: string;
    confidence: number;
    classification: MatchClassification;
    selected: boolean;
    evidence: MatchEvidence;
}

export interface CaptureCoreError extends Error {
    code: 'too-many-peaks' | 'too-many-segments' | 'mandatory-point-overflow';
}

interface SegmentProjection {
    distanceM: number;
    fraction: number;
    lat: number;
    lon: number;
}

type TrackBreakReason = 'spatialGaps' | 'reversedTimes' | 'extremeSpeeds' | 'longGaps' | 'untimedGaps';

interface ElevationRangeIndex {
    size: number;
    minima: Float64Array;
    maxima: Float64Array;
}

interface EdgeRecord {
    segmentIndex: number;
    edgeIndex: number;
    singleton: boolean;
}

interface TrackIndex {
    cumulativeBySegment: number[][];
    segmentOffsets: number[];
    elevationBySegment: ElevationRangeIndex[];
    edgeBuckets: Map<string, EdgeRecord[]>;
    polarEdges: EdgeRecord[];
    totalDistanceM: number;
}

interface LatLonBbox {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
}

interface ReductionInterval {
    segmentIndex: number;
    startIndex: number;
    endIndex: number;
    index: number;
    errorM: number;
}

const { FEET_PER_METER } = Units;
const QUERY_PADDING_M = 300;
// How far a corridor query box may reach before it is split.
const QUERY_CHUNK_M = 10000;
// The straight-line step above which sanitization stops calling two
// consecutive fixes one continuous path. Numerically equal to
// QUERY_CHUNK_M today, but a separate constant on purpose: retuning the
// corridor query must not silently retune what counts as a recording gap.
const SPATIAL_GAP_M = 10000;
const ENCOUNTER_WINDOW_M = 300;
const ENCOUNTER_WINDOW_MS = 5 * 60 * 1000;
const SPATIAL_CELL_DEG = 0.05;
const POLAR_INDEX_LAT = 85;
const LONGITUDE_CELL_COUNT = Math.ceil(360 / SPATIAL_CELL_DEG);

// Geometry primitives come from the shared pure module so the corridor
// boxes and the analyzer's chart cannot measure the same track differently.
const { EARTH_RADIUS_M, toRad, normalizeLonDelta, distanceM } = Metrics;
// A longitude past the antimeridian wraps by the same rule as a delta.
const normalizeLon = normalizeLonDelta;

const toDeg = (value: number): number => value * 180 / Math.PI;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const finiteOrNull = (value: unknown): number | null => value === null || value === undefined || value === ''
    ? null
    : (Number.isFinite(Number(value)) ? Number(value) : null);

const codedError = (
    message: string,
    code: CaptureCoreError['code'],
): CaptureCoreError => Object.assign(new Error(message), { code });

// Local tangent-plane projection is stable for the short GPX edges used here
// and handles the antimeridian by normalizing longitude deltas first.
const projectPointToSegment = (point: LatLon, start: LatLon, end: LatLon): SegmentProjection => {
    const cosLat = Math.max(0.01, Math.cos(toRad(point.lat)));
    const xy = (candidate: LatLon) => ({
        x: toRad(normalizeLonDelta(candidate.lon - point.lon)) * EARTH_RADIUS_M * cosLat,
        y: toRad(candidate.lat - point.lat) * EARTH_RADIUS_M
    });
    const a = xy(start);
    const b = xy(end);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared === 0
        ? 0
        : clamp(-(a.x * dx + a.y * dy) / lengthSquared, 0, 1);
    const x = a.x + fraction * dx;
    const y = a.y + fraction * dy;
    const lonDelta = normalizeLonDelta(end.lon - start.lon);
    return {
        distanceM: Math.hypot(x, y),
        fraction,
        lat: start.lat + (end.lat - start.lat) * fraction,
        lon: normalizeLon(start.lon + lonDelta * fraction)
    };
};

const pointSegmentDistanceM = (point: LatLon, start: LatLon, end: LatLon): number =>
    projectPointToSegment(point, start, end).distanceM;

const sanitizeTrack = (
    rawSegments?: readonly (readonly RawTrackPoint[] | null | undefined)[] | null,
): SanitizedTrack => {
    const segments: TrackSegment[] = [];
    const quality: TrackQuality = {
        inputPoints: 0,
        retainedPoints: 0,
        invalidCoordinates: 0,
        invalidTimes: 0,
        reversedTimes: 0,
        extremeSpeeds: 0,
        longGaps: 0,
        untimedGaps: 0,
        spatialGaps: 0,
        missingElevation: 0,
        suspectElevation: 0,
        missingTime: 0,
        score: 0
    };

    const flush = (current: TrackSegment): void => {
        if (current.length) segments.push(current.splice(0));
    };

    for (const rawSegment of rawSegments || []) {
        const current: TrackSegment = [];
        for (const rawPoint of rawSegment || []) {
            quality.inputPoints++;
            const lat = finiteOrNull(rawPoint.lat);
            const lon = finiteOrNull(rawPoint.lon);
            if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                quality.invalidCoordinates++;
                flush(current);
                continue;
            }

            const parsedElevation = finiteOrNull(rawPoint.ele);
            const ele = parsedElevation !== null && Metrics.isPlausibleElevationM(parsedElevation)
                ? parsedElevation
                : null;
            if (parsedElevation !== null && ele === null) quality.suspectElevation++;
            let time = finiteOrNull(rawPoint.time);
            if (rawPoint.invalidTime) {
                quality.invalidTimes++;
                flush(current);
                time = null;
            }

            const point: TrackPoint = { lat, lon, ele, time };
            const previous = current[current.length - 1];
            if (previous) {
                const stepDistanceM = distanceM(previous, point);
                let breakReason: TrackBreakReason | null = null;
                if (stepDistanceM > SPATIAL_GAP_M) {
                    breakReason = 'spatialGaps';
                } else if (previous.time !== null && time !== null) {
                    const elapsedSeconds = (time - previous.time) / 1000;
                    if (elapsedSeconds < 0) breakReason = 'reversedTimes';
                    else if (elapsedSeconds === 0 && stepDistanceM > 100) breakReason = 'extremeSpeeds';
                    else if (elapsedSeconds > 0 && stepDistanceM / elapsedSeconds > 100) breakReason = 'extremeSpeeds';
                    else if (elapsedSeconds > 600 && stepDistanceM > 300) breakReason = 'longGaps';
                } else if (stepDistanceM > 1000) {
                    // With no usable clock there is no defensible way to
                    // interpret a kilometre-scale chord as recorded travel.
                    breakReason = 'untimedGaps';
                }
                if (breakReason) {
                    quality[breakReason]++;
                    flush(current);
                }
            }

            current.push(point);
            quality.retainedPoints++;
            if (ele === null) quality.missingElevation++;
            if (time === null) quality.missingTime++;
        }
        flush(current);
    }

    const breakCount = quality.invalidCoordinates + quality.invalidTimes + quality.reversedTimes
            + quality.extremeSpeeds + quality.longGaps + quality.untimedGaps + quality.spatialGaps;
    const missingTimeRatio = quality.retainedPoints ? quality.missingTime / quality.retainedPoints : 1;
    quality.score = clamp(1 - Math.min(0.35, breakCount * 0.04) - missingTimeRatio * 0.1, 0, 1);
    return { segments, quality };
};

const sanitizeWaypoints = (
    rawWaypoints?: readonly (RawWaypoint | null | undefined)[] | null,
): Waypoint[] => (rawWaypoints || []).flatMap(rawWaypoint => {
    const lat = finiteOrNull(rawWaypoint && rawWaypoint.lat);
    const lon = finiteOrNull(rawWaypoint && rawWaypoint.lon);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return [];
    const name = typeof rawWaypoint?.name === 'string'
        ? rawWaypoint.name.replace(/\s+/g, ' ').trim().slice(0, 200)
        : '';
    return [{ lat, lon, name }];
});

const spatialCellKey = (latIndex: number, lonIndex: number): string =>
    `${latIndex}:${((lonIndex % LONGITUDE_CELL_COUNT) + LONGITUDE_CELL_COUNT) % LONGITUDE_CELL_COUNT}`;

const buildElevationRangeIndex = (segment: readonly TrackPoint[]): ElevationRangeIndex => {
    let size = 1;
    while (size < segment.length) size *= 2;
    const minima = new Float64Array(size * 2);
    const maxima = new Float64Array(size * 2);
    minima.fill(Infinity);
    maxima.fill(-Infinity);
    segment.forEach((point, index) => {
        if (point.ele === null || !Number.isFinite(point.ele)) return;
        minima[size + index] = point.ele;
        maxima[size + index] = point.ele;
    });
    for (let index = size - 1; index > 0; index--) {
        minima[index] = Math.min(minima[index * 2], minima[index * 2 + 1]);
        maxima[index] = Math.max(maxima[index * 2], maxima[index * 2 + 1]);
    }
    return { size, minima, maxima };
};

const queryElevationRange = (
    index: ElevationRangeIndex | null | undefined,
    start: number,
    end: number,
): { min: number | null; max: number | null } => {
    if (!index || start > end) return { min: null, max: null };
    let left = start + index.size;
    let right = end + index.size;
    let min = Infinity;
    let max = -Infinity;
    while (left <= right) {
        if (left % 2 === 1) {
            min = Math.min(min, index.minima[left]);
            max = Math.max(max, index.maxima[left]);
            left++;
        }
        if (right % 2 === 0) {
            min = Math.min(min, index.minima[right]);
            max = Math.max(max, index.maxima[right]);
            right--;
        }
        left = Math.floor(left / 2);
        right = Math.floor(right / 2);
    }
    return {
        min: Number.isFinite(min) ? min : null,
        max: Number.isFinite(max) ? max : null,
    };
};

const lowerBound = (values: readonly number[], target: number): number => {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (values[middle] < target) low = middle + 1;
        else high = middle;
    }
    return low;
};

const upperBound = (values: readonly number[], target: number): number => {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (values[middle] <= target) low = middle + 1;
        else high = middle;
    }
    return low;
};

const buildTrackIndex = (segments: readonly TrackSegment[]): TrackIndex => {
    const cumulativeBySegment: number[][] = [];
    const segmentOffsets: number[] = [];
    const elevationBySegment: ElevationRangeIndex[] = [];
    const edgeBuckets = new Map<string, EdgeRecord[]>();
    const polarEdges: EdgeRecord[] = [];
    let totalDistanceM = 0;
    const latPadding = toDeg(QUERY_PADDING_M / EARTH_RADIUS_M);
    const addEdge = (record: EdgeRecord): void => {
        const start = segments[record.segmentIndex][record.edgeIndex];
        const end = record.singleton
            ? start
            : segments[record.segmentIndex][record.edgeIndex + 1];
        const minLat = Math.max(-90, Math.min(start.lat, end.lat) - latPadding);
        const maxLat = Math.min(90, Math.max(start.lat, end.lat) + latPadding);
        const maxAbsoluteLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
        if (maxAbsoluteLat >= POLAR_INDEX_LAT) {
            polarEdges.push(record);
            return;
        }
        const referenceLon = start.lon;
        const endLon = referenceLon + normalizeLonDelta(end.lon - referenceLon);
        const lonPadding = toDeg(QUERY_PADDING_M
            / (EARTH_RADIUS_M * Math.max(0.01, Math.cos(toRad(maxAbsoluteLat)))));
        const minLon = Math.min(referenceLon, endLon) - lonPadding;
        const maxLon = Math.max(referenceLon, endLon) + lonPadding;
        const minLatCell = Math.floor((minLat + 90) / SPATIAL_CELL_DEG);
        const maxLatCell = Math.floor((maxLat + 90) / SPATIAL_CELL_DEG);
        const minLonCell = Math.floor((minLon + 180) / SPATIAL_CELL_DEG);
        const maxLonCell = Math.floor((maxLon + 180) / SPATIAL_CELL_DEG);
        for (let latCell = minLatCell; latCell <= maxLatCell; latCell++) {
            for (let lonCell = minLonCell; lonCell <= maxLonCell; lonCell++) {
                const key = spatialCellKey(latCell, lonCell);
                let bucket = edgeBuckets.get(key);
                if (!bucket) {
                    bucket = [];
                    edgeBuckets.set(key, bucket);
                }
                bucket.push(record);
            }
        }
    };

    segments.forEach((segment, segmentIndex) => {
        segmentOffsets.push(totalDistanceM);
        const cumulative = [0];
        for (let index = 1; index < segment.length; index++) {
            cumulative[index] = cumulative[index - 1] + distanceM(segment[index - 1], segment[index]);
        }
        cumulativeBySegment.push(cumulative);
        elevationBySegment.push(buildElevationRangeIndex(segment));
        if (segment.length === 1) addEdge({ segmentIndex, edgeIndex: 0, singleton: true });
        else {
            for (let edgeIndex = 0; edgeIndex < segment.length - 1; edgeIndex++) {
                addEdge({ segmentIndex, edgeIndex, singleton: false });
            }
        }
        totalDistanceM += cumulative[cumulative.length - 1] || 0;
    });
    return {
        cumulativeBySegment,
        segmentOffsets,
        elevationBySegment,
        edgeBuckets,
        polarEdges,
        totalDistanceM,
    };
};

const candidateEdges = (trackIndex: TrackIndex, peak: LatLon): EdgeRecord[] => {
    const candidates = [...trackIndex.polarEdges];
    if (Math.abs(peak.lat) >= POLAR_INDEX_LAT) return candidates;
    const latCell = Math.floor((peak.lat + 90) / SPATIAL_CELL_DEG);
    const lonCell = Math.floor((peak.lon + 180) / SPATIAL_CELL_DEG);
    const bucket = trackIndex.edgeBuckets.get(spatialCellKey(latCell, lonCell)) || [];
    if (!candidates.length) return bucket;
    const seen = new Set(candidates.map(record => `${record.segmentIndex}:${record.edgeIndex}`));
    for (const record of bucket) {
        const key = `${record.segmentIndex}:${record.edgeIndex}`;
        if (!seen.has(key)) candidates.push(record);
    }
    return candidates;
};

const bboxDiagonalM = (bbox: LatLonBbox): number => distanceM(
    { lat: bbox.minLat, lon: bbox.minLon },
    { lat: bbox.maxLat, lon: bbox.maxLon }
);

const addPointToBbox = (bbox: LatLonBbox, point: LatLon, referenceLon: number): LatLonBbox => {
    const unwrappedLon = referenceLon + normalizeLonDelta(point.lon - referenceLon);
    return {
        minLat: Math.min(bbox.minLat, point.lat),
        maxLat: Math.max(bbox.maxLat, point.lat),
        minLon: Math.min(bbox.minLon, unwrappedLon),
        maxLon: Math.max(bbox.maxLon, unwrappedLon)
    };
};

const paddedBoxes = (bbox: LatLonBbox): CorridorQueryBox[] => {
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const latPadding = toDeg(QUERY_PADDING_M / EARTH_RADIUS_M);
    const lonPadding = toDeg(QUERY_PADDING_M / (EARTH_RADIUS_M * Math.max(0.01, Math.cos(toRad(midLat)))));
    const minLat = clamp(bbox.minLat - latPadding, -90, 90);
    const maxLat = clamp(bbox.maxLat + latPadding, -90, 90);
    const minLon = bbox.minLon - lonPadding;
    const maxLon = bbox.maxLon + lonPadding;

    if (minLon >= -180 && maxLon <= 180) return [{ miny: minLat, maxy: maxLat, minx: minLon, maxx: maxLon }];
    if (maxLon > 180) {
        return [
            { miny: minLat, maxy: maxLat, minx: minLon, maxx: 180 },
            { miny: minLat, maxy: maxLat, minx: -180, maxx: maxLon - 360 }
        ];
    }
    return [
        { miny: minLat, maxy: maxLat, minx: minLon + 360, maxx: 180 },
        { miny: minLat, maxy: maxLat, minx: -180, maxx: maxLon }
    ];
};

const buildQueryBoxes = (segments: readonly TrackSegment[]): CorridorQueryBox[] => {
    const boxes: CorridorQueryBox[] = [];
    segments.forEach(segment => {
        if (!segment.length) return;
        let chunkStart = 0;
        let chunkDistanceM = 0;
        let referenceLon = segment[0].lon;
        let bbox: LatLonBbox = {
            minLat: segment[0].lat,
            maxLat: segment[0].lat,
            minLon: referenceLon,
            maxLon: referenceLon,
        };

        // Emit the chunk accumulated so far. The mid-loop call always has at
        // least one edge behind it; the call after the loop may have none,
        // because sanitizeTrack's flush() keeps a single-point segment (which
        // findEncountersAsync handles explicitly below). That case wants exactly what
        // this does: bbox is still the degenerate start point, and paddedBoxes
        // turns it into the corridor box around that fix. There is nothing to
        // guard — but the reason is that a zero-edge chunk is correct here, not
        // that it cannot happen.
        const finishChunk = () => boxes.push(...paddedBoxes(bbox));

        for (let index = 1; index < segment.length; index++) {
            const stepM = distanceM(segment[index - 1], segment[index]);
            const proposedBbox = addPointToBbox(bbox, segment[index], referenceLon);
            if (index > chunkStart + 1
                    && (chunkDistanceM + stepM > QUERY_CHUNK_M || bboxDiagonalM(proposedBbox) > QUERY_CHUNK_M)) {
                finishChunk();
                chunkStart = index - 1;
                chunkDistanceM = stepM;
                referenceLon = segment[index - 1].lon;
                bbox = addPointToBbox({
                    minLat: segment[index - 1].lat,
                    maxLat: segment[index - 1].lat,
                    minLon: referenceLon,
                    maxLon: referenceLon
                }, segment[index], referenceLon);
            } else {
                chunkDistanceM += stepM;
                bbox = proposedBbox;
            }
        }
        finishChunk();
    });

    const seen = new Set<string>();
    return boxes.filter(box => {
        const key = [box.miny, box.maxy, box.minx, box.maxx].map(value => value.toFixed(6)).join(':');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
    quot: '"', apos: "'", lt: '<', gt: '>', amp: '&'
});
const decodeXml = (value: unknown): string => String(value || '').replace(
    /&#[xX]([0-9a-fA-F]+);|&#(\d+);|&(quot|apos|lt|gt|amp);/g,
    (match, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
        if (named) return XML_NAMED_ENTITIES[named];
        const codePoint = Number.parseInt(hex ?? decimal ?? '', hex === undefined ? 10 : 16);
        return codePoint <= 0x10FFFF && !(codePoint >= 0xD800 && codePoint <= 0xDFFF)
            ? String.fromCodePoint(codePoint)
            : match;
    }
);

const parsePeakbaggerPeaks = (
    text: string,
    { maxPeaks = Infinity }: ParsePeakbaggerPeaksOptions = {},
): PeakCandidate[] => {
    const peaks: PeakCandidate[] = [];
    const tagPattern = /<t\b([^>]*)\/?\s*>/gi;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagPattern.exec(text))) {
        const attrs: Record<string, string> = {};
        const attrPattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
        let attrMatch: RegExpExecArray | null;
        while ((attrMatch = attrPattern.exec(tagMatch[1]))) attrs[attrMatch[1]] = decodeXml(attrMatch[3]);
        const id = Number.parseInt(attrs.i ?? '', 10);
        const lat = Number.parseFloat(attrs.a ?? '');
        const lon = Number.parseFloat(attrs.o ?? '');
        if (!Number.isInteger(id) || id <= 0
            || !Number.isFinite(lat) || lat < -90 || lat > 90
            || !Number.isFinite(lon) || lon < -180 || lon > 180) continue;
        if (peaks.length >= maxPeaks) {
            throw codedError(
                `Peak response exceeds its ${maxPeaks}-peak limit.`,
                'too-many-peaks',
            );
        }
        const elevationFt = Number.parseFloat(attrs.e ?? '');
        const prominenceFt = Number.parseFloat(attrs.r ?? '');
        peaks.push({
            id,
            name: (attrs.n || `Peak ${id}`).replace(/\s+/g, ' ').trim().slice(0, 200),
            location: (attrs.l || '').replace(/\s+/g, ' ').trim().slice(0, 200),
            lat,
            lon,
            elevationM: Number.isFinite(elevationFt) ? elevationFt / FEET_PER_METER : null,
            prominenceFt: Number.isFinite(prominenceFt) ? prominenceFt : null
        });
    }
    return peaks;
};

const interpolateNullable = (start: number | null, end: number | null, fraction: number): number | null => {
    if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    return start + (end - start) * fraction;
};

const encounterCandidate = (
    segments: readonly TrackSegment[],
    peak: PeakCandidate,
    trackIndex: TrackIndex,
    record: EdgeRecord,
): PeakEncounter | null => {
    const { segmentIndex, edgeIndex } = record;
    const segment = segments[segmentIndex];
    const cumulative = trackIndex.cumulativeBySegment[segmentIndex];
    const offset = trackIndex.segmentOffsets[segmentIndex];
    if (record.singleton) {
        const candidateDistanceM = distanceM(segment[0], peak);
        return candidateDistanceM <= QUERY_PADDING_M ? {
            segmentIndex,
            edgeIndex: 0,
            fraction: 0,
            distanceM: candidateDistanceM,
            segmentDistanceM: 0,
            globalDistanceM: offset,
            lat: segment[0].lat,
            lon: segment[0].lon,
            ele: segment[0].ele,
            time: segment[0].time
        } : null;
    }
    const start = segment[edgeIndex];
    const end = segment[edgeIndex + 1];
    const projected = projectPointToSegment(peak, start, end);
    if (projected.distanceM > QUERY_PADDING_M) return null;
    const edgeLengthM = cumulative[edgeIndex + 1] - cumulative[edgeIndex];
    const segmentDistanceM = cumulative[edgeIndex] + edgeLengthM * projected.fraction;
    return {
        segmentIndex,
        edgeIndex,
        fraction: projected.fraction,
        distanceM: projected.distanceM,
        segmentDistanceM,
        globalDistanceM: offset + segmentDistanceM,
        lat: projected.lat,
        lon: projected.lon,
        ele: interpolateNullable(start.ele, end.ele, projected.fraction),
        time: interpolateNullable(start.time, end.time, projected.fraction)
    };
};

const nearestEncounters = (candidates: PeakEncounter[]): PeakEncounter[] => {
    candidates.sort((a, b) => a.globalDistanceM - b.globalDistanceM);
    const groups: PeakEncounter[][] = [];
    for (const candidate of candidates) {
        const group = groups[groups.length - 1];
        if (!group) {
            groups.push([candidate]);
            continue;
        }
        const previous = group[group.length - 1];
        const closeByDistance = candidate.globalDistanceM - previous.globalDistanceM <= ENCOUNTER_WINDOW_M;
        const closeByTime = candidate.time === null || previous.time === null
                || candidate.time - previous.time <= ENCOUNTER_WINDOW_MS;
        if (candidate.segmentIndex === previous.segmentIndex && closeByDistance && closeByTime) group.push(candidate);
        else groups.push([candidate]);
    }
    return groups.map(group => group.reduce((best, candidate) =>
        candidate.distanceM < best.distanceM ? candidate : best));
};

const findEncountersAsync = async (
    segments: readonly TrackSegment[],
    peak: PeakCandidate,
    trackIndex: TrackIndex,
    checkpoint: AsyncCheckpoint,
): Promise<PeakEncounter[]> => {
    const candidates: PeakEncounter[] = [];
    let visited = 0;
    for (const record of candidateEdges(trackIndex, peak)) {
        if (++visited % 256 === 0) await checkpoint();
        const candidate = encounterCandidate(segments, peak, trackIndex, record);
        if (candidate) candidates.push(candidate);
    }
    return nearestEncounters(candidates);
};

const cubicDecay = (value: number | null, fullAt: number, zeroAt: number): number | null => {
    if (value === null || !Number.isFinite(value)) return null;
    if (value <= fullAt) return 1;
    if (value >= zeroAt) return 0;
    const x = (value - fullAt) / (zeroAt - fullAt);
    return 1 - (3 * x * x - 2 * x * x * x);
};

interface WeightedSignal {
    weight: number;
    value: number | null;
}

const hasSignalValue = (signal: WeightedSignal): signal is { weight: number; value: number } =>
    signal.value !== null;

const scoreEncounter = (
    _segments: readonly TrackSegment[],
    peak: PeakCandidate,
    encounter: PeakEncounter,
    trackIndex: TrackIndex,
    qualityScore: number,
): PeakMatch => {
    const cumulative = trackIndex.cumulativeBySegment[encounter.segmentIndex];
    const elevationIndex = trackIndex.elevationBySegment[encounter.segmentIndex];
    const nearbyStart = lowerBound(cumulative, encounter.segmentDistanceM - ENCOUNTER_WINDOW_M);
    const nearbyEnd = upperBound(cumulative, encounter.segmentDistanceM + ENCOUNTER_WINDOW_M) - 1;
    const localMaxM = queryElevationRange(elevationIndex, nearbyStart, nearbyEnd).max;
    const localHighDeltaM = encounter.ele !== null && localMaxM !== null
        && Number.isFinite(encounter.ele) && Number.isFinite(localMaxM)
        ? Math.max(0, localMaxM - encounter.ele)
        : null;

    const beforeEnd = lowerBound(cumulative, encounter.segmentDistanceM) - 1;
    const afterStart = upperBound(cumulative, encounter.segmentDistanceM);
    const beforeMinM = queryElevationRange(elevationIndex, nearbyStart, beforeEnd).min;
    const afterMinM = queryElevationRange(elevationIndex, afterStart, nearbyEnd).min;
    const shapeParts: number[] = [];
    if (encounter.ele !== null && beforeMinM !== null
        && Number.isFinite(encounter.ele) && Number.isFinite(beforeMinM)) {
        shapeParts.push(clamp((encounter.ele - beforeMinM) / 20, 0, 1));
    }
    if (encounter.ele !== null && afterMinM !== null
        && Number.isFinite(encounter.ele) && Number.isFinite(afterMinM)) {
        shapeParts.push(clamp((encounter.ele - afterMinM) / 20, 0, 1));
    }
    const shapeScore = shapeParts.length
        ? shapeParts.reduce((sum, value) => sum + value, 0) / shapeParts.length
        : null;
    const elevationDeltaM = encounter.ele !== null && peak.elevationM !== null
        && Number.isFinite(encounter.ele) && Number.isFinite(peak.elevationM)
        ? Math.abs(encounter.ele - peak.elevationM)
        : null;

    const signals: WeightedSignal[] = [
        { weight: 0.50, value: cubicDecay(encounter.distanceM, 10, 100) },
        { weight: 0.20, value: cubicDecay(elevationDeltaM, 10, 80) },
        { weight: 0.15, value: cubicDecay(localHighDeltaM, 5, 40) },
        { weight: 0.10, value: shapeScore },
        { weight: 0.05, value: qualityScore }
    ];
    const available = signals.filter(hasSignalValue);
    const availableWeight = available.reduce((sum, signal) => sum + signal.weight, 0);
    let score = availableWeight
        ? available.reduce((sum, signal) => sum + signal.weight * signal.value, 0) / availableWeight
        : 0;
    const hasUsableElevation = elevationDeltaM !== null;
    if (!hasUsableElevation) score = Math.min(score, 0.69);
    if (encounter.distanceM > 30) score = Math.min(score, 0.79);
    const confidence = Math.round(score * 100);

    let classification: MatchClassification = 'weak';
    if (encounter.distanceM <= 150) {
        if (confidence >= 80 && encounter.distanceM <= 30) classification = 'strong';
        else if (confidence >= 60) classification = 'probable';
        else if (confidence >= 35) classification = 'possible';
    }

    return {
        ...peak,
        encounter,
        confidence,
        classification,
        evidence: {
            distanceM: encounter.distanceM,
            elevationDeltaM,
            localHighDeltaM,
            trackQuality: qualityScore
        }
    };
};

// Two encounters are ambiguous with each other when the track cannot
// separate them: they sit within one encounter window by both distance and
// clock (an absent clock cannot separate anything).
const sharesEncounterWindow = (left: PeakEncounter, right: PeakEncounter): boolean => {
    const closeDistance = Math.abs(left.globalDistanceM - right.globalDistanceM) <= ENCOUNTER_WINDOW_M;
    const closeTime = left.time === null || right.time === null
            || Math.abs(left.time - right.time) <= ENCOUNTER_WINDOW_MS;
    return closeDistance && closeTime;
};

const capAmbiguousGroup = (matches: PeakMatch[], group: number[]): void => {
    if (group.length < 2) return;
    group.sort((a, b) => matches[b].confidence - matches[a].confidence);
    const winnerHasLead = matches[group[0]].confidence - matches[group[1]].confidence >= 10;
    group.forEach((matchIndex, position) => {
        if (position === 0 && winnerHasLead) return;
        const match = matches[matchIndex];
        match.confidence = Math.min(match.confidence, 79);
        if (match.confidence >= 60) match.classification = 'probable';
        else if (match.confidence >= 35) match.classification = 'possible';
        else match.classification = 'weak';
        match.evidence.ambiguous = true;
    });
};

const applyAmbiguityCapsAsync = async (
    matches: PeakMatch[],
    checkpoint: AsyncCheckpoint,
): Promise<PeakMatch[]> => {
    const remaining = new Set(matches.map((_match, index) => index));
    let comparisons = 0;
    // Expand the full transitive ambiguity group, independent of peak order.
    while (remaining.size) {
        const seed = remaining.values().next().value;
        if (seed === undefined) break;
        remaining.delete(seed);
        const group = [seed];
        for (let cursor = 0; cursor < group.length; cursor++) {
            for (const index of [...remaining]) {
                if (++comparisons % 256 === 0) await checkpoint();
                if (!sharesEncounterWindow(matches[group[cursor]].encounter, matches[index].encounter)) continue;
                group.push(index);
                remaining.delete(index);
            }
        }
        capAmbiguousGroup(matches, group);
    }
    return matches;
};

const detectPeaksAsync = async (
    segments: readonly TrackSegment[],
    peaks: readonly PeakCandidate[],
    qualityScore = 1,
    { checkpoint = async () => {} }: AsyncCheckpointOptions = {},
): Promise<PeakMatch[]> => {
    const trackIndex = buildTrackIndex(segments);
    await checkpoint();
    const matches: PeakMatch[] = [];
    for (const peak of peaks) {
        const encounters = await findEncountersAsync(segments, peak, trackIndex, checkpoint);
        if (encounters.length) {
            const scored = encounters.map(encounter =>
                scoreEncounter(segments, peak, encounter, trackIndex, qualityScore));
            scored.sort((a, b) => b.confidence - a.confidence || a.evidence.distanceM - b.evidence.distanceM);
            matches.push(scored[0]);
        }
        await checkpoint();
    }
    const capped = await applyAmbiguityCapsAsync(matches, checkpoint);
    return capped.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
};

class MaxHeap {
    private items: ReductionInterval[] = [];

    push(item: ReductionInterval): void {
        this.items.push(item);
        let index = this.items.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.items[parent].errorM >= item.errorM) break;
            this.items[index] = this.items[parent];
            index = parent;
        }
        this.items[index] = item;
    }

    pop(): ReductionInterval | null {
        if (!this.items.length) return null;
        const first = this.items[0];
        const last = this.items.pop();
        if (!last) return first;
        if (!this.items.length) return first;
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            if (left >= this.items.length) break;
            let child = left;
            if (right < this.items.length && this.items[right].errorM > this.items[left].errorM) child = right;
            if (this.items[child].errorM <= last.errorM) break;
            this.items[index] = this.items[child];
            index = child;
        }
        this.items[index] = last;
        return first;
    }

    get length(): number {
        return this.items.length;
    }
}

const reductionAnchors = (
    segments: readonly TrackSegment[],
    matches?: readonly { encounter: Pick<PeakEncounter, 'segmentIndex' | 'edgeIndex'> }[] | null,
): Set<number>[] => {
    const anchors = segments.map(() => new Set<number>());
    segments.forEach((segment, segmentIndex) => {
        if (!segment.length) return;
        anchors[segmentIndex].add(0);
        anchors[segmentIndex].add(segment.length - 1);
        let lowest: { index: number; ele: number } | null = null;
        let highest: { index: number; ele: number } | null = null;
        for (let index = 0; index < segment.length; index++) {
            const point = segment[index];
            if (point.ele === null || !Metrics.isPlausibleElevationM(point.ele)) continue;
            if (!lowest || point.ele < lowest.ele) lowest = { index, ele: point.ele };
            if (!highest || point.ele > highest.ele) highest = { index, ele: point.ele };
        }
        if (lowest && highest) {
            anchors[segmentIndex].add(lowest.index);
            anchors[segmentIndex].add(highest.index);
        }
    });
    for (const match of matches || []) {
        const encounter = match.encounter;
        const segment = segments[encounter.segmentIndex];
        if (!segment) continue;
        anchors[encounter.segmentIndex].add(clamp(encounter.edgeIndex, 0, segment.length - 1));
        anchors[encounter.segmentIndex].add(clamp(encounter.edgeIndex + 1, 0, segment.length - 1));
    }
    return anchors;
};

const intervalCandidateAsync = async (
    segment: readonly TrackPoint[],
    segmentIndex: number,
    startIndex: number,
    endIndex: number,
    checkpoint: AsyncCheckpoint,
): Promise<ReductionInterval | null> => {
    if (endIndex - startIndex <= 1) return null;
    let bestIndex = -1;
    let errorM = -1;
    const midpoint = (startIndex + endIndex) / 2;
    for (let index = startIndex + 1; index < endIndex; index++) {
        if ((index - startIndex) % 256 === 0) await checkpoint();
        const candidateErrorM = pointSegmentDistanceM(segment[index], segment[startIndex], segment[endIndex]);
        if (candidateErrorM > errorM + 1e-9
            || (Math.abs(candidateErrorM - errorM) <= 1e-9
                && Math.abs(index - midpoint) < Math.abs(bestIndex - midpoint))) {
            bestIndex = index;
            errorM = candidateErrorM;
        }
    }
    return { segmentIndex, startIndex, endIndex, index: bestIndex, errorM };
};

const reduceTrackAsync = async (
    segments: readonly TrackSegment[],
    matches?: readonly { encounter: Pick<PeakEncounter, 'segmentIndex' | 'edgeIndex'> }[] | null,
    limit: number = MAX_UPLOAD_POINTS,
    { checkpoint = async () => {} }: AsyncCheckpointOptions = {},
): Promise<ReducedTrack> => {
    const originalPointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (segments.length > MAX_TRACK_SEGMENTS) {
        throw codedError(
            `Track has ${segments.length} segments; Peakbagger allows ${MAX_TRACK_SEGMENTS}.`,
            'too-many-segments',
        );
    }
    if (originalPointCount <= limit) {
        return {
            segments: segments.map(segment => segment.slice()),
            originalPointCount,
            retainedPointCount: originalPointCount,
            maxDeviationM: 0,
        };
    }

    const anchors = reductionAnchors(segments, matches);
    await checkpoint();
    const mandatoryCount = anchors.reduce((sum, set) => sum + set.size, 0);
    if (mandatoryCount > limit) {
        throw codedError(
            `Track requires ${mandatoryCount} protected points, exceeding Peakbagger's ${limit}-point limit.`,
            'mandatory-point-overflow',
        );
    }

    const heap = new MaxHeap();
    for (let segmentIndex = 0; segmentIndex < anchors.length; segmentIndex++) {
        const sorted = [...anchors[segmentIndex]].sort((a, b) => a - b);
        for (let index = 1; index < sorted.length; index++) {
            const candidate = await intervalCandidateAsync(
                segments[segmentIndex],
                segmentIndex,
                sorted[index - 1],
                sorted[index],
                checkpoint,
            );
            if (candidate) heap.push(candidate);
        }
    }

    let retainedPointCount = mandatoryCount;
    while (retainedPointCount < limit && heap.length) {
        const candidate = heap.pop();
        if (!candidate) break;
        const set = anchors[candidate.segmentIndex];
        if (set.has(candidate.index)) continue;
        set.add(candidate.index);
        retainedPointCount++;
        const segment = segments[candidate.segmentIndex];
        const left = await intervalCandidateAsync(
            segment,
            candidate.segmentIndex,
            candidate.startIndex,
            candidate.index,
            checkpoint,
        );
        const right = await intervalCandidateAsync(
            segment,
            candidate.segmentIndex,
            candidate.index,
            candidate.endIndex,
            checkpoint,
        );
        if (left) heap.push(left);
        if (right) heap.push(right);
        if (retainedPointCount % 64 === 0) await checkpoint();
    }

    let maxDeviationM = 0;
    const reducedSegments: TrackSegment[] = [];
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];
        const retained = [...anchors[segmentIndex]].sort((a, b) => a - b);
        for (let retainedIndex = 1; retainedIndex < retained.length; retainedIndex++) {
            const startIndex = retained[retainedIndex - 1];
            const endIndex = retained[retainedIndex];
            for (let index = startIndex + 1; index < endIndex; index++) {
                if ((index - startIndex) % 256 === 0) await checkpoint();
                maxDeviationM = Math.max(
                    maxDeviationM,
                    pointSegmentDistanceM(segment[index], segment[startIndex], segment[endIndex]),
                );
            }
        }
        reducedSegments.push(retained.map(index => segment[index]));
        await checkpoint();
    }

    return { segments: reducedSegments, originalPointCount, retainedPointCount, maxDeviationM };
};

const escapeXml = (value: unknown): string => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const serializeUploadGpx = (
    segments: readonly (readonly TrackPointLike[])[],
    waypoints: readonly WaypointInput[] = [],
    { includeTimestamps = true }: SerializeUploadGpxOptions = {},
): string => {
    const waypointBody = waypoints.map(waypoint => {
        const name = waypoint.name ? `<name>${escapeXml(waypoint.name)}</name>` : '';
        return `<wpt lat="${waypoint.lat}" lon="${waypoint.lon}">${name}</wpt>`;
    }).join('');
    const body = segments.map(segment => {
        const points = segment.map(point => {
            const elevation = point.ele !== null && point.ele !== undefined
                && Metrics.isPlausibleElevationM(point.ele)
                ? `<ele>${point.ele}</ele>`
                : '';
            const date = includeTimestamps && point.time !== null && point.time !== undefined
                && Number.isFinite(point.time)
                ? new Date(point.time)
                : null;
            const isoTime = date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
            const time = isoTime
                ? `<time>${isoTime.endsWith('.000Z') ? isoTime.slice(0, -5) + 'Z' : isoTime}</time>`
                : '';
            return `<trkpt lat="${point.lat}" lon="${point.lon}">${elevation}${time}</trkpt>`;
        }).join('');
        return `<trkseg>${points}</trkseg>`;
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>'
            + '<gpx version="1.1" creator="Better Peakbagger" xmlns="http://www.topografix.com/GPX/1/1">'
            + `${waypointBody}<trk>${body}</trk></gpx>`;
};

const firstFinite = (
    segments: readonly (readonly TrackPointLike[])[],
    key: 'lat' | 'lon' | 'ele' | 'time',
    reverse = false,
): number | null => {
    const source = segments || [];
    const outer = reverse ? source.slice().reverse() : source;
    for (const segment of outer) {
        const inner = reverse ? segment.slice().reverse() : segment;
        const point = inner.find(candidate => {
            const value = candidate[key];
            return typeof value === 'number' && Number.isFinite(value);
        });
        if (point) {
            const value = point[key];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
    }
    return null;
};

const durationParts = (minutesValue: number | null | undefined): DurationParts | null => {
    if (typeof minutesValue !== 'number' || !Number.isFinite(minutesValue)) return null;
    const totalMinutes = Math.max(0, Math.round(minutesValue));
    return {
        days: Math.floor(totalMinutes / 1440),
        hours: Math.floor((totalMinutes % 1440) / 60),
        minutes: totalMinutes % 60
    };
};

const cleanUtcOffsetMinutes = (value: unknown): number | null =>
    typeof value === 'number' && Metrics.isValidUtcOffsetMinutes(value) ? value : null;

const parseUtcOffsetSuffix = (value: unknown): number | null => {
    const match = /([+-])(\d{2}):(\d{2})$/.exec(typeof value === 'string' ? value : '');
    if (!match) return null;
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    if (minutes > 59) return null;
    const magnitude = hours * 60 + minutes;
    const offset = match[1] === '-' ? -magnitude : magnitude;
    return cleanUtcOffsetMinutes(offset);
};

const timezoneOffsetMinutes = (
    providerMeta?: ProviderMetadata | null,
    referenceTime: number | null = null,
): number => {
    const explicit = cleanUtcOffsetMinutes(providerMeta && providerMeta.utcOffsetMinutes);
    if (explicit !== null) return explicit;
    const parsed = parseUtcOffsetSuffix(providerMeta && providerMeta.localStart);
    if (parsed !== null) return parsed;
    const wallClock = providerMeta && providerMeta.displayedLocalStart;
    if (wallClock && referenceTime !== null && Number.isFinite(referenceTime)) {
        const wallClockAsUtc = Date.parse(`${wallClock}Z`);
        const derived = Math.round((wallClockAsUtc - referenceTime) / 60000);
        if (Number.isFinite(wallClockAsUtc) && cleanUtcOffsetMinutes(derived) !== null) return derived;
    }
    return 0;
};

// The result carries no "was the offset resolved or assumed" flag. One used
// to ride along, but nothing ever read it and it could not be trusted: it
// reported a known timezone whenever displayedLocalStart was merely
// present, including the cases where timezoneOffsetMinutes had rejected it
// as unparseable or out of range and quietly fallen back to UTC. Anything
// that needs that distinction must get it from timezoneOffsetMinutes, which
// is where the decision is actually made.
const formatEncounterDateTime = (
    time: number | null | undefined,
    providerMeta?: ProviderMetadata | null,
    referenceTime: number | null = null,
): FormattedDateTime => {
    if (typeof time !== 'number' || !Number.isFinite(time)) return { date: '', time: '' };
    const offsetMinutes = timezoneOffsetMinutes(providerMeta, referenceTime);
    const date = new Date(time + offsetMinutes * 60 * 1000);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return {
        date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
        time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
    };
};

const calculateTripDate = (
    segments: readonly (readonly TrackPointLike[])[],
    providerMeta: ProviderMetadata = {},
): string => {
    const firstTime = firstFinite(segments, 'time');
    return formatEncounterDateTime(firstTime, providerMeta, firstTime).date
        || (providerMeta.displayedLocalStart || '').slice(0, 10);
};

const calculateNightsOut = (
    segments: readonly (readonly TrackPointLike[])[],
    providerMeta: ProviderMetadata = {},
): number | null => {
    const firstTime = firstFinite(segments, 'time');
    const lastTime = firstFinite(segments, 'time', true);
    if (firstTime === null || lastTime === null || !Number.isFinite(firstTime)
            || !Number.isFinite(lastTime) || lastTime < firstTime) return null;
    const offsetMs = timezoneOffsetMinutes(providerMeta, firstTime) * 60 * 1000;
    const firstDay = Math.floor((firstTime + offsetMs) / 86400000);
    const lastDay = Math.floor((lastTime + offsetMs) / 86400000);
    return Math.max(0, lastDay - firstDay);
};

const calculateDayStats = (
    segments: readonly TrackSegment[],
    providerMeta: ProviderMetadata = {},
): DayStat[] => {
    const firstTime = firstFinite(segments, 'time');
    const lastTime = firstFinite(segments, 'time', true);
    const points = (segments || []).flat();
    if (firstTime === null || lastTime === null || !Number.isFinite(firstTime)
            || !Number.isFinite(lastTime) || lastTime < firstTime
            || !points.length || points.some(point => point.time === null || !Number.isFinite(point.time))) return [];

    const dayMs = 24 * 60 * 60 * 1000;
    const offsetMs = timezoneOffsetMinutes(providerMeta, firstTime) * 60 * 1000;
    const firstDay = Math.floor((firstTime + offsetMs) / dayMs);
    const lastDay = Math.floor((lastTime + offsetMs) / dayMs);
    // Peakbagger's Wilderness Nights selector currently supports 0–100.
    // Refuse a pathological timestamp span rather than building an
    // unbounded payload for rows the page cannot expose.
    if (lastDay - firstDay + 1 > 101) return [];
    const pathsByDay = new Map<number, TrackSegment[]>();
    const appendPath = (day: number, path: TrackSegment): void => {
        if (!path.length) return;
        let paths = pathsByDay.get(day);
        if (!paths) {
            paths = [];
            pathsByDay.set(day, paths);
        }
        paths.push(path);
    };

    for (const segment of segments) {
        let currentDay: number | null = null;
        let currentPath: TrackSegment = [];
        let previous: TrackPoint | null = null;
        for (const point of segment) {
            if (point.time === null) continue;
            const day = Math.floor((point.time + offsetMs) / dayMs);
            if (currentDay === null) {
                currentDay = day;
                currentPath = [point];
            } else if (day !== currentDay) {
                appendPath(currentDay, currentPath);
                currentDay = day;
                // Preserve the cross-midnight edge exactly once by assigning
                // it to the new day. The prior point is also the best known
                // start/camp position when the recorder was idle overnight.
                currentPath = previous ? [previous, point] : [point];
            } else {
                currentPath.push(point);
            }
            previous = point;
        }
        if (currentDay !== null) appendPath(currentDay, currentPath);
    }

    const pad = (value: number): string => String(value).padStart(2, '0');
    const formatDay = (day: number): string => {
        const date = new Date(day * dayMs);
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    };

    const result: DayStat[] = [];
    for (let day = firstDay; day <= lastDay; day++) {
        const paths = pathsByDay.get(day) || [];
        const metrics = Metrics.computeMetricsForSegments(paths);
        const rawStartElevationM = metrics.routePoints[0]?.rawEleM;
        const rawEndElevationM = metrics.routePoints.at(-1)?.rawEleM;
        const elevationComplete = metrics.elevationQuality.status === 'complete'
            && typeof rawStartElevationM === 'number' && Number.isFinite(rawStartElevationM)
            && typeof rawEndElevationM === 'number' && Number.isFinite(rawEndElevationM);
        const startElevationM = elevationComplete ? rawStartElevationM : null;
        const endElevationM = elevationComplete ? rawEndElevationM : null;
        const gainM = elevationComplete ? metrics.gainM : null;
        const lossM = elevationComplete && gainM !== null && startElevationM !== null && endElevationM !== null
            ? Math.max(0, gainM + startElevationM - endElevationM)
            : null;
        result.push({
            date: formatDay(day),
            gainM,
            lossM,
            distanceM: metrics.coordinateQuality.status === 'complete' ? metrics.distanceM : null,
            maxElevationM: elevationComplete ? metrics.maxEleM : null,
            campElevationM: elevationComplete && day < lastDay ? endElevationM : null
        });
    }
    return result;
};

const calculateDraftFields = (
    segments: readonly TrackSegment[],
    match: { encounter: NonNullable<Parameters<typeof Metrics.deriveAscentMetrics>[1]> },
    providerMeta: ProviderMetadata = {},
): DraftFields => {
    const encounter = match.encounter;
    const firstTime = firstFinite(segments, 'time');
    const derived = Metrics.deriveAscentMetrics([...segments], encounter);
    const dateTime = formatEncounterDateTime(derived.encounterTime, providerMeta, firstTime);
    // A timeless encounter still deserves the activity's own start date.
    if (!dateTime.date && providerMeta.displayedLocalStart) {
        dateTime.date = providerMeta.displayedLocalStart.slice(0, 10);
    }
    return {
        date: dateTime.date,
        time: dateTime.time,
        startElevationM: derived.startElevationM,
        endElevationM: derived.endElevationM,
        upDistanceM: derived.upDistanceM,
        downDistanceM: derived.downDistanceM,
        upGainM: derived.upGainM,
        downGainM: derived.downGainM,
        upDuration: durationParts(derived.upDurationMinutes),
        downDuration: durationParts(derived.downDurationMinutes),
        quality: derived.quality,
    };
};

const suffixForIndex = (index: number): string => {
    let value = index + 1;
    let suffix = '';
    while (value > 0) {
        value--;
        suffix = String.fromCharCode(97 + (value % 26)) + suffix;
        value = Math.floor(value / 26);
    }
    return suffix;
};

const assignDraftSuffixes = <
    D extends { date?: string; upDistanceM?: number | null },
    T extends { draftFields: D },
>(matches: readonly T[]) => {
    const result = matches.map(match => ({
        ...match,
        draftFields: { ...match.draftFields, suffix: '' }
    }));
    const byDate = new Map<string, { match: (typeof result)[number]; index: number }[]>();
    result.forEach((match, index) => {
        const date = match.draftFields.date;
        if (!date) return;
        let group = byDate.get(date);
        if (!group) {
            group = [];
            byDate.set(date, group);
        }
        group.push({ match, index });
    });
    for (const group of byDate.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) => {
            const aDistance = a.match.draftFields.upDistanceM;
            const bDistance = b.match.draftFields.upDistanceM;
            if (typeof aDistance === 'number' && typeof bDistance === 'number'
                && Number.isFinite(aDistance) && Number.isFinite(bDistance) && aDistance !== bDistance) {
                return aDistance - bDistance;
            }
            return a.index - b.index;
        });
        group.forEach(({ match }, index) => { match.draftFields.suffix = suffixForIndex(index); });
    }
    return result;
};

const prepareDraftSelection = <
    D extends { date?: string; upDistanceM?: number | null },
    T extends { id: number | string; name: string; confidence?: number; draftFields: D },
>(matches: readonly T[]) => {
    const selected = assignDraftSuffixes(matches);
    const trackOrdered = selected.map((match, index) => ({ match, index }))
        .sort((left, right) => {
            const leftDistance = left.match.draftFields.upDistanceM;
            const rightDistance = right.match.draftFields.upDistanceM;
            return typeof leftDistance === 'number' && typeof rightDistance === 'number'
                && Number.isFinite(leftDistance) && Number.isFinite(rightDistance)
                && leftDistance !== rightDistance
                ? leftDistance - rightDistance : left.index - right.index;
        })
        .map(({ match }) => match);
    return {
        matches: selected,
        confidenceOrdered: [...selected].sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0)),
        trackOrdered,
        sequenceById: new Map(trackOrdered.map((match, index) => [String(match.id), index + 1])),
        fallbackTripName: trackOrdered.map(match => match.name).join(' / ').slice(0, 200),
    };
};

const publicMatch = (match: PublicMatchInput): PublicPeakMatch => ({
    id: match.id,
    name: match.name,
    location: match.location,
    confidence: match.confidence,
    classification: match.classification,
    selected: match.classification === 'strong',
    evidence: match.evidence
});

const API = {
    FEET_PER_METER,
    MAX_UPLOAD_POINTS,
    MAX_TRACK_SEGMENTS,
    distanceM,
    sanitizeTrack,
    sanitizeWaypoints,
    buildQueryBoxes,
    parsePeakbaggerPeaks,
    detectPeaksAsync,
    reduceTrackAsync,
    serializeUploadGpx,
    calculateDraftFields,
    calculateTripDate,
    calculateNightsOut,
    calculateDayStats,
    assignDraftSuffixes,
    prepareDraftSelection,
    publicMatch,
    formatEncounterDateTime,
    cleanUtcOffsetMinutes
};

export const captureCore = API;
