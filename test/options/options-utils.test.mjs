// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { optionsUtils as Utils } from '../../options/options-utils.js';

test('options busy runner rejects overlap and always clears its state', async () => {
    let busy = false;
    let release;
    let calls = 0;
    const state = {
        isBusy: () => busy,
        setBusy: value => { busy = value; },
    };
    const first = Utils.withBusy(state, async () => {
        calls++;
        await new Promise(resolve => { release = resolve; });
    });
    await Utils.withBusy(state, async () => { calls++; });
    assert.equal(calls, 1);
    assert.equal(busy, true);
    release();
    await first;
    assert.equal(busy, false);

    await assert.rejects(Utils.withBusy(state, async () => { throw new Error('failed'); }), /failed/);
    assert.equal(busy, false);
});

test('options repository names prefer the canonical full name', () => {
    assert.equal(Utils.githubRepoName({ repo: { fullName: 'ada/peaks', owner: 'x', name: 'y' } }), 'ada/peaks');
    assert.equal(Utils.githubRepoName({ repo: { owner: 'ada', name: 'peaks' } }), 'ada/peaks');
    assert.equal(Utils.githubRepoName(null), 'the connected repository');
});

test('options missing-element diagnostics name every absent control', () => {
    const messages = [];
    const original = console.error;
    console.error = message => messages.push(message);
    try {
        assert.equal(Utils.logMissingElements('test panel', {
            present: {}, missing: null, 'empty selector': [], 'partial selector': [{}, null]
        }), true);
        assert.deepEqual(messages, [
            'Better Peakbagger test panel unavailable; missing: missing, empty selector, partial selector'
        ]);
        assert.equal(Utils.logMissingElements('test panel', { present: {} }), false);
    } finally {
        console.error = original;
    }
});
