// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure capture/detection helpers shared by the MV3 background worker and tests.
// This file intentionally has no DOM or extension-API dependency. Geometry and
// gain primitives shared with the GPX Analyzer live in src/gpx-metrics.js.

import { gpxMetrics as Metrics } from './gpx-metrics.js';

    const FEET_PER_METER = 3.28084;
    const MAX_UPLOAD_POINTS = 3000;
    const MAX_TRACK_SEGMENTS = 50;
    const QUERY_PADDING_M = 300;
    const QUERY_CHUNK_M = 10000;
    const ENCOUNTER_WINDOW_M = 300;
    const ENCOUNTER_WINDOW_MS = 5 * 60 * 1000;

    // Geometry primitives come from the shared pure module so the corridor
    // boxes and the analyzer's chart cannot measure the same track differently.
    const { EARTH_RADIUS_M, toRad, normalizeLonDelta, distanceM } = Metrics;
    // A longitude past the antimeridian wraps by the same rule as a delta.
    const normalizeLon = normalizeLonDelta;

    const toDeg = value => value * 180 / Math.PI;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const finiteOrNull = value => value === null || value === undefined || value === ''
        ? null
        : (Number.isFinite(Number(value)) ? Number(value) : null);

    // Local tangent-plane projection is stable for the short GPX edges used here
    // and handles the antimeridian by normalizing longitude deltas first.
    const projectPointToSegment = (point, start, end) => {
        const cosLat = Math.max(0.01, Math.cos(toRad(point.lat)));
        const xy = candidate => ({
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

    const pointSegmentDistanceM = (point, start, end) =>
        projectPointToSegment(point, start, end).distanceM;

    const sanitizeTrack = rawSegments => {
        const segments = [];
        const quality = {
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
            missingTime: 0
        };

        const flush = current => {
            if (current.length) segments.push(current.splice(0));
        };

        for (const rawSegment of rawSegments || []) {
            const current = [];
            for (const rawPoint of rawSegment || []) {
                quality.inputPoints++;
                const lat = finiteOrNull(rawPoint.lat);
                const lon = finiteOrNull(rawPoint.lon);
                if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                    quality.invalidCoordinates++;
                    flush(current);
                    continue;
                }

                const ele = finiteOrNull(rawPoint.ele);
                let time = finiteOrNull(rawPoint.time);
                if (rawPoint.invalidTime) {
                    quality.invalidTimes++;
                    flush(current);
                    time = null;
                }

                const point = { lat, lon, ele, time };
                const previous = current[current.length - 1];
                if (previous) {
                    const stepDistanceM = distanceM(previous, point);
                    let breakReason = null;
                    if (stepDistanceM > QUERY_CHUNK_M) {
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

    const sanitizeWaypoints = rawWaypoints => (rawWaypoints || []).flatMap(rawWaypoint => {
        const lat = finiteOrNull(rawWaypoint && rawWaypoint.lat);
        const lon = finiteOrNull(rawWaypoint && rawWaypoint.lon);
        if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return [];
        const name = typeof rawWaypoint.name === 'string'
            ? rawWaypoint.name.replace(/\s+/g, ' ').trim().slice(0, 200)
            : '';
        return [{ lat, lon, name }];
    });

    const buildTrackIndex = segments => {
        const cumulativeBySegment = [];
        const segmentOffsets = [];
        let totalDistanceM = 0;
        segments.forEach(segment => {
            segmentOffsets.push(totalDistanceM);
            const cumulative = [0];
            for (let index = 1; index < segment.length; index++) {
                cumulative[index] = cumulative[index - 1] + distanceM(segment[index - 1], segment[index]);
            }
            cumulativeBySegment.push(cumulative);
            totalDistanceM += cumulative[cumulative.length - 1] || 0;
        });
        return { cumulativeBySegment, segmentOffsets, totalDistanceM };
    };

    const bboxDiagonalM = bbox => distanceM(
        { lat: bbox.minLat, lon: bbox.minLon },
        { lat: bbox.maxLat, lon: bbox.maxLon }
    );

    const addPointToBbox = (bbox, point, referenceLon) => {
        const unwrappedLon = referenceLon + normalizeLonDelta(point.lon - referenceLon);
        return {
            minLat: Math.min(bbox.minLat, point.lat),
            maxLat: Math.max(bbox.maxLat, point.lat),
            minLon: Math.min(bbox.minLon, unwrappedLon),
            maxLon: Math.max(bbox.maxLon, unwrappedLon)
        };
    };

    const paddedBoxes = bbox => {
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

    const buildQueryBoxes = segments => {
        const boxes = [];
        segments.forEach(segment => {
            if (!segment.length) return;
            let chunkStart = 0;
            let chunkDistanceM = 0;
            let referenceLon = segment[0].lon;
            let bbox = { minLat: segment[0].lat, maxLat: segment[0].lat, minLon: referenceLon, maxLon: referenceLon };

            const finishChunk = endIndex => {
                if (endIndex < chunkStart) return;
                boxes.push(...paddedBoxes(bbox));
            };

            for (let index = 1; index < segment.length; index++) {
                const stepM = distanceM(segment[index - 1], segment[index]);
                const proposedBbox = addPointToBbox(bbox, segment[index], referenceLon);
                if (index > chunkStart + 1
                    && (chunkDistanceM + stepM > QUERY_CHUNK_M || bboxDiagonalM(proposedBbox) > QUERY_CHUNK_M)) {
                    finishChunk(index - 1);
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
            finishChunk(segment.length - 1);
        });

        const seen = new Set();
        return boxes.filter(box => {
            const key = [box.miny, box.maxy, box.minx, box.maxx].map(value => value.toFixed(6)).join(':');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };

    const decodeXml = value => String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(parseInt(code, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

    const parsePeakbaggerPeaks = text => {
        const peaks = [];
        const tagPattern = /<t\b([^>]*)\/?\s*>/gi;
        let tagMatch;
        while ((tagMatch = tagPattern.exec(text))) {
            const attrs = {};
            const attrPattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
            let attrMatch;
            while ((attrMatch = attrPattern.exec(tagMatch[1]))) attrs[attrMatch[1]] = decodeXml(attrMatch[3]);
            const id = Number.parseInt(attrs.i, 10);
            const lat = Number.parseFloat(attrs.a);
            const lon = Number.parseFloat(attrs.o);
            if (!Number.isInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const elevationFt = Number.parseFloat(attrs.e);
            peaks.push({
                id,
                name: attrs.n || `Peak ${id}`,
                location: attrs.l || '',
                lat,
                lon,
                elevationM: Number.isFinite(elevationFt) ? elevationFt / FEET_PER_METER : null,
                prominenceFt: Number.isFinite(Number.parseFloat(attrs.r)) ? Number.parseFloat(attrs.r) : null
            });
        }
        return peaks;
    };

    const interpolateNullable = (start, end, fraction) => {
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        return start + (end - start) * fraction;
    };

    const findEncounters = (segments, peak, trackIndex) => {
        const candidates = [];
        segments.forEach((segment, segmentIndex) => {
            const cumulative = trackIndex.cumulativeBySegment[segmentIndex];
            const offset = trackIndex.segmentOffsets[segmentIndex];
            if (segment.length === 1) {
                const candidateDistanceM = distanceM(segment[0], peak);
                if (candidateDistanceM <= QUERY_PADDING_M) {
                    candidates.push({
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
                    });
                }
                return;
            }
            for (let edgeIndex = 0; edgeIndex < segment.length - 1; edgeIndex++) {
                const start = segment[edgeIndex];
                const end = segment[edgeIndex + 1];
                const projected = projectPointToSegment(peak, start, end);
                if (projected.distanceM > QUERY_PADDING_M) continue;
                const edgeLengthM = cumulative[edgeIndex + 1] - cumulative[edgeIndex];
                const segmentDistanceM = cumulative[edgeIndex] + edgeLengthM * projected.fraction;
                candidates.push({
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
                });
            }
        });

        candidates.sort((a, b) => a.globalDistanceM - b.globalDistanceM);
        const groups = [];
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

    const cubicDecay = (value, fullAt, zeroAt) => {
        if (!Number.isFinite(value)) return null;
        if (value <= fullAt) return 1;
        if (value >= zeroAt) return 0;
        const x = (value - fullAt) / (zeroAt - fullAt);
        return 1 - (3 * x * x - 2 * x * x * x);
    };

    const scoreEncounter = (segments, peak, encounter, trackIndex, qualityScore) => {
        const segment = segments[encounter.segmentIndex];
        const cumulative = trackIndex.cumulativeBySegment[encounter.segmentIndex];
        const nearby = segment.map((point, index) => ({ point, distanceM: cumulative[index] }))
            .filter(item => Math.abs(item.distanceM - encounter.segmentDistanceM) <= ENCOUNTER_WINDOW_M);
        const elevations = nearby.map(item => item.point.ele).filter(Number.isFinite);
        const localMaxM = elevations.length ? Math.max(...elevations) : null;
        const localHighDeltaM = Number.isFinite(encounter.ele) && Number.isFinite(localMaxM)
            ? Math.max(0, localMaxM - encounter.ele)
            : null;

        const before = nearby.filter(item => item.distanceM < encounter.segmentDistanceM && Number.isFinite(item.point.ele));
        const after = nearby.filter(item => item.distanceM > encounter.segmentDistanceM && Number.isFinite(item.point.ele));
        const shapeParts = [];
        if (Number.isFinite(encounter.ele) && before.length) {
            shapeParts.push(clamp((encounter.ele - Math.min(...before.map(item => item.point.ele))) / 20, 0, 1));
        }
        if (Number.isFinite(encounter.ele) && after.length) {
            shapeParts.push(clamp((encounter.ele - Math.min(...after.map(item => item.point.ele))) / 20, 0, 1));
        }
        const shapeScore = shapeParts.length
            ? shapeParts.reduce((sum, value) => sum + value, 0) / shapeParts.length
            : null;
        const elevationDeltaM = Number.isFinite(encounter.ele) && Number.isFinite(peak.elevationM)
            ? Math.abs(encounter.ele - peak.elevationM)
            : null;

        const signals = [
            { weight: 0.50, value: cubicDecay(encounter.distanceM, 10, 100) },
            { weight: 0.20, value: cubicDecay(elevationDeltaM, 10, 80) },
            { weight: 0.15, value: cubicDecay(localHighDeltaM, 5, 40) },
            { weight: 0.10, value: shapeScore },
            { weight: 0.05, value: qualityScore }
        ];
        const available = signals.filter(signal => signal.value !== null);
        const availableWeight = available.reduce((sum, signal) => sum + signal.weight, 0);
        let score = availableWeight
            ? available.reduce((sum, signal) => sum + signal.weight * signal.value, 0) / availableWeight
            : 0;
        const hasUsableElevation = elevationDeltaM !== null;
        if (!hasUsableElevation) score = Math.min(score, 0.69);
        if (encounter.distanceM > 30) score = Math.min(score, 0.79);
        const confidence = Math.round(score * 100);

        let classification = 'weak';
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

    const applyAmbiguityCaps = matches => {
        const remaining = new Set(matches.map((_match, index) => index));
        while (remaining.size) {
            const seed = remaining.values().next().value;
            remaining.delete(seed);
            const group = [seed];
            for (const index of [...remaining]) {
                if (group.some(groupIndex => {
                    const a = matches[groupIndex].encounter;
                    const b = matches[index].encounter;
                    const closeDistance = Math.abs(a.globalDistanceM - b.globalDistanceM) <= ENCOUNTER_WINDOW_M;
                    const closeTime = a.time === null || b.time === null || Math.abs(a.time - b.time) <= ENCOUNTER_WINDOW_MS;
                    return closeDistance && closeTime;
                })) {
                    group.push(index);
                    remaining.delete(index);
                }
            }
            if (group.length < 2) continue;
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
        }
        return matches;
    };

    const detectPeaks = (segments, peaks, qualityScore = 1) => {
        const trackIndex = buildTrackIndex(segments);
        const matches = [];
        for (const peak of peaks) {
            const encounters = findEncounters(segments, peak, trackIndex);
            if (!encounters.length) continue;
            const scored = encounters.map(encounter =>
                scoreEncounter(segments, peak, encounter, trackIndex, qualityScore));
            scored.sort((a, b) => b.confidence - a.confidence || a.evidence.distanceM - b.evidence.distanceM);
            matches.push(scored[0]);
        }
        return applyAmbiguityCaps(matches).sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
    };

    class MaxHeap {
        constructor() {
            this.items = [];
        }
        push(item) {
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
        pop() {
            if (!this.items.length) return null;
            const first = this.items[0];
            const last = this.items.pop();
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
        get length() {
            return this.items.length;
        }
    }

    const intervalCandidate = (segment, segmentIndex, startIndex, endIndex) => {
        if (endIndex - startIndex <= 1) return null;
        let bestIndex = -1;
        let errorM = -1;
        const midpoint = (startIndex + endIndex) / 2;
        for (let index = startIndex + 1; index < endIndex; index++) {
            const candidateErrorM = pointSegmentDistanceM(segment[index], segment[startIndex], segment[endIndex]);
            if (candidateErrorM > errorM + 1e-9
                || (Math.abs(candidateErrorM - errorM) <= 1e-9 && Math.abs(index - midpoint) < Math.abs(bestIndex - midpoint))) {
                bestIndex = index;
                errorM = candidateErrorM;
            }
        }
        return { segmentIndex, startIndex, endIndex, index: bestIndex, errorM };
    };

    const reductionAnchors = (segments, matches) => {
        const anchors = segments.map(() => new Set());
        segments.forEach((segment, segmentIndex) => {
            if (!segment.length) return;
            anchors[segmentIndex].add(0);
            anchors[segmentIndex].add(segment.length - 1);
            const finiteElevations = segment
                .map((point, index) => ({ index, ele: point.ele }))
                .filter(item => Number.isFinite(item.ele));
            if (finiteElevations.length) {
                anchors[segmentIndex].add(finiteElevations.reduce((best, item) => item.ele < best.ele ? item : best).index);
                anchors[segmentIndex].add(finiteElevations.reduce((best, item) => item.ele > best.ele ? item : best).index);
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

    const reduceTrack = (segments, matches, limit = MAX_UPLOAD_POINTS) => {
        const originalPointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
        if (segments.length > MAX_TRACK_SEGMENTS) {
            const error = new Error(`Track has ${segments.length} segments; Peakbagger allows ${MAX_TRACK_SEGMENTS}.`);
            error.code = 'too-many-segments';
            throw error;
        }
        if (originalPointCount <= limit) {
            return {
                segments: segments.map(segment => segment.slice()),
                originalPointCount,
                retainedPointCount: originalPointCount,
                maxDeviationM: 0
            };
        }

        const anchors = reductionAnchors(segments, matches);
        const mandatoryCount = anchors.reduce((sum, set) => sum + set.size, 0);
        if (mandatoryCount > limit) {
            const error = new Error(`Track requires ${mandatoryCount} protected points, exceeding Peakbagger's ${limit}-point limit.`);
            error.code = 'mandatory-point-overflow';
            throw error;
        }

        const heap = new MaxHeap();
        anchors.forEach((set, segmentIndex) => {
            const sorted = [...set].sort((a, b) => a - b);
            for (let index = 1; index < sorted.length; index++) {
                const candidate = intervalCandidate(segments[segmentIndex], segmentIndex, sorted[index - 1], sorted[index]);
                if (candidate) heap.push(candidate);
            }
        });

        let retainedPointCount = mandatoryCount;
        while (retainedPointCount < limit && heap.length) {
            const candidate = heap.pop();
            const set = anchors[candidate.segmentIndex];
            if (set.has(candidate.index)) continue;
            set.add(candidate.index);
            retainedPointCount++;
            const segment = segments[candidate.segmentIndex];
            const left = intervalCandidate(segment, candidate.segmentIndex, candidate.startIndex, candidate.index);
            const right = intervalCandidate(segment, candidate.segmentIndex, candidate.index, candidate.endIndex);
            if (left) heap.push(left);
            if (right) heap.push(right);
        }

        let maxDeviationM = 0;
        const reducedSegments = segments.map((segment, segmentIndex) => {
            const retained = [...anchors[segmentIndex]].sort((a, b) => a - b);
            for (let retainedIndex = 1; retainedIndex < retained.length; retainedIndex++) {
                const startIndex = retained[retainedIndex - 1];
                const endIndex = retained[retainedIndex];
                for (let index = startIndex + 1; index < endIndex; index++) {
                    maxDeviationM = Math.max(maxDeviationM,
                        pointSegmentDistanceM(segment[index], segment[startIndex], segment[endIndex]));
                }
            }
            return retained.map(index => segment[index]);
        });

        return { segments: reducedSegments, originalPointCount, retainedPointCount, maxDeviationM };
    };

    const escapeXml = value => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const serializeUploadGpx = (segments, waypoints = []) => {
        const waypointBody = waypoints.map(waypoint => {
            const name = waypoint.name ? `<name>${escapeXml(waypoint.name)}</name>` : '';
            return `<wpt lat="${waypoint.lat}" lon="${waypoint.lon}">${name}</wpt>`;
        }).join('');
        const body = segments.map(segment => {
            const points = segment.map(point => {
                const elevation = Number.isFinite(point.ele) ? `<ele>${point.ele}</ele>` : '';
                const date = Number.isFinite(point.time) ? new Date(point.time) : null;
                const isoTime = date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
                const time = isoTime
                    ? `<time>${isoTime.endsWith('.000Z') ? isoTime.slice(0, -5) + 'Z' : isoTime}</time>`
                    : '';
                return `<trkpt lat="${point.lat}" lon="${point.lon}">${elevation}${time}</trkpt>`;
            }).join('');
            return `<trkseg>${points}</trkseg>`;
        }).join('');
        return `<?xml version="1.0" encoding="UTF-8"?>`
            + `<gpx version="1.1" creator="Better Peakbagger" xmlns="http://www.topografix.com/GPX/1/1">`
            + `${waypointBody}<trk>${body}</trk></gpx>`;
    };

    const calculateConfirmedGainM = Metrics.calculateConfirmedGainM;

    const firstFinite = (segments, key, reverse = false) => {
        const outer = reverse ? segments.slice().reverse() : segments;
        for (const segment of outer) {
            const inner = reverse ? segment.slice().reverse() : segment;
            const point = inner.find(candidate => Number.isFinite(candidate[key]));
            if (point) return point[key];
        }
        return null;
    };

    const splitElevationPaths = (segments, encounter) => {
        const before = [];
        const after = [];
        segments.forEach((segment, segmentIndex) => {
            const values = segment.map(point => point.ele).filter(Number.isFinite);
            if (segmentIndex < encounter.segmentIndex) before.push(values);
            else if (segmentIndex > encounter.segmentIndex) after.push(values);
            else {
                const encounterElevation = encounter.ele;
                const beforeValues = segment.slice(0, encounter.edgeIndex + 1).map(point => point.ele).filter(Number.isFinite);
                const afterValues = segment.slice(encounter.edgeIndex + 1).map(point => point.ele).filter(Number.isFinite);
                if (Number.isFinite(encounterElevation)) {
                    beforeValues.push(encounterElevation);
                    afterValues.unshift(encounterElevation);
                }
                before.push(beforeValues);
                after.push(afterValues);
            }
        });
        return { before, after };
    };

    const durationParts = minutesValue => {
        const totalMinutes = Math.max(0, Math.round(minutesValue || 0));
        return {
            days: Math.floor(totalMinutes / 1440),
            hours: Math.floor((totalMinutes % 1440) / 60),
            minutes: totalMinutes % 60
        };
    };

    const timezoneOffsetMinutes = (providerMeta, referenceTime = null) => {
        if (Number.isFinite(providerMeta && providerMeta.utcOffsetMinutes)) return providerMeta.utcOffsetMinutes;
        const localStart = providerMeta && providerMeta.localStart;
        if (localStart) {
            const match = /([+-])(\d{2}):(\d{2})$/.exec(localStart);
            if (match) {
                const value = Number(match[2]) * 60 + Number(match[3]);
                return match[1] === '-' ? -value : value;
            }
        }
        const wallClock = providerMeta && providerMeta.displayedLocalStart;
        if (wallClock && Number.isFinite(referenceTime)) {
            const wallClockAsUtc = Date.parse(`${wallClock}Z`);
            const derived = Math.round((wallClockAsUtc - referenceTime) / 60000);
            if (Number.isFinite(wallClockAsUtc) && derived >= -14 * 60 && derived <= 14 * 60) return derived;
        }
        return 0;
    };

    const formatEncounterDateTime = (time, providerMeta, referenceTime = null) => {
        if (!Number.isFinite(time)) return { date: '', time: '', timezoneKnown: false };
        const offsetMinutes = timezoneOffsetMinutes(providerMeta, referenceTime);
        const date = new Date(time + offsetMinutes * 60 * 1000);
        const pad = value => String(value).padStart(2, '0');
        return {
            date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
            time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
            timezoneKnown: Number.isFinite(providerMeta && providerMeta.utcOffsetMinutes)
                || /([+-])(\d{2}):(\d{2})$/.test((providerMeta && providerMeta.localStart) || '')
                || !!(providerMeta && providerMeta.displayedLocalStart && Number.isFinite(referenceTime))
        };
    };

    const calculateNightsOut = (segments, providerMeta = {}) => {
        const firstTime = firstFinite(segments, 'time');
        const lastTime = firstFinite(segments, 'time', true);
        if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime < firstTime) return null;
        const offsetMs = timezoneOffsetMinutes(providerMeta, firstTime) * 60 * 1000;
        const firstDay = Math.floor((firstTime + offsetMs) / 86400000);
        const lastDay = Math.floor((lastTime + offsetMs) / 86400000);
        return Math.max(0, lastDay - firstDay);
    };

    const calculateDayStats = (segments, providerMeta = {}) => {
        const firstTime = firstFinite(segments, 'time');
        const lastTime = firstFinite(segments, 'time', true);
        const points = (segments || []).flat();
        if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime < firstTime
            || !points.length || points.some(point => !Number.isFinite(point.time))) return [];

        const dayMs = 24 * 60 * 60 * 1000;
        const offsetMs = timezoneOffsetMinutes(providerMeta, firstTime) * 60 * 1000;
        const firstDay = Math.floor((firstTime + offsetMs) / dayMs);
        const lastDay = Math.floor((lastTime + offsetMs) / dayMs);
        // Peakbagger's Wilderness Nights selector currently supports 0–100.
        // Refuse a pathological timestamp span rather than building an
        // unbounded payload for rows the page cannot expose.
        if (lastDay - firstDay + 1 > 101) return [];
        const pathsByDay = new Map();
        const appendPath = (day, path) => {
            if (!path.length) return;
            if (!pathsByDay.has(day)) pathsByDay.set(day, []);
            pathsByDay.get(day).push(path);
        };

        for (const segment of segments) {
            let currentDay = null;
            let currentPath = [];
            let previous = null;
            for (const point of segment) {
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

        const pathDistanceM = path => path.reduce((sum, point, index) =>
            index ? sum + distanceM(path[index - 1], point) : sum, 0);
        const pad = value => String(value).padStart(2, '0');
        const formatDay = day => {
            const date = new Date(day * dayMs);
            return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
        };

        const result = [];
        for (let day = firstDay; day <= lastDay; day++) {
            const paths = pathsByDay.get(day) || [];
            const elevations = paths.flatMap(path => path.map(point => point.ele).filter(Number.isFinite));
            const pathGains = paths.flatMap(path => {
                const values = path.map(point => point.ele).filter(Number.isFinite);
                if (!values.length) return [];
                return [calculateConfirmedGainM(values)];
            });
            const startElevationM = firstFinite(paths, 'ele');
            const endElevationM = firstFinite(paths, 'ele', true);
            // The confirmed-gain filter is directional, so reversing samples
            // does not produce a symmetric loss. Enforce the day's elevation
            // balance across sanitized recording gaps while keeping the sum of
            // confirmed gains as its lower bound.
            const recordedGainM = pathGains.reduce((sum, gainM) => sum + gainM, 0);
            const gainM = elevations.length
                ? Math.max(recordedGainM, endElevationM - startElevationM) : null;
            const lossM = elevations.length ? Math.max(0, gainM + startElevationM - endElevationM) : null;
            result.push({
                date: formatDay(day),
                gainM,
                lossM,
                distanceM: paths.reduce((sum, path) => sum + pathDistanceM(path), 0),
                maxElevationM: elevations.length
                    ? elevations.reduce((maximum, elevation) => Math.max(maximum, elevation), -Infinity) : null,
                campElevationM: day < lastDay ? firstFinite(paths, 'ele', true) : null
            });
        }
        return result;
    };

    const calculateDraftFields = (segments, match, providerMeta = {}) => {
        const trackIndex = buildTrackIndex(segments);
        const encounter = match.encounter;
        const firstTime = firstFinite(segments, 'time');
        const lastTime = firstFinite(segments, 'time', true);
        const dateTime = formatEncounterDateTime(encounter.time, providerMeta, firstTime);
        if (!dateTime.date && providerMeta.displayedLocalStart) {
            dateTime.date = providerMeta.displayedLocalStart.slice(0, 10);
            dateTime.timezoneKnown = true;
        }
        const elevationPaths = splitElevationPaths(segments, encounter);
        return {
            date: dateTime.date,
            time: dateTime.time,
            timezoneKnown: dateTime.timezoneKnown,
            startElevationM: firstFinite(segments, 'ele'),
            endElevationM: firstFinite(segments, 'ele', true),
            upDistanceM: encounter.globalDistanceM,
            downDistanceM: Math.max(0, trackIndex.totalDistanceM - encounter.globalDistanceM),
            upGainM: elevationPaths.before.reduce((sum, values) => sum + calculateConfirmedGainM(values), 0),
            downGainM: elevationPaths.after.reduce((sum, values) => sum + calculateConfirmedGainM(values), 0),
            upDuration: durationParts(Number.isFinite(firstTime) && Number.isFinite(encounter.time)
                ? (encounter.time - firstTime) / 60000 : 0),
            downDuration: durationParts(Number.isFinite(lastTime) && Number.isFinite(encounter.time)
                ? (lastTime - encounter.time) / 60000 : 0)
        };
    };

    const suffixForIndex = index => {
        let value = index + 1;
        let suffix = '';
        while (value > 0) {
            value--;
            suffix = String.fromCharCode(97 + (value % 26)) + suffix;
            value = Math.floor(value / 26);
        }
        return suffix;
    };

    const assignDraftSuffixes = matches => {
        const result = matches.map(match => ({
            ...match,
            draftFields: { ...match.draftFields, suffix: '' }
        }));
        const byDate = new Map();
        result.forEach((match, index) => {
            const date = match.draftFields.date;
            if (!date) return;
            if (!byDate.has(date)) byDate.set(date, []);
            byDate.get(date).push({ match, index });
        });
        for (const group of byDate.values()) {
            if (group.length < 2) continue;
            group.sort((a, b) => {
                const aDistance = a.match.draftFields.upDistanceM;
                const bDistance = b.match.draftFields.upDistanceM;
                if (Number.isFinite(aDistance) && Number.isFinite(bDistance) && aDistance !== bDistance) {
                    return aDistance - bDistance;
                }
                return a.index - b.index;
            });
            group.forEach(({ match }, index) => { match.draftFields.suffix = suffixForIndex(index); });
        }
        return result;
    };

    const publicMatch = match => ({
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
        detectPeaks,
        reduceTrack,
        serializeUploadGpx,
        calculateDraftFields,
        calculateNightsOut,
        calculateDayStats,
        assignDraftSuffixes,
        publicMatch,
        formatEncounterDateTime
    };

    export const captureCore = API;
