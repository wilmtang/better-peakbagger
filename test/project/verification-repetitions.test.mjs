// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { repeatVerification, verificationRepetitions } from '../../scripts/verification-repetitions.mjs';
import { verifyPackageRepetitions } from '../../scripts/verify-packaged-extensions.mjs';

test('verification repetitions are bounded and every requested run must pass', async () => {
    for (const value of ['0','6','3.0','',NaN]) assert.throws(() => verificationRepetitions(value), /integer/);
    const calls = [];
    await repeatVerification(async attempt => calls.push(attempt), 3);
    assert.deepEqual(calls, [1,2,3]);
    calls.length = 0;
    await assert.rejects(repeatVerification(async attempt => {
        calls.push(attempt);
        if (attempt === 2) throw new Error('real assertion failure');
    }, 3), /real assertion failure/);
    assert.deepEqual(calls, [1,2], 'a failed repetition cannot be retried into a green result');
});

test('repeated package verification uses the same archives and rejects changed bytes', async () => {
    const calls = [];
    let changed = false;
    const options = {
        chromeArchive: 'chrome.zip', firefoxArchive: 'firefox.zip', chromeSource: 'extracted', count: 3,
        read: async file => `${file}:${changed ? 'changed' : 'original'}`,
        execute: async (script, source) => calls.push([script, source]),
    };
    await verifyPackageRepetitions(options);
    assert.deepEqual(calls, Array.from({ length: 3 }, () => [
        ['verify-extension.mjs','extracted'], ['verify-firefox-extension.mjs','firefox.zip'],
    ]).flat());
    calls.length = 0;
    await assert.rejects(verifyPackageRepetitions({ ...options, execute: async script => {
        calls.push(script); changed = true;
    } }), /bytes changed/);
    assert.equal(calls.length, 1, 'changed bytes must stop verification before the next browser');
});
