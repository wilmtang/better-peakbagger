// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { climberCheckOptions } from '../../scripts/verify-climber-transitions.mjs';

test('climber verification defaults to all transitions and fails closed on empty or misspelled selections', () => {
    assert.equal(climberCheckOptions([]).checks, 'all');
    assert.deepEqual(climberCheckOptions(['--checks=buddy', '--variant=firefox-dark-390-2']), { checks: 'buddy', onlyVariant: 'firefox-dark-390-2' });
    for (const args of [['--checks=bogus'], ['--variant=typo'], ['--variant='], ['--checks='], ['--unknown'], ['--checks=baseline', '--variant=chrome-light-390-1']])
        assert.throws(() => climberCheckOptions(args));
});
