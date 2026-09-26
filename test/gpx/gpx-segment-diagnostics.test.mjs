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
    assert.equal(result.excludedSegmentCount, 1);
    assert.equal(result.excludedPointCount, 56);
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
        assert.equal(diagnose(source).excludedSegmentCount, 0);
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
