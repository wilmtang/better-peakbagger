// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePhases } from '../../src/capture/capture-phases.js';

test('capture terminal phases have one shared immutable definition', () => {
    assert.deepEqual(capturePhases.TERMINAL_PHASES, [
        'ready', 'no-matches', 'no-gps', 'error', 'opened', 'previewed'
    ]);
    assert.equal(Object.isFrozen(capturePhases.TERMINAL_PHASES), true);
    for (const phase of capturePhases.TERMINAL_PHASES) assert.equal(capturePhases.isTerminal(phase), true);
    for (const phase of ['starting', 'checking-peakbagger', 'analyzing', null]) {
        assert.equal(capturePhases.isTerminal(phase), false);
    }
});
