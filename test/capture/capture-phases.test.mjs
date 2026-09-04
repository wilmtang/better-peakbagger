// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePhases } from '../../src/capture/capture-phases.js';

test('capture terminal phases have one shared immutable definition', () => {
    assert.deepEqual(capturePhases.TERMINAL_PHASES, [
        'ready', 'no-matches', 'no-gps', 'error', 'opening', 'opened', 'previewed'
    ]);
    assert.equal(Object.isFrozen(capturePhases.TERMINAL_PHASES), true);
    assert.deepEqual(capturePhases.REUSABLE_PHASES, [
        'ready', 'no-matches', 'no-gps', 'opening', 'opened', 'previewed'
    ]);
    assert.equal(Object.isFrozen(capturePhases.REUSABLE_PHASES), true);
    assert.deepEqual(capturePhases.ACTIVE_PHASES, [
        'validating-activity', 'waiting-provider', 'verifying-ownership',
        'checking-peakbagger', 'exporting-gpx', 'processing-track',
        'searching-summits', 'preparing-results'
    ]);
    assert.equal(Object.isFrozen(capturePhases.ACTIVE_PHASES), true);
    for (const phase of capturePhases.TERMINAL_PHASES) assert.equal(capturePhases.isTerminal(phase), true);
    for (const phase of capturePhases.REUSABLE_PHASES) assert.equal(capturePhases.isReusable(phase), true);
    assert.equal(capturePhases.isReusable('error'), false);
    for (const phase of capturePhases.ACTIVE_PHASES) assert.equal(capturePhases.isActive(phase), true);
    assert.equal(capturePhases.isActive('ready'), false);
    for (const phase of ['starting', 'checking-peakbagger', 'analyzing', null]) {
        assert.equal(capturePhases.isTerminal(phase), false);
    }
});
