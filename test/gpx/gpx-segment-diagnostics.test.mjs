// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { gpxMetrics as M } from '../../src/gpx/gpx-metrics.js';
import { diagnoseGpxSegments as diagnose, diagnosticMetricInputs } from '../../src/gpx/gpx-segment-diagnostics.js';
import { suspectSegments, metricInputs } from '../helpers/suspect-gpx.mjs';

test('synthetic contamination independently doubles distance and extends elapsed time', () => {
    const source = suspectSegments();
    const all = M.computeMetrics(metricInputs(source));
    const withoutDuplicate = M.computeMetrics(metricInputs(source.slice(0, 2)));
    const hike = M.computeMetrics(metricInputs([source[1]]));
    assert.equal(all.coordinateQuality.totalPoints, 113);
    assert.ok(Math.abs(all.rawDistanceM - hike.rawDistanceM * 2) < 0.001);
    assert.equal(withoutDuplicate.distanceM, hike.distanceM);
    assert.equal(all.endMs - all.startMs, (68 * 60 + 28) * 60_000);
    assert.equal(withoutDuplicate.endMs - withoutDuplicate.startMs, all.endMs - all.startMs);
    assert.equal(hike.endMs - hike.startMs, (12 * 60 + 32) * 60_000);
});

test('exact degenerate duplicate is excluded with stable identities and immutable source', () => {
    const source = suspectSegments();
    const snapshot = structuredClone(source);
    const result = diagnose(source);
    assert.equal(result.excludedSegmentCount, 2);
    assert.equal(result.excludedPointCount, 57);
    assert.equal(result.sourcePointCount, 113);
    assert.equal(result.inventory[2].reason, 'degenerate-duplicate');
    assert.equal(result.inventory[2].donorSegmentId, 1);
    assert.equal(diagnosticMetricInputs(result).at(-1).sourcePointId, '1:55');
    assert.equal(diagnosticMetricInputs(result, true).at(-1).sourcePointId, '2:55');
    assert.deepEqual(source, snapshot);
    assert.deepEqual(diagnose(source), result);
});

for (const [name, alter] of [
    ['progressing lap', s => s[2].forEach((p, i) => { p.time += (i + 1) * 60_000; p.ele = s[1][i].ele; })],
    ['reversed geometry', s => s[2].reverse()],
    ['near matching geometry', s => { s[2][20].lat += 1e-9; }],
    ['missing elevation', s => { s[2][20].ele = null; s[2][20].elevationState = 'missing'; }],
    ['invalid elevation', s => { s[2][20].elevationState = 'invalid'; }],
    ['missing time', s => { s[2][20].timeState = 'missing'; }],
    ['different constant time', s => s[2].forEach(p => { p.time += 1000; })],
    ['sea-level donor', s => s[1].forEach(p => { p.ele = 0; })],
    ['invalid donor elevation', s => { s[1][20].ele = 10001; }],
    ['backwards donor time', s => { s[1][20].time = s[1][0].time - 1; }],
    ['invalid coordinate', s => { s[1][20].lat = s[2][20].lat = 91; }],
    ['no donor', s => s.splice(1, 1)],
    ['too few points', s => { s[1].length = s[2].length = 7; }],
    ['stationary points', s => s.slice(1).forEach(seg => seg.forEach(p => { p.lat = 46; p.lon = -120; }))],
    ['tiny geometry', s => s.slice(1).forEach(seg => seg.forEach(p => { p.lat = 46 + (p.lat - 46) / 1000; p.lon = -120; }))],
]) {
    test(`preserves ${name}`, () => {
        const source = suspectSegments();
        alter(source);
        assert.notEqual(diagnose(source).inventory.at(-1).reason, 'degenerate-duplicate');
    });
}

test('multiple possible donors warn without selecting a survivor', () => {
    const source = suspectSegments();
    source.push(structuredClone(source[1]));
    const result = diagnose(source);
    assert.equal(result.excludedSegmentCount, 0);
    assert.equal(result.inventory[2].reason, 'ambiguous-duplicate');
});

test('20,000 points and 50 segments stay bounded and oversized input is rejected', () => {
    const route = suspectSegments()[1];
    const source = Array.from({ length: 50 }, () => Array.from({ length: 400 }, (_, i) => ({ ...route[i % 56] })));
    assert.equal(diagnose(source).sourcePointCount, 20_000);
    assert.throws(() => diagnose([...source, []]), /too large/);
    source[0].push(route[0]);
    assert.throws(() => diagnose(source), /too large/);
});

test('isolated point is independent of duplicate detection and uses 24h / 50km floors', () => {
    const source = suspectSegments().slice(0, 2);
    assert.equal(diagnose(source).inventory[0].reason, 'isolated-distant-point');
    const start = source[1][0].time;
    source[0][0].time = start - 24 * 60 * 60_000 + 1;
    assert.equal(diagnose(source).excludedSegmentCount, 0);
    source[0][0].time--;
    assert.equal(diagnose(source).excludedSegmentCount, 1);
    source[0][0].time = source[1].at(-1).time + 24 * 60 * 60_000;
    assert.equal(diagnose(source).excludedSegmentCount, 1);
    source[0][0].lat = source[1][0].lat;
    source[0][0].lon = source[1][0].lon;
    assert.equal(diagnose(source).excludedSegmentCount, 0);
});

test('competing activities and singleton breadcrumbs stay included with a warning', () => {
    const source = suspectSegments().slice(0, 2);
    for (const extra of [[{ ...source[0][0] }], structuredClone(source[1])]) {
        const result = diagnose([...source, extra]);
        assert.equal(result.excludedSegmentCount, 0);
        assert.equal(result.inventory[0].reason, 'ambiguous-activity');
    }
});

test('multi-day and overnight records are retained', () => {
    const route = suspectSegments()[1];
    route.forEach((p, i) => { p.time += i * 24 * 60 * 60_000; });
    assert.equal(diagnose([route]).excludedSegmentCount, 0);
});

test('a singleton near a sparse edge interior is retained despite remote vertices', () => {
    const route = suspectSegments()[1].slice(0, 8);
    route.forEach((p, i) => { p.lat = 0; p.lon = i - 3.5; });
    const singleton = { ...route[0], lon: 0, time: route[0].time - 48 * 60 * 60_000 };
    assert.ok(Math.min(...route.map(p => M.distanceM(singleton, p))) > 50_000);
    assert.equal(diagnose([[singleton], route]).excludedSegmentCount, 0);
});

test('point-to-path distance handles sparse arcs, endpoints, poles, and antimeridian', () => {
    const distance = (p, a, b) => M.distanceToPathM(p, [a, b]);
    assert.ok(distance({ lat: 0, lon: 0 }, { lat: 0, lon: -2 }, { lat: 0, lon: 2 }) < 1e-6);
    assert.ok(distance({ lat: 0, lon: 180 }, { lat: 0, lon: 179 }, { lat: 0, lon: -179 }) < 1e-6);
    assert.ok(distance({ lat: 90, lon: 0 }, { lat: 89, lon: 0 }, { lat: 89, lon: 180 }) < 1e-6);
    assert.ok(Math.abs(distance({ lat: 0, lon: 3 }, { lat: 0, lon: -2 }, { lat: 0, lon: 2 })
        - M.distanceM({ lat: 0, lon: 3 }, { lat: 0, lon: 2 })) < 1e-6);
    assert.ok(Number.isNaN(distance({ lat: 20, lon: 20 }, { lat: 0, lon: 0 }, { lat: 0, lon: 180 })));
    assert.ok(Number.isNaN(distance({ lat: 91, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 1 })));
    const north = 50_000 / M.EARTH_RADIUS_M * 180 / Math.PI;
    assert.ok(Math.abs(distance({ lat: north, lon: 0 }, { lat: 0, lon: -2 }, { lat: 0, lon: 2 }) - 50_000) < 1e-6);
});

test('100 metre and eight point duplicate floors are enforced', () => {
    for (const [count, length, expected] of [[8, 100.001, 1], [8, 99.999, 0], [7, 101, 0]]) {
        const route = suspectSegments()[1].slice(0, count);
        route.forEach((p, i) => { p.lat = 0; p.lon = i / (count - 1) * length / M.EARTH_RADIUS_M * 180 / Math.PI; });
        const copy = route.map(p => ({ ...p, ele: 0, time: route[0].time }));
        assert.equal(diagnose([route, copy]).excludedSegmentCount, expected);
    }
});
