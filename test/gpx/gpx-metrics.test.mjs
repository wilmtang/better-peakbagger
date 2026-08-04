// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { gpxMetrics as GpxMetrics } from '../../src/gpx/gpx-metrics.js';

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

test('metrics do not bridge declared track-segment boundaries', () => {
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

test('one absent or invalid analyzed timestamp disables only time-derived output', async t => {
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

            assert.equal(metrics.hasTime, false);
            assert.deepEqual(metrics.timePoints, []);
            assert.deepEqual(metrics.timeChartPoints, []);
            assert.equal(metrics.points.length, 3);
            assert.ok(metrics.distanceM > 0);
        });
    }
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
