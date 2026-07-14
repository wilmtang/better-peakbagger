// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../src/capture-core.js');

const point = (lat, lon, ele = 100, time = null) => ({ lat, lon, ele, time });

test('sanitization breaks, rather than bridges, invalid and impossible edges', () => {
    const start = Date.UTC(2026, 0, 1);
    const raw = [[
        point(0, 0, 100, start),
        point(0, 0.0001, 101, start + 10000),
        point(95, 0, 102, start + 20000),
        point(0, 0.0002, 103, start + 30000),
        point(0, 0.05, 104, start + 31000),
        point(0, 0.0501, 105, start + 20000),
        point(0, 0.055, 106, start + 20 * 60 * 1000)
    ]];

    const result = Core.sanitizeTrack(raw);
    assert.equal(result.quality.invalidCoordinates, 1);
    assert.equal(result.quality.extremeSpeeds, 1);
    assert.equal(result.quality.reversedTimes, 1);
    assert.equal(result.quality.longGaps, 1);
    assert.equal(result.segments.length, 5);
    assert.equal(result.quality.retainedPoints, 6);
});

test('kilometre-scale edges without usable time are treated as gaps', () => {
    const result = Core.sanitizeTrack([[
        point(0, 0, 100, null),
        point(0, 0.02, 100, null)
    ]]);
    assert.equal(result.quality.untimedGaps, 1);
    assert.equal(result.segments.length, 2);
});

test('single edges can never exceed the summit-query spatial limit', () => {
    const start = Date.UTC(2026, 0, 1);
    const result = Core.sanitizeTrack([[
        point(0, 0, 100, start),
        point(0, 0.2, 100, start + 5 * 60000)
    ]]);
    assert.equal(result.quality.spatialGaps, 1);
    assert.equal(result.segments.length, 2);
});

test('Peakbagger XML parsing decodes metadata and ignores malformed peaks', () => {
    const peaks = Core.parsePeakbaggerPeaks('<p><t i="12" n="A &amp; B" a="47.1" o="-121.2" e="5000" r="800" l="WA"/><t i="x" a="0" o="0"/></p>');
    assert.equal(peaks.length, 1);
    assert.equal(peaks[0].id, 12);
    assert.equal(peaks[0].name, 'A & B');
    assert.equal(Math.round(peaks[0].elevationM * Core.FEET_PER_METER), 5000);
});

test('full-resolution segment projection detects a sparse summit crossing', () => {
    const segments = [[point(0, -0.001, 100), point(0, 0.001, 100)]];
    const matches = Core.detectPeaks(segments, [{ id: 1, name: 'Sparse Peak', location: '', lat: 0, lon: 0, elevationM: 100 }], 1);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].classification, 'strong');
    assert.ok(matches[0].evidence.distanceM < 0.01);
    assert.ok(Math.abs(matches[0].encounter.fraction - 0.5) < 0.001);
});

test('missing elevation can be probable but is capped below strong', () => {
    const segments = [[point(0, -0.001, null), point(0, 0.001, null)]];
    const [match] = Core.detectPeaks(segments, [{ id: 2, name: 'Horizontal Peak', location: '', lat: 0, lon: 0, elevationM: 100 }], 1);
    assert.equal(match.confidence, 69);
    assert.equal(match.classification, 'probable');
    assert.equal(Core.publicMatch(match).selected, false);
});

test('separate GPX segments are never bridged through a summit', () => {
    const segments = [
        [point(0, -0.002, 100)],
        [point(0, 0.002, 100)]
    ];
    const [match] = Core.detectPeaks(segments, [{ id: 3, name: 'Gap Peak', location: '', lat: 0, lon: 0, elevationM: 100 }], 1);
    assert.notEqual(match.classification, 'strong');
    assert.ok(match.evidence.distanceM > 200);
});

test('nearby peaks sharing one encounter are capped unless one clearly leads', () => {
    const segments = [[
        point(0, -0.001, 80),
        point(0, 0, 100),
        point(0, 0.001, 80)
    ]];
    const matches = Core.detectPeaks(segments, [
        { id: 4, name: 'Main', location: '', lat: 0, lon: 0, elevationM: 100 },
        { id: 5, name: 'Subpeak', location: '', lat: 0, lon: 0.00001, elevationM: 100 }
    ], 1);
    assert.equal(matches.length, 2);
    assert.ok(matches.every(match => match.classification === 'probable'));
    assert.ok(matches.every(match => match.confidence <= 79 && match.evidence.ambiguous));
});

test('query boxes stay short, padded, and split at the antimeridian', () => {
    const many = Array.from({ length: 220 }, (_value, index) => point(0, index * 0.0005));
    assert.ok(Core.buildQueryBoxes([many]).length > 1);
    const dateline = Core.buildQueryBoxes([[point(10, 179.999), point(10, -179.999)]]);
    assert.equal(dateline.length, 2);
    assert.ok(dateline.every(box => box.minx >= -180 && box.maxx <= 180));
});

test('priority reduction retains original objects, summit brackets, and an exact 3,000-point cap', () => {
    const segment = Array.from({ length: 4000 }, (_value, index) =>
        point(47 + index * 0.00001, -121 + Math.sin(index / 20) * 0.00003, 100 + Math.sin(index / 50) * 10));
    const matches = [{ encounter: { segmentIndex: 0, edgeIndex: 1999 } }];
    const result = Core.reduceTrack([segment], matches);
    assert.equal(result.originalPointCount, 4000);
    assert.equal(result.retainedPointCount, 3000);
    assert.equal(result.segments[0].length, 3000);
    assert.ok(result.segments[0].includes(segment[1999]));
    assert.ok(result.segments[0].includes(segment[2000]));
    assert.ok(result.segments[0].every(retained => segment.includes(retained)));
    assert.ok(result.maxDeviationM >= 0);
});

test('tracks at the limit are unchanged and mandatory overflow fails closed', () => {
    const exact = Array.from({ length: 3000 }, (_value, index) => point(0, index * 0.000001));
    const unchanged = Core.reduceTrack([exact], []);
    assert.equal(unchanged.retainedPointCount, 3000);
    assert.equal(unchanged.segments[0][1500], exact[1500]);

    const small = [[point(0, 0), point(0, 1), point(0, 2), point(0, 3)]];
    assert.throws(
        () => Core.reduceTrack(small, [
            { encounter: { segmentIndex: 0, edgeIndex: 0 } },
            { encounter: { segmentIndex: 0, edgeIndex: 2 } }
        ], 3),
        error => error.code === 'mandatory-point-overflow'
    );
});

test('privacy upload contains only track geometry and segment structure', () => {
    const gpx = Core.serializeUploadGpx([
        [point(1, 2, 300, Date.now()), point(3, 4, 400, Date.now())],
        [point(5, 6, 500, Date.now())]
    ]);
    assert.match(gpx, /<trkseg><trkpt lat="1" lon="2"><\/trkpt>/);
    assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
    assert.doesNotMatch(gpx, /<(?:ele|time|extensions|wpt|rte|name)(?:\s|>)/i);
});

test('draft fields use full-resolution distance, gains, durations, and activity offset', () => {
    const start = Date.UTC(2026, 6, 1, 15, 0);
    const segments = [[
        point(0, 0, 100, start),
        point(0, 0.001, 130, start + 30 * 60000),
        point(0, 0.002, 110, start + 60 * 60000)
    ]];
    const match = {
        encounter: {
            segmentIndex: 0,
            edgeIndex: 0,
            fraction: 1,
            ele: 130,
            time: start + 30 * 60000,
            globalDistanceM: Core.distanceM(segments[0][0], segments[0][1])
        }
    };
    const fields = Core.calculateDraftFields(segments, match, { utcOffsetMinutes: -420 });
    assert.equal(fields.date, '2026-07-01');
    assert.equal(fields.time, '08:30');
    assert.deepEqual(fields.upDuration, { days: 0, hours: 0, minutes: 30 });
    assert.deepEqual(fields.downDuration, { days: 0, hours: 0, minutes: 30 });
    assert.ok(fields.upGainM >= 30);
    assert.equal(fields.startElevationM, 100);
    assert.equal(fields.endElevationM, 110);
});

test('Strava displayed wall-clock time derives the activity timezone from GPX UTC', () => {
    const start = Date.UTC(2026, 6, 11, 23, 13);
    const formatted = Core.formatEncounterDateTime(start + 60 * 60000, {
        displayedLocalStart: '2026-07-11T16:13:00'
    }, start);
    assert.equal(formatted.date, '2026-07-11');
    assert.equal(formatted.time, '17:13');
    assert.equal(formatted.timezoneKnown, true);
});
