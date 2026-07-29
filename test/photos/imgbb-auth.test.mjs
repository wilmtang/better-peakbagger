// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { imgbbAuth as Auth } from '../../src/photos/imgbb-auth.js';

const fakeArea = () => {
    const values = {};
    return {
        values,
        async get(key) { return { [key]: values[key] }; },
        async set(patch) { Object.assign(values, structuredClone(patch)); },
        async remove(key) { delete values[key]; },
    };
};

test('stores a valid ImgBB key only in its device-local record', async () => {
    const area = fakeArea();
    const store = Auth.createKeyStore(area);
    assert.equal(await store.getKey(), null);
    assert.deepEqual(await store.setKey(' api-key ', '2026-07-27T18:00:00.000Z'), {
        configured: true,
        savedAt: '2026-07-27T18:00:00.000Z',
    });
    assert.deepEqual(area.values, {
        [Auth.STORAGE_KEY]: {
            key: 'api-key',
            savedAt: '2026-07-27T18:00:00.000Z',
        },
    });
    assert.equal(await store.getKey(), 'api-key');
    await store.clear();
    assert.equal(await store.getKey(), null);
});

test('rejects malformed keys and ignores malformed stored values', async () => {
    const area = fakeArea();
    const store = Auth.createKeyStore(area);
    await assert.rejects(store.setKey('has whitespace'), /invalid/);
    area.values[Auth.STORAGE_KEY] = { key: 'has whitespace' };
    assert.equal(await store.read(), null);
});
