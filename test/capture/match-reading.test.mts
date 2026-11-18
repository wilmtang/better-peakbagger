// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchReading } from '../../src/capture/match-reading.ts';

test('a match reading prints the integer percentage as assigned, without guessing a scale', () => {
    assert.deepEqual(matchReading('strong', 92), { text: 'Strong · 92%', spoken: 'Strong match · 92% confidence' });
    assert.deepEqual(matchReading('probable', 1), { text: 'Probable · 1%', spoken: 'Probable match · 1% confidence' },
        'a 1% score must not be read as a 0–1 fraction and shown as 100%');
    assert.deepEqual(matchReading('weak', 64.6), { text: 'Off track · 65%', spoken: 'Off track match · 65% confidence' });
});

test('a reading without a usable confidence names only the classification', () => {
    for (const value of [undefined, null, Number.NaN, '92']) {
        assert.deepEqual(matchReading('strong', value), { text: 'Strong', spoken: 'Strong match' });
    }
});
