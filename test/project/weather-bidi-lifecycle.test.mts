// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { createBidiRequestLifecycle } from '../../scripts/verify-ascent-weather.mts';

test('ignores no-such-request provideResponse errors only for superseded navigations or fetchError cancellations', () => {
    const lifecycle = createBidiRequestLifecycle(4);
    lifecycle.beginNavigation();
    const firstEpoch = lifecycle.captureRequest();

    assert.equal(
        lifecycle.shouldIgnoreProvideError('req-1', firstEpoch, new Error('network.provideResponse: no such request: Blocked request not found')),
        false,
        'active non-aborted no-such-request must fail loudly',
    );

    lifecycle.beginNavigation();
    assert.equal(
        lifecycle.shouldIgnoreProvideError('req-1', firstEpoch, new Error('network.provideResponse: no such request: Blocked request not found')),
        true,
        'superseded-epoch no-such-request should be ignored',
    );

    const secondEpoch = lifecycle.captureRequest();
    lifecycle.recordFetchError('req-2');
    assert.equal(
        lifecycle.shouldIgnoreProvideError('req-2', secondEpoch, new Error('network.provideResponse: no such request: req-2')),
        true,
        'same-epoch request aborted via network.fetchError should be ignored',
    );

    assert.equal(
        lifecycle.shouldIgnoreProvideError('req-2', secondEpoch, new Error('network.provideResponse: invalid argument: bad headers')),
        false,
        'non-cancellation BiDi errors must still fail even after fetchError',
    );

    // Bounded history evicts oldest entries cleanly without hiding newer cancellations.
    for (const id of ['req-3', 'req-4', 'req-5', 'req-6']) lifecycle.recordFetchError(id);
    assert.equal(
        lifecycle.shouldIgnoreProvideError('req-6', secondEpoch, new Error('network.provideResponse: no such request')),
        true,
    );
});
