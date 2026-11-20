// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureCore as Core } from '../../src/capture/capture-core.ts';
import { gpxParse as Parse } from '../../src/gpx/gpx-parse.ts';
import { gpxMetrics as Metrics } from '../../src/gpx/gpx-metrics.ts';
import { readCompressedGpxFixture } from '../helpers/gpx-fixtures.mts';

interface TrackPoint { lat: number; lon: number; ele: number | null; time: number | null }

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml');

test('a nonexistent GPX date cannot become a capture date or duration', () => {
    const document = parseXml(`<gpx><trk><trkseg>
      <trkpt lat="47" lon="-121"><ele>100</ele><time>2026-02-28T12:00:00Z</time></trkpt>
      <trkpt lat="47.0001" lon="-121"><ele>110</ele><time>2026-02-30T12:01:00Z</time></trkpt>
      <trkpt lat="47.0002" lon="-121"><ele>100</ele><time>2026-02-28T12:02:00Z</time></trkpt>
    </trkseg></trk></gpx>`);
    const raw = [[...document.querySelectorAll('trkpt')].map(pointNode =>
        Parse.parseTrackPoint(pointNode))];
    const { segments, quality } = Core.sanitizeTrack(raw);

    assert.equal(quality.invalidTimes, 1);
    assert.equal(segments.flat()[1]!.time, null);
    assert.deepEqual(Core.calculateDayStats(segments, { utcOffsetMinutes: 0 }), []);
    const fields = Core.calculateDraftFields(segments, {
        encounter: {
            segmentIndex: 1,
            edgeIndex: 0,
            fraction: 1,
            lat: 47.0002,
            lon: -121,
            ele: 100,
            time: Date.UTC(2026, 1, 28, 12, 2),
        },
    });
    assert.equal(fields.upDuration, null);
    assert.equal(fields.downDuration, null);
});

test('Capitol draft totals match shared analyzer metrics without reordering serialized GPX', async () => {
    const source = await readCompressedGpxFixture('capitol-2021-segment-order.gpx.gz.b64');
    const document = parseXml(source);
    const rawSegments = [...document.querySelectorAll('trkseg')].map(segment =>
        [...segment.querySelectorAll(':scope > trkpt')].map(pointNode =>
            Parse.parseTrackPoint(pointNode)));
    const { segments } = Core.sanitizeTrack(rawSegments);
    let summit: TrackPoint & { segmentIndex: number; pointIndex: number } = {
        lat: NaN, lon: NaN, ele: -Infinity, time: null, segmentIndex: 0, pointIndex: 0,
    };
    segments.forEach((segment: TrackPoint[], segmentIndex: number) => segment.forEach((candidate: TrackPoint, pointIndex: number) => {
        if (candidate.ele !== null && candidate.ele > (summit.ele ?? -Infinity)) summit = { ...candidate, segmentIndex, pointIndex };
    }));
    const encounter = {
        segmentIndex: summit.segmentIndex,
        edgeIndex: Math.max(0, summit.pointIndex - 1),
        fraction: summit.pointIndex === 0 ? 0 : 1,
        lat: summit.lat,
        lon: summit.lon,
        ele: summit.ele,
        time: summit.time,
    };
    const fields = Core.calculateDraftFields(segments, { encounter }, { utcOffsetMinutes: -360 });
    const metrics = Metrics.computeMetricsForSegments(segments);

    assert.ok(Math.abs(fields.upGainM! + fields.downGainM! - metrics.gainM) < 1e-9);
    assert.ok(Math.abs(fields.upDistanceM! + fields.downDistanceM! - metrics.distanceM) < 1e-9);
    assert.equal(Math.round(metrics.gainM * 100) / 100, 1747.89);

    const serialized = parseXml(Core.serializeUploadGpx(segments));
    assert.deepEqual([...serialized.querySelectorAll('trkseg')].map(segment =>
        segment.querySelector('time')?.textContent), [
        '2021-07-26T14:52:00Z',
        '2021-07-27T22:32:00Z',
        '2021-07-27T11:08:00Z',
        '2021-07-27T17:10:00Z',
    ], 'serialized route geometry must retain GPX source segment order');
});
