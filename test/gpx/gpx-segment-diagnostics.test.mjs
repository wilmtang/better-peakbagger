// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { gpxMetrics as M } from '../../src/gpx/gpx-metrics.js';
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
