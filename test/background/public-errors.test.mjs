// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { publicErrors as PublicErrors } from '../../src/background/public-errors.js';

test('only typed product errors may carry public copy across the worker boundary', () => {
    const sentinel = new Error('RAW_BROWSER_SENTINEL');
    assert.deepEqual(PublicErrors.expose(sentinel), {
        code: 'unexpected',
        message: 'Better Peakbagger could not complete this action. Reload and try again.',
    });

    const typed = PublicErrors.exception(
        'job-expired',
        '  Capture results are no longer available.   Capture the activity again. ',
        { cause: sentinel }
    );
    assert.deepEqual(PublicErrors.expose(typed), {
        code: 'job-expired',
        message: 'Capture results are no longer available. Capture the activity again.',
    });
    assert.equal(typed.cause, sentinel);
    assert.doesNotMatch(JSON.stringify(PublicErrors.expose(typed)), /RAW_BROWSER_SENTINEL/);
});
