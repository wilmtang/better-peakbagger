// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { gpxMetrics as GpxMetrics } from '../../src/gpx/gpx-metrics.js';
import { MAX_MAP_ROUTE_POINTS, MAX_MAP_ROUTE_SEGMENTS } from '../../src/gpx/map-route-limits.js';

const segmentsOf = (count, pointsEach) => Array.from({ length: count }, (_segment, index) =>
    Array.from({ length: pointsEach }, (_point, step) => [47 + index * 0.001, -121 + step * 0.0001]));

test('the shared bounds are the ones the renderer was built around', () => {
    assert.equal(MAX_MAP_ROUTE_POINTS, 3000);
    assert.equal(MAX_MAP_ROUTE_SEGMENTS, 1500);
});

// The producer's output must land inside the verifier's window, at the window
// edge and one step past it. Drift here does not fail loudly: the frame drops
// the whole payload and the user sees a renderer failure for valid geometry.
test('the producer never emits a route the terrain frame would reject', () => {
    const cases = [
        segmentsOf(1, MAX_MAP_ROUTE_POINTS),
        segmentsOf(1, MAX_MAP_ROUTE_POINTS + 1),
        segmentsOf(1, MAX_MAP_ROUTE_POINTS * 4),
        segmentsOf(MAX_MAP_ROUTE_SEGMENTS, 2),
        segmentsOf(MAX_MAP_ROUTE_SEGMENTS, 3),
        segmentsOf(7, 900),
    ];
    for (const segments of cases) {
        const limited = GpxMetrics.limitMapRouteSegments(segments);
        const points = limited.reduce((sum, segment) => sum + segment.length, 0);
        assert.ok(limited.length <= MAX_MAP_ROUTE_SEGMENTS,
            `emitted ${limited.length} segments, frame accepts ${MAX_MAP_ROUTE_SEGMENTS}`);
        assert.ok(points <= MAX_MAP_ROUTE_POINTS,
            `emitted ${points} points, frame accepts ${MAX_MAP_ROUTE_POINTS}`);
        // Dropping the overlay entirely is a valid outcome; silently losing a
        // segment while keeping the rest is not, because the drawn route would
        // then bridge a gap the track actually has.
        assert.ok(limited.length === 0 || limited.length === segments.length);
        assert.ok(limited.every(segment => segment.length >= 2));
    }
});

test('a route past the segment bound is dropped rather than truncated', () => {
    assert.deepEqual(GpxMetrics.limitMapRouteSegments(segmentsOf(MAX_MAP_ROUTE_SEGMENTS + 1, 2)), []);
    assert.equal(GpxMetrics.limitMapRouteSegments(segmentsOf(MAX_MAP_ROUTE_SEGMENTS, 2)).length,
        MAX_MAP_ROUTE_SEGMENTS);
});

test('a route inside both bounds is passed through untouched', () => {
    const segments = segmentsOf(3, 10);
    assert.deepEqual(GpxMetrics.limitMapRouteSegments(segments), segments);
});

// Structural guard, like src/capture/upload-limits.js: the two sides sit in
// different bundles and never import each other, so a bare literal on either
// side is how they would silently disagree.
test('both sides of the bridge read the bounds instead of restating them', async () => {
    const [producer, verifier] = await Promise.all([
        readFile(new URL('../../src/gpx/gpx-metrics.js', import.meta.url), 'utf8'),
        readFile(new URL('../../src/terrain/terrain-frame.js', import.meta.url), 'utf8'),
    ]);
    for (const [name, source] of [['gpx-metrics.js', producer], ['terrain-frame.js', verifier]]) {
        assert.match(source, /from '[^']*map-route-limits\.js'/,
            `${name} must import the shared route bounds`);
        // Any binding whose name claims a route bound must be defined from the
        // shared module, never from a number typed in beside it. The file is
        // free to use unrelated numeric literals — terrain-frame.js has an
        // elevation stop at 1500 m — so match on the assignment, not the digits.
        for (const [, binding, value] of source.matchAll(
            /\b(MAX_(?:MAP_)?ROUTE_(?:POINTS|SEGMENTS))\s*=\s*([^;\n]+)/g)) {
            assert.doesNotMatch(value, /^\s*\d/,
                `${name} defines ${binding} from a literal instead of map-route-limits.js`);
        }
    }
});
