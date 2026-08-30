// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { gpxParse as GpxParse } from '../../src/gpx/gpx-parse.js';
import { gpxMetrics as GpxMetrics } from '../../src/gpx/gpx-metrics.js';
import { readCompressedGpxFixture } from '../helpers/gpx-fixtures.mjs';

test('geographic coordinate validation accepts only finite latitude and longitude bounds', () => {
    for (const [lat, lon] of [[-90, -180], [0, 0], [90, 180]]) {
        assert.equal(GpxMetrics.isValidCoordinate(lat, lon), true);
    }
    for (const [lat, lon] of [[-90.01, 0], [90.01, 0], [0, -180.01], [0, 180.01], [NaN, 0], [0, Infinity]]) {
        assert.equal(GpxMetrics.isValidCoordinate(lat, lon), false);
    }
});

test('metrics discard impossible coordinates without bridging across the resulting gap', () => {
    const metrics = GpxMetrics.computeMetrics([
        { lat: 0, lon: 0, rawEleM: 100, ms: 0 },
        { lat: 0, lon: 0.001, rawEleM: 101, ms: 0 },
        { lat: 91, lon: 0.002, rawEleM: 9999, ms: 0 },
        { lat: 0, lon: 1, rawEleM: 1000, ms: 0 },
        { lat: 0, lon: 1.001, rawEleM: 1010, ms: 0 },
    ]);

    assert.deepEqual(metrics.points.map(point => [point.lat, point.lon]), [
        [0, 0],
        [0, 0.001],
        [0, 1],
        [0, 1.001],
    ]);
    assert.ok(metrics.rawDistanceM > 200 && metrics.rawDistanceM < 250,
        `expected only the two local edges, got ${metrics.rawDistanceM} m`);
    assert.equal(metrics.rawGainM, 11, 'elevation gain must not bridge the invalid-coordinate gap');
    assert.equal(metrics.maxEleM < 9999, true);
});

test('metrics do not bridge implausible track-segment boundaries', () => {
    const metrics = GpxMetrics.computeMetrics([
        { lat: 48.2, lon: -121.2, rawEleM: 100, ms: 0, coordinateGroup: 0 },
        { lat: 48.3, lon: -121.3, rawEleM: 110, ms: 0, coordinateGroup: 0 },
        { lat: 47, lon: -121, rawEleM: 1000, ms: 0, coordinateGroup: 1 },
        { lat: 47.1, lon: -121.1, rawEleM: 1010, ms: 0, coordinateGroup: 1 },
    ]);

    assert.ok(metrics.rawDistanceM > 25_000 && metrics.rawDistanceM < 30_000,
        `expected only the two segment edges, got ${metrics.rawDistanceM} m`);
    assert.equal(metrics.rawGainM, 20,
        'elevation gain must not include the jump between segments');
    assert.deepEqual(metrics.chartPoints.map(point => point.coordinateGroup), [0, 0, 1, 1],
        'each segment must retain both endpoints and its break identity after sampling');
});

test('metrics safely sequence and join nearby chronological track segments', () => {
    const dayOne = Date.UTC(2026, 6, 10, 12);
    const dayTwo = Date.UTC(2026, 6, 11, 12);
    const sourcePoints = [
        { lat: 40, lon: -105, rawEleM: 100, ms: dayOne, coordinateGroup: 0 },
        { lat: 40.0001, lon: -105, rawEleM: 110, ms: dayOne + 60_000, coordinateGroup: 0 },
        { lat: 40.00061, lon: -105, rawEleM: 130, ms: dayTwo + 3 * 3_600_000, coordinateGroup: 1 },
        { lat: 40.0007, lon: -105, rawEleM: 120, ms: dayTwo + 3 * 3_600_000 + 60_000, coordinateGroup: 1 },
        { lat: 40.0002, lon: -105, rawEleM: 105, ms: dayTwo, coordinateGroup: 2 },
        { lat: 40.0003, lon: -105, rawEleM: 150, ms: dayTwo + 60_000, coordinateGroup: 2 },
        { lat: 40.00035, lon: -105, rawEleM: 154, ms: dayTwo + 2 * 3_600_000, coordinateGroup: 3 },
        { lat: 40.0006, lon: -105, rawEleM: 135, ms: dayTwo + 2 * 3_600_000 + 60_000, coordinateGroup: 3 },
    ];
    const metrics = GpxMetrics.computeMetrics(sourcePoints);
    const expectedOrder = [100, 110, 105, 150, 154, 135, 130, 120];
    const orderedSourcePoints = expectedOrder.map(rawEleM =>
        sourcePoints.find(point => point.rawEleM === rawEleM));
    const expectedRawDistanceM = orderedSourcePoints.slice(1).reduce((sum, point, index) =>
        sum + GpxMetrics.distanceM(orderedSourcePoints[index], point), 0);

    assert.deepEqual(metrics.points.map(point => point.rawEleM), expectedOrder,
        'non-overlapping, internally ordered segments should use chronological segment order');
    assert.deepEqual(metrics.points.map(point => point.coordinateGroup), Array(8).fill(0),
        'nearby endpoints with ballpark elevations should form one elevation profile');
    assert.ok(Math.abs(metrics.rawDistanceM - expectedRawDistanceM) < 0.001,
        'route distance should include every plausible cross-segment edge');
    assert.equal(metrics.rawGainM, 59,
        'gain should include the plausible four-metre rise across a segment boundary');
});

test('Capitol regression keeps the full four-segment track chronological and continuous', async () => {
    const source = await readCompressedGpxFixture('capitol-2021-segment-order.gpx.gz.b64');
    const document = new JSDOM(source, { contentType: 'text/xml' }).window.document;
    const segmentNodes = Array.from(document.querySelectorAll('trkseg'));
    const sourcePoints = segmentNodes.flatMap((segment, coordinateGroup) =>
        Array.from(segment.querySelectorAll('trkpt'), point => {
            const parsed = GpxParse.parseTrackPoint(point, { includeQuality: true });
            return {
                lat: parsed.lat,
                lon: parsed.lon,
                rawEleM: parsed.ele,
                elevationState: parsed.elevationState,
                ms: parsed.time,
                timeState: parsed.timeState,
                coordinateGroup,
            };
        }));

    assert.equal(document.querySelector('metadata, wpt, name, author'), null,
        'the committed regression fixture must not retain identifying metadata');
    assert.deepEqual(segmentNodes.map(segment => segment.querySelectorAll('trkpt').length),
        [767, 553, 838, 753]);
    assert.deepEqual(segmentNodes.map(segment =>
        segment.querySelector('trkpt time').textContent), [
        '2021-07-26T14:52:00Z',
        '2021-07-27T22:32:00Z',
        '2021-07-27T11:08:00Z',
        '2021-07-27T17:10:00Z',
    ], 'the fixture must retain the source-order segment defect');

    const metrics = GpxMetrics.computeMetrics(sourcePoints);
    const chronologicalSegmentStarts = [0, 767, 767 + 838, 767 + 838 + 753]
        .map(index => new Date(metrics.points[index].ms).toISOString());

    assert.deepEqual(chronologicalSegmentStarts, [
        '2021-07-26T14:52:00.000Z',
        '2021-07-27T11:08:00.000Z',
        '2021-07-27T17:10:00.000Z',
        '2021-07-27T22:32:00.000Z',
    ], 'whole segments must be safely sequenced as 0, 2, 3, 1');
    assert.deepEqual([...new Set(metrics.points.map(point => point.coordinateGroup))], [0],
        'all three nearby, ballpark-elevation boundaries must form one distance profile');
    assert.deepEqual([...new Set(metrics.timeChartPoints.map(point => point.timeCoordinateGroup))], [0],
        'all three boundaries must also form one time profile');
    assert.equal(Math.round(metrics.distanceM), 28_209);
    assert.equal(Math.round(metrics.gainM), 1_748);
    assert.equal(Math.round(metrics.rawGainM - metrics.gainM), 4_823);
    assert.equal(metrics.chartPoints.length, 971);
    assert.equal(metrics.timeChartPoints.length, 971);
});

test('nearby segment endpoints with an implausible elevation reset keep a profile break', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 40, lon: -105, rawEleM: 100, ms: start, coordinateGroup: 0 },
        { lat: 40.0001, lon: -105, rawEleM: 100, ms: start + 60_000, coordinateGroup: 0 },
        { lat: 40.00011, lon: -105, rawEleM: 250, ms: start + 120_000, coordinateGroup: 1 },
        { lat: 40.0002, lon: -105, rawEleM: 260, ms: start + 180_000, coordinateGroup: 1 },
    ]);

    assert.deepEqual(metrics.routePoints.map(point => point.coordinateGroup), [0, 0, 0, 0],
        'coordinate distance may cross a nearby recorder boundary');
    assert.deepEqual(metrics.points.map(point => point.coordinateGroup), [0, 0, 1, 1],
        'a 150-metre endpoint reset must remain a visible elevation break');
    assert.equal(metrics.rawGainM, 10,
        'gain must not include the implausible elevation reset');
});

test('a nearby but impossibly fast segment boundary remains a gap', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 40, lon: -105, rawEleM: 100, ms: start, coordinateGroup: 0 },
        { lat: 40.0001, lon: -105, rawEleM: 110, ms: start + 60_000, coordinateGroup: 0 },
        { lat: 40.0009, lon: -105, rawEleM: 115, ms: start + 61_000, coordinateGroup: 1 },
        { lat: 40.001, lon: -105, rawEleM: 120, ms: start + 120_000, coordinateGroup: 1 },
    ]);

    assert.deepEqual(metrics.routePoints.map(point => point.coordinateGroup), [0, 0, 1, 1],
        'an 89-metre jump in one second must not become route continuity');
    assert.equal(metrics.rawGainM, 15,
        'gain must not cross the rejected coordinate boundary');
});

test('partial segment timing preserves source segment order', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 40.0002, lon: -105, rawEleM: 120, ms: start + 120_000, coordinateGroup: 0 },
        { lat: 40.0003, lon: -105, rawEleM: 130, ms: 0, coordinateGroup: 0 },
        { lat: 40, lon: -105, rawEleM: 100, ms: start, coordinateGroup: 1 },
        { lat: 40.0001, lon: -105, rawEleM: 110, ms: start + 60_000, coordinateGroup: 1 },
    ]);

    assert.deepEqual(metrics.points.map(point => point.rawEleM), [120, 130, 100, 110],
        'one incomplete segment must prevent speculative whole-segment reordering');
});

test('unsafe segment time ranges preserve source segment order', async t => {
    const start = Date.UTC(2026, 6, 10, 12);
    const cases = [
        {
            name: 'internally reversed segment',
            firstTimes: [start + 180_000, start + 120_000],
            secondTimes: [start, start + 60_000],
        },
        {
            name: 'overlapping segment ranges',
            firstTimes: [start + 120_000, start + 300_000],
            secondTimes: [start, start + 180_000],
        },
    ];

    for (const { name, firstTimes, secondTimes } of cases) {
        await t.test(name, () => {
            const metrics = GpxMetrics.computeMetrics([
                { lat: 40.0002, lon: -105, rawEleM: 120, ms: firstTimes[0], coordinateGroup: 0 },
                { lat: 40.0003, lon: -105, rawEleM: 130, ms: firstTimes[1], coordinateGroup: 0 },
                { lat: 40, lon: -105, rawEleM: 100, ms: secondTimes[0], coordinateGroup: 1 },
                { lat: 40.0001, lon: -105, rawEleM: 110, ms: secondTimes[1], coordinateGroup: 1 },
            ]);

            assert.deepEqual(metrics.points.map(point => point.rawEleM), [120, 130, 100, 110]);
        });
    }
});

test('map routes split at impossible coordinates and discard unusable fragments', () => {
    assert.deepEqual(GpxMetrics.sanitizeMapRouteSegments([[
        [47, -121],
        [47.01, -121.01],
        [47.02, 181],
        [47.03, -121.03],
        [47.04, -121.04],
        [95, -121.05],
        [47.06, -121.06],
    ]]), [
        [[47, -121], [47.01, -121.01]],
        [[47.03, -121.03], [47.04, -121.04]],
    ]);
});

test('coordinate-only route distance preserves segment and invalid-coordinate gaps', () => {
    const distanceM = GpxMetrics.computeRouteDistanceM([
        [[0, 0], [0, 0.001], [91, 0.002], [0, 1], [0, 1.001]],
        [[0, 2], [0, 2.001]],
    ]);

    assert.ok(distanceM > 300 && distanceM < 360,
        `expected only three local edges, got ${distanceM} m`);
});

test('coordinate-only route distance joins nearby segment endpoints', () => {
    const distanceM = GpxMetrics.computeRouteDistanceM([
        [[0, 0], [0, 0.001]],
        [[0, 0.0011], [0, 0.002]],
    ]);

    assert.ok(distanceM > 220 && distanceM < 225,
        `expected the nearby cross-segment edge to count, got ${distanceM} m`);
});

test('missing elevation does not shortcut route distance or invent an elevation span', () => {
    const metrics = GpxMetrics.computeMetrics([
        { lat: 0, lon: 0, rawEleM: 100, ms: 0 },
        { lat: 0.01, lon: 0, rawEleM: Number.NaN, ms: 0 },
        { lat: 0.01, lon: 0.01, rawEleM: 110, ms: 0 },
    ]);

    assert.ok(metrics.distanceM > 2200 && metrics.distanceM < 2250,
        `the route must follow both legs instead of their chord: ${metrics.distanceM} m`);
    assert.equal(metrics.points.at(-1).distM, metrics.distanceM,
        'the next elevation sample keeps its position on the complete route');
    assert.deepEqual(metrics.chartPoints.map(point => point.coordinateGroup), [0, 1],
        'missing elevation splits the profile instead of drawing through it');
    assert.equal(metrics.rawGainM, 0,
        'gain cannot be inferred across a section with no elevation samples');
});

test('route timing remains usable when elevation is absent at its endpoints', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: Number.NaN, ms: start },
        { lat: 47.001, lon: -121.001, rawEleM: 100, ms: start + 30 * 60_000 },
        { lat: 47.002, lon: -121.002, rawEleM: Number.NaN, ms: start + 60 * 60_000 },
    ]);

    assert.equal(metrics.hasTime, true);
    assert.equal(metrics.startMs, start);
    assert.equal(metrics.endMs, start + 60 * 60_000);
    assert.equal(metrics.routePoints.length, 3);
    assert.equal(metrics.timePoints.length, 3);
    assert.equal(metrics.points.length, 1, 'only the actual elevation sample belongs in the profile');
});

test('a timed coordinate-only route retains duration without inventing elevation', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: Number.NaN, ms: start },
        { lat: 47.001, lon: -121.001, rawEleM: Number.NaN, ms: start + 60_000 },
    ]);

    assert.equal(metrics.hasTime, true);
    assert.equal(metrics.startMs, start);
    assert.equal(metrics.endMs, start + 60_000);
    assert.ok(metrics.distanceM > 100);
    assert.deepEqual(metrics.points, []);
    assert.deepEqual(metrics.chartPoints, []);
});

test('metrics reject an all-equal timestamp series without losing the elevation route', () => {
    const timestamp = Date.UTC(2025, 6, 7, 1, 55);
    const metrics = GpxMetrics.computeMetrics(Array.from({ length: 355 }, (_, index) => ({
        lat: 40.27 - index * 0.00001,
        lon: -105.56 - index * 0.00001,
        rawEleM: 2800 + Math.sin(index / 20) * 200,
        ms: timestamp,
    })));

    assert.equal(metrics.hasTime, false);
    assert.equal(metrics.startMs, 0);
    assert.equal(metrics.endMs, 0);
    assert.equal(metrics.summitMs, 0);
    assert.equal(metrics.points.length, 355,
        'the observed 355-point equal-time export must keep its elevation route');
    assert.equal(metrics.chartPoints.length, 119);
    assert.deepEqual(metrics.timePoints, []);
    assert.deepEqual(metrics.timeChartPoints, []);
    assert.ok(metrics.distanceM > 0);
});

test('metrics allow duplicate timestamps inside a progressing track', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: 100, ms: start },
        { lat: 47.001, lon: -121.001, rawEleM: 110, ms: start },
        { lat: 47.002, lon: -121.002, rawEleM: 120, ms: start + 60_000 },
    ]);

    assert.equal(metrics.hasTime, true);
    assert.equal(metrics.startMs, start);
    assert.equal(metrics.endMs, start + 60_000);
    assert.deepEqual(metrics.timePoints.map(point => point.lat), [47, 47.001, 47.002],
        'a stable time sort must preserve GPX order for equal timestamps');
});

test('metrics sort the time view without reordering route geometry', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: 100, ms: start + 60_000 },
        { lat: 47.001, lon: -121.001, rawEleM: 110, ms: start },
        { lat: 47.002, lon: -121.002, rawEleM: 120, ms: start + 30_000 },
    ]);

    assert.equal(metrics.hasTime, true);
    assert.equal(metrics.startMs, start);
    assert.equal(metrics.endMs, start + 60_000);
    assert.deepEqual(metrics.points.map(point => point.lat), [47, 47.001, 47.002]);
    assert.deepEqual(metrics.timePoints.map(point => point.lat), [47.001, 47.002, 47]);
    assert.deepEqual(metrics.chartPoints.map(point => point.lat), [47, 47.001, 47.002]);
    assert.deepEqual(metrics.timeChartPoints.map(point => point.lat), [47.001, 47.002, 47]);
    assert.ok(metrics.points[1].distM >= metrics.points[0].distM,
        'distance must remain cumulative in GPX route order');
});

test('timestamp direction cannot bypass bad-jump filtering', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const analyze = descending => GpxMetrics.computeMetrics([
        { lat: 0, lon: 0, rawEleM: 100, ms: start + (descending ? 1000 : 0) },
        { lat: 0, lon: 0.02, rawEleM: 101, ms: start + (descending ? 0 : 1000) },
    ]);

    const ascending = analyze(false);
    const descending = analyze(true);
    assert.ok(ascending.rawDistanceM > 2200 && ascending.rawDistanceM < 2250);
    assert.equal(ascending.distanceM, 0, 'the one-second jump is not credible travel');
    assert.equal(descending.distanceM, ascending.distanceM,
        'serializing the same timed edge in reverse must not restore the bad jump');
});

test('timestamp ordering permutations affect only the chronological view', async t => {
    const start = Date.UTC(2026, 6, 10, 12);
    const buildPoints = offsets => offsets.map((offset, index) => ({
        lat: 40 + index * 0.001,
        lon: -105 - index * 0.001,
        rawEleM: 100 + index,
        ms: start + offset * 60_000,
    }));
    const chronologicalMetrics = GpxMetrics.computeMetrics(buildPoints([0, 1, 2, 3]));
    const cases = [
        { name: 'already chronological', offsets: [0, 1, 2, 3], expected: [0, 1, 2, 3] },
        { name: 'strictly descending', offsets: [3, 2, 1, 0], expected: [3, 2, 1, 0] },
        { name: 'interleaved multi-day append', offsets: [1440, 0, 1500, 60], expected: [1, 3, 0, 2] },
        { name: 'scrambled with duplicate samples', offsets: [2, 0, 0, 1], expected: [1, 2, 3, 0] },
    ];

    for (const { name, offsets, expected } of cases) {
        await t.test(name, () => {
            const metrics = GpxMetrics.computeMetrics(buildPoints(offsets));
            const pointIndexes = points => points.map(point => point.rawEleM - 100);

            assert.equal(metrics.hasTime, true);
            assert.deepEqual(pointIndexes(metrics.points), [0, 1, 2, 3],
                'route analysis must retain GPX document order');
            assert.deepEqual(pointIndexes(metrics.timePoints), expected);
            assert.equal(metrics.distanceM, chronologicalMetrics.distanceM);
            assert.equal(metrics.rawDistanceM, chronologicalMetrics.rawDistanceM);
            assert.equal(metrics.gainM, chronologicalMetrics.gainM);
            assert.equal(metrics.rawGainM, chronologicalMetrics.rawGainM);
            assert.deepEqual(metrics.points.map(point => point.distM),
                chronologicalMetrics.points.map(point => point.distM),
                'timestamp order must not change route-order cumulative distance');
            assert.ok(metrics.timeChartPoints.every((point, index, points) =>
                index === 0 || point.ms >= points[index - 1].ms));
        });
    }
});

test('one absent or invalid timestamp preserves a partial time series with a visible break', async t => {
    const start = Date.UTC(2026, 6, 10, 12);
    const cases = [
        { name: 'missing timestamp', value: 0 },
        { name: 'invalid timestamp', value: Number.NaN },
        { name: 'infinite timestamp', value: Infinity },
        { name: 'pre-epoch timestamp', value: -1 },
    ];

    for (const { name, value } of cases) {
        await t.test(name, () => {
            const metrics = GpxMetrics.computeMetrics([
                { lat: 47, lon: -121, rawEleM: 100, ms: start },
                { lat: 47.001, lon: -121.001, rawEleM: 110, ms: value },
                { lat: 47.002, lon: -121.002, rawEleM: 120, ms: start + 60_000 },
            ]);

            assert.equal(metrics.hasTime, true);
            assert.equal(metrics.timeQuality.status, 'partial');
            assert.equal(metrics.timeQuality.validPoints, 2);
            assert.equal(metrics.timeQuality.missingPoints, value === 0 ? 1 : 0);
            assert.equal(metrics.timeQuality.invalidPoints, value === 0 ? 0 : 1);
            assert.deepEqual(metrics.timePoints.map(point => point.rawEleM), [100, 120]);
            assert.deepEqual(metrics.timeChartPoints.map(point => point.rawEleM), [100, 120]);
            assert.notEqual(
                metrics.timeChartPoints[0].timeCoordinateGroup,
                metrics.timeChartPoints[1].timeCoordinateGroup,
                'the time chart must not draw through an excluded timestamp'
            );
            assert.equal(metrics.points.length, 3);
            assert.ok(metrics.distanceM > 0);
        });
    }
});

test('quality summaries distinguish missing, invalid, and suspect elevation samples', () => {
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: 100, ms: 0 },
        { lat: 47.001, lon: -121.001, rawEleM: Number.NaN, elevationState: 'missing', ms: 0 },
        { lat: 47.002, lon: -121.002, rawEleM: Number.NaN, elevationState: 'invalid', ms: 0 },
        { lat: 47.003, lon: -121.003, rawEleM: 999999, ms: 0 },
    ]);

    assert.deepEqual(metrics.elevationQuality, {
        status: 'partial',
        totalPoints: 4,
        validPoints: 1,
        missingPoints: 1,
        invalidPoints: 1,
        suspectPoints: 1,
        coverage: 0.25,
    });
    assert.deepEqual(metrics.points.map(point => point.rawEleM), [100],
        'impossible elevations must be excluded rather than pulling the chart off scale');
    assert.equal(GpxMetrics.isPlausibleElevationM(-1000), true);
    assert.equal(GpxMetrics.isPlausibleElevationM(10000), true);
    assert.equal(GpxMetrics.isPlausibleElevationM(-1000.1), false);
    assert.equal(GpxMetrics.isPlausibleElevationM(10000.1), false);
});

test('coordinate and non-progressing time quality remain independently visible', () => {
    const timestamp = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: 100, ms: timestamp },
        { lat: 999, lon: -121, rawEleM: 110, ms: timestamp + 60_000 },
        { lat: 47.002, lon: -121.002, rawEleM: 120, ms: timestamp },
    ]);

    assert.deepEqual(metrics.coordinateQuality, {
        status: 'partial',
        totalPoints: 3,
        validPoints: 2,
        invalidPoints: 1,
        coverage: 2 / 3,
    });
    assert.equal(metrics.timeQuality.status, 'suspect');
    assert.equal(metrics.timeQuality.reason, 'not-progressing');
    assert.equal(metrics.timeQuality.coverage, 1);
    assert.equal(metrics.hasTime, false);
    assert.equal(metrics.points.length, 2);
});

test('chronological endpoints survive route-order chart sampling', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const offsets = [60, 0, 20, 30, 40, 50, 70, 80, 120, 90, 100, 110];
    const metrics = GpxMetrics.computeMetrics(offsets.map((offset, index) => ({
        lat: 40 + index * 0.001,
        lon: -105 - index * 0.001,
        rawEleM: 100 + index,
        ms: start + offset * 60_000,
    })));
    const pointIndexes = points => points.map(point => point.rawEleM - 100);

    assert.deepEqual(pointIndexes(metrics.chartPoints), [0, 1, 3, 6, 8, 9, 11],
        'route sampling must add chronological endpoints without changing route order');
    assert.equal(pointIndexes(metrics.timeChartPoints)[0], 1);
    assert.equal(pointIndexes(metrics.timeChartPoints).at(-1), 8);
    assert.equal(metrics.timeChartPoints[0].ms, metrics.startMs);
    assert.equal(metrics.timeChartPoints.at(-1).ms, metrics.endMs);
});

test('display chart sampling is pixel-bounded and retains semantic profile points', () => {
    const selectedIndex = 12_345;
    const points = Array.from({ length: 20_000 }, (_, index) => ({
        sourceIndex: index,
        coordinateGroup: index < 8_000 ? 0 : index < 14_000 ? 1 : 2,
        eleM: index === 4_321 ? -250 : index === 17_654 ? 5_000 : 1_000 + Math.sin(index / 25) * 100,
    }));

    const narrow = GpxMetrics.sampleChartPoints(points, 320, {
        required: [points[selectedIndex]],
    });
    const wide = GpxMetrics.sampleChartPoints(points, 1_100, {
        required: [points[selectedIndex]],
    });
    const indexes = samples => new Set(samples.map(point => point.sourceIndex));
    const narrowIndexes = indexes(narrow);

    assert.equal(narrow.length, 320);
    assert.equal(wide.length, 1_100);
    assert.ok(wide.length > narrow.length, 'a wider canvas earns a larger shape budget');
    assert.deepEqual([narrow[0], narrow.at(-1)], [points[0], points.at(-1)]);
    assert.ok(narrowIndexes.has(selectedIndex), 'the selected point survives a rebuild');
    assert.ok(narrowIndexes.has(4_321) && narrowIndexes.has(17_654),
        'global profile extrema remain truthful');
    assert.ok([7_999, 8_000, 13_999, 14_000].every(index => narrowIndexes.has(index)),
        'ordinary disconnected-group boundaries are retained');
});

test('pathological chart groups cannot defeat the display work bound', () => {
    const points = Array.from({ length: 20_000 }, (_, index) => ({
        sourceIndex: index,
        coordinateGroup: index,
        eleM: index % 101,
    }));
    const sampled = GpxMetrics.sampleChartPoints(points, 400);

    assert.equal(sampled.length, 400);
    assert.equal(sampled[0], points[0]);
    assert.equal(sampled.at(-1), points.at(-1));
});

test('summit time remains attached to the highest route point after chronological sorting', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const summitMs = start + 120_000;
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: 300, ms: summitMs },
        { lat: 47.001, lon: -121.001, rawEleM: 100, ms: start },
        { lat: 47.002, lon: -121.002, rawEleM: 200, ms: start + 60_000 },
    ]);

    assert.equal(metrics.summitMs, summitMs);
    assert.deepEqual(metrics.timePoints.map(point => point.rawEleM), [100, 200, 300]);
    assert.deepEqual(metrics.points.map(point => point.rawEleM), [300, 100, 200]);
});

test('civil offsets and labelled longitude estimates reject impossible inputs', () => {
    assert.equal(GpxMetrics.isValidUtcOffsetMinutes(-14 * 60), true);
    assert.equal(GpxMetrics.isValidUtcOffsetMinutes(14 * 60), true);
    assert.equal(GpxMetrics.isValidUtcOffsetMinutes(-14 * 60 - 1), false);
    assert.equal(GpxMetrics.isValidUtcOffsetMinutes(14 * 60 + 1), false);
    assert.equal(GpxMetrics.isValidUtcOffsetMinutes(Number.NaN), false);

    assert.equal(GpxMetrics.isValidCoordinate(0, -180), true);
    assert.equal(GpxMetrics.isValidCoordinate(0, 180), true);
    assert.equal(GpxMetrics.longitudeUtcOffsetMinutes(-180), -12 * 60);
    assert.equal(GpxMetrics.longitudeUtcOffsetMinutes(180), 12 * 60);
    assert.equal(GpxMetrics.longitudeUtcOffsetMinutes(-180.001), null);
    assert.equal(GpxMetrics.longitudeUtcOffsetMinutes(180.001), null);
});
