// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Saved-ascent interpretation only. Parsing and shared computeMetrics callers
// deliberately do not apply this policy (in particular, activity capture).
import { gpxMetrics as M } from './gpx-metrics.js';
import { MAX_GPX_TRACK_POINTS, MAX_GPX_TRACK_SEGMENTS, gpxLimitMessage } from '../capture/capture-resource-limits.js';

export const SEGMENT_POLICY = Object.freeze({ minPoints: 8, minDistanceM: 100,
    isolatedTimeGapMs: 24 * 60 * 60_000, isolatedDistanceM: 50_000 });

const validTime = point => point.timeState === 'valid' && M.isValidTimestamp(point.time);
const validElevation = point => point.elevationState === 'valid' && M.isPlausibleElevationM(point.ele);

function describe(points, sourceSegmentId) {
    const validCoordinates = points.length > 0 && points.every(p => M.isValidCoordinate(p.lat, p.lon));
    const distanceM = validCoordinates ? points.slice(1).reduce((sum, p, i) => sum + M.distanceM(points[i], p), 0) : 0;
    const orderedTime = points.length > 0 && points.every((p, i) => validTime(p) && (!i || p.time >= points[i - 1].time));
    const startMs = orderedTime ? points[0].time : null;
    const endMs = orderedTime ? points.at(-1).time : null;
    return {
        sourceSegmentId, sourcePointIds: points.map((_, i) => `${sourceSegmentId}:${i}`),
        points, pointCount: points.length, disposition: 'retained', reason: null, donorSegmentId: null,
        evidence: { distanceM, startMs, endMs }, validCoordinates,
        substantial: validCoordinates && points.length >= SEGMENT_POLICY.minPoints && distanceM >= SEGMENT_POLICY.minDistanceM,
        progressingTime: orderedTime && endMs > startMs,
        completeElevation: points.length > 0 && points.every(validElevation) && points.some(p => p.ele !== 0),
        zeroElevation: points.length > 0 && points.every(p => validElevation(p) && p.ele === 0),
        constantTime: orderedTime && endMs === startMs,
    };
}

export function diagnoseGpxSegments(segments) {
    const sourcePointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (segments.length > MAX_GPX_TRACK_SEGMENTS || sourcePointCount > MAX_GPX_TRACK_POINTS) {
        throw new Error(gpxLimitMessage());
    }
    const inventory = segments.map(describe);
    // Exact numeric sequences form buckets. Equality is verified below rather
    // than treating a fingerprint alone as authority to exclude source data.
    const geometry = new Map();
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
    const excluded = inventory.filter(s => s.disposition === 'excluded');
    return { inventory, sourcePointCount, excludedSegmentCount: excluded.length,
        excludedPointCount: excluded.reduce((sum, s) => sum + s.pointCount, 0),
        warningSegmentCount: inventory.filter(s => s.disposition === 'warning').length };
}

// Stable identities belong to the source, never to a filtered/sampled index.
export function diagnosticMetricInputs(diagnostics, sourceView = false) {
    return diagnostics.inventory.filter(s => sourceView || s.disposition !== 'excluded')
        .flatMap(segment => segment.points.map((p, i) => ({
            lat: p.lat, lon: p.lon, rawEleM: p.ele, ms: p.time,
            elevationState: p.elevationState, timeState: p.timeState,
            coordinateGroup: segment.sourceSegmentId,
            sourcePointId: segment.sourcePointIds[i],
        })));
}
