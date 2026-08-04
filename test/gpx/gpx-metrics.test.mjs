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

test('metrics reject an all-equal timestamp series without losing the elevation route', () => {
    const timestamp = Date.UTC(2025, 6, 7, 1, 55);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 40.27, lon: -105.56, rawEleM: 2800, ms: timestamp },
        { lat: 40.26, lon: -105.57, rawEleM: 3200, ms: timestamp },
        { lat: 40.25, lon: -105.58, rawEleM: 3000, ms: timestamp },
    ]);

    assert.equal(metrics.hasTime, false);
    assert.equal(metrics.startMs, 0);
    assert.equal(metrics.endMs, 0);
    assert.equal(metrics.summitMs, 0);
    assert.equal(metrics.points.length, 3);
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
});

test('metrics reject backward timestamps instead of reordering route geometry', () => {
    const start = Date.UTC(2026, 6, 10, 12);
    const metrics = GpxMetrics.computeMetrics([
        { lat: 47, lon: -121, rawEleM: 100, ms: start },
        { lat: 47.001, lon: -121.001, rawEleM: 110, ms: start + 60_000 },
        { lat: 47.002, lon: -121.002, rawEleM: 120, ms: start + 30_000 },
    ]);

    assert.equal(metrics.hasTime, false);
    assert.deepEqual(metrics.points.map(point => point.lat), [47, 47.001, 47.002]);
});
