// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStorePackages } from '../../scripts/verify-store-packages.mjs';

function fixture(failAt) {
    const calls = [];
    const note = name => { calls.push(name); if (name === failAt) throw new Error(`failed ${name}`); };
    return { calls, hooks: {
        execute: async (command, args) => note(command === 'npm' ? 'build' : `execute ${args.slice(1).join(' ')}`),
        read: async path => { note(`read ${path}`); return 'canonical chrome bytes'; },
        deriveFirefox: async bytes => { assert.equal(bytes, 'canonical chrome bytes'); note('derive'); return 'derived firefox bytes'; },
        verify: async (bytes, version, browser) => {
            assert.equal(version, '3.9.2');
            assert.equal(bytes, browser === 'chrome' ? 'canonical chrome bytes' : 'derived firefox bytes');
            note(`verify ${browser}`);
        },
        write: async (path, bytes) => { assert.equal(bytes, 'derived firefox bytes'); note(`write ${path}`); },
    } };
}

test('CI and release derive, validate, and execute the same two canonical archives', async () => {
    const { calls, hooks } = fixture();
    await verifyStorePackages('3.9.2', hooks);
    assert.deepEqual(calls, [
        'build', 'read web-ext-artifacts/better_peakbagger-3.9.2.zip', 'verify chrome',
        'derive', 'verify firefox', 'write web-ext-artifacts/better_peakbagger-3.9.2-firefox.zip',
        'execute web-ext-artifacts/better_peakbagger-3.9.2.zip web-ext-artifacts/better_peakbagger-3.9.2-firefox.zip',
    ]);
});

test('a failed build or either invalid archive prevents browser execution', async () => {
    for (const phase of ['build', 'verify chrome', 'derive', 'verify firefox']) {
        const { calls, hooks } = fixture(phase);
        await assert.rejects(verifyStorePackages('3.9.2', hooks), /failed/);
        assert.ok(!calls.some(call => call.startsWith('execute')));
    }
    await assert.rejects(verifyStorePackages('../unsafe', fixture().hooks), /exact package version/);
});
