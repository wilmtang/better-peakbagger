// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';

import { terrainActivation as TerrainActivation } from '../../src/background/terrain-activation.js';

const peakbagger = (tabId = 5, frameId = 0, documentId = 'host-document') => ({
    tab: { id: tabId },
    frameId,
    documentId,
    url: 'https://www.peakbagger.com/climber/ascent.aspx?aid=1',
});
const terrainFrame = (tabId = 5) => ({
    tab: { id: tabId },
    frameId: 4,
    url: 'chrome-extension://test-id/terrain/terrain.html',
});

const create = ({ start = 1000 } = {}) => {
    let current = start;
    let sequence = 0;
    const activation = TerrainActivation.create({
        isPeakbaggerSender: sender => sender?.url?.startsWith('https://www.peakbagger.com/'),
        isTerrainFrameSender: sender => sender?.url === 'chrome-extension://test-id/terrain/terrain.html',
        now: () => current,
        randomToken: () => `token-${++sequence}`,
    });
    return { activation, advance: ms => { current += ms; } };
};

test('terrain init capabilities are tab-bound, action-bound, short-lived, and one-use', () => {
    const { activation, advance } = create();

    const issued = activation.issue({ action: 'init' }, peakbagger());
    assert.deepEqual(issued, { ok: true, token: 'token-1', expiresAt: 6000 });
    assert.deepEqual(activation.consumeFrame({ token: issued.token, action: 'init' }, terrainFrame(9)),
        { ok: false, reason: 'activation' });
    assert.deepEqual(activation.consumeFrame({ token: issued.token, action: 'init' }, terrainFrame()),
        { ok: false, reason: 'activation' }, 'a mismatched attempt consumes the opaque capability');

    const replayed = activation.issue({ action: 'init' }, peakbagger());
    assert.deepEqual(activation.consumeFrame({ token: replayed.token, action: 'init' }, terrainFrame()), { ok: true });
    assert.deepEqual(activation.consumeFrame({ token: replayed.token, action: 'init' }, terrainFrame()),
        { ok: false, reason: 'activation' });

    const expired = activation.issue({ action: 'init' }, peakbagger());
    advance(TerrainActivation.TTL_MS);
    assert.deepEqual(activation.consumeFrame({ token: expired.token, action: 'init' }, terrainFrame()),
        { ok: false, reason: 'activation' });
});

test('prefetch capabilities return only to the issuing page document', () => {
    const { activation } = create();
    const sender = peakbagger(5, 0, 'document-a');
    const issued = activation.issue({ action: 'prefetch' }, sender);

    assert.equal(activation.consumePrefetch(issued.token, peakbagger(5, 1, 'document-a')), false);
    assert.equal(activation.consumePrefetch(issued.token, sender), false,
        'a mismatched frame cannot leave the capability replayable');

    const second = activation.issue({ action: 'prefetch' }, sender);
    assert.equal(activation.consumePrefetch(second.token, peakbagger(5, 0, 'document-b')), false);

    const third = activation.issue({ action: 'prefetch' }, sender);
    assert.equal(activation.consumePrefetch(third.token, sender), true);
    assert.equal(activation.consumePrefetch(third.token, sender), false);
});

test('only Peakbagger content scripts can issue known terrain actions', () => {
    const { activation } = create();
    assert.deepEqual(activation.issue({ action: 'init' }, { tab: { id: 5 }, url: 'https://evil.example/' }),
        { ok: false, reason: 'forbidden' });
    assert.deepEqual(activation.issue({ action: 'other' }, peakbagger()),
        { ok: false, reason: 'forbidden' });
    assert.deepEqual(activation.consumeFrame({ token: 'guessed', action: 'init' }, peakbagger()),
        { ok: false, reason: 'forbidden' });
});
