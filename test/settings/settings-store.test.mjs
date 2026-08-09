// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, STORAGE_KEY } from '../../src/settings/settings.js';

const makeArea = (initial = {}) => {
    const data = { ...initial };
    return {
        data,
        get: async key => ({ [key]: data[key] }),
        set: async values => { Object.assign(data, values); },
    };
};

test('a settings mutation fails closed when the authoritative read fails', async () => {
    let writes = 0;
    const store = createSettingsStore({
        area: {
            get: async () => { throw new Error('sync read failed'); },
            set: async () => { writes++; },
        },
        sendMessage: null,
    });

    await assert.rejects(store.applyPatch({ theme: 'dark' }), /sync read failed/);
    await assert.rejects(store.requireCurrent(), /sync read failed/,
        'privacy and preservation callers need the authoritative read failure');
    assert.equal(writes, 0, 'fallback defaults must never become the base of a mutation');
    assert.equal((await store.get()).theme, 'system', 'ordinary reads remain fail-soft');
});

test('a settings mutation propagates storage write failure and its queue recovers', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light', units: 'imperial' } });
    const nativeSet = area.set;
    let fail = true;
    area.set = async values => {
        if (fail) {
            fail = false;
            throw new Error('sync write failed');
        }
        await nativeSet(values);
    };
    const store = createSettingsStore({ area, sendMessage: null });

    await assert.rejects(store.applyPatch({ theme: 'dark' }), /sync write failed/);
    const next = await store.applyPatch({ units: 'metric' });
    assert.equal(next.theme, 'light');
    assert.equal(next.units, 'metric');
});

test('a client mutation fails when the worker-owned settings route is absent', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light' } });
    let writes = 0;
    area.set = async () => { writes++; };
    const store = createSettingsStore({ area, sendMessage: async () => null });

    await assert.rejects(store.set({ theme: 'dark' }), /could not be saved/i);
    assert.equal(writes, 0, 'a client must not fall back to a competing local read-modify-write');
});

test('worker-owned settings patches preserve concurrent writes from separate contexts', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light', units: 'imperial' } });
    let releaseFirstRead;
    let readCount = 0;
    const nativeGet = area.get;
    area.get = async key => {
        readCount++;
        if (readCount === 1) await new Promise(resolve => { releaseFirstRead = resolve; });
        return nativeGet(key);
    };

    const workerStore = createSettingsStore({ area, sendMessage: null });
    const route = async message => ({
        ok: true,
        settings: await workerStore.applyPatch(message.patch),
    });
    const firstContext = createSettingsStore({ area, sendMessage: route });
    const secondContext = createSettingsStore({ area, sendMessage: route });

    const themeWrite = firstContext.set({ theme: 'dark' });
    const unitsWrite = secondContext.set({ units: 'metric' });
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseFirstRead();
    await Promise.all([themeWrite, unitsWrite]);

    assert.equal(area.data[STORAGE_KEY].theme, 'dark');
    assert.equal(area.data[STORAGE_KEY].units, 'metric');
});

test('conditional settings restore yields to a newer queued patch', async () => {
    const area = makeArea({ [STORAGE_KEY]: { theme: 'light', units: 'imperial' } });
    const store = createSettingsStore({ area, sendMessage: null });
    const previous = await store.requireCurrent();
    const imported = await store.applyPatch({ theme: 'dark' });

    const newer = store.applyPatch({ units: 'metric' });
    const rollback = store.replaceIfCurrent(imported, previous);
    await newer;

    assert.deepEqual(await rollback, {
        replaced: false,
        current: await store.requireCurrent(),
    });
    assert.equal(area.data[STORAGE_KEY].theme, 'dark');
    assert.equal(area.data[STORAGE_KEY].units, 'metric');
});
