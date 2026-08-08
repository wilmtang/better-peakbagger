// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureCore as Core } from '../../src/capture/capture-core.js';
import { captureResourceLimits as Limits } from '../../src/capture/capture-resource-limits.js';

const corridorTrack = pointCount => Array.from({ length: pointCount }, (_, index) => ({
    lat: 0,
    lon: index * 0.085,
    ele: 100,
    time: index * 100_000,
}));

test('the capture resource contract preserves the production scale within hard budgets', () => {
    assert.equal(Limits.MAX_GPX_TRACK_POINTS, 20_000);
    assert.equal(Limits.MAX_GPX_TRACK_SEGMENTS, 50);
    assert.equal(Limits.MAX_GPX_WAYPOINTS, 3_000);
    assert.equal(Limits.CORRIDOR_CONCURRENCY, 4);
    assert.equal(Limits.MAX_CORRIDOR_BOXES, 64);
    assert.equal(Limits.MAX_CORRIDOR_REQUESTS, Limits.MAX_CORRIDOR_BOXES * 2);
    assert.equal(Limits.CORRIDOR_TOTAL_TIMEOUT_MS, 60_000);
});

test('corridor construction distinguishes the exact box limit from limit plus one', () => {
    const exact = Core.sanitizeTrack([corridorTrack(65)]).segments;
    const oversized = Core.sanitizeTrack([corridorTrack(66)]).segments;
    assert.equal(Core.buildQueryBoxes(exact).length, Limits.MAX_CORRIDOR_BOXES);
    assert.equal(Core.buildQueryBoxes(oversized).length, Limits.MAX_CORRIDOR_BOXES + 1);
});
