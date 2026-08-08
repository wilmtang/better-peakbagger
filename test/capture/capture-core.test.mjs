// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { captureCore as Core } from '../../src/capture/capture-core.js';
import { gpxParse as Parse } from '../../src/gpx/gpx-parse.js';
import { gpxMetrics as Metrics } from '../../src/gpx/gpx-metrics.js';
import { readCompressedGpxFixture } from '../helpers/gpx-fixtures.mjs';
import { walkFiles } from '../helpers/walk-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

test('sanitization excludes impossible elevations from matching and serialized GPX', () => {
    const { segments, quality } = Core.sanitizeTrack([[
        point(0, -0.001, 100),
        point(0, 0, 1_000_000_000),
        point(0, 0.001, 100),
    ]]);

    assert.equal(quality.suspectElevation, 1);
    assert.equal(segments[0][1].ele, null);
    const [match] = Core.detectPeaks(
        segments,
        [{ id: 99, name: 'Peak', location: '', lat: 0, lon: 0, elevationM: 1_000_000_000 }],
        quality.score,
    );
    assert.notEqual(match.classification, 'strong');
    assert.equal(match.evidence.elevationDeltaM, null);
    assert.doesNotMatch(Core.serializeUploadGpx(segments), /1000000000/);

    const boundaries = Core.sanitizeTrack([[
        point(0, 0, -1000),
        point(0, 0.0001, 10000),
        point(0, 0.0002, -1000.1),
        point(0, 0.0003, 10000.1),
    ]]);
    assert.deepEqual(boundaries.segments[0].map(candidate => candidate.ele), [
        -1000, 10000, null, null,
    ]);
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

test('Peakbagger XML parsing decodes each entity only once', () => {
    const [peak] = Core.parsePeakbaggerPeaks(
        '<t i="13" n="A &#38;lt; B &amp;gt; C &#x110000;" a="47.1" o="-121.2"/>'
    );

    assert.equal(peak.name, 'A &lt; B &gt; C &#x110000;');
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

// A chain A–B–C where only the neighbours overlap: whichever peak seeds the
// group must pull in the whole chain, or the escapee keeps an uncapped Strong
// score and arrives at the popup pre-selected for drafting.
test('chained ambiguity caps every peak regardless of the order Peakbagger returns them', () => {
    const bump = (index, centre) => Math.max(0, 60 - Math.abs(index - centre));
    const segment = Array.from({ length: 801 }, (_value, index) => point(
        47 + index * 0.000009,
        -121,
        1000 + bump(index, 140) + bump(index, 420) + bump(index, 700),
        Date.UTC(2026, 0, 1) + index * 1000
    ));
    const peakAt = (id, name, index) => ({
        id,
        name,
        location: '',
        lat: segment[index].lat,
        lon: segment[index].lon,
        elevationM: segment[index].ele
    });
    const a = peakAt(1, 'A', 140);
    const b = peakAt(2, 'B', 420);
    const c = peakAt(3, 'C', 700);
    // A–B and B–C share an encounter window; A–C do not.
    for (const order of [[a, b, c], [c, a, b], [b, c, a], [c, b, a]]) {
        const matches = Core.detectPeaks([segment], order, 1);
        assert.equal(matches.length, 3, `order ${order.map(peak => peak.name).join('')}`);
        for (const match of matches) {
            assert.ok(
                match.confidence <= 79 && match.evidence.ambiguous
                    && !Core.publicMatch(match).selected,
                `${match.name} escaped the cap for order ${order.map(peak => peak.name).join('')}`
            );
        }
    }
});

test('query boxes stay short, padded, and split at the antimeridian', () => {
    const many = Array.from({ length: 220 }, (_value, index) => point(0, index * 0.0005));
    assert.ok(Core.buildQueryBoxes([many]).length > 1);
    const dateline = Core.buildQueryBoxes([[point(10, 179.999), point(10, -179.999)]]);
    assert.equal(dateline.length, 2);
    assert.ok(dateline.every(box => box.minx >= -180 && box.maxx <= 180));

    // sanitizeTrack's flush() keeps a single-point segment, so the chunk
    // emitted after the edge loop can have no edges at all. That is not a case
    // to guard against: the degenerate bbox is the fix itself, and it must
    // still become the padded corridor box around it — findEncounters looks for
    // summits near lone points too.
    const lone = Core.buildQueryBoxes([[point(47.5, -121.5)]]);
    assert.equal(lone.length, 1);
    const [box] = lone;
    assert.ok(box.miny < 47.5 && box.maxy > 47.5 && box.minx < -121.5 && box.maxx > -121.5,
        'a lone fix must be padded on every side, not collapsed to a zero-area box');
    assert.ok(Core.buildQueryBoxes([[]]).length === 0, 'an empty segment contributes no box');
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

test('privacy upload retains reduced track elevation and time without unrelated source fields', () => {
    const start = Date.UTC(2026, 6, 1, 15, 0);
    const gpx = Core.serializeUploadGpx([
        [point(1, 2, 300, start), point(3, 4, 400, start + 1000)],
        [point(5, 6, null, null)]
    ]);
    assert.match(gpx, /<trkseg><trkpt lat="1" lon="2"><ele>300<\/ele><time>2026-07-01T15:00:00Z<\/time><\/trkpt>/);
    assert.match(gpx, /<trkpt lat="5" lon="6"><\/trkpt>/);
    assert.equal((gpx.match(/<trkseg>/g) || []).length, 2);
    assert.equal((gpx.match(/<ele>/g) || []).length, 2);
    assert.equal((gpx.match(/<time>/g) || []).length, 2);
    assert.doesNotMatch(gpx, /<(?:extensions|wpt|rte|name)(?:\s|>)/i);
});

test('retained waypoints are validated, bounded, escaped, and limited to coordinates plus name', () => {
    const waypoints = Core.sanitizeWaypoints([
        { lat: '47.1', lon: '-121.2', name: ' Camp & <Water> ', ele: 999, desc: 'private' },
        { lat: 95, lon: 1, name: 'invalid' }
    ]);
    assert.deepEqual(waypoints, [{ lat: 47.1, lon: -121.2, name: 'Camp & <Water>' }]);

    const gpx = Core.serializeUploadGpx([[point(1, 2), point(3, 4)]], waypoints);
    assert.match(gpx, /<wpt lat="47\.1" lon="-121\.2"><name>Camp &amp; &lt;Water&gt;<\/name><\/wpt>/);
    assert.doesNotMatch(gpx, /999|private|<(?:desc|sym|extensions)(?:\s|>)/i);
    assert.doesNotMatch(gpx.match(/<wpt[\s\S]*?<\/wpt>/i)[0], /<(?:ele|time)>/i);
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
    const shared = Metrics.computeMetricsForSegments(segments);
    assert.equal(fields.upGainM + fields.downGainM, shared.gainM);
    assert.equal(fields.startElevationM, 100);
    assert.equal(fields.endElevationM, 110);
});

test('draft metrics expose gaps instead of bridging or substituting zero', () => {
    const start = Date.UTC(2026, 6, 1, 15);
    const segments = [[
        point(0, 0, 100, start),
        point(0, 0.0001, null, null),
        point(0, 0.0002, 200, start + 120_000),
        point(0, 0.0003, 210, start + 180_000),
    ]];
    const fields = Core.calculateDraftFields(segments, {
        encounter: {
            segmentIndex: 0,
            edgeIndex: 1,
            fraction: 1,
            lat: 0,
            lon: 0.0002,
            ele: 200,
            time: start + 120_000,
        },
    }, { utcOffsetMinutes: 0 });

    assert.equal(fields.upGainM, null, 'missing elevation must split the ascent gain');
    assert.equal(fields.downGainM, 0, 'the complete flat/down half may report its recorded gain');
    assert.equal(fields.upDuration, null, 'missing time must not become a zero duration');
    assert.deepEqual(fields.downDuration, { days: 0, hours: 0, minutes: 1 });
    assert.equal(fields.quality.elevation.status, 'partial');
    assert.equal(fields.quality.time.status, 'partial');
});

test('draft duration requires complete, progressing, ordered timestamps', () => {
    const start = Date.UTC(2026, 6, 1, 15);
    const encounter = {
        segmentIndex: 0, edgeIndex: 0, fraction: 1,
        lat: 0, lon: 0.0001, ele: 110, time: start,
    };
    const equal = Core.calculateDraftFields([[
        point(0, 0, 100, start),
        point(0, 0.0001, 110, start),
        point(0, 0.0002, 100, start),
    ]], { encounter });
    assert.equal(equal.upDuration, null);
    assert.equal(equal.downDuration, null);

    const reversed = Core.calculateDraftFields([[
        point(0, 0, 100, start + 60_000),
        point(0, 0.0001, 110, start),
        point(0, 0.0002, 100, start + 120_000),
    ]], { encounter: { ...encounter, time: start } });
    assert.equal(reversed.upDuration, null);
});

test('Capitol draft totals match shared analyzer metrics without reordering serialized GPX', async () => {
    const source = await readCompressedGpxFixture('capitol-2021-segment-order.gpx.gz.b64');
    const document = new JSDOM(source, { contentType: 'text/xml' }).window.document;
    const rawSegments = [...document.querySelectorAll('trkseg')].map(segment =>
        [...segment.querySelectorAll(':scope > trkpt')].map(pointNode =>
            Parse.parseTrackPoint(pointNode)));
    const { segments } = Core.sanitizeTrack(rawSegments);
    let summit = { ele: -Infinity };
    segments.forEach((segment, segmentIndex) => segment.forEach((candidate, pointIndex) => {
        if (candidate.ele > summit.ele) summit = { ...candidate, segmentIndex, pointIndex };
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

    assert.ok(Math.abs(fields.upGainM + fields.downGainM - metrics.gainM) < 1e-9);
    assert.ok(Math.abs(fields.upDistanceM + fields.downDistanceM - metrics.distanceM) < 1e-9);
    assert.equal(Math.round(metrics.gainM * 100) / 100, 1747.89);

    const serialized = new JSDOM(Core.serializeUploadGpx(segments), {
        contentType: 'text/xml',
    }).window.document;
    assert.deepEqual([...serialized.querySelectorAll('trkseg')].map(segment =>
        segment.querySelector('time')?.textContent), [
        '2021-07-26T14:52:00Z',
        '2021-07-27T22:32:00Z',
        '2021-07-27T11:08:00Z',
        '2021-07-27T17:10:00Z',
    ], 'serialized route geometry must retain GPX source segment order');
});

test('Strava displayed wall-clock time derives the activity timezone from GPX UTC', () => {
    const start = Date.UTC(2026, 6, 11, 23, 13);
    const formatted = Core.formatEncounterDateTime(start + 60 * 60000, {
        displayedLocalStart: '2026-07-11T16:13:00'
    }, start);
    assert.equal(formatted.date, '2026-07-11');
    assert.equal(formatted.time, '17:13');
});

test('an unusable displayed wall clock falls back to UTC without claiming a timezone', () => {
    const start = Date.UTC(2026, 6, 11, 23, 13);
    const formatted = Core.formatEncounterDateTime(start, { displayedLocalStart: 'not a timestamp' }, start);
    assert.equal(formatted.date, '2026-07-11');
    assert.equal(formatted.time, '23:13');
    // The shape carries no timezone-confidence field to be wrong about.
    assert.deepEqual(Object.keys(formatted).sort(), ['date', 'time']);
});

test('nights out uses the activity-local calendar span and stays unknown without timestamps', () => {
    const start = Date.UTC(2026, 6, 1, 23, 30);
    const segments = [[
        point(0, 0, 100, start),
        point(0, 0.001, 100, Date.UTC(2026, 6, 3, 1, 0))
    ]];
    assert.equal(Core.calculateNightsOut(segments, { utcOffsetMinutes: 0 }), 2);
    assert.equal(Core.calculateNightsOut([[point(0, 0), point(0, 1)]], {}), null);
});

test('day statistics use activity-local dates and preserve the cross-midnight edge once', () => {
    const start = Date.UTC(2026, 6, 1, 6, 0);
    const segments = [[
        point(0, 0, 100, start),
        point(0, 0.001, 130, start + 30 * 60000),
        point(0, 0.002, 120, start + 90 * 60000),
        point(0, 0.003, 160, start + 120 * 60000)
    ]];

    const stats = Core.calculateDayStats(segments, { utcOffsetMinutes: -420 });

    assert.deepEqual(stats.map(row => row.date), ['2026-06-30', '2026-07-01']);
    assert.equal(stats[0].gainM, 0);
    assert.equal(stats[0].lossM, 0);
    assert.equal(stats[0].maxElevationM, 115);
    assert.equal(stats[0].campElevationM, 130);
    assert.equal(stats[1].gainM, 0);
    assert.equal(stats[1].lossM, 0);
    assert.equal(stats[1].maxElevationM, 130);
    assert.equal(stats[1].campElevationM, null);
    assert.ok(Math.abs(stats.reduce((sum, row) => sum + row.distanceM, 0)
        - Core.distanceM(segments[0][0], segments[0][1])
        - Core.distanceM(segments[0][1], segments[0][2])
        - Core.distanceM(segments[0][2], segments[0][3])) < 0.001);
});

test('day statistics stay unavailable when any retained point lacks a timestamp', () => {
    const start = Date.UTC(2026, 6, 1);
    assert.deepEqual(Core.calculateDayStats([[
        point(0, 0, 100, start),
        point(0, 0.001, 110, null),
        point(0, 0.002, 120, start + 60000)
    ]], { utcOffsetMinutes: 0 }), []);
});

test('day statistics leave elevation fields unknown when the track has no elevation', () => {
    const start = Date.UTC(2026, 6, 1);
    const [stats] = Core.calculateDayStats([[
        point(0, 0, null, start),
        point(0, 0.001, null, start + 60000)
    ]], { utcOffsetMinutes: 0 });
    assert.equal(stats.gainM, null);
    assert.equal(stats.lossM, null);
    assert.equal(stats.maxElevationM, null);
    assert.equal(stats.campElevationM, null);
    assert.ok(stats.distanceM > 0);
});

test('day statistics reject spans beyond Peakbagger’s supported row count', () => {
    assert.deepEqual(Core.calculateDayStats([[
        point(0, 0, 100, Date.UTC(2026, 0, 1)),
        point(0, 0.001, 100, Date.UTC(2026, 4, 1))
    ]], { utcOffsetMinutes: 0 }), []);
});

test('same-day draft suffixes follow encounter order without mutating matches', () => {
    const matches = [
        { id: 1, draftFields: { date: '2026-07-01', upDistanceM: 300 } },
        { id: 2, draftFields: { date: '2026-07-02', upDistanceM: 50 } },
        { id: 3, draftFields: { date: '2026-07-01', upDistanceM: 100 } },
        { id: 4, draftFields: { date: '2026-07-01', upDistanceM: 200 } }
    ];

    const assigned = Core.assignDraftSuffixes(matches);

    assert.deepEqual(assigned.map(match => match.draftFields.suffix), ['c', '', 'a', 'b']);
    assert.equal(matches[0].draftFields.suffix, undefined);
});

test('draft selection prepares one track order, confidence order, and fallback trip name', () => {
    const matches = [
        { id: 7, name: 'Later', confidence: 80, draftFields: { date: '2026-07-01', upDistanceM: 300 } },
        { id: 8, name: 'Earlier', confidence: 95, draftFields: { date: '2026-07-01', upDistanceM: 100 } },
    ];

    const prepared = Core.prepareDraftSelection(matches);

    assert.deepEqual(prepared.trackOrdered.map(match => match.id), [8, 7]);
    assert.deepEqual(prepared.confidenceOrdered.map(match => match.id), [8, 7]);
    assert.deepEqual(Array.from(prepared.sequenceById), [['8', 1], ['7', 2]]);
    assert.equal(prepared.fallbackTripName, 'Earlier / Later');
    assert.deepEqual(prepared.matches.map(match => match.draftFields.suffix), ['b', 'a']);
    assert.equal(matches[0].draftFields.suffix, undefined);
});

// The same regression the settings-schema guard prevents, in the other pure
// module pair: capture-core serializes a GPX to fit Peakbagger's limits and
// ascent-draft re-validates it against them from a different bundle, so a
// literal in either one is free to drift out of agreement with the other.
test('no surface keeps its own copy of a Peakbagger upload limit', async () => {
    const sourceRoot = path.join(root, 'src');
    const sources = (await walkFiles(sourceRoot, file => file.endsWith('.js')))
        .filter(file => path.basename(file) !== 'upload-limits.js');
    assert.ok(sources.length >= 15, 'expected the src module set to be present');

    const leaks = [];
    for (const file of sources) {
        const text = await readFile(file, 'utf8');
        // The upload limits are only ever compared against a point or segment
        // count, so look for the numbers in that company rather than banning
        // 3000 and 50 outright — both are ordinary numbers elsewhere.
        const pattern = /(?:points?|waypoints?|segments?)\w*\.length\s*[<>]=?\s*(?:3000|50)\b|[<>]=?\s*(?:3000|50)\b\s*(?:\)|;).*(?:point|segment)/i;
        if (pattern.test(text)) {
            leaks.push(`${path.relative(root, file)} hardcodes a Peakbagger upload limit`);
        }
    }
    assert.deepEqual(leaks, [],
        `import MAX_UPLOAD_POINTS / MAX_TRACK_SEGMENTS from src/capture/upload-limits.js:\n${leaks.join('\n')}`);
});
