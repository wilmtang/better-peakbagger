// Copyright (C) 2026 wilmtang <wilm.tang@outlook.com>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createCustomOverlayStore } from '../../src/background/custom-overlay-store.js';
import { createCustomPrivateStore } from '../../src/background/custom-private-store.js';
import { CUSTOM_REGISTRY_KEY } from '../../src/maps/custom-overlay-schema.js';

const source = { id: 'custom:0537a032-271c-4d11-9b8c-0edc566b47c1', revision: 1, name: 'Fixture', kind: 'raster',
    source: { tiles: ['https://tiles.example.com/{z}/{x}/{y}.png'], minNativeZoom: 0, maxNativeZoom: 18, scheme: 'xyz', tileSize: 256 },
    approvedOrigins: ['https://tiles.example.com'], attribution: { text: '' }, appearance: { opacity: 60, rules: [] } };

const harness = () => {
    const records = {}, faults = { cleanup: false, publicWrite: false, cleanupAck: false, armed: false }, privateStore = createCustomPrivateStore(new IDBFactory());
    let commits = 0;
    const storage = {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(records[key])])),
        set: async patch => {
            if (faults.cleanupAck && !patch[CUSTOM_REGISTRY_KEY]) throw new Error('Controlled cleanup acknowledgement failure');
            if (patch[CUSTOM_REGISTRY_KEY]) {
                if (faults.publicWrite) throw new Error('Controlled public commit failure');
                commits++; faults.armed = faults.cleanup;
            }
            Object.assign(records, structuredClone(patch));
        },
    };
    const check = () => { if (faults.armed) { faults.armed = false; throw new Error('Controlled postcommit cleanup failure'); } };
    const wrapped = { get: privateStore.get, mutate: (id, change) => { check(); return privateStore.mutate(id, change); }, put: (id, value) => { check(); return privateStore.put(id, value); } };
    const restart = () => createCustomOverlayStore({ storage, privateStore: wrapped, canRead: () => true, canEdit: () => true, canReadPrivate: () => true });
    const save = (store, revision, value) => store.handle({ type: 'CUSTOM_OVERLAYS_SAVE', id: source.id, expectedRevision: revision, source,
        requestParameters: [{ key: 'api_key', value }] }, {});
    return { privateStore, faults, restart, save, records, commits: () => commits };
};

for (const action of ['save', 'remove']) test(`committed private ${action} succeeds when cleanup fails and reconciles after restart`, async () => {
    const h = harness(), store = h.restart();
    try {
        assert.equal((await h.save(store, 0, 'old-key')).ok, true);
        await h.privateStore.put('budget:tiles.example.com', { count: 7 });
        h.faults.cleanup = true;
        const result = action === 'save' ? await h.save(store, 1, 'new-key')
            : await store.handle({ type: 'CUSTOM_OVERLAYS_REMOVE', id: source.id, expectedRevision: 1 }, {});
        assert.equal(result.ok, true, 'cleanup cannot retract a committed mutation');
        assert.equal(result.cleanupPending, true);
        assert.equal(result.registry.sources.length, action === 'save' ? 1 : 0);
        const commits = h.commits();
        h.faults.cleanup = false;
        const refreshed = await h.restart().handle({ type: 'CUSTOM_OVERLAYS_GET' }, {});
        assert.equal(refreshed.ok, true); assert.equal(refreshed.cleanupPending, undefined);
        assert.equal(h.commits(), commits, 'cleanup recovery never replays the public mutation');
        const saved = await h.privateStore.get(source.id);
        if (action === 'save') { assert.deepEqual(Object.keys(saved.versions), ['2']); assert.equal(saved.versions[2].parameters[0].value, 'new-key'); }
        else assert.equal(saved, undefined);
        assert.deepEqual(await h.privateStore.get('budget:tiles.example.com'), { count: 7 });
    } finally { await h.privateStore.close(); }
});

test('cleanup debt follows the current revision instead of deleting a newer save', async () => {
    const h = harness(), store = h.restart();
    try {
        await h.save(store, 0, 'old-key'); h.faults.cleanup = true;
        assert.equal((await h.save(store, 1, 'second-key')).ok, true);
        h.faults.armed = true; // Retry of earlier cleanup is also unavailable.
        const latest = await h.save(store, 2, 'latest-key');
        assert.equal(latest.ok, true); assert.equal(latest.registry.sources[0].revision, 3);
        h.faults.cleanup = false;
        await h.restart().handle({ type: 'CUSTOM_OVERLAYS_GET' }, {});
        const saved = await h.privateStore.get(source.id);
        assert.deepEqual(Object.keys(saved.versions), ['3']); assert.equal(saved.versions[3].parameters[0].value, 'latest-key');
    } finally { await h.privateStore.close(); }
});

test('a failed public commit preserves the prior private definition', async () => {
    const h = harness(), store = h.restart();
    try {
        await h.save(store, 0, 'old-key'); h.faults.publicWrite = true;
        assert.equal((await h.save(store, 1, 'new-key')).ok, false);
        h.faults.publicWrite = false;
        const current = await store.snapshot({ includePrivate: true });
        assert.equal(current.registry.sources[0].revision, 1);
        assert.equal(current.privateSources[0].parameters[0].value, 'old-key');
    } finally { await h.privateStore.close(); }
});

test('a failed private staging write preserves the previous public and private values', async () => {
    const h = harness(), store = h.restart();
    try {
        await h.save(store, 0, 'old-key'); h.faults.armed = true;
        assert.equal((await h.save(store, 1, 'new-key')).ok, false);
        assert.equal(h.commits(), 1);
        const current = await store.snapshot({ includePrivate: true });
        assert.equal(current.registry.sources[0].revision, 1); assert.equal(current.privateSources[0].parameters[0].value, 'old-key');
    } finally { await h.privateStore.close(); }
});

test('failed cleanup acknowledgement remains recoverable without repeating a committed save', async () => {
    const h = harness(), store = h.restart();
    try {
        await h.save(store, 0, 'old-key'); h.faults.cleanupAck = true;
        const result = await h.save(store, 1, 'new-key');
        assert.equal(result.ok, true); assert.equal(result.cleanupPending, true);
        assert.equal(h.commits(), 2);
        h.faults.cleanupAck = false;
        const refreshed = await h.restart().handle({ type: 'CUSTOM_OVERLAYS_GET' }, {});
        assert.equal(refreshed.ok, true); assert.equal(refreshed.cleanupPending, undefined);
        assert.equal(h.commits(), 2);
        assert.deepEqual(Object.keys((await h.privateStore.get(source.id)).versions), ['2']);
        assert.equal(JSON.stringify(h.records).includes('new-key'), false, 'cleanup debt never persists credentials in public storage');
    } finally { await h.privateStore.close(); }
});
