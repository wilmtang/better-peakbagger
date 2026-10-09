// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCaptureCpuSamples } from '../helpers/capture-scale-policy.mjs';

test('capture CPU policy tolerates one moderate scheduling outlier, preserving all measurements', () => {
    const samples = [10_000, 18_143, 10_100];
    assert.deepEqual(evaluateCaptureCpuSamples(samples), { median: 10_100, maximum: 18_143, minimum: 10_000 });
    assert.deepEqual(samples, [10_000, 18_143, 10_100]);
});

test('sustained regressions and catastrophic individual samples fail the performance gate', () => {
    for (const samples of [[15_000,15_000,15_000], [14_900,15_100,16_000], [10_000,30_000,10_100]]) {
        assert.throws(() => evaluateCaptureCpuSamples(samples), /Capture CPU regression/);
    }
});

test('missing or invalid measurements cannot be treated as a green benchmark', () => {
    for (const samples of [[], [1,2], [1,2,3,4], [NaN,1,2], [Infinity,1,2], [-1,1,2], [0,1,2]]) {
        assert.throws(() => evaluateCaptureCpuSamples(samples), /three finite positive/);
    }
});
