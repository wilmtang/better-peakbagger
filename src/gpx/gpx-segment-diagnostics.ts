// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Saved-ascent interpretation only. Parsing and shared computeMetrics callers
// deliberately do not apply this policy (in particular, activity capture).
import { gpxMetrics as M, type ElevationState, type MetricPointInput, type TimeState } from './gpx-metrics.ts';
import type { ParsedQualityState } from './gpx-parse.ts';
import { MAX_GPX_TRACK_POINTS, MAX_GPX_TRACK_SEGMENTS, gpxLimitMessage } from '../capture/capture-resource-limits.ts';

export const SEGMENT_POLICY = Object.freeze({ minPoints: 8, minDistanceM: 100,
    isolatedTimeGapMs: 24 * 60 * 60_000, isolatedDistanceM: 50_000 });

export interface DiagnosticSegmentPoint {
    lat?: number | null;
    lon?: number | null;
    ele?: number | null;
    time?: number | null;
    invalidTime?: boolean;
    elevationState?: ParsedQualityState | ElevationState;
    timeState?: ParsedQualityState | TimeState;
}

export type SegmentDisposition = 'retained' | 'excluded' | 'warning';

export type SegmentDispositionReason =
    | 'degenerate-duplicate'
    | 'ambiguous-duplicate'
    | 'constant-time'
    | 'isolated-distant-point'
    | 'ambiguous-activity';

export interface SegmentComparison {
    donorSegmentId: number;
    timeGapMs: number;
    pathDistanceM: number;
}

export interface SegmentEvidence {
    distanceM: number;
    startMs: number | null;
    endMs: number | null;
    comparisons?: SegmentComparison[];
}

export interface GpxSegmentInventoryEntry<TPoint extends DiagnosticSegmentPoint = DiagnosticSegmentPoint> {
    sourceSegmentId: number;
    sourcePointIds: string[];
    points: readonly TPoint[];
    pointCount: number;
    disposition: SegmentDisposition;
    reason: SegmentDispositionReason | null;
    donorSegmentId: number | null;
    evidence: SegmentEvidence;
    validCoordinates: boolean;
    substantial: boolean;
    progressingTime: boolean;
    completeElevation: boolean;
    zeroElevation: boolean;
    constantTime: boolean;
}

export interface GpxSegmentDiagnostics<TPoint extends DiagnosticSegmentPoint = DiagnosticSegmentPoint> {
    inventory: GpxSegmentInventoryEntry<TPoint>[];
    sourcePointCount: number;
    excludedSegmentCount: number;
    excludedPointCount: number;
    warningSegmentCount: number;
}

export interface DiagnosticMetricInput extends MetricPointInput {
    sourcePointId: string;
}

const validTime = (point: DiagnosticSegmentPoint): point is DiagnosticSegmentPoint & { time: number } =>
    point.timeState === 'valid' && M.isValidTimestamp(point.time);
const validElevation = (point: DiagnosticSegmentPoint): point is DiagnosticSegmentPoint & { ele: number } =>
    point.elevationState === 'valid' && M.isPlausibleElevationM(point.ele);

function validRouteDistanceM(points: readonly DiagnosticSegmentPoint[]): number | null {
    if (!points.length) return null;
    let prev: { lat: number; lon: number } | null = null;
    let distanceM = 0;
    for (const p of points) {
        if (typeof p.lat !== 'number' || typeof p.lon !== 'number' || !M.isValidCoordinate(p.lat, p.lon)) {
            return null;
        }
        const curr = { lat: p.lat, lon: p.lon };
        if (prev) distanceM += M.distanceM(prev, curr);
        prev = curr;
    }
    return distanceM;
}

function orderedTimeRange(points: readonly DiagnosticSegmentPoint[]): { startMs: number; endMs: number } | null {
    if (!points.length) return null;
    let prevTime = -Infinity;
    let startMs = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!validTime(p)) return null;
        if (i === 0) startMs = p.time;
        else if (p.time < prevTime) return null;
        prevTime = p.time;
    }
    return { startMs, endMs: prevTime };
}

function describe<TPoint extends DiagnosticSegmentPoint>(
    points: readonly TPoint[],
    sourceSegmentId: number,
): GpxSegmentInventoryEntry<TPoint> {
    const maybeDistanceM = validRouteDistanceM(points);
    const validCoordinates = maybeDistanceM !== null;
    const distanceM = maybeDistanceM ?? 0;
    const timeRange = orderedTimeRange(points);
    const startMs = timeRange ? timeRange.startMs : null;
    const endMs = timeRange ? timeRange.endMs : null;
    return {
        sourceSegmentId, sourcePointIds: points.map((_, i) => `${sourceSegmentId}:${i}`),
        points, pointCount: points.length, disposition: 'retained', reason: null, donorSegmentId: null,
        evidence: { distanceM, startMs, endMs }, validCoordinates,
        substantial: validCoordinates && points.length >= SEGMENT_POLICY.minPoints && distanceM >= SEGMENT_POLICY.minDistanceM,
        progressingTime: timeRange !== null && timeRange.endMs > timeRange.startMs,
        completeElevation: points.length > 0 && points.every(validElevation) && points.some(p => p.ele !== 0),
        zeroElevation: points.length > 0 && points.every(p => validElevation(p) && p.ele === 0),
        constantTime: timeRange !== null && timeRange.endMs === timeRange.startMs,
    };
}

export function diagnoseGpxSegments<TPoint extends DiagnosticSegmentPoint = DiagnosticSegmentPoint>(
    segments: readonly (readonly TPoint[])[],
): GpxSegmentDiagnostics<TPoint> {
    const sourcePointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (segments.length > MAX_GPX_TRACK_SEGMENTS || sourcePointCount > MAX_GPX_TRACK_POINTS) {
        throw new Error(gpxLimitMessage());
    }
    const inventory = segments.map(describe);
    // Exact numeric sequences form buckets. Equality is verified below rather
    // than treating a fingerprint alone as authority to exclude source data.
    const geometry = new Map<string, GpxSegmentInventoryEntry<TPoint>[]>();
    for (const segment of inventory.filter(s => s.substantial)) {
        const key = segment.points.map(p => `${p.lat},${p.lon}`).join(';');
        const bucket = geometry.get(key) || [];
        bucket.push(segment);
        geometry.set(key, bucket);
    }
    for (const bucket of geometry.values()) {
        for (const candidate of bucket) {
            const donors = bucket.filter(other => other !== candidate && other.progressingTime
                && other.completeElevation && other.evidence.startMs === candidate.evidence.startMs
                && other.points.length === candidate.points.length
                && other.points.every((p, i) => p.lat === candidate.points[i].lat && p.lon === candidate.points[i].lon));
            if (candidate.zeroElevation && candidate.constantTime && donors.length === 1) {
                candidate.disposition = 'excluded';
                candidate.reason = 'degenerate-duplicate';
                candidate.donorSegmentId = donors[0].sourceSegmentId;
            } else if (candidate.zeroElevation && candidate.constantTime && donors.length > 1) {
                candidate.disposition = 'warning';
                candidate.reason = 'ambiguous-duplicate';
            }
        }
    }
    for (const segment of inventory) {
        if (segment.disposition === 'retained' && segment.substantial && segment.constantTime) {
            segment.disposition = 'warning';
            segment.reason = 'constant-time';
        }
    }
    // Only one remaining multi-point recording may own an automatic decision.
    // Multiple singleton breadcrumbs could be a connecting recording: review
    // those too, rather than cascading exclusions through a multi-trip file.
    const remaining = inventory.filter(s => s.disposition !== 'excluded');
    const routes = remaining.filter(s => s.pointCount > 1);
    const coherent = routes.filter((s): s is GpxSegmentInventoryEntry<TPoint> & { evidence: { startMs: number; endMs: number } } =>
        s.substantial && s.progressingTime && s.evidence.startMs !== null && s.evidence.endMs !== null);
    const singletons = remaining.filter(s => s.pointCount === 1);
    for (const candidate of singletons) {
        const candidatePoint = candidate.points[0];
        if (!candidate.validCoordinates || !candidatePoint || !validTime(candidatePoint) || !coherent.length) continue;
        const comparisons = coherent.map(route => ({
            donorSegmentId: route.sourceSegmentId,
            timeGapMs: Math.max(route.evidence.startMs - candidatePoint.time,
                candidatePoint.time - route.evidence.endMs),
            pathDistanceM: M.distanceToPathM(candidatePoint, route.points),
        }));
        if (!comparisons.every(c => c.timeGapMs >= SEGMENT_POLICY.isolatedTimeGapMs
            && Number.isFinite(c.pathDistanceM) && c.pathDistanceM >= SEGMENT_POLICY.isolatedDistanceM)) continue;
        candidate.evidence = { ...candidate.evidence, comparisons };
        if (routes.length === 1 && coherent.length === 1 && singletons.length === 1) {
            candidate.disposition = 'excluded';
            candidate.reason = 'isolated-distant-point';
            candidate.donorSegmentId = coherent[0].sourceSegmentId;
        } else {
            candidate.disposition = 'warning';
            candidate.reason = 'ambiguous-activity';
        }
    }
    const excluded = inventory.filter(s => s.disposition === 'excluded');
    return { inventory, sourcePointCount, excludedSegmentCount: excluded.length,
        excludedPointCount: excluded.reduce((sum, s) => sum + s.pointCount, 0),
        warningSegmentCount: inventory.filter(s => s.disposition === 'warning').length };
}

// Stable identities belong to the source, never to a filtered/sampled index.
export function diagnosticMetricInputs<TPoint extends DiagnosticSegmentPoint>(
    diagnostics: GpxSegmentDiagnostics<TPoint>,
    sourceView = false,
): DiagnosticMetricInput[] {
    return diagnostics.inventory.filter(s => sourceView || s.disposition !== 'excluded')
        .flatMap(segment => segment.points.map((p, i) => ({
            lat: p.lat, lon: p.lon, rawEleM: p.ele, ms: p.time,
            elevationState: p.elevationState, timeState: p.timeState,
            coordinateGroup: segment.sourceSegmentId,
            sourcePointId: segment.sourcePointIds[i],
        })));
}
